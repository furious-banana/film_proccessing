from flask import Flask, send_file, request, render_template, jsonify, Response
import sys
import os

# Add current directory to path for imports
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from film_processing import FilmProcessor
import numpy as np
from PIL import Image, ImageCms
import cv2
import io
import base64
import logging
import time
import tifffile  # Proper 16-bit TIFF support
import colour  # Professional color science for 16-bit color space conversion

# GPU acceleration support
try:
    import cupy as cp
    GPU_AVAILABLE = True
except ImportError:
    GPU_AVAILABLE = False

# Try to import AI correction (optional)
try:
    from ai_color_correction import AIColorCorrector
    AI_AVAILABLE = True
except ImportError:
    AI_AVAILABLE = False
    print("AI color correction not available - missing dependencies")

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configure Flask to look for templates and static in the parent directory
template_dir = os.path.join(os.path.dirname(current_dir), 'templates')
static_dir = os.path.join(os.path.dirname(current_dir), 'static')
app = Flask(__name__, template_folder=template_dir, static_folder=static_dir, static_url_path='/static')
processor = None

def _smoothstep(xp, edge0, edge1, x):
    """GLSL smoothstep equivalent for numpy/cupy arrays"""
    t = xp.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)

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
    import json
    # Try multiple locations for package.json
    candidates = [
        os.path.join(os.path.dirname(current_dir), 'package.json'),
        os.path.join(os.getcwd(), 'package.json'),
    ]
    for pkg_json in candidates:
        try:
            with open(pkg_json, encoding='utf-8-sig') as f:
                v = json.load(f).get('version', None)
                if v:
                    return jsonify(version=v)
        except Exception:
            continue
    return jsonify(version='unknown')

@app.route('/get_raw_image', methods=['GET'])
def get_raw_image():
    """Serve raw float32 image data for WebGL client-side processing"""
    try:
        global processor
        if processor is None:
            return jsonify({'error': 'No image loaded'}), 404
        
        # Get original image from cache
        img = processor.cached_stages['initial']
        
        # Transfer from GPU if needed
        if hasattr(img, 'get'):
            img_cpu = img.get()  # CuPy → NumPy
        else:
            img_cpu = img.copy()
        
        # Downsample for display (like Photoshop's adaptive quality)
        # Max 5000px on longest side for editing performance
        h, w, c = img_cpu.shape
        max_display_size = 5000
        
        if max(h, w) > max_display_size:
            scale = max_display_size / max(h, w)
            new_w = int(w * scale)
            new_h = int(h * scale)
            logger.info(f"Downsampling for display: {w}x{h} -> {new_w}x{new_h} ({scale:.1%})")
            # Use INTER_NEAREST for sharp pixels (no smoothing, like Photoshop)
            img_cpu = cv2.resize(img_cpu, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
            h, w = new_h, new_w
        
        # Image is already float32 [0.0, 1.0] sRGB gamma-encoded
        
        # Convert to bytes (float32 little-endian)
        img_bytes = img_cpu.tobytes()
        
        # Return raw data with metadata in headers
        response = Response(img_bytes, mimetype='application/octet-stream')
        response.headers['X-Image-Width'] = str(w)
        response.headers['X-Image-Height'] = str(h)
        response.headers['X-Image-Channels'] = str(c)
        response.headers['X-Image-Type'] = 'float32'
        response.headers['Access-Control-Expose-Headers'] = 'X-Image-Width,X-Image-Height,X-Image-Channels,X-Image-Type'
        
        logger.info(f"Serving raw image data: {w}x{h}x{c} float32 = {len(img_bytes)} bytes")
        return response
        
    except Exception as e:
        logger.error(f"Error serving raw image: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/process', methods=['POST'])
@app.route('/adjust', methods=['POST'])
def process_image():
    try:
        params = request.json
        global processor
        
        if processor is None:
            return jsonify({'error': 'No image loaded'})
        
        # PROXY RENDERING SYSTEM (like Photoshop)
        # Store both high-res and low-res versions (only once)
        if not hasattr(processor, '_original_full_res_cache'):
            from src.film_processing import GPU_AVAILABLE, cp
            
            full_res_img = processor.cached_stages['initial']
            processor._original_full_res_cache = full_res_img.copy()  # Keep on GPU if GPU enabled
            
            # Create low-res proxy (20% scale for faster response)
            # Transfer to CPU only for resize, then back to GPU
            if hasattr(full_res_img, 'get'):
                full_res_cpu = full_res_img.get()  # CuPy → NumPy
            else:
                full_res_cpu = full_res_img.copy()
            
            h_full, w_full = full_res_cpu.shape[:2]
            proxy_h, proxy_w = int(h_full * 0.3), int(w_full * 0.3)
            proxy_cpu = cv2.resize(full_res_cpu, (proxy_w, proxy_h), interpolation=cv2.INTER_AREA)
            
            # Keep proxy on GPU if available (no transfer overhead on slider updates)
            if GPU_AVAILABLE:
                processor._low_res_proxy = cp.asarray(proxy_cpu)
                logger.info(f"Created GPU proxy: {w_full}x{h_full} → {proxy_w}x{proxy_h} [GPU]")
            else:
                processor._low_res_proxy = proxy_cpu
                logger.info(f"Created CPU proxy: {w_full}x{h_full} → {proxy_w}x{proxy_h}")
        
        # Use proxy while dragging, full-res when released
        use_proxy = params.pop('use_proxy', False)
        if use_proxy:
            processor.cached_stages['initial'] = processor._low_res_proxy.copy()
            h, w = processor.cached_stages['initial'].shape[:2]
            logger.info(f"Using PROXY: {w}x{h}")
        else:
            processor.cached_stages['initial'] = processor._original_full_res_cache.copy()
            h, w = processor.cached_stages['initial'].shape[:2]
            logger.info(f"Using FULL-RES: {w}x{h}")
        
        show_analysis = params.pop('show_analysis', False)
        
        # Extract all parameters with defaults
        all_params = {
            # Basic adjustments
            'contrast': float(params.get('contrast', 0.0)),
            'exposure': float(params.get('exposure', 0.0)),
            'highlights': float(params.get('highlights', 0.0)),
            'shadows': float(params.get('shadows', 0.0)),
            'saturation': float(params.get('saturation', 1.0)),
            'temperature': float(params.get('temperature', 0.0)),
            'tint': float(params.get('tint', 0.0)),
            'red_balance': float(params.get('red_balance', 1.0)),
            'green_balance': float(params.get('green_balance', 1.0)),
            'blue_balance': float(params.get('blue_balance', 1.0)),
            'gamma': float(params.get('gamma', 1.0)),
            'clarity': float(params.get('clarity', 0.0)),
            'dehaze': float(params.get('dehaze', 0.0)),
            'texture': float(params.get('texture', 0.0)),
            'whites': float(params.get('whites', 0.0)),
            'blacks': float(params.get('blacks', 0.0)),
            
            # Eyedropper points
            'black_point_r': params.get('black_point_r'),
            'black_point_g': params.get('black_point_g'),
            'black_point_b': params.get('black_point_b'),
            'white_point_r': params.get('white_point_r'),
            'white_point_g': params.get('white_point_g'),
            'white_point_b': params.get('white_point_b'),
            'gray_point_r': params.get('gray_point_r'),
            'gray_point_g': params.get('gray_point_g'),
            'gray_point_b': params.get('gray_point_b'),
            
            # Curves
            'curves': params.get('curves'),
            
            # Film processing
            'film_correction': float(params.get('film_correction', 0.0)),
            'film_type': params.get('film_type', 'none'),
            'film_stock': params.get('film_stock', 'none'),
            'film_intensity': float(params.get('film_intensity', 0.0)),
            
            # Advanced film processing
            'film_profile_strength': float(params.get('film_profile_strength', 1.0)),
            'orange_mask_removal': float(params.get('orange_mask_removal', 1.0)),
            'base_fog_removal': float(params.get('base_fog_removal', 0.0)),
            'grain_simulation': float(params.get('grain_simulation', 0.0)),
            'halation_effect': float(params.get('halation_effect', 0.0)),
            
            # Auto adjustments (toggles)
            'auto_exposure': float(params.get('auto_exposure', 0.0)),
            'auto_contrast': float(params.get('auto_contrast', 0.0)),
            'auto_levels': float(params.get('auto_levels', 0.0)),
            'auto_white_balance': float(params.get('auto_white_balance', 0.0)),
            'auto_highlights': float(params.get('auto_highlights', 0.0)),
            'auto_shadows': float(params.get('auto_shadows', 0.0)),
            
            # Effects
            'grain': float(params.get('grain', 0.0)),
            'vignette': float(params.get('vignette', 0.0)),
            
            # Tone curve and levels
            'tone_curve_points': params.get('tone_curve_points', []),
            'white_level': float(params.get('white_level', 1.0)),
            'black_level': float(params.get('black_level', 0.0)),
            'curve_gamma': float(params.get('curve_gamma', 1.0)),
            'output_white': float(params.get('output_white', 1.0)),
            'output_black': float(params.get('output_black', 0.0)),
            
            # Presence controls
            'structure': float(params.get('structure', 0.0)),
            'vibrance': float(params.get('vibrance', 0.0))
        }
        
        # Convert individual color grading parameters to arrays
        # Frontend sends: shadows_red, shadows_green, shadows_blue
        # Backend expects: three_way_shadows: [red, green, blue]
        shadows_red = float(params.get('shadows_red', 0.0))
        shadows_green = float(params.get('shadows_green', 0.0))
        shadows_blue = float(params.get('shadows_blue', 0.0))
        all_params['three_way_shadows'] = [1.0 + shadows_red, 1.0 + shadows_green, 1.0 + shadows_blue]
        
        midtones_red = float(params.get('midtones_red', 0.0))
        midtones_green = float(params.get('midtones_green', 0.0))
        midtones_blue = float(params.get('midtones_blue', 0.0))
        all_params['three_way_midtones'] = [1.0 + midtones_red, 1.0 + midtones_green, 1.0 + midtones_blue]
        
        highlights_red = float(params.get('highlights_red', 0.0))
        highlights_green = float(params.get('highlights_green', 0.0))
        highlights_blue = float(params.get('highlights_blue', 0.0))
        all_params['three_way_highlights'] = [1.0 + highlights_red, 1.0 + highlights_green, 1.0 + highlights_blue]
        
        # Convert selective color parameters
        # Frontend sends target + individual adjustments
        # Backend expects selective_color_{target}: [hue, saturation, lightness]
        selective_target = params.get('selective_color_target', 'reds')
        selective_hue = float(params.get('selective_hue_shift', 0.0))
        selective_sat = float(params.get('selective_saturation', 0.0))
        selective_light = float(params.get('selective_lightness', 0.0))
        
        # Initialize all selective color arrays to default
        for color in ['reds', 'greens', 'blues', 'cyans', 'magentas', 'yellows']:
            all_params[f'selective_color_{color}'] = [0.0, 0.0, 0.0]
        
        # Set the selected target
        if selective_target in ['reds', 'greens', 'blues', 'cyans', 'magentas', 'yellows']:
            all_params[f'selective_color_{selective_target}'] = [selective_hue, selective_sat, selective_light]
        
        processor.update_params(**all_params)
        img_processed = processor.get_processed_image()
        
        # Ensure it's a numpy array (convert from CuPy if needed)
        if hasattr(img_processed, 'get'):  # CuPy array
            img_processed = img_processed.get()
        elif not isinstance(img_processed, np.ndarray):
            img_processed = np.asarray(img_processed)
        
        # Ensure we have a valid RGB image
        if len(img_processed.shape) != 3 or img_processed.shape[2] != 3:
            logger.warning(f"Invalid processed image shape: {img_processed.shape}, converting to RGB")
            img_processed = np.array(Image.fromarray(img_processed).convert('RGB'))
        
        if show_analysis and hasattr(processor, 'debug_mask') and processor.debug_mask is not None:
            try:
                # Get the current processed image dimensions
                h, w = img_processed.shape[:2]
                
                # Resize debug mask to match processed image if needed
                if processor.debug_mask.shape[:2] != (h, w):
                    debug_mask_resized = cv2.resize(processor.debug_mask, (w, h), interpolation=cv2.INTER_NEAREST)
                else:
                    debug_mask_resized = processor.debug_mask
                
                # Create visualization overlay with correct dimensions
                overlay = np.zeros((h, w, 4), dtype=np.uint8)
                overlay[..., 1] = 255  # Green channel
                overlay[..., 3] = debug_mask_resized * 127  # Alpha channel
                
                # Blend overlay with processed image
                alpha = overlay[..., 3:4].astype(float) / 255
                img_processed = (img_processed * (1 - alpha) + overlay[..., :3] * alpha).astype(np.uint8)
                
                logger.debug(f"Applied analysis overlay: processed shape {img_processed.shape}, mask shape {debug_mask_resized.shape}")
            except Exception as e:
                logger.warning(f"Failed to apply analysis overlay: {str(e)}")
                # Continue without overlay
        
        # Save as PNG for lossless quality (JPEG always loses data)
        img_byte_arr = io.BytesIO()
        Image.fromarray(img_processed).save(img_byte_arr, format='PNG', compress_level=6)
        img_byte_arr = img_byte_arr.getvalue()
        
        # Cache is automatically restored at the start of next request
        
        return jsonify({
            'image': base64.b64encode(img_byte_arr).decode(),
            'success': True
        })
        
    except Exception as e:
        logger.error(f"Error processing image: {str(e)}")
        return jsonify({
            'error': str(e),
            'success': False
        })

@app.route('/get_pixel', methods=['POST'])
def get_pixel():
    """Get the RGB value of a pixel at the specified coordinates"""
    try:
        global processor
        if processor is None or processor.original_image is None:
            return jsonify({'error': 'No image loaded', 'success': False})
        
        data = request.json
        x = int(data.get('x', 0))
        y = int(data.get('y', 0))
        
        # Get the image as numpy array
        img = processor.original_image
        height, width = img.shape[:2]
        
        # Validate coordinates
        if x < 0 or x >= width or y < 0 or y >= height:
            return jsonify({'error': 'Coordinates out of bounds', 'success': False})
        
        # Get RGB values - original_image is float32 (0.0-1.0), convert to 0-255
        pixel = img[y, x]
        rgb = [int(pixel[0] * 255), int(pixel[1] * 255), int(pixel[2] * 255)]
        
        return jsonify({
            'rgb': rgb,
            'success': True
        })
    except Exception as e:
        logger.error(f"Error getting pixel: {str(e)}")
        return jsonify({'error': str(e), 'success': False})

# Stack of pre-crop originals for undo
crop_undo_stack = []

@app.route('/crop', methods=['POST'])
def crop_image():
    """Crop the image to the specified rectangle"""
    try:
        global processor
        if processor is None or processor.original_image is None:
            return jsonify({'error': 'No image loaded', 'success': False})
        
        # Save pre-crop state for undo
        img_backup = processor.original
        if hasattr(img_backup, 'get'):
            img_backup = img_backup.get()
        crop_undo_stack.append(img_backup.copy())
        
        data = request.json
        x = int(data.get('x', 0))
        y = int(data.get('y', 0))
        width = int(data.get('width', 100))
        height = int(data.get('height', 100))
        
        # Crop the raw original image (not the processed one) so that
        # adjustments can be re-applied non-destructively after cropping.
        img = processor.original
        if hasattr(img, 'get'):
            img = img.get()  # GPU (CuPy) to CPU (NumPy)
        
        img_height, img_width = img.shape[:2]
        
        # The frontend computes crop coordinates based on the display dimensions
        # from /get_raw_image, which may be downsampled. Scale coordinates to
        # match the full-resolution original image.
        max_display_size = 5000
        if max(img_height, img_width) > max_display_size:
            scale = max_display_size / max(img_height, img_width)
            display_w = int(img_width * scale)
            display_h = int(img_height * scale)
            # Scale crop coordinates from display space to full resolution
            scale_x = img_width / display_w
            scale_y = img_height / display_h
            x = int(x * scale_x)
            y = int(y * scale_y)
            width = int(width * scale_x)
            height = int(height * scale_y)
        
        # Validate crop bounds
        x = max(0, min(x, img_width - 1))
        y = max(0, min(y, img_height - 1))
        width = min(width, img_width - x)
        height = min(height, img_height - y)
        
        # Crop the raw original (float32 [0,1])
        cropped = img[y:y+height, x:x+width].copy()
        
        # Update processor with cropped raw original
        processor.original = cropped
        processor.original_image = cropped
        processor.original_cpu = cropped
        processor._initialize_cache()
        
        # If client will use WebGL, skip expensive PNG encoding
        if request.json.get('webgl'):
            return jsonify({'success': True})
        
        # Return the cropped initial stage (with negative inversion if applicable)
        initial = processor.cached_stages.get('initial')
        if hasattr(initial, 'get'):
            initial = initial.get()  # GPU to CPU
        display_img = (np.clip(initial, 0, 1) * 255).astype(np.uint8)
        
        img_byte_arr = io.BytesIO()
        Image.fromarray(display_img).save(img_byte_arr, format='PNG', compress_level=1)
        img_byte_arr = img_byte_arr.getvalue()
        
        return jsonify({
            'image': base64.b64encode(img_byte_arr).decode(),
            'success': True
        })
    except Exception as e:
        logger.error(f"Error cropping image: {str(e)}")
        return jsonify({'error': str(e), 'success': False})

@app.route('/undo_crop', methods=['POST'])
def undo_crop():
    """Restore the image to pre-crop state"""
    try:
        global processor
        if not crop_undo_stack:
            return jsonify({'error': 'No crop to undo', 'success': False})
        
        restored = crop_undo_stack.pop()
        processor.original = restored
        processor.original_image = restored
        processor.original_cpu = restored
        processor._initialize_cache()
        
        # If client will use WebGL, skip expensive PNG encoding
        if request.json and request.json.get('webgl'):
            return jsonify({'success': True, 'undoAvailable': len(crop_undo_stack) > 0})
        
        initial = processor.cached_stages.get('initial')
        if hasattr(initial, 'get'):
            initial = initial.get()
        display_img = (np.clip(initial, 0, 1) * 255).astype(np.uint8)
        
        img_byte_arr = io.BytesIO()
        Image.fromarray(display_img).save(img_byte_arr, format='PNG', compress_level=1)
        img_byte_arr = img_byte_arr.getvalue()
        
        return jsonify({
            'image': base64.b64encode(img_byte_arr).decode(),
            'success': True,
            'undoAvailable': len(crop_undo_stack) > 0
        })
    except Exception as e:
        logger.error(f"Error undoing crop: {str(e)}")
        return jsonify({'error': str(e), 'success': False})

@app.route('/export', methods=['POST'])
def export_image():
    """Export the processed image at full quality (16-bit TIFF)"""
    try:
        global processor
        if processor is None:
            return jsonify({'error': 'No image loaded'}), 404
        
        params = request.json
        logger.info(f"Export request with parameters: {list(params.keys())}")
        logger.info(f"Export curves data: {params.get('curves', 'NOT PROVIDED')}")
        
        # Ensure we're using full resolution
        if hasattr(processor, '_original_full_res_cache'):
            processor.cached_stages['initial'] = processor._original_full_res_cache.copy()
            logger.info("Using full resolution for export")
        
        # Update all parameters
        processor.update_params(
            exposure=params.get('exposure', 0.0),
            contrast=params.get('contrast', 0.0),
            highlights=params.get('highlights', 0.0),
            shadows=params.get('shadows', 0.0),
            whites=params.get('whites', 0.0),
            blacks=params.get('blacks', 0.0),
            brightness=params.get('brightness', 0.0),
            saturation=params.get('saturation', 1.0),
            temperature=params.get('temperature', 0.0),
            tint=params.get('tint', 0.0),
            clarity=params.get('clarity', 0.0),
            vibrance=params.get('vibrance', 0.0),
            film_correction=params.get('film_correction', 0.0),
            curves=params.get('curves'),
            # Eyedropper points
            black_point_r=params.get('black_point_r'),
            black_point_g=params.get('black_point_g'),
            black_point_b=params.get('black_point_b'),
            white_point_r=params.get('white_point_r'),
            white_point_g=params.get('white_point_g'),
            white_point_b=params.get('white_point_b'),
            gray_point_r=params.get('gray_point_r'),
            gray_point_g=params.get('gray_point_g'),
            gray_point_b=params.get('gray_point_b')
        )
        
        # For lossless export: use ORIGINAL uint16 data, apply adjustments, export as uint16
        # This preserves the original color space and bit depth
        if hasattr(processor, 'original_uint16_data') and processor.original_uint16_data is not None:
            logger.info("=" * 80)
            
            # Check if user made ANY edits
            has_curves = False
            curves_str = processor.params.get('curves')
            if curves_str:
                try:
                    import json as _json
                    curves_data = _json.loads(curves_str) if isinstance(curves_str, str) else curves_str
                    default_points = [{"x": 0, "y": 0}, {"x": 1, "y": 1}]
                    for ch in ['rgb', 'red', 'green', 'blue']:
                        pts = curves_data.get(ch, default_points)
                        if len(pts) != 2 or pts[0].get('x') != 0 or pts[0].get('y') != 0 or pts[-1].get('x') != 1 or pts[-1].get('y') != 1:
                            has_curves = True
                            break
                except Exception:
                    pass
            
            has_edits = (
                processor.params['exposure'] != 0 or
                processor.params['contrast'] != 0 or
                processor.params['highlights'] != 0 or
                processor.params['shadows'] != 0 or
                processor.params['whites'] != 0 or
                processor.params['blacks'] != 0 or
                float(params.get('red', 0)) != 0 or
                float(params.get('green', 0)) != 0 or
                float(params.get('blue', 0)) != 0 or
                processor.params.get('brightness', 0.0) != 0 or
                processor.params.get('saturation', 1.0) != 1.0 or
                processor.params.get('temperature', 0.0) != 0 or
                processor.params.get('tint', 0.0) != 0 or
                processor.params.get('black_point_r') is not None or
                processor.params.get('white_point_r') is not None or
                processor.params.get('gray_point_r') is not None or
                has_curves
            )
            
            if not has_edits:
                # ZERO EDITS: Just write original data directly (truly lossless)
                logger.info("EXPORT: Zero edits detected - using original uint16 data directly (100% lossless)")
                original_uint16 = processor.original_uint16_data
                img_processed = original_uint16.astype(np.float32) / 65535.0
                logger.info(f"EXPORT: Direct passthrough - shape: {img_processed.shape}, preserving exact pixel values")
            else:
                # HAS EDITS: Process the data
                logger.info("EXPORT: Edits detected - processing original uint16 data")
                original_uint16 = processor.original_uint16_data
                logger.info(f"EXPORT: Original data shape: {original_uint16.shape}, dtype: {original_uint16.dtype}")
                logger.info(f"EXPORT: Original data range: [{original_uint16.min()}, {original_uint16.max()}]")
                logger.info(f"EXPORT: Original data sample pixel: {original_uint16[original_uint16.shape[0]//2, original_uint16.shape[1]//2, :]}")
                
                # Normalize to float32 for processing
                img_float = original_uint16.astype(np.float32) / 65535.0
                logger.info(f"EXPORT: Normalized to float32, shape: {img_float.shape}, range: [{img_float.min():.4f}, {img_float.max():.4f}]")
            
            # Apply user's adjustments if any
            from src.film_processing import GPU_AVAILABLE, cp
            xp = cp if GPU_AVAILABLE else np
            
            if has_edits:
                # Transfer to GPU if available
                if GPU_AVAILABLE:
                    processed = cp.asarray(img_float)
                else:
                    processed = img_float
            
            if has_edits:
                # Apply all adjustments matching the WebGL shader pipeline order exactly
                
                # 0. Levels (eyedropper black/white/gray points)
                processed = processor._apply_levels_adjustment(processed)
                
                # 1. Exposure: color * 2^exposure
                if processor.params['exposure'] != 0:
                    processed *= 2 ** processor.params['exposure']
                
                # 2. Tone curve (highlights/shadows/whites/blacks) using smoothstep
                highlights = processor.params['highlights']
                shadows = processor.params['shadows']
                whites = processor.params['whites']
                blacks = processor.params['blacks']
                if highlights != 0 or shadows != 0 or whites != 0 or blacks != 0:
                    luminance = 0.299 * processed[:, :, 0] + 0.587 * processed[:, :, 1] + 0.114 * processed[:, :, 2]
                    luminance = xp.clip(luminance, 0.0, 1.0)
                    
                    if shadows != 0:
                        shadow_mask = 1.0 - _smoothstep(xp, 0.0, 0.5, luminance)
                        for c in range(3):
                            processed[:, :, c] += shadows * shadow_mask * 0.3
                    
                    if blacks != 0:
                        black_mask = 1.0 - _smoothstep(xp, 0.0, 0.25, luminance)
                        for c in range(3):
                            processed[:, :, c] += blacks * black_mask * 0.3
                    
                    if highlights != 0:
                        highlight_mask = _smoothstep(xp, 0.5, 1.0, luminance)
                        for c in range(3):
                            processed[:, :, c] += highlights * highlight_mask * 0.3
                    
                    if whites != 0:
                        white_mask = _smoothstep(xp, 0.75, 1.0, luminance)
                        for c in range(3):
                            processed[:, :, c] += whites * white_mask * 0.3
                
                # 3. Contrast: (color - 0.5) * (1 + contrast) + 0.5
                if processor.params['contrast'] != 0:
                    contrast_factor = 1.0 + processor.params['contrast']
                    processed = (processed - 0.5) * contrast_factor + 0.5
                
                # 4. Brightness
                brightness = processor.params.get('brightness', 0.0)
                if brightness != 0:
                    processed += brightness
                
                # 5. Temperature and Tint
                temperature = processor.params.get('temperature', 0.0)
                tint = processor.params.get('tint', 0.0)
                if temperature != 0:
                    processed[:, :, 0] += temperature * 0.05
                    processed[:, :, 2] -= temperature * 0.05
                if tint != 0:
                    processed[:, :, 1] += tint * 0.05
                
                # 6. RGB channel adjustments
                red = float(params.get('red', 0))
                green = float(params.get('green', 0))
                blue = float(params.get('blue', 0))
                if red != 0:
                    processed[:, :, 0] += red
                if green != 0:
                    processed[:, :, 1] += green
                if blue != 0:
                    processed[:, :, 2] += blue
                
                # 7. Saturation: mix(gray, color, 1 + saturation)
                saturation = processor.params.get('saturation', 1.0)
                if saturation != 1.0:
                    gray = 0.299 * processed[:, :, 0] + 0.587 * processed[:, :, 1] + 0.114 * processed[:, :, 2]
                    for c in range(3):
                        processed[:, :, c] = gray + (processed[:, :, c] - gray) * saturation
                
                # 8. Custom curves (after other adjustments)
                processed = processor._apply_curves(processed)
                
                processed = xp.clip(processed, 0.0, 1.0)
                
                # Transfer from GPU if needed
                if hasattr(processed, 'get'):
                    img_processed = processed.get()
                else:
                    img_processed = processed
                
                logger.info(f"EXPORT: After processing - shape: {img_processed.shape}, dtype: {img_processed.dtype}, range: [{img_processed.min():.4f}, {img_processed.max():.4f}]")
                logger.info(f"EXPORT: Sample pixel after processing: {img_processed[img_processed.shape[0]//2, img_processed.shape[1]//2, :]}")
            
            logger.info("=" * 80)
        else:
            # Fallback: use sRGB display data (will lose original color space)
            logger.warning("=" * 80)
            logger.warning("EXPORT: No original uint16 data found, using sRGB display data for export")
            logger.warning("=" * 80)
            
            from src.film_processing import GPU_AVAILABLE, cp
            xp = cp if GPU_AVAILABLE else np
            
            processed = processor.cached_stages.get('initial', processor.cached_stages.get('inverted'))
            
            # Apply all adjustments matching the WebGL shader pipeline order
            processed = processor._apply_levels_adjustment(processed)
            
            if processor.params['exposure'] != 0:
                processed *= 2 ** processor.params['exposure']
            
            highlights = processor.params['highlights']
            shadows = processor.params['shadows']
            whites = processor.params['whites']
            blacks = processor.params['blacks']
            if highlights != 0 or shadows != 0 or whites != 0 or blacks != 0:
                luminance = 0.299 * processed[:, :, 0] + 0.587 * processed[:, :, 1] + 0.114 * processed[:, :, 2]
                luminance = xp.clip(luminance, 0.0, 1.0)
                if shadows != 0:
                    shadow_mask = 1.0 - _smoothstep(xp, 0.0, 0.5, luminance)
                    for c in range(3):
                        processed[:, :, c] += shadows * shadow_mask * 0.3
                if blacks != 0:
                    black_mask = 1.0 - _smoothstep(xp, 0.0, 0.25, luminance)
                    for c in range(3):
                        processed[:, :, c] += blacks * black_mask * 0.3
                if highlights != 0:
                    highlight_mask = _smoothstep(xp, 0.5, 1.0, luminance)
                    for c in range(3):
                        processed[:, :, c] += highlights * highlight_mask * 0.3
                if whites != 0:
                    white_mask = _smoothstep(xp, 0.75, 1.0, luminance)
                    for c in range(3):
                        processed[:, :, c] += whites * white_mask * 0.3
            
            if processor.params['contrast'] != 0:
                contrast_factor = 1.0 + processor.params['contrast']
                processed = (processed - 0.5) * contrast_factor + 0.5
            
            brightness = processor.params.get('brightness', 0.0)
            if brightness != 0:
                processed += brightness
            
            temperature = processor.params.get('temperature', 0.0)
            tint = processor.params.get('tint', 0.0)
            if temperature != 0:
                processed[:, :, 0] += temperature * 0.05
                processed[:, :, 2] -= temperature * 0.05
            if tint != 0:
                processed[:, :, 1] += tint * 0.05
            
            red = float(params.get('red', 0))
            green = float(params.get('green', 0))
            blue = float(params.get('blue', 0))
            if red != 0:
                processed[:, :, 0] += red
            if green != 0:
                processed[:, :, 1] += green
            if blue != 0:
                processed[:, :, 2] += blue
            
            saturation = processor.params.get('saturation', 1.0)
            if saturation != 1.0:
                gray = 0.299 * processed[:, :, 0] + 0.587 * processed[:, :, 1] + 0.114 * processed[:, :, 2]
                for c in range(3):
                    processed[:, :, c] = gray + (processed[:, :, c] - gray) * saturation
            
            processed = processor._apply_curves(processed)
            processed = xp.clip(processed, 0.0, 1.0)
            
            if hasattr(processed, 'get'):
                img_processed = processed.get()
            else:
                img_processed = processed
        
        # Convert float32 [0.0, 1.0] → uint16 [0, 65535]
        img_uint16 = (np.clip(img_processed, 0.0, 1.0) * 65535).astype(np.uint16)
        
        logger.info(f"Preparing export: shape={img_uint16.shape} (H×W×C), dtype={img_uint16.dtype}, range=[{img_uint16.min()}, {img_uint16.max()}]")
        
        # Save as 16-bit TIFF to BytesIO
        output = io.BytesIO()
        
        # DON'T embed ICC profile - the data is already in sRGB despite the Adobe RGB profile tag
        # Embedding the Adobe RGB profile causes viewers to misinterpret the sRGB data
        tifffile.imwrite(output, img_uint16, photometric='rgb', compression=None)
        logger.info("Saved as untagged TIFF (no ICC profile)")
        
        file_size = output.tell()  # Get size before seeking
        output.seek(0)
        
        logger.info(f"Exported 16-bit TIFF: {img_uint16.shape}, {file_size} bytes")
        
        return send_file(
            output,
            mimetype='image/tiff',
            as_attachment=True,
            download_name=f'processed_{int(time.time())}.tif'
        )
        
    except Exception as e:
        logger.error(f"Export error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/upload', methods=['POST'])
def upload_file():
    try:
        global processor
        crop_undo_stack.clear()
        if 'image' not in request.files:
            return jsonify({
                'error': 'No file uploaded',
                'success': False
            })
        
        file = request.files['image']
        if not file:
            return jsonify({
                'error': 'Empty file provided',
                'success': False
            })
            
        # Validate file type
        if not file.filename.lower().endswith(('.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp')):
            return jsonify({
                'error': 'Invalid file type. Please upload an image file.',
                'success': False
            })
        
        # Check for is_negative flag (default True)
        is_negative = True
        if 'is_negative' in request.form:
            is_negative = request.form['is_negative'].lower() == 'true'
        try:
            image_bytes = file.read()
            
            # Initialize these early to avoid scoping issues
            original_uint16_data = None
            original_icc_profile = None
            
            # Also get metadata from PIL for detailed TIFF inspection
            pil_image = Image.open(io.BytesIO(image_bytes))
            original_format = pil_image.format
            original_mode = pil_image.mode
            icc_profile = pil_image.info.get('icc_profile')
            
            logger.info(f"Original format: {original_format}, size: {pil_image.size}, mode: {original_mode}")
            if icc_profile:
                logger.info(f"Embedded ICC profile detected ({len(icc_profile)} bytes)")
            
            # For TIFF files, check actual bit depth from tags
            if original_format == 'TIFF' and hasattr(pil_image, 'tag_v2'):
                # TIFF tag IDs: 258=BitsPerSample, 277=SamplesPerPixel, 262=PhotometricInterpretation
                bits_per_sample = pil_image.tag_v2.get(258, None)
                samples_per_pixel = pil_image.tag_v2.get(277, None)
                photometric = pil_image.tag_v2.get(262, None)
                compression = pil_image.tag_v2.get(259, None)
                logger.info(f"TIFF tags - BitsPerSample: {bits_per_sample}, SamplesPerPixel: {samples_per_pixel}, Photometric: {photometric}, Compression: {compression}")
            
            # Use tifffile for proper 16-bit TIFF support
            # (imageio and PIL both auto-convert to 8-bit)
            if original_format == 'TIFF':
                img_array = tifffile.imread(io.BytesIO(image_bytes))
                logger.info(f"Loaded with tifffile: shape={img_array.shape}, dtype={img_array.dtype}, range=[{img_array.min()}, {img_array.max()}]")
                
                # ALWAYS store original uint16 data BEFORE any modifications (for lossless export)
                # But we need to store it AFTER color space conversion since adjustments are in sRGB space
                original_uint16_before_conversion = img_array.copy()
                logger.info(f"Stored pre-conversion uint16 data: shape={original_uint16_before_conversion.shape}")
                
                # Apply ICC color profile if present (convert to sRGB for display)
                if icc_profile:
                    try:
                        # Get profile info
                        input_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
                        profile_name = ImageCms.getProfileName(input_profile)
                        logger.info(f"Detected ICC profile: {profile_name}")
                        
                        # Store original ICC profile for export
                        original_icc_profile = icc_profile
                        
                        # Convert Adobe RGB → sRGB for proper browser display
                        profile_lower = profile_name.lower()
                        if 'adobe' in profile_lower and 'rgb' in profile_lower:
                            logger.info("Converting Adobe RGB → sRGB (for display)")
                            
                            # Convert to float [0, 1]
                            img_float = img_array.astype(np.float32) / 65535.0
                            
                            # Adobe RGB → sRGB transformation matrix
                            matrix = np.array([
                                [ 1.39822014, -0.39830039, -0.00006393],
                                [ 0.00010625,  0.99991441,  0.00000183],
                                [ 0.00003334, -0.04293803,  1.04296793],
                            ], dtype=np.float32)
                            
                            h, w = img_float.shape[:2]
                            img_reshaped = img_float.reshape(-1, 3)
                            img_transformed = img_reshaped @ matrix.T
                            img_float = img_transformed.reshape(h, w, 3)
                            img_float = np.clip(img_float, 0.0, 1.0)
                            
                            img_array = (img_float * 65535).astype(np.uint16)
                            logger.info("Converted Adobe RGB → sRGB")
                            
                            # Store the sRGB-converted uint16 data for export
                            original_uint16_data = img_array.copy()
                            logger.info(f"Stored sRGB-converted uint16 data for export: shape={original_uint16_data.shape}")
                        else:
                            # Not Adobe RGB, store as-is
                            original_uint16_data = img_array.copy()
                            logger.info(f"Stored uint16 data (no conversion): shape={original_uint16_data.shape}")
                        
                    except Exception as e:
                        logger.warning(f"Color profile reading failed: {str(e)}, using raw data")
                        import traceback
                        logger.warning(traceback.format_exc())
                        # No conversion, store as-is
                        original_uint16_data = img_array.copy()
                else:
                    # No ICC profile, store as-is
                    original_uint16_data = img_array.copy()
                    logger.info(f"No ICC profile, stored uint16 data as-is: shape={original_uint16_data.shape}")
            else:
                # For non-TIFF formats, use PIL
                img_array = np.array(pil_image)
                logger.info(f"Loaded with PIL: shape={img_array.shape}, dtype={img_array.dtype}, range=[{img_array.min()}, {img_array.max()}]")
            
            # NO RESIZING - preserve full resolution for maximum quality
            # Film scans can be 6000-10000px and we want every pixel
            
            # Normalize to float32 [0.0, 1.0] based on actual dtype
            if img_array.dtype == np.uint16:
                logger.info("16-bit image detected, normalizing to float32")
                img_array = img_array.astype(np.float32) / 65535.0
            elif img_array.dtype == np.uint8:
                logger.info("8-bit image detected, normalizing to float32")
                img_array = img_array.astype(np.float32) / 255.0
            else:
                # Handle other dtypes (float, int32, etc.)
                logger.info(f"Non-standard dtype {img_array.dtype}, normalizing")
                img_array = img_array.astype(np.float32)
                if img_array.max() > 1.0:
                    img_array = img_array / img_array.max()
            
            logger.info(f"Normalized array: shape={img_array.shape}, dtype={img_array.dtype}, range=[{img_array.min():.4f}, {img_array.max():.4f}]")
            
            # Ensure 3-channel RGB without destroying float32 precision
            if len(img_array.shape) == 2:
                # Grayscale - replicate to 3 channels
                logger.info("Converting grayscale to RGB")
                img_array = np.stack([img_array] * 3, axis=-1)
            elif len(img_array.shape) == 3:
                if img_array.shape[2] == 1:
                    # Single channel with dimension
                    logger.info("Converting single-channel to RGB")
                    img_array = np.concatenate([img_array] * 3, axis=2)
                elif img_array.shape[2] == 4:
                    # RGBA - drop alpha (or could composite on white)
                    logger.info("Converting RGBA to RGB (dropping alpha)")
                    img_array = img_array[:, :, :3]
                elif img_array.shape[2] != 3:
                    # Other channel count - take first 3 or pad
                    logger.warning(f"Unexpected channel count: {img_array.shape[2]}, taking first 3")
                    img_array = img_array[:, :, :3]
            
            logger.info(f"Final RGB array: shape={img_array.shape}, dtype={img_array.dtype}, range=[{img_array.min():.4f}, {img_array.max():.4f}]")
            
            logger.info(f"Final image array shape before FilmProcessor: {img_array.shape}")
            global processor
            processor = FilmProcessor(img_array, is_negative=is_negative)
            
            # Store ICC profile AND original uint16 data for export (already initialized)
            processor.original_icc_profile = original_icc_profile
            processor.original_uint16_data = original_uint16_data
            
            if processor.original_icc_profile:
                logger.info(f"Processor has ICC profile: {len(processor.original_icc_profile)} bytes")
            if processor.original_uint16_data is not None:
                logger.info(f"Processor has original uint16 data: shape={processor.original_uint16_data.shape}")
            
            # Process with default settings and return initial image
            img_processed = processor.get_processed_image()
            
            # Save as PNG for lossless preview
            img_byte_arr = io.BytesIO()
            Image.fromarray(img_processed).save(img_byte_arr, format='PNG', compress_level=6)
            img_byte_arr = img_byte_arr.getvalue()
            
            return jsonify({
                'success': True,
                'image': base64.b64encode(img_byte_arr).decode()
            })
            
        except Exception as e:
            logger.error(f"Error during image processing: {str(e)}")
            raise
        
    except Exception as e:
        logger.error(f"Error uploading file: {str(e)}")
        return jsonify({
            'error': f"Failed to process image: {str(e)}",
            'success': False
        })

@app.route('/ai-correct', methods=['POST'])
def ai_correct():
    """AI-powered automatic color correction endpoint"""
    try:
        global processor
        
        if processor is None:
            return jsonify({'error': 'No image loaded', 'success': False})
        
        if not AI_AVAILABLE:
            return jsonify({'error': 'AI color correction not available', 'success': False})
        
        # Get API key from request or environment
        api_key = request.json.get('api_key') or os.environ.get('OPENAI_API_KEY')
        if not api_key:
            return jsonify({'error': 'API key required for AI correction', 'success': False})
        
        # Initialize AI corrector
        ai_corrector = AIColorCorrector(api_key=api_key, model_provider="openai")
        
        # Get current processed image
        current_image = processor.get_processed_image()
        
        # Run AI analysis
        logger.info("Running AI color correction analysis...")
        correction_data = ai_corrector.analyze_image_for_correction(current_image)
        
        # Apply suggested corrections
        suggestions = correction_data["suggested_corrections"]
        reasoning = suggestions.pop("reasoning", [])  # Remove reasoning from params
        
        # Convert numpy arrays to lists for JSON serialization
        for key, value in suggestions.items():
            if isinstance(value, np.ndarray):
                suggestions[key] = value.tolist()
            elif hasattr(value, 'item'):  # numpy scalar
                suggestions[key] = value.item()
        
        logger.info(f"AI suggestions: {suggestions}")
        
        # Apply the suggested parameters
        processor.update_params(**suggestions)
        
        # Get the AI-corrected image
        corrected_image = processor.get_processed_image()
        
        # Convert to base64 for response
        img_byte_arr = io.BytesIO()
        Image.fromarray(corrected_image).save(img_byte_arr, format='JPEG', quality=95)
        img_base64 = base64.b64encode(img_byte_arr.getvalue()).decode()
        
        return jsonify({
            'success': True,
            'image': img_base64,
            'analysis': correction_data.get("analysis", {}),
            'suggestions': suggestions,
            'confidence': correction_data.get("confidence_score", 0.0),
            'reasoning': reasoning
        })
        
    except Exception as e:
        logger.error(f"Error in AI correction: {str(e)}")
        return jsonify({
            'error': f"AI correction failed: {str(e)}",
            'success': False
        })

@app.route('/ai-analyze', methods=['POST'])
def ai_analyze():
    """AI-powered image analysis without applying corrections"""
    try:
        global processor
        
        if processor is None:
            return jsonify({'error': 'No image loaded', 'success': False})
        
        if not AI_AVAILABLE:
            return jsonify({'error': 'AI analysis not available', 'success': False})
        
        # Get current processed image
        current_image = processor.get_processed_image()
        
        # Initialize AI corrector (no API key needed for local analysis)
        ai_corrector = AIColorCorrector()
        
        # Run local AI analysis
        logger.info("Running AI image analysis...")
        analysis_data = ai_corrector.analyze_image_for_correction(current_image)
        
        # Convert numpy arrays to lists for JSON serialization
        def convert_numpy(obj):
            if isinstance(obj, np.ndarray):
                return obj.tolist()
            elif hasattr(obj, 'item'):
                return obj.item()
            elif isinstance(obj, dict):
                return {k: convert_numpy(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [convert_numpy(item) for item in obj]
            return obj
        
        analysis_data = convert_numpy(analysis_data)
        
        return jsonify({
            'success': True,
            'analysis': analysis_data.get("analysis", {}),
            'suggestions': analysis_data.get("suggested_corrections", {}),
            'confidence': analysis_data.get("confidence_score", 0.0)
        })
        
    except Exception as e:
        logger.error(f"Error in AI analysis: {str(e)}")
        return jsonify({
            'error': f"AI analysis failed: {str(e)}",
            'success': False
        })

if __name__ == '__main__':
    app.run(debug=True)
