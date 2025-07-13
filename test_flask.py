#!/usr/bin/env python3
"""
Test Flask template loading
"""

import sys
import os

# Set working directory and add src to path
script_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(script_dir)
sys.path.insert(0, os.path.join(script_dir, 'src'))

def test_flask_app():
    print("Testing Flask app configuration...")
    
    try:
        from app import app
        print("✓ App imported successfully")
        
        with app.test_client() as client:
            print("✓ Test client created")
            
            # Test template loading
            response = client.get('/')
            print(f"✓ GET / response: {response.status_code}")
            
            if response.status_code == 200:
                print("✓ Template loaded successfully!")
                return True
            else:
                print(f"✗ Template loading failed with status {response.status_code}")
                print(f"Response data: {response.data.decode()[:200]}...")
                return False
                
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

if __name__ == "__main__":
    success = test_flask_app()
    if success:
        print("\n🚀 Flask app is ready!")
        print("Run: uv run python main.py")
    else:
        print("\n❌ Flask app has issues")
        
    sys.exit(0 if success else 1)
