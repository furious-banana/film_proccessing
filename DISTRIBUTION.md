# Film Processor - Distribution Guide

## Building for Distribution

### Quick Build

Run: `build.bat`

This creates `dist\FilmProcessor-Portable.exe` - a standalone executable.

### What Users Need

**Option 1: Python Already Installed (Simplest)**
- Send them `FilmProcessor-Portable.exe`
- They need: Python 3.11+ and `uv` installed
- The app will use their system Python

**Option 2: Bundle Everything (Best for non-technical users)**

Create a complete package:

1. **Build the app**: Run `build.bat`
2. **Create distribution folder**:
   ```
   FilmProcessor\
   ├── FilmProcessor-Portable.exe
   ├── .venv\              (copy your entire .venv folder)
   ├── src\                (copy src folder)
   ├── static\             (copy static folder)
   ├── templates\          (copy templates folder)
   ├── pyproject.toml
   └── README.txt          (instructions)
   ```

3. **Zip it up** - send the whole folder

### Installation Instructions for Users

**If using bundled .venv:**

1. Extract the ZIP file
2. Double-click `FilmProcessor-Portable.exe`
3. That's it!

**If Python needs to be installed:**

1. Install Python 3.11+: https://www.python.org/downloads/
2. Install uv: `pip install uv`
3. Run `FilmProcessor-Portable.exe`

### Notes

- The portable .exe doesn't require installation
- Settings and recent files are saved in AppData
- First launch may be slower (Python environment setup)

