#!/usr/bin/env python3
"""
Compare original vs new conservative color correction
"""

import numpy as np
from PIL import Image
from film_processing import FilmProcessor
import matplotlib.pyplot as plt

def compare_corrections():
    """Compare the new conservative correction with the previous results"""
    
    try:
        # Load the test image
        test_image = Image.open("test_file.jpg").convert("RGB")
        image_array = np.array(test_image)
        
        # Process with new conservative algorithm
        processor = FilmProcessor(image_array)
        new_processed = processor.get_processed_image()
        
        # Save the new result
        new_result = Image.fromarray(new_processed)
        new_result.save("conservative_correction.jpg")
        
        # Create a side-by-side comparison if we have both images
        try:
            old_processed = Image.open("test_processed_with_new_detection.jpg")
            
            # Create comparison image
            fig, axes = plt.subplots(1, 3, figsize=(15, 5))
            
            # Original (inverted)
            axes[0].imshow(255 - image_array)  # Simple inversion for reference
            axes[0].set_title("Original (Simple Inversion)")
            axes[0].axis('off')
            
            # Old processing
            axes[1].imshow(old_processed)
            axes[1].set_title("Previous (Aggressive Correction)")
            axes[1].axis('off')
            
            # New processing
            axes[2].imshow(new_processed)
            axes[2].set_title("New (Conservative Correction)")
            axes[2].axis('off')
            
            plt.tight_layout()
            plt.savefig("correction_comparison.jpg", dpi=150, bbox_inches='tight')
            plt.close()
            
            print("Saved comparison as correction_comparison.jpg")
            
        except Exception as e:
            print(f"Could not create comparison: {e}")
        
        print("Conservative correction completed successfully!")
        print("Check conservative_correction.jpg for the improved result")
        
        return True
        
    except Exception as e:
        print(f"Error in comparison: {str(e)}")
        return False

if __name__ == "__main__":
    print("Comparing conservative vs aggressive color correction...")
    compare_corrections()
