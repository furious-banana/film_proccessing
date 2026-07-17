"""Flask server for the film processor.

Serves the UI, hands the browser raw float32 pixels for WebGL preview, and
re-applies the same adjustment pipeline server-side for CPU-fallback preview
(/process) and full-quality 16-bit TIFF export (/export). All pixel math
lives in film_processing.FilmProcessor.
"""

import base64
import io
import json
import logging
import os
import sys
import time

import cv2
import numpy as np
import tifffile
from flask import Flask, Response, jsonify, render_template, request, send_file
from PIL import Image, ImageCms

# Allow running both as `python src/app.py` and as a package
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from film_processing import DEFAULT_PARAMS, FilmProcessor

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

template_dir = os.path.join(os.path.dirname(current_dir), 'templates')
static_dir = os.path.join(os.path.dirname(current_dir), 'static')
app = Flask(__name__, template_folder=template_dir, static_folder=static_dir,
            static_url_path='/static')

processor = None

# Stack of pre-crop originals for undo
crop_undo_stack = []

# The preview served to the browser is capped to this size on the longest
# edge; crop coordinates arrive in that display space and are scaled back up.
MAX_DISPLAY_SIZE = 5000


def _params_from_request(params):
    """Translate a request body into a complete parameter dict.

    Every known parameter is set (absent ones reset to their neutral
    default), so requests are stateless and the processor can't be left
    with stale values from a previous request.
    """
    updates = {}
    for key, default in DEFAULT_PARAMS.items():
        if key == 'curves' or key.endswith(('_r', '_g', '_b')):
            updates[key] = params.get(key, default)
        else:
            value = params.get(key, default)
            updates[key] = float(value) if value is not None else default
    return updates


def _png_base64(img_uint8, compress_level=6):
    buf = io.BytesIO()
    Image.fromarray(img_uint8).save(buf, format='PNG', compress_level=compress_level)
    return base64.b64encode(buf.getvalue()).decode()


@app.after_request
def no_cache(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    return response


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/version')
def version():
    candidates = [
        os.path.join(os.path.dirname(current_dir), 'package.json'),
        os.path.join(os.getcwd(), 'package.json'),
    ]
    for pkg_json in candidates:
        try:
            with open(pkg_json, encoding='utf-8-sig') as f:
                v = json.load(f).get('version')
                if v:
                    return jsonify(version=v)
        except Exception:
            continue
    return jsonify(version='unknown')


@app.route('/get_raw_image', methods=['GET'])
def get_raw_image():
    """Serve raw float32 image data for WebGL client-side processing."""
    try:
        if processor is None:
            return jsonify({'error': 'No image loaded'}), 404

        img = processor.get_full_res()
        img_cpu = img.get() if hasattr(img, 'get') else img

        # Downsample for display performance; export still uses full res
        h, w, c = img_cpu.shape
        if max(h, w) > MAX_DISPLAY_SIZE:
            scale = MAX_DISPLAY_SIZE / max(h, w)
            new_w, new_h = int(w * scale), int(h * scale)
            logger.info(f"Downsampling for display: {w}x{h} -> {new_w}x{new_h}")
            img_cpu = cv2.resize(img_cpu, (new_w, new_h), interpolation=cv2.INTER_AREA)
            h, w = new_h, new_w

        img_bytes = np.ascontiguousarray(img_cpu, dtype=np.float32).tobytes()

        response = Response(img_bytes, mimetype='application/octet-stream')
        response.headers['X-Image-Width'] = str(w)
        response.headers['X-Image-Height'] = str(h)
        response.headers['X-Image-Channels'] = str(c)
        response.headers['X-Image-Type'] = 'float32'
        response.headers['Access-Control-Expose-Headers'] = \
            'X-Image-Width,X-Image-Height,X-Image-Channels,X-Image-Type'
        logger.info(f"Serving raw image data: {w}x{h}x{c} float32 = {len(img_bytes)} bytes")
        return response

    except Exception as e:
        logger.exception("Error serving raw image")
        return jsonify({'error': str(e)}), 500


@app.route('/process', methods=['POST'])
@app.route('/adjust', methods=['POST'])
def process_image():
    """CPU-fallback preview: apply adjustments server-side, return a PNG."""
    try:
        if processor is None:
            return jsonify({'error': 'No image loaded', 'success': False})

        params = request.json or {}
        use_proxy = bool(params.get('use_proxy', False))

        processor.update_params(**_params_from_request(params))

        # WebGL clients only need the server-side params updated (e.g. film
        # base correction, which is baked into the raw image they reload);
        # skip the expensive render + PNG encode.
        if params.get('webgl'):
            return jsonify({'success': True})

        img = processor.get_processed_image(use_proxy=use_proxy)

        return jsonify({'image': _png_base64(img), 'success': True})

    except Exception as e:
        logger.exception("Error processing image")
        return jsonify({'error': str(e), 'success': False})


@app.route('/crop', methods=['POST'])
def crop_image():
    """Crop the raw original (non-destructive: adjustments re-apply after)."""
    try:
        if processor is None or processor.original_image is None:
            return jsonify({'error': 'No image loaded', 'success': False})

        data = request.json or {}
        x = int(data.get('x', 0))
        y = int(data.get('y', 0))
        width = int(data.get('width', 100))
        height = int(data.get('height', 100))

        # Crop in the space the user sees: the straightened original. The
        # fine rotation is baked into the cropped result, and the straighten
        # parameter resets to 0 (the response tells the frontend).
        straighten = float(processor.params.get('straighten') or 0.0)
        img = processor.get_rotated_original_cpu()
        img_height, img_width = img.shape[:2]

        # The frontend computes crop coordinates in the (possibly downsampled)
        # display space served by /get_raw_image; scale back to full res.
        if max(img_height, img_width) > MAX_DISPLAY_SIZE:
            scale = MAX_DISPLAY_SIZE / max(img_height, img_width)
            display_w = int(img_width * scale)
            display_h = int(img_height * scale)
            x = int(x * img_width / display_w)
            y = int(y * img_height / display_h)
            width = int(width * img_width / display_w)
            height = int(height * img_height / display_h)

        # Clamp to image bounds
        x = max(0, min(x, img_width - 1))
        y = max(0, min(y, img_height - 1))
        width = min(width, img_width - x)
        height = min(height, img_height - y)

        crop_undo_stack.append((processor.original_cpu, straighten))
        processor.params['straighten'] = 0.0  # now baked into the crop
        processor.set_original(img[y:y + height, x:x + width].copy())

        # WebGL clients reload the texture from /get_raw_image instead
        if data.get('webgl'):
            return jsonify({'success': True})

        return jsonify({
            'image': _png_base64(processor.get_processed_image(), compress_level=1),
            'success': True
        })
    except Exception as e:
        logger.exception("Error cropping image")
        return jsonify({'error': str(e), 'success': False})


@app.route('/undo_crop', methods=['POST'])
def undo_crop():
    """Restore the image to its pre-crop state."""
    try:
        if not crop_undo_stack:
            return jsonify({'error': 'No crop to undo', 'success': False})

        restored, straighten = crop_undo_stack.pop()
        processor.params['straighten'] = straighten
        processor.set_original(restored)
        undo_available = len(crop_undo_stack) > 0

        data = request.json or {}
        if data.get('webgl'):
            return jsonify({'success': True, 'undoAvailable': undo_available,
                            'straighten': straighten})

        return jsonify({
            'image': _png_base64(processor.get_processed_image(), compress_level=1),
            'success': True,
            'undoAvailable': undo_available,
            'straighten': straighten
        })
    except Exception as e:
        logger.exception("Error undoing crop")
        return jsonify({'error': str(e), 'success': False})


@app.route('/auto_grade', methods=['POST'])
def auto_grade():
    """Fit an automatic film-scan correction (levels + density balance +
    S-curve) from the current image. Returns the fitted params without
    applying them; the client sets its controls and re-renders."""
    try:
        if processor is None:
            return jsonify({'error': 'No image loaded', 'success': False})
        return jsonify({'success': True, 'params': processor.auto_grade()})
    except Exception as e:
        logger.exception("Error fitting auto grade")
        return jsonify({'error': str(e), 'success': False})


@app.route('/export', methods=['POST'])
def export_image():
    """Export the processed image as a full-resolution 16-bit TIFF.

    Uses the exact same pipeline as the preview, on the full-resolution
    source (inverted if negative, cropped if cropped), so the export
    always matches what's on screen.
    """
    try:
        if processor is None:
            return jsonify({'error': 'No image loaded'}), 404

        params = request.json or {}
        rotation = int(params.get('rotation', 0) or 0)

        processor.update_params(**_params_from_request(params))

        processed = processor.apply_adjustments(processor.get_full_res())
        if hasattr(processed, 'get'):
            processed = processed.get()  # CuPy -> NumPy

        # Match the on-screen CSS rotation (positive = clockwise)
        quarter_turns = (((rotation % 360) + 360) % 360) // 90
        if quarter_turns:
            processed = np.rot90(processed, k=(4 - quarter_turns) % 4)

        img_uint16 = np.rint(np.clip(processed, 0.0, 1.0) * 65535).astype(np.uint16)

        output = io.BytesIO()
        # Untagged (the data is sRGB); embedding the source profile would
        # make viewers misinterpret it.
        tifffile.imwrite(output, np.ascontiguousarray(img_uint16),
                         photometric='rgb', compression=None)
        size = output.tell()
        output.seek(0)
        logger.info(f"Exported 16-bit TIFF: {img_uint16.shape}, {size} bytes")

        return send_file(
            output,
            mimetype='image/tiff',
            as_attachment=True,
            download_name=f'processed_{int(time.time())}.tif'
        )

    except Exception as e:
        logger.exception("Export error")
        return jsonify({'error': str(e)}), 500


def _convert_adobe_rgb_to_srgb(img_uint16):
    """Adobe RGB -> sRGB matrix conversion on uint16 data."""
    matrix = np.array([
        [1.39822014, -0.39830039, -0.00006393],
        [0.00010625,  0.99991441,  0.00000183],
        [0.00003334, -0.04293803,  1.04296793],
    ], dtype=np.float32)

    img_float = img_uint16.astype(np.float32) / 65535.0
    h, w = img_float.shape[:2]
    img_float = (img_float.reshape(-1, 3) @ matrix.T).reshape(h, w, 3)
    img_float = np.clip(img_float, 0.0, 1.0)
    return (img_float * 65535).astype(np.uint16)


def _load_image(image_bytes):
    """Decode uploaded bytes to a float32 [0,1] RGB array (full resolution)."""
    pil_image = Image.open(io.BytesIO(image_bytes))
    original_format = pil_image.format
    icc_profile = pil_image.info.get('icc_profile')
    logger.info(f"Original format: {original_format}, size: {pil_image.size}, "
                f"mode: {pil_image.mode}")

    if original_format == 'TIFF':
        # tifffile keeps 16-bit depth (PIL/imageio downconvert to 8-bit)
        img_array = tifffile.imread(io.BytesIO(image_bytes))
        logger.info(f"Loaded with tifffile: shape={img_array.shape}, "
                    f"dtype={img_array.dtype}")

        if icc_profile:
            try:
                profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
                profile_name = ImageCms.getProfileName(profile).lower()
                logger.info(f"Detected ICC profile: {profile_name.strip()}")
                if 'adobe' in profile_name and 'rgb' in profile_name \
                        and img_array.dtype == np.uint16:
                    img_array = _convert_adobe_rgb_to_srgb(img_array)
                    logger.info("Converted Adobe RGB -> sRGB")
            except Exception:
                logger.warning("Color profile reading failed, using raw data",
                               exc_info=True)
    else:
        img_array = np.array(pil_image)
        logger.info(f"Loaded with PIL: shape={img_array.shape}, dtype={img_array.dtype}")

    # Normalize to float32 [0,1]
    if img_array.dtype == np.uint16:
        img_array = img_array.astype(np.float32) / 65535.0
    elif img_array.dtype == np.uint8:
        img_array = img_array.astype(np.float32) / 255.0
    else:
        img_array = img_array.astype(np.float32)
        if img_array.max() > 1.0:
            img_array = img_array / img_array.max()

    # Ensure 3-channel RGB
    if img_array.ndim == 2:
        img_array = np.stack([img_array] * 3, axis=-1)
    elif img_array.ndim == 3:
        if img_array.shape[2] == 1:
            img_array = np.concatenate([img_array] * 3, axis=2)
        elif img_array.shape[2] != 3:
            img_array = img_array[:, :, :3]  # e.g. drop alpha

    logger.info(f"Normalized RGB array: shape={img_array.shape}, "
                f"range=[{img_array.min():.4f}, {img_array.max():.4f}]")
    return img_array


@app.route('/upload', methods=['POST'])
def upload_file():
    try:
        global processor
        crop_undo_stack.clear()

        file = request.files.get('image')
        if not file:
            return jsonify({'error': 'No file uploaded', 'success': False})

        if not file.filename.lower().endswith(('.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp')):
            return jsonify({'error': 'Invalid file type. Please upload an image file.',
                            'success': False})

        is_negative = request.form.get('is_negative', 'true').lower() == 'true'

        img_array = _load_image(file.read())
        processor = FilmProcessor(img_array, is_negative=is_negative)

        return jsonify({
            'image': _png_base64(processor.get_processed_image()),
            'success': True
        })

    except Exception as e:
        logger.exception("Error uploading file")
        return jsonify({'error': f"Failed to process image: {str(e)}", 'success': False})


if __name__ == '__main__':
    # No reloader: this entrypoint is spawned by Electron, and the reloader's
    # child process would survive Electron's kill and keep port 5000 busy.
    app.run(debug=True, use_reloader=False)
