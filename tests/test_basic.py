#!/usr/bin/env python3
"""
Simple test runner for film processing functionality
"""

import sys
import os

# Add src directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from film_processing import FilmProcessor
from PIL import Image
import numpy as np
import logging

logging.basicConfig(level=logging.INFO)

def run_basic_tests():
    """Run basic functionality tests"""
    print("=== FILM PROCESSING TESTS ===\n")
    
    # Test 1: Basic processor initialization
    print("Test 1: Basic processor initialization")
    try:
        # Create a dummy image for testing
        test_image = np.random.randint(0, 255, (100, 100, 3), dtype=np.uint8)
        processor = FilmProcessor(test_image)
        print("✓ Processor initialized successfully")
    except Exception as e:
        print(f"✗ Processor initialization failed: {e}")
        return False
    
    # Test 2: Basic processing
    print("\nTest 2: Basic image processing")
    try:
        result = processor.get_processed_image()
        print(f"✓ Processed image shape: {result.shape}")
    except Exception as e:
        print(f"✗ Processing failed: {e}")
        return False
    
    # Test 3: Parameter updates
    print("\nTest 3: Parameter updates")
    try:
        processor.update_params(
            contrast=1.2,
            exposure=0.5,
            film_correction=0.3
        )
        result = processor.get_processed_image()
        print("✓ Parameter updates work correctly")
    except Exception as e:
        print(f"✗ Parameter update failed: {e}")
        return False
    
    print("\n=== ALL TESTS PASSED ===")
    return True

if __name__ == "__main__":
    success = run_basic_tests()
    sys.exit(0 if success else 1)
