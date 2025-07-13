# Film Negative Processor

A sophisticated web-based application for processing and correcting scanned film negatives with professional-grade controls and a modern interface.

## 🎯 Features

### **Core Processing Pipeline**
- **Three-Stage Algorithm**: Film base removal → Auto levels → Auto white balance
- **Intelligent Film Base Detection**: Single brightest pixel analysis for accurate color cast removal
- **Toggle-Based Workflow**: Individual control over each processing step
- **Real-Time Preview**: Smooth, debounced updates with no image flickering

### **Professional Controls**
- **Film Processing**: Toggle-based film correction, auto levels, auto white balance
- **Tone Adjustments**: Exposure, contrast, highlights, shadows, gamma
- **Color Grading**: Temperature, tint, individual RGB balance, saturation
- **Advanced Effects**: Clarity, dehaze, and professional film corrections
- **Debug Visualization**: Show algorithm detection points for validation

### **Modern Interface**
- **Dark Theme**: Professional gradient-based design
- **Responsive Layout**: Adaptive panels that work on any screen size
- **Smooth Animations**: Subtle transitions and hover effects throughout
- **Drag & Drop Upload**: Intuitive file handling with visual feedback
- **Live Value Displays**: Real-time parameter readouts with monospace fonts

## 🚀 Quick Start

### **Installation (Using uv - Recommended)**

1. **Install uv** (fast Python package manager):
   ```powershell
   # Windows PowerShell
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```

2. **Install dependencies**:
   ```bash
   # Install all dependencies from pyproject.toml
   uv sync
   ```

3. **Run the application**:
   ```bash
   # Start the web application
   uv run python src/app.py
   ```

4. **Open your browser** to `http://localhost:5000`

### **Usage**
1. **Upload** a scanned film negative (drag & drop or click to select)
2. **Process** with toggles:
   - **Film Correction**: Remove film base color cast (off/on)
   - **Auto Levels**: Automatic contrast adjustment (on by default)
   - **Auto White Balance**: Automatic color temperature correction (on by default)
3. **Fine-tune** with professional controls for exposure, color, and tone
4. **Preview** changes in real-time with smooth, responsive interface

## 🏗️ Project Structure

```
film_processing/
├── src/                          # Core application
│   ├── app.py                   # Flask web server
│   └── film_processing.py       # Three-stage processing algorithm
├── templates/                    # Modern HTML interface
│   └── index.html              # Professional UI with toggles
├── tests/                       # Test files
│   ├── test_fixed_processor.py # Algorithm validation
│   └── test_*.py               # Various test scripts
├── examples/                    # Usage examples  
│   ├── simple_analysis.py      # Basic processing example
│   └── compare_*.py            # Comparison utilities
├── docs/                       # Documentation
├── pyproject.toml              # Modern dependency management
├── .venv/                      # Virtual environment
└── README.md                   # This file
```

## ⚙️ Algorithm Details

### **Three-Stage Processing Pipeline**

1. **Film Base Removal** (Toggle: Film Correction)
   - Analyzes single brightest pixel for film base color
   - Subtracts inverted film base from entire image
   - Conservative detection to avoid using image content

2. **Auto Levels** (Toggle: Auto Levels)  
   - Automatic contrast adjustment
   - Optimizes dynamic range
   - Enhances image clarity

3. **Auto White Balance** (Toggle: Auto White Balance)
   - Intelligent color temperature correction
   - Reduces blue channel dominance typical in film negatives
   - Creates natural-looking color balance

### **Key Technical Features**
- **Single Pixel Detection**: More accurate than average-based methods
- **Conservative Analysis**: Avoids using actual image content for correction
- **Fallback Methods**: Robust handling when detection fails
- **Memory Optimized**: Efficient processing for large film scans
## 🛠️ Development

### **Dependencies Management with uv**
```bash
# Install all dependencies
uv sync

# Add new dependency
uv add package-name

# Add development dependency  
uv add --dev package-name

# Update dependencies
uv sync --upgrade
```

### **Development Commands**
```bash
# Run the application
uv run python src/app.py

# Run tests
uv run python -m pytest tests/

# Run specific test
uv run python tests/test_fixed_processor.py

# Format code (if black is installed)
uv run black src/ tests/

# Start development server with auto-reload
uv run flask --app src/app.py run --debug
```

### **Testing the Algorithm**
```bash
# Test with synthetic images
uv run python tests/test_improved_correction.py

# Validate three-stage pipeline
uv run python tests/test_fixed_processor.py

# Compare different approaches
uv run python examples/compare_corrections.py
```

## 🎨 UI Features

### **Modern Design Elements**
- **Gradient Backgrounds**: Professional dark theme with subtle gradients
- **Smooth Interactions**: Debounced updates prevent image flickering  
- **Responsive Controls**: Sliders with real-time value displays
- **Toggle Switches**: Intuitive on/off controls for processing steps
- **Loading Indicators**: Visual feedback during processing
- **Drag & Drop**: Modern file upload with hover states

### **Performance Optimizations**
- **Debounced Updates**: 150ms delay for smooth real-time adjustments
- **Opacity Transitions**: Smooth image changes during processing
- **Efficient Rendering**: Optimized CSS and JavaScript for responsiveness
- **Memory Management**: Smart handling of large film scans

## 🔬 Technical Implementation

### **Backend (Flask + OpenCV)**
- **Flask**: Lightweight web framework for API endpoints
- **OpenCV**: Image processing and computer vision operations
- **NumPy**: Efficient numerical operations on image arrays  
- **Pillow**: Image format handling and encoding

### **Frontend (Modern HTML/CSS/JS)**
- **CSS Grid/Flexbox**: Responsive layout system
- **CSS Custom Properties**: Dynamic theming and consistency
- **Vanilla JavaScript**: No dependencies, optimized performance
- **Web APIs**: FileReader, fetch() for modern browser features

### **Image Processing Pipeline**
```python
def process_negative(image_array, film_correction=0.0, auto_levels=True, auto_white_balance=True):
    """
    Three-stage film processing pipeline
    
    Args:
        image_array: Input negative image
        film_correction: 0.0 (off) or 1.0 (on)  
        auto_levels: Boolean for contrast adjustment
        auto_white_balance: Boolean for color correction
    
    Returns:
        Processed positive image
    """
    # Stage 1: Film base removal (if enabled)
    # Stage 2: Auto levels (if enabled)  
    # Stage 3: Auto white balance (if enabled)
```

## 📸 Supported Image Formats

- **JPEG/JPG**: Standard digital camera format
- **PNG**: Lossless with transparency support
- **TIFF**: High-quality film scan format
- **BMP**: Uncompressed bitmap format

## 🚨 Troubleshooting

### **Common Issues**
- **Port 5000 in use**: Change port in `src/app.py` or stop conflicting service
- **Large file uploads**: Browser may timeout on very large scans
- **Memory issues**: Use smaller images or increase system RAM
- **Import errors**: Ensure all dependencies installed with `uv sync`

### **Performance Tips**
- **Image Size**: Resize very large scans (>4000px) for better performance
- **Browser**: Use modern browsers (Chrome, Firefox, Safari, Edge)
- **RAM**: 8GB+ recommended for processing large film scans
- **Storage**: Ensure adequate disk space for temporary files

## 🎯 Why This Project?

### **Professional Film Processing**
Traditional film processing software is often expensive, complex, or lacks the specific algorithms needed for accurate film negative conversion. This project provides:

- **Specialized Algorithms**: Designed specifically for film negative characteristics
- **Professional Controls**: Industry-standard adjustment tools
- **Modern Interface**: Responsive, intuitive design for efficient workflow
- **Open Source**: Transparent algorithms you can understand and modify

### **Educational Value**
- **Algorithm Transparency**: See exactly how film base detection works
- **Modern Web Development**: Learn Flask, modern CSS, and responsive design
- **Image Processing**: Understand OpenCV and computer vision techniques
- **Best Practices**: Modern Python development with uv, type hints, and testing

## 📄 License

This project is for educational and personal use. Feel free to explore, learn, and adapt the algorithms for your own film processing needs.
