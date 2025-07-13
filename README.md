# Film Processing Tool

A comprehensive web-based application for processing and correcting scanned film negatives.

## Features

- **Automatic Film Inversion**: Converts negative film to positive images
- **Intelligent Film Base Detection**: Automatically detects and corrects color casts from film base
- **User-Controllable Correction**: Adjustable film correction strength (0-100%)
- **Advanced Color Correction**: Temperature, tint, and individual channel adjustments
- **Professional Controls**: Exposure, contrast, gamma, saturation, highlight/shadow recovery
- **Real-time Preview**: Interactive web interface with live updates
- **Debug Visualization**: Shows detected film base areas for validation

## Installation

### Quick Setup (Recommended - using uv)

1. **Install uv** (fast Python package manager):
   ```bash
   # Windows PowerShell
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   
   # macOS/Linux  
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

   **Note**: After installation, restart your terminal or add `C:\Users\{YourUsername}\.local\bin` to your PATH.

2. **Install project dependencies**:
   ```bash
   # Install everything from pyproject.toml
   uv sync
   
   # Install with development dependencies
   uv sync --extra dev
   ```

3. **Run the application**:
   ```bash
   # Start the web application
   uv run python main.py
   ```

   The application will be available at `http://localhost:5000`
   
4. **Verify everything works**:
   ```bash
   # Test all components
   uv run python test_flask.py
   ```

### Development Commands

```bash
# Install dependencies
uv sync --extra dev

# Run the app
uv run python main.py

# Run tests  
uv run python -m pytest

# Format code
uv run black src/ tests/
uv run isort src/ tests/

# Lint code
uv run flake8 src/ tests/
```

### Windows Batch Helper

```cmd
# Install everything
.\dev.bat install

# Run application  
.\dev.bat run

# Run tests
.\dev.bat test

# Clean cache files
.\dev.bat clean
```

4. **Open your browser** to `http://localhost:5000`

## Why uv?

This project is optimized for [uv](https://docs.astral.sh/uv/), a fast Python package manager:

- **⚡ 10-100x faster** than pip for installing packages
- **🔒 Reliable** dependency resolution
- **📦 Better caching** and virtual environment management  
- **🔄 Compatible** with pip and requirements.txt
- **💾 Smaller** download sizes

## Quick Start

1. Upload a scanned film negative image
2. The image will be automatically inverted to positive
3. Adjust parameters as needed:
   - **Film Correction**: 0% for pure inversion, increase for color cast correction
   - **Exposure**: Brighten/darken the image
   - **Contrast**: Adjust contrast
   - **Color Balance**: Fine-tune RGB channels
   - **Temperature/Tint**: Adjust white balance

## Project Structure

```
film_processing/
├── src/                    # Core source code
│   ├── __init__.py        # Package initialization
│   ├── app.py             # Flask web application
│   └── film_processing.py # Core processing algorithms
├── tests/                 # Tests
│   └── test_basic.py      # Basic functionality tests
├── docs/                  # Documentation
│   └── ALGORITHM.md       # Technical algorithm documentation
├── examples/              # Usage examples
│   ├── analyze_negative.py
│   └── compare_corrections.py
├── templates/             # HTML templates
├── images_archive/        # Sample images (moved for performance)
├── .vscode/              # VS Code settings
├── .venv/                # Virtual environment
├── main.py               # Main entry point
├── pyproject.toml        # Dependencies and project config
├── dev.bat               # Development helper (Windows)
└── README.md            # This file
```

## Algorithm Details

The film processing algorithm uses a sophisticated approach:

1. **Edge Analysis**: Determines if the image is full-frame or has borders
2. **Film Base Detection**: Identifies unexposed film areas using:
   - Thin border detection for full-frame shots
   - Broader border detection for images with clear borders
   - Conservative validation to avoid using image content
3. **Color Correction**: Applies user-controlled subtractive correction
4. **Fallback Methods**: Robust handling when detection fails

## Usage Examples

### Command Line Processing
See `examples/` folder for standalone processing scripts.

### Web Interface
1. Start the server: `python main.py`
2. Navigate to `http://localhost:5000`
3. Upload image and adjust parameters

## Technical Notes

- **Default Behavior**: Film correction is disabled by default (0%)
- **Memory Optimized**: Large images moved to archive folder
- **Robust**: Multiple fallback methods ensure reliable results
- **Professional**: Industry-standard film base correction techniques

## Troubleshooting

- **High Memory Usage**: Large images have been moved to `images_archive/`
- **Import Errors**: Install requirements with `pip install -r requirements.txt`
- **Server Issues**: Check that port 5000 is available

## Development

See `docs/` folder for detailed algorithm explanations and development notes.

## License

This project is for educational and personal use.
