"""
Image Processor wrapper for backward compatibility
"""

import numpy as np
from PIL import Image
from .film_processing import FilmProcessor

class ImageProcessor:
    """Wrapper class for backward compatibility with existing test scripts"""
    
    def __init__(self, image_path_or_array):
        if isinstance(image_path_or_array, str):
            # Load image from path
            self.image_path = image_path_or_array
            self.image_array = np.array(Image.open(image_path_or_array).convert("RGB"))
        elif isinstance(image_path_or_array, np.ndarray):
            # Use array directly
            self.image_path = None
            self.image_array = image_path_or_array
        else:
            raise ValueError("Input must be image path (string) or numpy array")
        
        # Create the actual processor
        self.processor = FilmProcessor(self.image_array)
    
    def get_processed_image(self):
        """Get processed image - delegates to FilmProcessor"""
        return self.processor.get_processed_image()
    
    def update_params(self, **kwargs):
        """Update processing parameters"""
        return self.processor.update_params(**kwargs)
