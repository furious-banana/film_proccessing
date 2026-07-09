# Film Processor

A desktop/web app for color-correcting scanned film negatives. Loads 16-bit
TIFF scans (and JPEG/PNG/BMP), inverts negatives, and gives you real-time
GPU-accelerated adjustments with a lossless 16-bit TIFF export that exactly
matches the on-screen preview.

## Running

**Desktop app (Electron):**

```bash
npm install        # first time only
npm start
```

**In a browser:**

```bash
uv sync            # first time only
uv run python main.py
# open http://localhost:5000
```

`dev.bat run` does the same (and sets the CUDA path for GPU acceleration).

## Features

- **Modes**: Negative (inverts the scan) or Photo (positive, no inversion) —
  set before uploading
- **Film base correction**: removes the orange mask by detecting the film
  base color from the brightest 5% of the negative
- **Tone**: exposure (stops), contrast, highlights, shadows, whites, blacks
- **Color**: red / green / blue channel offsets
- **Eyedroppers**: black / gray / white point pickers with a magnifying
  loupe; picks sample the *raw* source pixels, so picking is repeatable
- **Tone curves**: RGB + per-channel curves with up to 16 points, monotone
  cubic interpolation
- **Crop** (press `C`): drag/resize, works at any zoom/rotation, undoable,
  non-destructive (adjustments re-apply to the cropped raw data)
- **View**: zoom (buttons, `+`/`-`/`0`/`1`, Ctrl+scroll), rotate 90°,
  click-and-hold for before/after
- **Undo**: Ctrl+Z steps back through slider, curve, eyedropper, and
  rotation changes
- **Settings sidecars**: save/load all edit parameters as JSON; in the
  desktop app, `<image>_settings.json` next to the file is auto-loaded
- **Export**: full-resolution 16-bit TIFF, with rotation and crop applied;
  zero-edit exports are pixel-lossless

## Architecture (short version)

```
main.py / src/app.py        Flask server (routes, upload, export)
src/film_processing.py      FilmProcessor: the adjustment pipeline
static/webgl-renderer.js    WebGL fragment shader: live preview pipeline
static/app.js               UI logic (sliders, curves, crop, history)
templates/index.html        Single-page UI
electron-main.js            Desktop wrapper (spawns Flask, native dialogs)
```

The browser fetches the raw float32 pixels (downsampled to max 5000 px for
display) and applies all adjustments in a WebGL fragment shader, so slider
changes render instantly with no server round-trip. Export re-applies the
identical pipeline server-side at full resolution.

**The one rule when changing the pipeline:** the WebGL shader
(`webgl-renderer.js`) and `FilmProcessor.apply_adjustments()`
(`film_processing.py`) are the same pipeline implemented twice. Any change
to one must be mirrored in the other, in the same order, or preview and
export will disagree. See `docs/ARCHITECTURE.md` for details.

If CuPy + CUDA are available the server pipeline runs on the GPU;
otherwise it falls back to NumPy automatically.

## Development

```bash
uv run python tests/test_basic.py   # pipeline tests
dev.bat test                        # same
dev.bat clean                       # remove __pycache__
```

Packaging a portable Windows build: `package-for-distribution.bat`
(see `DISTRIBUTION.md`).

## Supported input formats

- **TIFF** (8/16-bit; 16-bit depth preserved end-to-end; Adobe RGB scans
  are converted to sRGB on load)
- **JPEG / PNG / BMP** (8-bit)

Export is always untagged sRGB 16-bit TIFF.
