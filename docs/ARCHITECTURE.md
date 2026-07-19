# Architecture

## Overview

The app is a Flask server plus a single-page frontend, optionally wrapped in
Electron for the desktop build.

```
Upload (TIFF/JPEG/PNG/BMP)
  └─ src/app.py:_load_image()      decode, 16-bit aware, Adobe RGB → sRGB
       └─ FilmProcessor(img)       float32 [0,1]; invert if negative;
                                   optional film base correction
            ├─ /get_raw_image      raw float32 pixels (≤5000px) → browser
            │    └─ WebGL shader   ALL live adjustments, instant
            ├─ /process            same adjustments in NumPy/CuPy (CPU
            │                      fallback preview when WebGL unavailable)
            └─ /export             same adjustments at full res → max-quality JPEG
```

## The pipeline invariant (read this before changing adjustments)

The adjustment pipeline exists in exactly **two implementations** that must
stay in sync:

1. `static/webgl-renderer.js` — the fragment shader (what the user sees)
2. `src/film_processing.py` — `FilmProcessor.apply_adjustments()`
   (what gets exported, and the CPU preview fallback)

Both apply, in this order:

```
levels (eyedropper black → white → gray points)
density balance   per-channel gamma (Auto Grade), aligns the film's dye
                  layers so grays stay neutral across the tonal range;
                  fitted by auto_grade() / computeAutoGrade() from histogram
                  percentiles + neutral-pixel medians
tone              one scalar curve: exposure (linear-light ×2^stops with a
                  soft highlight shoulder), then shadows/highlights/whites/
                  blacks/contrast/brightness (endpoint-pinned lifts,
                  soft-knee endpoint remaps, S-curve contrast, midtone-gamma
                  brightness). Applied Adobe-RGBTone-style (DNG SDK): the
                  curve is evaluated at each pixel's max and min channels
                  and the middle channel is interpolated — hue is preserved
                  exactly, saturation relaxes toward the endpoints.
                  Shadows/highlights masks are LOCAL: driven by a blurred
                  low-res luminance map, shared verbatim between renderers
                  (computeLocalLumMap) and mirrored in _local_lum_grid
tone map          uint8 grid <=128 px, 3-pass box blur, bilinear upsample
temperature/tint  ±0.05 channel shifts
RGB offsets       per-channel add
saturation        mix(gray, color, 1 + saturation)
curves            RGB curve, then per-channel curves (256-entry LUT)
clamp [0, 1]
```

Adding or changing an adjustment means changing **both files identically**.
If they disagree, the export will not match the preview — this was the root
cause of most historical bugs in this project.

Curves use monotone cubic (Fritsch–Carlson) interpolation, implemented three
times with the same algorithm: the curve editor's drawn line and the shader's
LUT textures (`buildMonotoneCubicSpline` in webgl-renderer.js, shared with
app.js) and the server LUT (`FilmProcessor._build_curve_lut`).

## Server state model

`FilmProcessor` holds one uploaded image at a time (module-level `processor`
in app.py — the app is single-user by design):

- `original` / `original_cpu` — the raw decoded scan, float32 [0,1]
- `cached_stages['initial']` — inversion + film base correction baked in;
  this is the *source* every preview/export starts from. It is never
  mutated by requests.
- `params` — the adjustment parameters; every `/process` and `/export`
  request sends the complete set (missing keys reset to neutral), so
  requests are stateless.
- Crop and undo-crop replace the original via `set_original()`, which
  rebuilds `initial` and invalidates the preview proxy.

Film base correction is baked into `initial` (it depends on analyzing the
raw negative), so when its toggle changes the frontend re-syncs params
(`/process` with `webgl: true`) and reloads the WebGL texture.

## Frontend notes

- The WebGL canvas shows the preview; a hidden `<img>` is the CPU fallback.
- The raw float32 pixels are kept client-side (`renderer.imageData`) so the
  eyedroppers sample *source* values — levels are the first pipeline stage,
  so points must be pre-adjustment values (and picks stay idempotent).
- Zoom/rotation are CSS-only on the wrapper; crop and the loupe map screen
  coordinates back through the rotation (`screenToImagePixel`,
  `screenToImageCss`). Export applies rotation server-side (`np.rot90`).
- Edit history is a snapshot stack (sliders, curves, eyedropper points,
  rotation) captured *before* each change; Ctrl+Z pops it.

## 16-bit fidelity

Uploads are normalized to float32 [0,1] (÷65535 for 16-bit). Export
multiplies back and rounds (`np.rint`), so a zero-edit export reproduces
the input TIFF exactly (verified in tests). The display path downsamples
to 5000px max, but export always uses the full-resolution source.
