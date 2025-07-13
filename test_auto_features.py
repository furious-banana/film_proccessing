#!/usr/bin/env python3
"""
Test auto levels and auto white balance specifically
"""

import sys
import os
import numpy as np
from PIL import Image

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from film_processing import FilmProcessor

# Create a test image that should benefit from auto levels and white balance
test_image = np.zeros((200, 200, 3), dtype=np.uint8)

# Create an image with poor contrast and color cast (typical film negative issues)
# Dark muddy image with blue color cast
test_image[:, :] = [30, 40, 80]  # Very dark with blue cast

# Add some brighter areas that should be highlights
test_image[50:150, 50:150] = [80, 100, 160]  # Medium tones with blue cast

# Add a small bright area (unexposed film edge)
test_image[0:20, 0:20] = [200, 220, 240]  # Bright unexposed film

print("Created test image with poor contrast and blue color cast")
print(f"Image shape: {test_image.shape}")
print(f"Min values: R={test_image[:,:,0].min()}, G={test_image[:,:,1].min()}, B={test_image[:,:,2].min()}")
print(f"Max values: R={test_image[:,:,0].max()}, G={test_image[:,:,1].max()}, B={test_image[:,:,2].max()}")

# Test with no corrections
processor = FilmProcessor(test_image)
result_none = processor.get_processed_image()
print("\n--- No corrections ---")
print(f"Result min: R={result_none[:,:,0].min()}, G={result_none[:,:,1].min()}, B={result_none[:,:,2].min()}")
print(f"Result max: R={result_none[:,:,0].max()}, G={result_none[:,:,1].max()}, B={result_none[:,:,2].max()}")

# Test with auto levels only
processor.update_params(auto_levels=1.0)
result_levels = processor.get_processed_image()
print("\n--- With auto levels ---")
print(f"Result min: R={result_levels[:,:,0].min()}, G={result_levels[:,:,1].min()}, B={result_levels[:,:,2].min()}")
print(f"Result max: R={result_levels[:,:,0].max()}, G={result_levels[:,:,1].max()}, B={result_levels[:,:,2].max()}")

# Check if there's any difference
levels_diff = np.abs(result_levels.astype(int) - result_none.astype(int)).max()
print(f"Max difference with auto levels: {levels_diff}")

# Test with auto white balance only
processor.update_params(auto_levels=0.0, auto_white_balance=1.0)
result_wb = processor.get_processed_image()
print("\n--- With auto white balance ---")
print(f"Result min: R={result_wb[:,:,0].min()}, G={result_wb[:,:,1].min()}, B={result_wb[:,:,2].min()}")
print(f"Result max: R={result_wb[:,:,0].max()}, G={result_wb[:,:,1].max()}, B={result_wb[:,:,2].max()}")

# Check if there's any difference
wb_diff = np.abs(result_wb.astype(int) - result_none.astype(int)).max()
print(f"Max difference with auto white balance: {wb_diff}")

# Test with both
processor.update_params(auto_levels=1.0, auto_white_balance=1.0)
result_both = processor.get_processed_image()
print("\n--- With both auto levels and white balance ---")
print(f"Result min: R={result_both[:,:,0].min()}, G={result_both[:,:,1].min()}, B={result_both[:,:,2].min()}")
print(f"Result max: R={result_both[:,:,0].max()}, G={result_both[:,:,1].max()}, B={result_both[:,:,2].max()}")

both_diff = np.abs(result_both.astype(int) - result_none.astype(int)).max()
print(f"Max difference with both: {both_diff}")

# Save test images to see the differences
Image.fromarray(result_none).save("test_none.jpg")
Image.fromarray(result_levels).save("test_levels.jpg") 
Image.fromarray(result_wb).save("test_wb.jpg")
Image.fromarray(result_both).save("test_both.jpg")
print("\nSaved test images: test_none.jpg, test_levels.jpg, test_wb.jpg, test_both.jpg")
