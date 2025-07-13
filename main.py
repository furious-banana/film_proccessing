#!/usr/bin/env python3
"""
Main entry point for the Film Processing Web Application
"""

import sys
import os

# Set working directory to script location
script_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(script_dir)

# Add src directory to Python path
sys.path.insert(0, os.path.join(script_dir, 'src'))

from app import app

if __name__ == '__main__':
    print("Starting Film Processing Web Application...")
    print("Available at: http://localhost:5000")
    print("Press Ctrl+C to stop")
    app.run(debug=True, host='0.0.0.0', port=5000)
