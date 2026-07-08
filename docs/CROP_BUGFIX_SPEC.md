# Crop Preserves Adjustments — Bugfix Spec

## Problem Statement

Two related bugs in the crop workflow caused adjustments to be lost:

1. **Adjustments reset after crop**: After applying a crop, all lighting/colour edits (exposure, contrast, shadows, RGB channels, black point eyedropper, tone curves) visually reverted to defaults.
2. **Clicking image after crop reverted to pre-crop original**: Clicking and holding the image (before/after preview) showed the full uncropped image instead of the cropped original.

## Root Cause Analysis

### Architecture Context

The app uses a **non-destructive WebGL pipeline**:
- The backend (`/get_raw_image`) serves raw float32 pixel data to the frontend.
- The frontend loads this into a WebGL texture and applies all adjustments (exposure, contrast, curves, eyedropper, etc.) via GPU shaders in real-time.
- The backend's `FilmProcessor.params` are **never updated** during WebGL editing — all slider state lives client-side only.

### Bug 1: Adjustments reset after crop

**Cause**: The `/crop` endpoint called `processor.get_processed_image()`, which applies the backend's `params` (all zeros/defaults) to produce a fully-baked uint8 image. It then:
1. Converted this baked image back to float32 to set as the new `processor.original`.
2. The frontend called `displayImage()` which hid the WebGL canvas and showed a static JPEG — the unadjusted, baked crop result.

The adjustments were still set in the UI sliders but the WebGL texture was stale (pre-crop full image) and hidden behind a JPEG with no adjustments baked in.

### Bug 2: Click showed pre-crop image

**Cause**: After crop, the frontend set `this.originalImage` to the returned JPEG but never reloaded the WebGL texture. The `handlePreviewMouseDown` handler sets `showOriginal: true` on the WebGL renderer, which displays the raw texture — still containing the old full-size pre-crop image data.

## Fix Applied

### Backend (`src/app.py` — `/crop` endpoint)

**Before**: Cropped `processor.get_processed_image()` (baked uint8 with default params), then converted back to float32.

**After**: Crops `processor.original` directly (raw float32 data, no adjustments applied). This preserves the non-destructive pipeline — the new original is still raw pixels that WebGL shaders can process.

Key changes:
- Read from `processor.original` instead of `processor.get_processed_image()`
- Handle GPU→CPU transfer (`CuPy .get()`) if needed
- Scale display-space coordinates to full-res using `max_display_size` logic based on actual original dimensions
- Set `processor.original`, `processor.original_image`, and `processor.original_cpu` to the cropped data
- Return the `cached_stages['initial']` (with negative inversion if applicable) for the response image

### Frontend (`static/app.js` — `applyCrop()`)

**Before**: Called `this.displayImage(data.image)` which hid the WebGL canvas and showed a static JPEG, then tried to call `updateImage()` on the now-hidden WebGL.

**After**: When WebGL is active, reloads the texture from `/get_raw_image` (which now serves the cropped original), then calls `updateImage()` to reapply all current slider/curve/eyedropper adjustments via the GPU shader.

```javascript
// Before (broken)
this.displayImage(data.image);
if (wasWebGLEnabled && this.webglRenderer) {
    await this.updateImage();
}

// After (fixed)
if (this.webglEnabled && this.webglRenderer) {
    await this.webglRenderer.loadImage('/get_raw_image');
    await this.updateImage();
} else {
    this.displayImage(data.image);
}
```

## Verification Procedure

1. Load a photo in Photo mode
2. Apply multiple adjustment types:
   - Tone sliders (exposure +0.5, contrast 25, shadows 30)
   - RGB colour channels (red -15, blue +20)
   - Black point eyedropper (click to set, **click again to deactivate**)
   - Tone curve (add at least one point)
3. Click Crop, resize the crop area, click Apply Crop
4. **Check adjustments preserved**: All sliders, curve points, and eyedropper should remain set. Image should look the same (just cropped).
5. **Check before/after**: Click and hold on image — should show cropped original without adjustments (natural colours). Release — should snap back to adjusted view.
6. **Check no revert**: The before/after image must be the cropped version, not the old full-size pre-crop image.

### Important: Deactivate eyedropper before testing click-to-preview
The eyedropper intercepts mousedown events on the canvas. If it's still active, clicking the image will set another eyedropper point instead of triggering the before/after preview. Click the eyedropper button a second time to deactivate it after picking a point.

## Files Changed

| File | Change |
|------|--------|
| `src/app.py` | `/crop` endpoint crops raw original instead of processed image |
| `static/app.js` | `applyCrop()` reloads WebGL texture after crop |
