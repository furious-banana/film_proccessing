from flask import Flask, send_file, request, render_template, jsonify
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
import tifffile  # Proper 16-bit TIFF support
import colour  # Professional color science for 16-bit color space conversion

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

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/process', methods=['POST'])
@app.route('/adjust', methods=['POST'])
def process_image():
    try:
        params = request.json
        global processor
        
        if processor is None:
            return jsonify({'error': 'No image loaded'})
        
        # DEBUG: Log incoming parameters
        logger.info(f"DEBUG: Received parameters: {list(params.keys())}")
        color_params = {k: v for k, v in params.items() if 'shadows' in k or 'midtones' in k or 'highlights' in k}
        if color_params:
            logger.info(f"DEBUG: Color grading parameters: {color_params}")
        
        advanced_params = {k: v for k, v in params.items() if 'film_profile' in k or 'orange_mask' in k or 'base_fog' in k}
        if advanced_params:
            logger.info(f"DEBUG: Advanced film parameters: {advanced_params}")
        
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
        
        # Get RGB values (OpenCV uses BGR, so we reverse it)
        pixel = img[y, x]
        rgb = [int(pixel[2]), int(pixel[1]), int(pixel[0])]  # BGR to RGB
        
        return jsonify({
            'rgb': rgb,
            'success': True
        })
    except Exception as e:
        logger.error(f"Error getting pixel: {str(e)}")
        return jsonify({'error': str(e), 'success': False})

@app.route('/crop', methods=['POST'])
def crop_image():
    """Crop the image to the specified rectangle"""
    try:
        global processor
        if processor is None or processor.original_image is None:
            return jsonify({'error': 'No image loaded', 'success': False})
        
        data = request.json
        x = int(data.get('x', 0))
        y = int(data.get('y', 0))
        width = int(data.get('width', 100))
        height = int(data.get('height', 100))
        
        # Get the current processed image
        img = processor.get_processed_image()
        
        # Validate crop bounds
        img_height, img_width = img.shape[:2]
        x = max(0, min(x, img_width - 1))
        y = max(0, min(y, img_height - 1))
        width = min(width, img_width - x)
        height = min(height, img_height - y)
        
        # Crop the image
        cropped = img[y:y+height, x:x+width]
        
        # Update processor with cropped image
        processor.original = cropped
        processor.original_image = cropped
        processor._initialize_cache()
        
        # Return cropped image as PNG for lossless quality
        img_byte_arr = io.BytesIO()
        Image.fromarray(cropped).save(img_byte_arr, format='PNG', compress_level=6)
        img_byte_arr = img_byte_arr.getvalue()
        
        return jsonify({
            'image': base64.b64encode(img_byte_arr).decode(),
            'success': True
        })
    except Exception as e:
        logger.error(f"Error cropping image: {str(e)}")
        return jsonify({'error': str(e), 'success': False})

@app.route('/upload', methods=['POST'])
def upload_file():
    try:
        global processor
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
                
                # DEBUG: Sample multiple regions to understand dynamic range
                h, w = img_array.shape[0], img_array.shape[1]
                samples = {
                    'top-left': img_array[h//4, w//4, :],
                    'top-right': img_array[h//4, 3*w//4, :],
                    'center': img_array[h//2, w//2, :],
                    'bottom-left': img_array[3*h//4, w//4, :],
                    'bottom-right': img_array[3*h//4, 3*w//4, :],
                }
                logger.info("DEBUG: Sample pixels across image (uint16):")
                for location, pixel in samples.items():
                    logger.info(f"  {location}: {pixel} (normalized: [{pixel[0]/65535:.4f}, {pixel[1]/65535:.4f}, {pixel[2]/65535:.4f}])")
                
                # Show histogram of values
                hist, bins = np.histogram(img_array.flatten(), bins=10, range=(0, 65535))
                logger.info(f"DEBUG: Value distribution: {hist}")
                logger.info(f"DEBUG: 10th percentile: {np.percentile(img_array, 10):.0f}, 50th: {np.percentile(img_array, 50):.0f}, 90th: {np.percentile(img_array, 90):.0f}")
                
                # Apply ICC color profile if present (convert to sRGB)
                if icc_profile:
                    try:
                        # Get profile info
                        input_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
                        profile_name = ImageCms.getProfileName(input_profile)
                        logger.info(f"Detected ICC profile: {profile_name}")
                        
                        # DEBUG: Sample before conversion
                        sample_before = img_array[img_array.shape[0]//2, img_array.shape[1]//2, :]
                        logger.info(f"DEBUG: Raw TIFF pixel values (uint16): {sample_before}")
                        
                        # Manual Adobe RGB → sRGB conversion preserving 16-bit
                        # This is what Photoshop does internally
                        profile_lower = profile_name.lower()
                        if 'adobe' in profile_lower and 'rgb' in profile_lower:
                            logger.info("Converting Adobe RGB → sRGB (manual 16-bit conversion)")
                            
                            # Convert to float [0, 1]
                            img_float = img_array.astype(np.float64) / 65535.0
                            
                            # The TIFF already contains gamma-encoded Adobe RGB values
                            # Photoshop keeps it in gamma space and just adjusts the primaries
                            # Use colour-science but ONLY for the matrix, not gamma
                            
                            # Get the transformation matrix from Adobe RGB to sRGB (ignoring gamma)
                            from colour.models import RGB_to_RGB
                            
                            # Transform WITHOUT touching gamma (data stays gamma-encoded)
                            # We just change the color primaries/white point
                            img_float = RGB_to_RGB(
                                img_float,
                                colour.RGB_COLOURSPACES['Adobe RGB (1998)'],
                                colour.RGB_COLOURSPACES['sRGB'],
                                apply_cctf_decoding=False,   # Don't decode - keep gamma as-is
                                apply_cctf_encoding=False    # Don't encode - keep gamma as-is
                            )
                            
                            # Clip any out-of-gamut values
                            img_float = np.clip(img_float, 0.0, 1.0)
                            
                            # Convert back to uint16
                            img_array = (img_float * 65535).astype(np.uint16)
                            
                            # DEBUG: Sample after conversion
                            sample_after = img_array[h//2, w//2, :]
                            logger.info(f"DEBUG: After manual conversion (uint16): {sample_after}")
                            logger.info(f"Converted Adobe RGB → sRGB (16-bit precision preserved)")
                        else:
                            logger.info(f"Unknown color space '{profile_name}', using raw data")
                        
                    except Exception as e:
                        logger.warning(f"Color space conversion failed: {str(e)}, using raw data")
                        import traceback
                        logger.warning(traceback.format_exc())
            else:
                # For non-TIFF formats, use PIL
                img_array = np.array(pil_image)
                logger.info(f"Loaded with PIL: shape={img_array.shape}, dtype={img_array.dtype}, range=[{img_array.min()}, {img_array.max()}]")
                
                # DEBUG: Sample multiple regions for PNG too
                if img_array.ndim == 3:
                    h, w = img_array.shape[0], img_array.shape[1]
                    samples = {
                        'top-left': img_array[h//4, w//4, :] if img_array.shape[2] >= 3 else img_array[h//4, w//4],
                        'center': img_array[h//2, w//2, :] if img_array.shape[2] >= 3 else img_array[h//2, w//2],
                        'bottom-right': img_array[3*h//4, 3*w//4, :] if img_array.shape[2] >= 3 else img_array[3*h//4, 3*w//4],
                    }
                    logger.info(f"DEBUG: PNG sample pixels (uint8):")
                    for location, pixel in samples.items():
                        if hasattr(pixel, '__len__') and len(pixel) >= 3:
                            logger.info(f"  {location}: {pixel[:3]} (normalized: [{pixel[0]/255:.4f}, {pixel[1]/255:.4f}, {pixel[2]/255:.4f}])")
                    logger.info(f"DEBUG: PNG 10th percentile: {np.percentile(img_array, 10):.0f}, 50th: {np.percentile(img_array, 50):.0f}, 90th: {np.percentile(img_array, 90):.0f}")
            
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
