# Lighting tools review

A review of the exposure / contrast / highlights / shadows / whites / blacks
sliders against how Photoshop (Camera Raw) and Lightroom implement the same
controls, and the changes made as a result. The pipeline lives in three
places that must stay identical: `static/webgl-renderer.js`,
`mobile/webgl-renderer.js`, and `src/film_processing.py`.

## Summary of findings

| Tool | Before | Problem | After |
|---|---|---|---|
| Exposure | `color * 2^ev` | ~2.2 real stops per slider stop; harsh, twitchy | `color * 2^(ev/2.2)` — true photographic stops |
| Contrast | linear pivot at 0.5 | clips both ends immediately | S-curve up (soft shoulders), linear compress down |
| Shadows | `+= amt·mask·0.3` | lifts pure black → milky, foggy look | power curve anchored at 0 and 1 |
| Highlights | `+= amt·mask·0.3` | pushes straight into clipping; no recovery | power curve anchored at 0 and 1 |
| Whites | `+= amt·mask·0.3` | duplicate of Highlights, not a white point | levels-style white point remap |
| Blacks | `+= amt·mask·0.3` | duplicate of Shadows, not a black point | levels-style black point remap |

## Detail per tool

### Exposure

**Before:** `color * 2^exposure` on the gamma-encoded (~2.2) image.

One stop of scene light corresponds to a gain of `2^(1/2.2) ≈ 1.37` on
display-encoded values, not `2.0`. Multiplying encoded values by `2^ev`
therefore applied roughly **2.2 real stops per slider stop** — the ±2 slider
actually spanned about ±4.4 stops. This is the main reason the slider felt
touchy and blew out to hard-clipped white almost immediately, while
Lightroom's Exposure at the same numbers looks gentle.

**After:** `color * 2^(exposure / 2.2)`. The slider now reads in true
photographic stops, matching what the same EV number does in Camera Raw.

### Shadows / Highlights

**Before:** additive offsets, `color += amount * mask * 0.3`, where the mask
was a luminance smoothstep. Two structural problems:

1. The shadow mask is 1.0 at pure black, so raising Shadows lifted the black
   point itself — every deep shadow got the same flat offset and the image
   went milky/washed out. Lightroom's Shadows keeps black anchored at black
   and lifts the region above it.
2. Adding a constant to all three channels regardless of their values
   desaturates and hue-shifts colors, and on the highlight side pushes
   channels past 1.0 where they hard-clip. Negative Highlights simply
   subtracted a constant instead of compressing the highlight range, so it
   darkened without recovering any tonal separation.

**After:** per-channel power curves, applied like a curves adjustment.
Shadows uses `x^g` with `g = e^(-shadows·1.2)`, faded in below ~0.7;
Highlights mirrors it from the top, `1-(1-x)^g` with `g = e^(highlights·1.2)`,
faded in above ~0.3. Both curves are anchored at 0 **and** 1, so:

- Shadows +max lifts 0.10 → ~0.27 (Lightroom-like) while pure black stays 0.
- Highlights −max compresses 0.90 → ~0.73 while pure white stays 1 —
  actual rolloff/recovery instead of uniform darkening.
- Being multiplicative-shaped rather than additive, they no longer fog
  blacks or clip whites, and color relationships survive.

### Whites / Blacks

**Before:** the same additive-offset construction as Highlights/Shadows with
a narrower mask — effectively a second Highlights and a second Shadows
slider, which is why the four tools felt redundant.

**After:** levels-style endpoint remaps, which is what these sliders mean in
Camera Raw:

- Whites moves the **white point**: `x / (1 - whites·0.25)`, faded toward
  the bright end. Positive re-clips the top (brightens near-whites into
  clipping on purpose), negative pulls the white point down.
- Blacks moves the **black point**: `(x - b)/(1 - b)` with
  `b = -blacks·0.25`, faded toward the dark end. Negative crushes below the
  new black point to 0; positive deliberately raises the floor (a matte
  look — that lift is intentional here, unlike the accidental one Shadows
  used to have).

The tone curve is monotone across all slider-extreme combinations
(verified numerically over an 81-combination sweep).

### Contrast

**Before:** `(color - 0.5) * (1 + contrast) + 0.5` — a straight line pivoted
at 0.5. Positive contrast ran shadows into 0 and highlights into 1 with hard
clipping almost immediately.

**After:** positive contrast blends toward a smoothstep S-curve
(`c·c·(3-2c)`), which steepens the midtones while the shoulders roll off
smoothly and the endpoints stay anchored — no clipping, like the modern
Photoshop Brightness/Contrast and Lightroom's Contrast. Negative contrast
keeps the linear compress (contraction can't clip, and linear flattening is
the expected behavior).

## What was verified

- `tests/test_basic.py` (17 tests, including new anchoring/endpoint tests)
  passes on the CPU pipeline.
- Both fragment shaders compile and link in headless Chromium WebGL.
- Preview/export parity: the desktop shader render and the Python pipeline
  agree within 1/255 on a 256-step gradient under two aggressive mixed
  parameter sets.

## Known remaining gaps vs. Lightroom (not addressed)

- Lightroom's Shadows/Highlights are *local* (spatially adaptive tone
  mapping with local contrast preservation); these are global curves. Global
  is the right call for this codebase's exact-parity GPU/CPU design, but
  very strong shadow lifts will look flatter than Lightroom's.
- Exposure has no highlight-rolloff shoulder of its own; the Highlights
  slider provides the recovery instead.
- Temperature/tint, saturation, and the luma coefficients used by
  saturation (Rec.601 rather than Rec.709) were out of scope for this
  review.
