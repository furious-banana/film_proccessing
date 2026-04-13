import logging
from PIL import Image
import numpy as np
import cv2

# GPU acceleration with CuPy (100x+ speedup)
try:
    import cupy as cp
    GPU_AVAILABLE = True
    # Create a non-default stream for async operations
    GPU_STREAM = cp.cuda.Stream(non_blocking=True)
    logger = logging.getLogger('FilmProcessor')
    logger.info(f"✓ GPU acceleration enabled with CuPy {cp.__version__} (async stream)")
except Exception as e:
    import numpy as cp
    GPU_AVAILABLE = False
    GPU_STREAM = None
    logger = logging.getLogger('FilmProcessor')
    logger.warning(f"⚠ GPU unavailable ({e}), using CPU")

logging.basicConfig(level=logging.INFO)

class FilmProcessor:
    def __init__(self, image_array, is_negative=True):
        # Store original on CPU for pixel sampling
        self.original_cpu = image_array
        self.original_image = image_array  # Keep for pixel sampling
        
        # Transfer to GPU if available
        if GPU_AVAILABLE:
            self.original = cp.asarray(image_array)
            logger.info(f"Transferred {image_array.shape} image to GPU")
        else:
            self.original = image_array
        
        self.is_negative = is_negative
        self.params = {
            'exposure': 0.0,  # Exposure in stops: -3 to +3
            'contrast': 0.0,  # Contrast: -100 to +100
            'highlights': 0.0,  # Highlights: -100 to +100
            'shadows': 0.0,  # Shadows: -100 to +100
            'whites': 0.0,  # Whites: -100 to +100
            'blacks': 0.0,  # Blacks: -100 to +100
            'film_correction': 0.0,  # Film base correction for negatives: 0 to 1
            # Eyedropper points
            'black_point_r': None,
            'black_point_g': None,
            'black_point_b': None,
            'white_point_r': None,
            'white_point_g': None,
            'white_point_b': None,
            'gray_point_r': None,
            'gray_point_g': None,
            'gray_point_b': None,
            # Curves
            'curves': None,
        }
        self.cached_stages = {}
        self._initialize_cache()
    
    def _initialize_cache(self):
        """Initialize the processing cache with inverted image (if negative)"""
        try:
            logger.info(f"Initializing cache. Is negative: {self.is_negative}")
            logger.info(f"Original image shape: {self.original.shape}, dtype: {self.original.dtype}")
            
            # Use CuPy (cp) or NumPy (np) depending on GPU availability
            xp = cp if GPU_AVAILABLE else np
            
            # Ensure 3-channel RGB
            if len(self.original.shape) == 2:
                img = xp.stack([self.original] * 3, axis=-1)
            else:
                img = self.original
            
            # Input is already float32 [0.0, 1.0] from upload
            # No need to convert - just ensure it's in valid range
            img = xp.clip(img, 0.0, 1.0).astype(xp.float32)
            
            # Invert for negatives, keep as-is for regular photos
            if self.is_negative:
                inverted = 1.0 - img  # Invert in float space
                logger.info("Inverted negative (float32)" + (" [GPU]" if GPU_AVAILABLE else ""))
            else:
                inverted = img.copy()
                logger.info("Regular photo - no inversion" + (" [GPU]" if GPU_AVAILABLE else ""))
            
            self.cached_stages['inverted'] = inverted
            
            # Already in float32 [0.0, 1.0] - ready for processing
            img_float = inverted
            
            # Apply film base correction if it's a negative
            if self.is_negative:
                # Note: _analyze_negative_characteristics expects uint8, need to convert temporarily
                # Use CPU version for analysis
                temp_cpu = cp.asnumpy(self.original) if GPU_AVAILABLE else self.original
                temp_uint8 = (temp_cpu * 255).astype(np.uint8) if temp_cpu.dtype == np.float32 else temp_cpu
                neg_analysis = self._analyze_negative_characteristics(temp_uint8)
                if neg_analysis and isinstance(neg_analysis, dict):
                    film_base_color = neg_analysis.get('film_base_color', np.zeros(3))
                    correction_strength = self.params.get('film_correction', 0.0)
                    
                    if correction_strength > 0:
                        film_base_color_norm = film_base_color / 255.0
                        for c in range(3):
                            img_float[:, :, c] -= film_base_color_norm[c] * correction_strength
                        logger.info(f"Applied film base correction: strength={correction_strength:.2f}")
            
            # Store final processed version in float32 [0.0, 1.0]
            self.cached_stages['initial'] = xp.clip(img_float, 0.0, 1.0).astype(xp.float32)
            
        except Exception as e:
            logger.error(f"Cache initialization failed: {str(e)}")
            # Fallback
            if self.is_negative:
                inverted = 255 - self.original if len(self.original.shape) == 3 else np.stack([255 - self.original] * 3, axis=-1)
            else:
                inverted = self.original if len(self.original.shape) == 3 else np.stack([self.original] * 3, axis=-1)
            self.cached_stages['inverted'] = inverted
            self.cached_stages['initial'] = inverted
    
    def _analyze_negative_characteristics(self, negative_img):
        """Analyze film negative to detect film base color"""
        try:
            # Find brightest pixels (unexposed film areas)
            if len(negative_img.shape) == 2:
                negative_img = np.stack([negative_img] * 3, axis=-1)
            
            luminance = np.mean(negative_img, axis=2)
            threshold = np.percentile(luminance, 95)
            mask = luminance >= threshold
            
            if np.sum(mask) > 0:
                film_base_color = np.array([
                    np.median(negative_img[:, :, 0][mask]),
                    np.median(negative_img[:, :, 1][mask]),
                    np.median(negative_img[:, :, 2][mask])
                ])
                logger.info(f"Film base detected: R={film_base_color[0]:.1f}, G={film_base_color[1]:.1f}, B={film_base_color[2]:.1f}")
                return {'film_base_color': film_base_color}
            
            return {'film_base_color': np.zeros(3)}
        except Exception as e:
            logger.error(f"Error in film base detection: {str(e)}")
            return {'film_base_color': np.zeros(3)}
    
    def get_processed_image(self):
        """Apply all adjustments and return the result"""
        try:
            # Get base image (already in float32 [0.0, 1.0] range)
            processed = self.cached_stages.get('initial', self.cached_stages.get('inverted'))
            
            if processed is None:
                logger.error("No cached image found")
                return np.ones((100, 100, 3), dtype=np.uint8) * 128
            
            # Use appropriate array library (CuPy or NumPy)
            xp = cp if GPU_AVAILABLE else np
            
            # Already in float [0, 1] - no conversion needed
            # (Preserves 16-bit precision as float32)
            
            # Apply eyedropper levels adjustment FIRST (before other tone adjustments)
            processed = self._apply_levels_adjustment(processed)
            
            # Apply exposure (photographic stops)
            if self.params['exposure'] != 0:
                processed *= 2 ** self.params['exposure']
                logger.info(f"Applied exposure: {self.params['exposure']:.2f} stops")
            
            # Apply contrast (linear gain around midpoint)
            if self.params['contrast'] != 0:
                # Convert contrast from -100/+100 to multiplier (0.5 to 2.0)
                contrast_factor = 1.0 + (self.params['contrast'] / 100.0)
                # Apply around 0.5 midpoint
                processed = (processed - 0.5) * contrast_factor + 0.5
                logger.info(f"Applied contrast: {self.params['contrast']:.1f}")
            
            # Calculate luminance for tone-based adjustments
            luminance = 0.299 * processed[:, :, 0] + 0.587 * processed[:, :, 1] + 0.114 * processed[:, :, 2]
            
            # Apply highlights (affects bright areas)
            if self.params['highlights'] != 0:
                # Create mask for highlights (bright areas)
                highlight_mask = xp.power(luminance, 4)  # Strong falloff for highlights only
                adjustment = self.params['highlights'] / 50.0  # Increase sensitivity
                for c in range(3):
                    processed[:, :, c] += highlight_mask * adjustment
                logger.info(f"Applied highlights: {self.params['highlights']:.1f}")
            
            # Apply shadows (affects dark areas)
            if self.params['shadows'] != 0:
                # Create mask for shadows (dark areas)
                shadow_mask = xp.power(1.0 - luminance, 4)  # Strong falloff for shadows only
                adjustment = self.params['shadows'] / 50.0  # Increase sensitivity
                for c in range(3):
                    processed[:, :, c] += shadow_mask * adjustment
                logger.info(f"Applied shadows: {self.params['shadows']:.1f}")
            
            # Apply whites (shifts white point)
            if self.params['whites'] != 0:
                # Compress/expand the bright end of the range
                white_adjust = self.params['whites'] / 100.0
                # Apply S-curve to whites
                mask = xp.power(luminance, 3)
                for c in range(3):
                    processed[:, :, c] += mask * white_adjust
                logger.info(f"Applied whites: {self.params['whites']:.1f}")
            
            # Apply blacks (shifts black point)
            if self.params['blacks'] != 0:
                # Compress/expand the dark end of the range
                black_adjust = self.params['blacks'] / 100.0
                # Apply S-curve to blacks
                mask = xp.power(1.0 - luminance, 3)
                for c in range(3):
                    processed[:, :, c] += mask * black_adjust
                logger.info(f"Applied blacks: {self.params['blacks']:.1f}")
            
            # Apply RGB adjustments (independent channel shifts)
            if self.params.get('red', 0) != 0:
                processed[:, :, 0] += self.params['red']
                logger.info(f"Applied red: {self.params['red']:.2f}")
            if self.params.get('green', 0) != 0:
                processed[:, :, 1] += self.params['green']
                logger.info(f"Applied green: {self.params['green']:.2f}")
            if self.params.get('blue', 0) != 0:
                processed[:, :, 2] += self.params['blue']
                logger.info(f"Applied blue: {self.params['blue']:.2f}")
            
            # Apply tone curves LAST (after all tone adjustments)
            processed = self._apply_curves(processed)
            
            # Use appropriate array library
            xp = cp if GPU_AVAILABLE else np
            
            # Clip to valid range and convert to 8-bit
            # Data is already gamma-encoded (sRGB), matching Photoshop's 16-bit behavior
            processed = xp.clip(processed, 0.0, 1.0)
            processed = (processed * 255).astype(xp.uint8)
            
            # Transfer from GPU to CPU using pinned memory for maximum speed
            if GPU_AVAILABLE:
                # Use cupy's built-in async transfer (handles pinning internally)
                processed_cpu_array = cp.asnumpy(processed)
                logger.info("Transferred result from GPU to CPU (pinned memory)")
            else:
                processed_cpu_array = processed
            
            return processed_cpu_array
            
        except Exception as e:
            logger.error(f"Error processing image: {str(e)}")
            fallback = self.cached_stages.get('initial', self.cached_stages.get('inverted'))
            if fallback is None:
                return np.ones((100, 100, 3), dtype=np.uint8) * 128
            return fallback
    
    def _apply_levels_adjustment(self, img):
        """Apply black/white/gray point adjustments per channel"""
        try:
            # Check if any eyedropper points are set
            has_black = all(self.params[f'black_point_{c}'] is not None for c in ['r', 'g', 'b'])
            has_white = all(self.params[f'white_point_{c}'] is not None for c in ['r', 'g', 'b'])
            has_gray = all(self.params[f'gray_point_{c}'] is not None for c in ['r', 'g', 'b'])
            
            if not (has_black or has_white or has_gray):
                return img
            
            # Work with a copy
            result = img.copy()
            
            # Get points (convert from 0-255 to 0-1)
            black_pt = np.array([
                self.params['black_point_r'] / 255.0 if self.params['black_point_r'] is not None else 0.0,
                self.params['black_point_g'] / 255.0 if self.params['black_point_g'] is not None else 0.0,
                self.params['black_point_b'] / 255.0 if self.params['black_point_b'] is not None else 0.0
            ])
            
            white_pt = np.array([
                self.params['white_point_r'] / 255.0 if self.params['white_point_r'] is not None else 1.0,
                self.params['white_point_g'] / 255.0 if self.params['white_point_g'] is not None else 1.0,
                self.params['white_point_b'] / 255.0 if self.params['white_point_b'] is not None else 1.0
            ])
            
            gray_pt = np.array([
                self.params['gray_point_r'] / 255.0 if self.params['gray_point_r'] is not None else None,
                self.params['gray_point_g'] / 255.0 if self.params['gray_point_g'] is not None else None,
                self.params['gray_point_b'] / 255.0 if self.params['gray_point_b'] is not None else None
            ])
            
            # Apply gray point correction first (removes color casts)
            if has_gray:
                # Calculate the average of the gray point
                gray_avg = np.mean(gray_pt)
                if gray_avg > 0:
                    # Scale each channel so that gray point becomes neutral
                    for c in range(3):
                        if gray_pt[c] > 0:
                            result[:, :, c] *= (gray_avg / gray_pt[c])
                    logger.info(f"Applied gray point correction: {gray_pt}")
            
            # Apply black and white points (per-channel levels)
            if has_black or has_white:
                for c in range(3):
                    # Ensure white point is above black point
                    if white_pt[c] <= black_pt[c]:
                        white_pt[c] = black_pt[c] + 0.01
                    
                    # Apply levels formula: output = (input - black) * (1 / (white - black))
                    result[:, :, c] = (result[:, :, c] - black_pt[c]) * (1.0 / (white_pt[c] - black_pt[c]))
                
                logger.info(f"Applied levels: black={black_pt}, white={white_pt}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error in levels adjustment: {str(e)}")
            return img
    
    def _apply_curves(self, img):
        """Apply tone curves per channel"""
        try:
            if self.params.get('curves') is None:
                return img
            
            import json
            curves_data = json.loads(self.params['curves']) if isinstance(self.params['curves'], str) else self.params['curves']
            
            # Work with a copy
            result = img.copy()
            
            # Apply RGB curve (affects all channels equally)
            if 'rgb' in curves_data and len(curves_data['rgb']) >= 2:
                lut = self._build_curve_lut(curves_data['rgb'])
                for c in range(3):
                    result[:, :, c] = self._apply_lut(result[:, :, c], lut)
                logger.info("Applied RGB curve")
            
            # Apply per-channel curves
            channel_names = ['red', 'green', 'blue']
            for idx, channel_name in enumerate(channel_names):
                if channel_name in curves_data and len(curves_data[channel_name]) >= 2:
                    # Check if it's not a linear curve
                    curve = curves_data[channel_name]
                    is_linear = (len(curve) == 2 and 
                               abs(curve[0]['x'] - 0.0) < 0.01 and abs(curve[0]['y'] - 0.0) < 0.01 and
                               abs(curve[1]['x'] - 1.0) < 0.01 and abs(curve[1]['y'] - 1.0) < 0.01)
                    
                    if not is_linear:
                        lut = self._build_curve_lut(curve)
                        result[:, :, idx] = self._apply_lut(result[:, :, idx], lut)
                        logger.info(f"Applied {channel_name} curve")
            
            return result
            
        except Exception as e:
            logger.error(f"Error applying curves: {str(e)}")
            return img
    
    def _build_curve_lut(self, curve_points):
        """Build a lookup table from curve control points using monotone cubic interpolation"""
        # Sort points by x coordinate
        points = sorted(curve_points, key=lambda p: p['x'])
        
        n = len(points)
        if n < 2:
            return np.linspace(0, 1, 256, dtype=np.float32)
        
        xs = np.array([p['x'] for p in points], dtype=np.float32)
        ys = np.array([p['y'] for p in points], dtype=np.float32)
        
        # Monotone cubic Hermite spline (Fritsch-Carlson)
        # Compute slopes between consecutive points
        dxs = xs[1:] - xs[:-1]
        dys = ys[1:] - ys[:-1]
        ms = dys / dxs  # Secant slopes
        
        # Compute tangents at each point
        c1s = np.zeros(n, dtype=np.float32)
        c1s[0] = ms[0]  # First endpoint
        
        for i in range(1, n - 1):
            m_left = ms[i - 1]
            m_right = ms[i]
            
            # If secants have opposite signs or either is zero, use zero tangent
            if m_left * m_right <= 0:
                c1s[i] = 0.0
            else:
                # Weighted harmonic mean
                dx_left = dxs[i - 1]
                dx_right = dxs[i]
                common = dx_left + dx_right
                c1s[i] = 3.0 * common / ((common + dx_right) / m_left + (common + dx_left) / m_right)
        
        c1s[n - 1] = ms[-1]  # Last endpoint
        
        # Apply monotonicity constraints
        for i in range(n - 1):
            if abs(ms[i]) < 1e-10:
                c1s[i] = 0.0
                c1s[i + 1] = 0.0
            else:
                alpha = c1s[i] / ms[i]
                beta = c1s[i + 1] / ms[i]
                
                # Restrict to circle of radius 3
                if alpha * alpha + beta * beta > 9.0:
                    tau = 3.0 / np.sqrt(alpha * alpha + beta * beta)
                    c1s[i] = tau * alpha * ms[i]
                    c1s[i + 1] = tau * beta * ms[i]
        
        # Compute cubic coefficients for each segment
        c2s = np.zeros(n - 1, dtype=np.float32)
        c3s = np.zeros(n - 1, dtype=np.float32)
        
        for i in range(n - 1):
            inv_dx = 1.0 / dxs[i]
            common = c1s[i] + c1s[i + 1] - 2.0 * ms[i]
            c2s[i] = (ms[i] - c1s[i] - common) * inv_dx
            c3s[i] = common * inv_dx * inv_dx
        
        # Build lookup table
        lut = np.zeros(256, dtype=np.float32)
        
        for idx in range(256):
            x = idx / 255.0
            
            # Find segment
            if x <= xs[0]:
                lut[idx] = ys[0]
            elif x >= xs[-1]:
                lut[idx] = ys[-1]
            else:
                # Binary search for segment
                i = np.searchsorted(xs, x, side='right') - 1
                i = min(max(i, 0), n - 2)
                
                # Evaluate cubic polynomial
                dx = x - xs[i]
                lut[idx] = ys[i] + dx * (c1s[i] + dx * (c2s[i] + dx * c3s[i]))
        
        return lut
    
    def _apply_lut(self, channel, lut):
        """Apply a lookup table to a channel"""
        # Get the array module (numpy or cupy) based on the channel
        xp = cp if GPU_AVAILABLE and hasattr(channel, 'device') else np
        
        # Ensure LUT is on the same device as channel
        if GPU_AVAILABLE and hasattr(channel, 'device'):
            # Convert LUT to GPU
            lut_gpu = cp.asarray(lut, dtype=cp.float32)
            # Compute indices on GPU
            indices = cp.clip((channel * 255.0).astype(cp.int32), 0, 255)
            # Index the LUT on GPU
            return lut_gpu[indices]
        else:
            # CPU path
            indices = np.clip((channel * 255.0).astype(np.int32), 0, 255)
            return lut[indices]
    
    def update_params(self, **kwargs):
        """Update parameters and regenerate cache if needed"""
        # Check if film_correction changed
        film_correction_changed = 'film_correction' in kwargs and kwargs['film_correction'] != self.params.get('film_correction', 0.0)
        
        # Update parameters
        self.params.update(kwargs)
        logger.info(f"Updated params: {kwargs}")
        
        # Regenerate cache if film correction changed
        if film_correction_changed:
            logger.info("Film correction changed, regenerating cache")
            self._initialize_cache()
    
    def get_histogram(self):
        """Get histogram for display"""
        try:
            img = self.get_processed_image()
            histograms = {}
            for i, color in enumerate(['red', 'green', 'blue']):
                hist, _ = np.histogram(img[:, :, i], bins=256, range=(0, 256))
                histograms[color] = hist.tolist()
            return histograms
        except Exception as e:
            logger.error(f"Error generating histogram: {str(e)}")
            return {'red': [0]*256, 'green': [0]*256, 'blue': [0]*256}
