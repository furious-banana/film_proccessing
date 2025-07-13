#!/usr/bin/env python3
"""
Test the simplified film processing algorithm
"""

import os
import sys
import numpy as np
from PIL import Image

# Add src to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from film_processing import FilmProcessor

def create_test_negative():
    """Create a synthetic film negative for testing"""
    # Create a 200x200 test image
    width, height = 200, 200
    
    # Create the "negative" - darker means brighter in final image
    negative = np.zeros((height, width, 3), dtype=np.uint8)
    
    # Add some image content (mid-tones in negative)
    # This represents a bright subject in the original photo
    negative[50:150, 50:150] = [100, 110, 120]  # Slightly colored mid-tone
    
    # Add unexposed film areas (bright in negative)
    # These should be the brightest parts and represent the film base
    negative[0:10, :] = [220, 210, 200]  # Top border - slightly orange film base
    negative[-10:, :] = [220, 210, 200]  # Bottom border
    negative[:, 0:10] = [220, 210, 200]  # Left border  
    negative[:, -10:] = [220, 210, 200]  # Right border
    
    # Add some noise to make it realistic
    noise = np.random.normal(0, 5, negative.shape).astype(np.int16)
    negative = np.clip(negative.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    
    return negative

def test_algorithm():
    """Test the simplified algorithm"""
    print("🧪 Testing simplified film processing algorithm")
    print("📝 Algorithm: Find bright areas in negative → Invert them → Subtract from inverted image")
    
    # Create test negative
    test_negative = create_test_negative()
    print(f"Created test negative: {test_negative.shape}")
    
    # Save test negative for inspection
    test_negative_pil = Image.fromarray(test_negative)
    test_negative_pil.save("test_negative.jpg")
    print("💾 Saved test_negative.jpg")
    
    # Show what we expect to happen
    unexposed_in_negative = test_negative[0:10, 0:10]  # Bright area in negative (film base)
    expected_after_inversion = 255 - unexposed_in_negative  # What it becomes after inversion
    print(f"📊 Unexposed film in negative: R={np.mean(unexposed_in_negative[:,:,0]):.1f}, G={np.mean(unexposed_in_negative[:,:,1]):.1f}, B={np.mean(unexposed_in_negative[:,:,2]):.1f}")
    print(f"📊 After inversion (what gets subtracted): R={np.mean(expected_after_inversion[:,:,0]):.1f}, G={np.mean(expected_after_inversion[:,:,1]):.1f}, B={np.mean(expected_after_inversion[:,:,2]):.1f}")
    
    # Process with the simplified algorithm
    processor = FilmProcessor(test_negative)
    
    try:
        # Set film correction strength to 1.0 (full correction)
        processor.update_params(film_correction=1.0)
        
        # Process the image
        result = processor.get_processed_image()
        
        print(f"✅ Processing successful! Result shape: {result.shape}")
        
        # Save result
        result_pil = Image.fromarray(result)
        result_pil.save("test_simple_result.jpg")
        print("💾 Saved test_simple_result.jpg")
        
        # Check what film base color was detected
        if hasattr(processor, 'analysis_result') and processor.analysis_result:
            film_base = processor.analysis_result.get('film_base_color', 'Unknown')
            print(f"🎨 Detected film base color to subtract: {film_base}")
        
        # Analyze the result - the corrected area should be closer to neutral
        result_corrected = result[0:10, 0:10]  # Border area after processing
        
        print(f"📊 Final corrected border: R={np.mean(result_corrected[:,:,0]):.1f}, G={np.mean(result_corrected[:,:,1]):.1f}, B={np.mean(result_corrected[:,:,2]):.1f}")
        print("� The border should now be closer to neutral gray after subtracting the film base color")
        
        return True
        
    except Exception as e:
        print(f"❌ Error processing: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = test_algorithm()
    if success:
        print("\n🎉 Algorithm test completed successfully!")
        print("Check test_negative.jpg and test_simple_result.jpg to see the results")
    else:
        print("\n💥 Algorithm test failed!")
