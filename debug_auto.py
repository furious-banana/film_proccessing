import numpy as np
from PIL import Image
import sys
import os

sys.path.insert(0, 'src')
from film_processing import FilmProcessor

# Create a test image that REALLY needs auto levels and white balance
height, width = 100, 100
test_image = np.zeros((height, width, 3), dtype=np.uint8)

# Create an image with terrible contrast and heavy color cast
# Very dark with severe blue color cast (typical film negative issue)
for y in range(height):
    for x in range(width):
        # Create gradient from very dark to medium
        brightness = int(20 + (x / width) * 60)  # 20 to 80 range
        test_image[y, x] = [brightness, brightness + 10, brightness + 40]  # Heavy blue cast

# Add a few bright spots (unexposed film)
test_image[5:15, 5:15] = [220, 230, 250]  # Bright neutral area

print("Test image stats:")
print(f"R: {test_image[:,:,0].min()}-{test_image[:,:,0].max()}")
print(f"G: {test_image[:,:,1].min()}-{test_image[:,:,1].max()}")  
print(f"B: {test_image[:,:,2].min()}-{test_image[:,:,2].max()}")

# Test 1: No auto features
processor = FilmProcessor(test_image)
result1 = processor.get_processed_image()
Image.fromarray(result1).save("debug_no_auto.jpg")
print("\nNo auto features:")
print(f"R: {result1[:,:,0].min()}-{result1[:,:,0].max()}")
print(f"G: {result1[:,:,1].min()}-{result1[:,:,1].max()}")
print(f"B: {result1[:,:,2].min()}-{result1[:,:,2].max()}")

# Test 2: Auto levels only  
processor.update_params(auto_levels=1.0)
result2 = processor.get_processed_image()
Image.fromarray(result2).save("debug_auto_levels.jpg")
print("\nWith auto levels:")
print(f"R: {result2[:,:,0].min()}-{result2[:,:,0].max()}")
print(f"G: {result2[:,:,1].min()}-{result2[:,:,1].max()}")
print(f"B: {result2[:,:,2].min()}-{result2[:,:,2].max()}")

diff_levels = np.abs(result2.astype(int) - result1.astype(int)).max()
print(f"Max difference from auto levels: {diff_levels}")

# Test 3: Auto white balance only
processor.update_params(auto_levels=0.0, auto_white_balance=1.0)  
result3 = processor.get_processed_image()
Image.fromarray(result3).save("debug_auto_wb.jpg")
print("\nWith auto white balance:")
print(f"R: {result3[:,:,0].min()}-{result3[:,:,0].max()}")
print(f"G: {result3[:,:,1].min()}-{result3[:,:,1].max()}")
print(f"B: {result3[:,:,2].min()}-{result3[:,:,2].max()}")

diff_wb = np.abs(result3.astype(int) - result1.astype(int)).max()
print(f"Max difference from auto white balance: {diff_wb}")

print("\nCreated debug_no_auto.jpg, debug_auto_levels.jpg, debug_auto_wb.jpg")
