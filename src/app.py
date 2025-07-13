from flask import Flask, send_file, request, render_template, jsonify
import sys
import os

# Add current directory to path for imports
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from film_processing import FilmProcessor
import numpy as np
from PIL import Image
import cv2
import io
import base64
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configure Flask to look for templates in the parent directory
template_dir = os.path.join(os.path.dirname(current_dir), 'templates')
app = Flask(__name__, template_folder=template_dir)
processor = None

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/process', methods=['POST'])
def process_image():
    try:
        params = request.json
        global processor
        
        if processor is None:
            return jsonify({'error': 'No image loaded'})
        
        show_analysis = params.pop('show_analysis', False)
        
        # Extract all parameters with defaults
        all_params = {
            'contrast': float(params.get('contrast', 1.0)),
            'exposure': float(params.get('exposure', 0.0)),
            'highlight_recovery': float(params.get('highlight_recovery', 0.0)),
            'shadow_recovery': float(params.get('shadow_recovery', 0.0)),
            'saturation': float(params.get('saturation', 1.0)),
            'temperature': float(params.get('temperature', 0.0)),
            'tint': float(params.get('tint', 0.0)),
            'red_balance': float(params.get('red', 1.0)),
            'green_balance': float(params.get('green', 1.0)),
            'blue_balance': float(params.get('blue', 1.0)),
            'gamma': float(params.get('gamma', 1.0)),
            'clarity': float(params.get('clarity', 0.0)),
            'dehaze': float(params.get('dehaze', 0.0)),
            'film_correction': float(params.get('film_correction', 0.0))  # New parameter
        }
        
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
        
        # Convert to JPEG
        img_byte_arr = io.BytesIO()
        Image.fromarray(img_processed).save(img_byte_arr, format='JPEG', quality=95)
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

@app.route('/upload', methods=['POST'])
def upload_file():
    try:
        global processor
        if 'file' not in request.files:
            return jsonify({
                'error': 'No file uploaded',
                'success': False
            })
        
        file = request.files['file']
        if not file:
            return jsonify({
                'error': 'Empty file provided',
                'success': False
            })
            
        # Validate file type
        if not file.filename.lower().endswith(('.png', '.jpg', '.jpeg', '.tiff', '.bmp')):
            return jsonify({
                'error': 'Invalid file type. Please upload an image file.',
                'success': False
            })
            
        try:
            image_bytes = file.read()
            image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
            logger.info(f"Image size after RGB conversion: {image.size}")
            
            # Resize image if it's too large
            max_size = 1200
            ratio = max_size / max(image.size)
            if ratio < 1:
                new_size = tuple(int(dim * ratio) for dim in image.size)
                image = image.resize(new_size, Image.Resampling.LANCZOS)
                logger.info(f"Image size after resize: {image.size}")
            
            # Convert to numpy array and ensure 3 channels
            img_array = np.array(image)
            logger.info(f"Initial numpy array shape: {img_array.shape}")
            
            if len(img_array.shape) != 3:
                logger.warning(f"Image not 3D, converting: {img_array.shape}")
                img_array = np.stack([img_array] * 3, axis=-1)
                logger.info(f"Shape after stacking: {img_array.shape}")
            elif img_array.shape[2] != 3:
                # If we somehow got more or fewer than 3 channels, convert to RGB
                logger.warning(f"Wrong number of channels: {img_array.shape[2]}")
                img_array = np.array(Image.fromarray(img_array).convert('RGB'))
                logger.info(f"Shape after RGB conversion: {img_array.shape}")
            
            logger.info(f"Final image array shape before FilmProcessor: {img_array.shape}")
            processor = FilmProcessor(img_array)
            
            # Process with default settings and return initial image
            img_processed = processor.get_processed_image()
            
            # Convert to JPEG
            img_byte_arr = io.BytesIO()
            Image.fromarray(img_processed).save(img_byte_arr, format='JPEG', quality=95)
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

if __name__ == '__main__':
    app.run(debug=True)
