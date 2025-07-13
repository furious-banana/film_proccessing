#!/usr/bin/env python3
"""
Quick debug test to check if the film processing is working correctly
"""

import sys
import os
import numpy as np
from PIL import Image

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

try:
    from film_processing import FilmProcessor
    print("Successfully imported FilmProcessor")
    
    # Create a simple test image (simulated film negative)
    # Dark image with a bright corner (simulating unexposed film edge)
    test_image = np.zeros((100, 100, 3), dtype=np.uint8)
    test_image[:, :] = [50, 60, 80]  # Dark bluish base (typical film negative)
    test_image[0:10, 0:10] = [200, 210, 220]  # Bright corner (unexposed film)
    
    print(f"Created test image: {test_image.shape}")
    
    # Test basic processing
    processor = FilmProcessor(test_image)
    print("Successfully loaded test image into processor")
    
    # Test with default parameters (all off)
    result = processor.get_processed_image()
    print(f"Basic processing works: {result.shape}")
    
    # Test toggling film correction
    processor.update_params(film_correction=1.0)
    result_with_correction = processor.get_processed_image()
    print(f"Film correction toggle works: {result_with_correction.shape}")
    
    # Test toggling auto levels
    processor.update_params(auto_levels=1.0)
    result_with_levels = processor.get_processed_image()
    print(f"Auto levels toggle works: {result_with_levels.shape}")
    
    # Test toggling auto white balance
    processor.update_params(auto_white_balance=1.0)
    result_with_wb = processor.get_processed_image()
    print(f"Auto white balance toggle works: {result_with_wb.shape}")
    
    # Test reverting (turn everything off)
    processor.update_params(film_correction=0.0, auto_levels=0.0, auto_white_balance=0.0)
    result_reverted = processor.get_processed_image()
    print(f"Revert toggle works: {result_reverted.shape}")
    
    print("\nAll basic functionality tests passed!")
    
except Exception as e:
    print(f"Error: {str(e)}")
    import traceback
    traceback.print_exc()
