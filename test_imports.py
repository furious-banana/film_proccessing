#!/usr/bin/env python3
"""
Simple test to verify imports work correctly
"""

import sys
import os

# Add src directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

def test_imports():
    print("Testing imports...")
    
    try:
        from film_processing import FilmProcessor
        print("✓ FilmProcessor import successful")
    except ImportError as e:
        print(f"✗ FilmProcessor import failed: {e}")
        return False
    
    try:
        from app import app
        print("✓ Flask app import successful")
    except ImportError as e:
        print(f"✗ Flask app import failed: {e}")
        return False
    
    try:
        import numpy as np
        print("✓ NumPy import successful")
    except ImportError as e:
        print(f"✗ NumPy import failed: {e}")
        return False
    
    try:
        from PIL import Image
        print("✓ Pillow import successful")
    except ImportError as e:
        print(f"✗ Pillow import failed: {e}")
        return False
    
    try:
        import cv2
        print("✓ OpenCV import successful")
    except ImportError as e:
        print(f"✗ OpenCV import failed: {e}")
        return False
    
    print("\n✅ All imports successful!")
    return True

if __name__ == "__main__":
    success = test_imports()
    if success:
        print("\n🚀 Application should run correctly!")
        print("Run: uv run python main.py")
    else:
        print("\n❌ Some imports failed. Check dependencies.")
    
    sys.exit(0 if success else 1)
