"""Core image processing for scanned film negatives.

The adjustment pipeline here is the single server-side implementation and is
kept in exact sync with the WebGL fragment shader in static/webgl-renderer.js
(same operations, same order, same constants). The live preview runs on the
client GPU; this module produces the identical result for the CPU preview
fallback and for full-quality export.

Shader pipeline order:
    levels (eyedropper) -> exposure (linear-light stops with highlight
    rolloff) -> tone (shadows/highlights/whites/blacks/contrast/brightness
    computed on luminance, applied as one ratio-preserving gain) ->
    temperature/tint -> RGB offsets -> saturation -> custom curves -> clamp
"""

import json
import logging

import cv2
import numpy as np

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('FilmProcessor')

# GPU acceleration with CuPy (optional)
try:
    import cupy as cp
    GPU_AVAILABLE = True
    logger.info(f"GPU acceleration enabled with CuPy {cp.__version__}")
except Exception as e:  # pragma: no cover - depends on machine
    import numpy as cp
    GPU_AVAILABLE = False
    logger.warning(f"GPU unavailable ({e}), using CPU")


def _soft_knee(xp, x, k_scale):
    """Soft-knee endpoint stretch, matching the shader's softKnee exactly:
    scales x by k_scale (>= 1) and rolls smoothly (C1) into 1.0 near the
    top instead of hard clipping. Values pushed past 1 + (k_scale-1)/2
    still clip, so endpoints remain settable with the clipping preview.
    Identity when k_scale == 1."""
    y = x * k_scale
    k = 1.0 - (k_scale - 1.0) * 0.5
    t = xp.clip((y - k) / max(k_scale - 1.0, 1e-6), 0.0, 1.0)
    knee = k + (1.0 - k) * (2.0 * t - t * t)
    return xp.where(y > k, knee, y)


# Every adjustment parameter the pipeline understands, with its neutral value.
# Keys not listed here are ignored by update_params.
DEFAULT_PARAMS = {
    'exposure': 0.0,      # true stops, applied in linear light
    'contrast': 0.0,      # -0.5..0.5, S-curve up / linear flatten down
    'highlights': 0.0,    # -0.5..0.5
    'shadows': 0.0,       # -0.5..0.5
    'whites': 0.0,        # -1..1, white-point control
    'blacks': 0.0,        # -1..1, black-point control
    'brightness': 0.0,    # midtone gamma
    'temperature': 0.0,   # blue-yellow shift
    'tint': 0.0,          # green-magenta shift
    'red': 0.0,           # per-channel offset
    'green': 0.0,
    'blue': 0.0,
    'saturation': 0.0,    # 0 = neutral, applied as mix(gray, color, 1 + s)
    'film_correction': 0.0,  # film base removal strength, rebuilds cache
    'straighten': 0.0,    # fine rotation in degrees (+ = clockwise), rebuilds cache
    # Eyedropper points (0-255 per channel, None = unset)
    'black_point_r': None, 'black_point_g': None, 'black_point_b': None,
    'white_point_r': None, 'white_point_g': None, 'white_point_b': None,
    'gray_point_r': None, 'gray_point_g': None, 'gray_point_b': None,
    # Tone curves: JSON string or dict with 'rgb'/'red'/'green'/'blue' point lists
    'curves': None,
}

# Proxy scale used for fast low-res preview while dragging sliders (CPU fallback)
PROXY_SCALE = 0.3


class FilmProcessor:
    def __init__(self, image_array, is_negative=True):
        # Keep a CPU copy for pixel sampling and proxy generation
        self.original_cpu = image_array
        self.original_image = image_array

        if GPU_AVAILABLE:
            self.original = cp.asarray(image_array)
            logger.info(f"Transferred {image_array.shape} image to GPU")
        else:
            self.original = image_array

        self.is_negative = is_negative
        self.params = dict(DEFAULT_PARAMS)
        self.cached_stages = {}
        self._proxy = None
        self._initialize_cache()

    # ------------------------------------------------------------------
    # Cache handling
    # ------------------------------------------------------------------

    def set_original(self, image_array):
        """Replace the source image (e.g. after crop/undo) and rebuild caches."""
        self.original_cpu = image_array
        self.original_image = image_array
        if GPU_AVAILABLE:
            self.original = cp.asarray(image_array)
        else:
            self.original = image_array
        self._initialize_cache()

    def _rotate_cpu(self, img_cpu, angle):
        """Rotate a CPU image by `angle` degrees clockwise, expanding the
        canvas to fit. Border fill is chosen so it ends up black after the
        pipeline (white in negative space, black in positive space)."""
        if angle == 0:
            return img_cpu
        h, w = img_cpu.shape[:2]
        # cv2's positive angle is counter-clockwise; ours is clockwise
        M = cv2.getRotationMatrix2D((w / 2, h / 2), -angle, 1.0)
        cos, sin = abs(M[0, 0]), abs(M[0, 1])
        new_w = int(h * sin + w * cos)
        new_h = int(h * cos + w * sin)
        M[0, 2] += new_w / 2 - w / 2
        M[1, 2] += new_h / 2 - h / 2
        fill = 1.0 if self.is_negative else 0.0
        return cv2.warpAffine(img_cpu, M, (new_w, new_h), flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_CONSTANT,
                              borderValue=(fill, fill, fill))

    def get_rotated_original_cpu(self):
        """The raw original with the current straighten angle applied.
        Crop coordinates arrive in this (displayed) space."""
        angle = float(self.params.get('straighten') or 0.0)
        return self._rotate_cpu(self.original_cpu, angle)

    def _initialize_cache(self):
        """Build the 'initial' image: float32 [0,1], straightened, inverted
        if negative, with optional film base correction applied."""
        logger.info(f"Initializing cache. Is negative: {self.is_negative}, "
                    f"shape: {self.original.shape}, dtype: {self.original.dtype}")

        xp = cp if GPU_AVAILABLE else np
        self._proxy = None  # source changed; any proxy is stale

        angle = float(self.params.get('straighten') or 0.0)
        if angle != 0:
            rotated = self.get_rotated_original_cpu()
            img = cp.asarray(rotated) if GPU_AVAILABLE else rotated
            logger.info(f"Applied straighten: {angle:.1f} deg -> {img.shape[1]}x{img.shape[0]}")
        else:
            img = self.original
        if img.ndim == 2:
            img = xp.stack([img] * 3, axis=-1)

        # Input is float32 [0,1] from upload; just enforce range/type
        img = xp.clip(img, 0.0, 1.0).astype(xp.float32)

        if self.is_negative:
            img = 1.0 - img
            logger.info("Inverted negative")

        # Film base removal (analyze the raw negative for its base color)
        if self.is_negative and self.params.get('film_correction', 0.0) > 0:
            strength = self.params['film_correction']
            base = self._detect_film_base_color()
            if base is not None:
                # base is numpy; convert so CuPy accepts the subtraction
                correction = (xp.asarray(base, dtype=xp.float32) / 255.0).reshape(1, 1, 3)
                img = img - correction * strength
                logger.info(f"Applied film base correction: strength={strength:.2f}")

        self.cached_stages['initial'] = xp.clip(img, 0.0, 1.0).astype(xp.float32)

    def _detect_film_base_color(self):
        """Detect film base color from the brightest 5% of the raw negative."""
        try:
            img = self.original_cpu
            if img.ndim == 2:
                img = np.stack([img] * 3, axis=-1)
            img_uint8 = (img * 255).astype(np.uint8) if img.dtype == np.float32 else img

            luminance = np.mean(img_uint8, axis=2)
            mask = luminance >= np.percentile(luminance, 95)
            if not np.any(mask):
                return None

            base = np.array([np.median(img_uint8[:, :, c][mask]) for c in range(3)])
            logger.info(f"Film base detected: R={base[0]:.1f}, G={base[1]:.1f}, B={base[2]:.1f}")
            return base
        except Exception as e:
            logger.error(f"Film base detection failed: {e}")
            return None

    def get_full_res(self):
        """Full-resolution source image (float32 [0,1], inverted if negative)."""
        return self.cached_stages['initial']

    def get_proxy(self):
        """Low-res copy of the source image for fast preview, built lazily."""
        if self._proxy is None:
            full = self.get_full_res()
            full_cpu = full.get() if hasattr(full, 'get') else full
            h, w = full_cpu.shape[:2]
            proxy_cpu = cv2.resize(full_cpu, (int(w * PROXY_SCALE), int(h * PROXY_SCALE)),
                                   interpolation=cv2.INTER_AREA)
            self._proxy = cp.asarray(proxy_cpu) if GPU_AVAILABLE else proxy_cpu
            logger.info(f"Created proxy: {w}x{h} -> {proxy_cpu.shape[1]}x{proxy_cpu.shape[0]}")
        return self._proxy

    # ------------------------------------------------------------------
    # The adjustment pipeline (must stay in sync with the WebGL shader)
    # ------------------------------------------------------------------

    def apply_adjustments(self, img):
        """Apply all current parameters to a float32 [0,1] image.

        Returns a new float32 array clipped to [0,1]. Works on numpy or
        cupy arrays.
        """
        xp = cp if (GPU_AVAILABLE and hasattr(img, 'device')) else np
        p = self.params
        processed = img.copy()

        # 0. Levels (eyedropper black/white/gray points)
        processed = self._apply_levels_adjustment(processed)

        # 1. Exposure: multiply in linear light (true stops), soft shoulder
        #    above 0.9 rolls pushed highlights off instead of clipping
        if p['exposure'] != 0:
            lin = xp.power(xp.maximum(processed, 0.0), 2.2) * (2.0 ** p['exposure'])
            shoulder = 0.9 + 0.1 * (1.0 - xp.exp(-(lin - 0.9) / 0.1))
            processed = xp.power(xp.where(lin > 0.9, shoulder, lin), 1.0 / 2.2)

        # 2. Tone (shadows/highlights/whites/blacks/contrast/brightness):
        #    computed on luminance, applied as one ratio-preserving gain so
        #    hue and saturation survive. Each op keeps black and white pinned
        #    unless its job is to move that endpoint. Matches applyTone in
        #    the shader.
        tone_keys = ('shadows', 'highlights', 'whites', 'blacks', 'contrast', 'brightness')
        if any(p[k] != 0 for k in tone_keys):
            lum = xp.clip(0.299 * processed[:, :, 0] + 0.587 * processed[:, :, 1]
                          + 0.114 * processed[:, :, 2], 0.0, 1.0)
            nl = lum

            # Shadows: multiplicative lift/dip weighted toward dark tones
            # (slider is +/-0.5, doubled internally for useful strength)
            if p['shadows'] != 0:
                nl = nl * xp.exp((p['shadows'] * 2.0) * (1.0 - nl) ** 2)

            # Highlights: compress/expand the top end, black stays put
            if p['highlights'] != 0:
                nl = 1.0 - (1.0 - nl) * xp.exp(-(p['highlights'] * 2.0) * nl * nl)

            # Whites: white point. Up = soft-knee stretch, down = scale back
            if p['whites'] > 0:
                nl = _soft_knee(xp, nl, 1.0 / (1.0 - 0.25 * p['whites']))
            elif p['whites'] < 0:
                nl = nl * (1.0 + 0.25 * p['whites'])

            # Blacks: black point. Down = soft toe, up = darkest-tone lift
            if p['blacks'] > 0:
                nl = nl * xp.exp(p['blacks'] * (1.0 - nl) ** 6)
            elif p['blacks'] < 0:
                nl = 1.0 - _soft_knee(xp, 1.0 - nl, 1.0 / (1.0 + 0.25 * p['blacks']))

            # Contrast: up = endpoint-pinned S-curve, down = linear flatten
            if p['contrast'] > 0:
                s_curve = nl * nl * (3.0 - 2.0 * nl)
                nl = nl + (s_curve - nl) * min(2.0 * p['contrast'], 1.0)
            elif p['contrast'] < 0:
                nl = 0.5 + (nl - 0.5) * (1.0 + p['contrast'])

            # Brightness: midtone gamma, endpoints pinned
            if p['brightness'] != 0:
                nl = xp.power(xp.maximum(nl, 0.0), 2.0 ** (-p['brightness']))

            gain = xp.maximum(nl, 0.0) / xp.maximum(lum, 1e-4)
            processed = processed * gain[:, :, None]

        # 3. Temperature and tint
        if p['temperature'] != 0:
            processed[:, :, 0] += p['temperature'] * 0.05
            processed[:, :, 2] -= p['temperature'] * 0.05
        if p['tint'] != 0:
            processed[:, :, 1] += p['tint'] * 0.05

        # 4. Per-channel RGB offsets
        for c, name in enumerate(('red', 'green', 'blue')):
            if p[name] != 0:
                processed[:, :, c] += p[name]

        # 5. Saturation: mix(gray, color, 1 + saturation)
        if p['saturation'] != 0:
            gray = (0.299 * processed[:, :, 0] + 0.587 * processed[:, :, 1]
                    + 0.114 * processed[:, :, 2])
            processed = gray[:, :, None] + (processed - gray[:, :, None]) * (1.0 + p['saturation'])

        # 6. Custom curves last
        processed = self._apply_curves(processed)

        return xp.clip(processed, 0.0, 1.0)

    def get_processed_image(self, use_proxy=False):
        """Apply all adjustments and return an 8-bit numpy RGB image."""
        try:
            source = self.get_proxy() if use_proxy else self.get_full_res()
            processed = self.apply_adjustments(source)
            processed = (processed * 255).astype('uint8')
            if hasattr(processed, 'get'):
                processed = processed.get()  # CuPy -> NumPy
            return processed
        except Exception as e:
            logger.error(f"Error processing image: {e}")
            fallback = self.cached_stages.get('initial')
            if fallback is None:
                return np.full((100, 100, 3), 128, dtype=np.uint8)
            if hasattr(fallback, 'get'):
                fallback = fallback.get()
            return (np.clip(fallback, 0, 1) * 255).astype(np.uint8)

    def _apply_levels_adjustment(self, img):
        """Eyedropper levels, matching the shader's applyLevels exactly:
        black point, then white point, then gray point, then clamp."""
        xp = cp if (GPU_AVAILABLE and hasattr(img, 'device')) else np
        p = self.params

        has_black = all(p[f'black_point_{c}'] is not None for c in 'rgb')
        has_white = all(p[f'white_point_{c}'] is not None for c in 'rgb')
        has_gray = all(p[f'gray_point_{c}'] is not None for c in 'rgb')
        if not (has_black or has_white or has_gray):
            return img

        result = img

        if has_black:
            black = xp.asarray([p['black_point_r'], p['black_point_g'],
                                p['black_point_b']], dtype=xp.float32) / 255.0
            result = (result - black) / xp.maximum(1.0 - black, 1e-6)
            result = xp.maximum(result, 0.0)

        if has_white:
            white = xp.asarray([p['white_point_r'], p['white_point_g'],
                                p['white_point_b']], dtype=xp.float32) / 255.0
            result = result / xp.maximum(white, 1e-6)
            result = xp.minimum(result, 1.0)

        if has_gray:
            gray = xp.asarray([p['gray_point_r'], p['gray_point_g'],
                               p['gray_point_b']], dtype=xp.float32) / 255.0
            result = result * (gray.mean() / xp.maximum(gray, 1e-3))

        return xp.clip(result, 0.0, 1.0)

    # ------------------------------------------------------------------
    # Curves
    # ------------------------------------------------------------------

    @staticmethod
    def _is_linear_curve(points):
        return (len(points) == 2
                and abs(points[0]['x']) < 0.01 and abs(points[0]['y']) < 0.01
                and abs(points[1]['x'] - 1.0) < 0.01 and abs(points[1]['y'] - 1.0) < 0.01)

    def _apply_curves(self, img):
        """Apply tone curves: RGB curve to all channels, then per-channel."""
        curves = self.params.get('curves')
        if curves is None:
            return img
        try:
            curves_data = json.loads(curves) if isinstance(curves, str) else curves
        except Exception as e:
            logger.error(f"Invalid curves data: {e}")
            return img

        result = img

        rgb_curve = curves_data.get('rgb')
        if rgb_curve and len(rgb_curve) >= 2 and not self._is_linear_curve(rgb_curve):
            lut = self._build_curve_lut(rgb_curve)
            for c in range(3):
                result[:, :, c] = self._apply_lut(result[:, :, c], lut)

        for idx, name in enumerate(('red', 'green', 'blue')):
            curve = curves_data.get(name)
            if curve and len(curve) >= 2 and not self._is_linear_curve(curve):
                lut = self._build_curve_lut(curve)
                result[:, :, idx] = self._apply_lut(result[:, :, idx], lut)

        return result

    @staticmethod
    def _build_curve_lut(curve_points):
        """256-entry LUT from control points via monotone cubic interpolation
        (Fritsch-Carlson). Same algorithm as buildMonotoneCubicSpline in the
        frontend, so the drawn curve, the GPU preview, and the export agree."""
        points = sorted(curve_points, key=lambda pt: pt['x'])
        n = len(points)
        if n < 2:
            return np.linspace(0, 1, 256, dtype=np.float32)

        xs = np.array([pt['x'] for pt in points], dtype=np.float32)
        ys = np.array([pt['y'] for pt in points], dtype=np.float32)

        dxs = xs[1:] - xs[:-1]
        ms = (ys[1:] - ys[:-1]) / dxs  # secant slopes

        # Tangents at each point
        c1s = np.zeros(n, dtype=np.float32)
        c1s[0] = ms[0]
        c1s[-1] = ms[-1]
        for i in range(1, n - 1):
            m_left, m_right = ms[i - 1], ms[i]
            if m_left * m_right <= 0:
                c1s[i] = 0.0
            else:
                common = dxs[i - 1] + dxs[i]
                c1s[i] = 3.0 * common / ((common + dxs[i]) / m_left
                                         + (common + dxs[i - 1]) / m_right)

        # Monotonicity constraints
        for i in range(n - 1):
            if abs(ms[i]) < 1e-10:
                c1s[i] = 0.0
                c1s[i + 1] = 0.0
            else:
                alpha = c1s[i] / ms[i]
                beta = c1s[i + 1] / ms[i]
                if alpha * alpha + beta * beta > 9.0:
                    tau = 3.0 / np.sqrt(alpha * alpha + beta * beta)
                    c1s[i] = tau * alpha * ms[i]
                    c1s[i + 1] = tau * beta * ms[i]

        # Cubic coefficients per segment
        c2s = np.zeros(n - 1, dtype=np.float32)
        c3s = np.zeros(n - 1, dtype=np.float32)
        for i in range(n - 1):
            inv_dx = 1.0 / dxs[i]
            common = c1s[i] + c1s[i + 1] - 2.0 * ms[i]
            c2s[i] = (ms[i] - c1s[i] - common) * inv_dx
            c3s[i] = common * inv_dx * inv_dx

        lut = np.zeros(256, dtype=np.float32)
        for idx in range(256):
            x = idx / 255.0
            if x <= xs[0]:
                lut[idx] = ys[0]
            elif x >= xs[-1]:
                lut[idx] = ys[-1]
            else:
                i = min(max(int(np.searchsorted(xs, x, side='right')) - 1, 0), n - 2)
                dx = x - xs[i]
                lut[idx] = ys[i] + dx * (c1s[i] + dx * (c2s[i] + dx * c3s[i]))

        return np.clip(lut, 0.0, 1.0)

    @staticmethod
    def _apply_lut(channel, lut):
        """Apply a 256-entry LUT to one channel (numpy or cupy)."""
        if GPU_AVAILABLE and hasattr(channel, 'device'):
            lut_gpu = cp.asarray(lut, dtype=cp.float32)
            indices = cp.clip((channel * 255.0).astype(cp.int32), 0, 255)
            return lut_gpu[indices]
        indices = np.clip((channel * 255.0).astype(np.int32), 0, 255)
        return lut[indices]

    # ------------------------------------------------------------------
    # Parameters
    # ------------------------------------------------------------------

    def update_params(self, **kwargs):
        """Update known parameters; rebuild the cached source image when a
        baked-in parameter (film correction, straighten) changed."""
        old_baked = (self.params.get('film_correction', 0.0),
                     self.params.get('straighten', 0.0))

        for key, value in kwargs.items():
            if key in DEFAULT_PARAMS:
                self.params[key] = value

        new_baked = (self.params.get('film_correction', 0.0),
                     self.params.get('straighten', 0.0))
        if new_baked != old_baked:
            logger.info("Baked source params changed, regenerating cache")
            self._initialize_cache()
