#!/usr/bin/env python3
"""Tests for the film processing pipeline.

Runnable directly (python tests/test_basic.py) or via pytest.
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from film_processing import FilmProcessor


def make_test_image(h=64, w=64):
    """Deterministic float32 [0,1] RGB gradient image."""
    rng = np.random.default_rng(42)
    return rng.random((h, w, 3), dtype=np.float32)


def test_negative_inversion():
    img = make_test_image()
    processor = FilmProcessor(img, is_negative=True)
    initial = processor.get_full_res()
    if hasattr(initial, 'get'):
        initial = initial.get()
    assert np.allclose(initial, 1.0 - img, atol=1e-6), "negative should be inverted"


def test_positive_passthrough():
    img = make_test_image()
    processor = FilmProcessor(img, is_negative=False)
    initial = processor.get_full_res()
    if hasattr(initial, 'get'):
        initial = initial.get()
    assert np.allclose(initial, img, atol=1e-6), "positive should not be inverted"


def test_neutral_params_are_identity():
    img = make_test_image()
    processor = FilmProcessor(img, is_negative=False)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    assert np.allclose(out, img, atol=1e-6), "neutral params must not change pixels"


def test_exposure_is_true_stops():
    # +1 EV doubles linear light: below the highlight shoulder that is a
    # gamma-space multiply by 2^(1/2.2)
    img = make_test_image() * 0.4  # keeps linear values below the 0.9 knee
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(exposure=1.0)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    expected = img * 2.0 ** (1.0 / 2.2)
    assert np.allclose(out, expected, atol=1e-5)


def test_exposure_never_hard_clips():
    # A bright image pushed a stop must roll off below 1.0, not slam into it
    img = np.full((8, 8, 3), 0.85, dtype=np.float32)
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(exposure=1.0)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    assert out.max() < 1.0, "highlight shoulder should prevent hard clipping"
    assert out.min() > 0.95, "positive exposure must still brighten"


def test_contrast_pins_endpoints():
    # Positive contrast is an S-curve: black stays black, white stays white,
    # darks get darker and brights get brighter
    img = np.zeros((2, 4, 3), dtype=np.float32)
    img[:, 1] = 0.25
    img[:, 2] = 0.75
    img[:, 3] = 1.0
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(contrast=0.5)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    assert np.allclose(out[:, 0], 0.0, atol=1e-5), "black must stay pinned"
    assert np.allclose(out[:, 3], 1.0, atol=1e-5), "white must stay pinned"
    assert out[:, 1].mean() < 0.25, "darks should get darker"
    assert out[:, 2].mean() > 0.75, "brights should get brighter"


def test_shadows_lift_pins_endpoints():
    img = np.zeros((2, 3, 3), dtype=np.float32)
    img[:, 1] = 0.2
    img[:, 2] = 1.0
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(shadows=0.5)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    assert np.allclose(out[:, 0], 0.0, atol=1e-5), "true black must stay black"
    assert np.allclose(out[:, 2], 1.0, atol=1e-5), "white must stay pinned"
    assert out[:, 1].mean() > 0.3, "shadows should lift substantially"


def test_whites_sets_white_point():
    # Whites up remaps the white point: near-white tones reach 1.0
    img = np.full((2, 2, 3), 0.95, dtype=np.float32)
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(whites=1.0)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    assert np.allclose(out, 1.0, atol=1e-5), "0.95 gray should clip to white at whites=+1"


def test_blacks_sets_black_point():
    # Blacks down remaps the black point: near-black tones reach 0.0
    img = np.full((2, 2, 3), 0.05, dtype=np.float32)
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(blacks=-1.0)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    assert np.allclose(out, 0.0, atol=1e-5), "0.05 gray should crush to black at blacks=-1"


def test_shadows_are_local():
    # Shadows are locally masked: the same pixel value gets a bigger lift
    # in a dark neighborhood than embedded in a bright one
    dark_scene = np.full((64, 64, 3), 0.1, dtype=np.float32)
    bright_scene = np.full((64, 64, 3), 0.9, dtype=np.float32)
    bright_scene[32, 32] = 0.1

    outs = []
    for scene in (dark_scene, bright_scene):
        processor = FilmProcessor(scene, is_negative=False)
        processor.update_params(shadows=0.5)
        out = processor.apply_adjustments(processor.get_full_res())
        if hasattr(out, 'get'):
            out = out.get()
        outs.append(out[32, 32, 0])
    lift_in_dark, lift_in_bright = outs
    assert lift_in_dark > lift_in_bright + 0.05, \
        f"dark surround {lift_in_dark:.3f} vs bright surround {lift_in_bright:.3f}"


def test_highlights_recovery_is_local():
    # Highlight recovery keeps a bright pixel inside a DARK region (a
    # specular detail) almost untouched while compressing broad bright areas
    bright_scene = np.full((64, 64, 3), 0.9, dtype=np.float32)
    dark_scene = np.full((64, 64, 3), 0.1, dtype=np.float32)
    dark_scene[32, 32] = 0.9

    outs = []
    for scene in (bright_scene, dark_scene):
        processor = FilmProcessor(scene, is_negative=False)
        processor.update_params(highlights=-0.5)
        out = processor.apply_adjustments(processor.get_full_res())
        if hasattr(out, 'get'):
            out = out.get()
        outs.append(out[32, 32, 0])
    broad_bright, specular_in_dark = outs
    assert specular_in_dark > broad_bright + 0.05, \
        f"specular {specular_in_dark:.3f} vs broad bright {broad_bright:.3f}"


def test_tone_preserves_hue():
    # The luminance-ratio gain must scale channels proportionally
    img = np.zeros((2, 2, 3), dtype=np.float32)
    img[:, :] = [0.4, 0.2, 0.1]
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(shadows=0.5)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    ratios_in = img[0, 0] / img[0, 0, 0]
    ratios_out = out[0, 0] / out[0, 0, 0]
    assert np.allclose(ratios_in, ratios_out, atol=1e-4), "channel ratios must survive tone edits"


def test_linear_curves_are_identity():
    img = make_test_image()
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(curves={
        'rgb': [{'x': 0, 'y': 0}, {'x': 1, 'y': 1}],
        'red': [{'x': 0, 'y': 0}, {'x': 1, 'y': 1}],
        'green': [{'x': 0, 'y': 0}, {'x': 1, 'y': 1}],
        'blue': [{'x': 0, 'y': 0}, {'x': 1, 'y': 1}],
    })
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    assert np.allclose(out, img, atol=1e-6), "linear curves must not change pixels"


def test_eyedropper_levels():
    img = make_test_image()
    processor = FilmProcessor(img, is_negative=False)
    # Black point at 25% gray: everything below maps to 0
    processor.update_params(black_point_r=64, black_point_g=64, black_point_b=64)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    black = 64 / 255.0
    expected = np.clip((img - black) / (1.0 - black), 0.0, 1.0)
    assert np.allclose(out, expected, atol=1e-5)


def test_proxy_is_downscaled():
    img = make_test_image(200, 300)
    processor = FilmProcessor(img, is_negative=False)
    proxy = processor.get_proxy()
    assert proxy.shape[0] < 200 and proxy.shape[1] < 300


def test_unknown_params_ignored():
    img = make_test_image()
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(nonsense=123, exposure=0.5)
    assert 'nonsense' not in processor.params
    assert processor.params['exposure'] == 0.5


def test_straighten_rotates_and_expands():
    img = make_test_image(100, 200)
    processor = FilmProcessor(img, is_negative=False)

    processor.update_params(straighten=10.0)  # triggers cache rebuild
    out = processor.get_full_res()
    h, w = out.shape[:2]
    assert h > 100 and w > 200, f"rotated bbox should expand, got {w}x{h}"

    processor.update_params(straighten=0.0)
    out = processor.get_full_res()
    assert out.shape[:2] == (100, 200), "resetting angle restores original dims"


def test_film_correction_applies_on_gpu_and_cpu():
    """Regression: film base subtraction must work with CuPy arrays too."""
    img = make_test_image()
    processor = FilmProcessor(img, is_negative=True)
    plain = processor.get_full_res()
    plain = plain.get().copy() if hasattr(plain, 'get') else plain.copy()

    processor.update_params(film_correction=1.0)  # triggers cache rebuild
    corrected = processor.get_full_res()
    if hasattr(corrected, 'get'):
        corrected = corrected.get()
    assert not np.allclose(corrected, plain), "film correction should change pixels"
    assert corrected.min() >= 0.0 and corrected.max() <= 1.0


def test_get_processed_image_uint8():
    img = make_test_image()
    processor = FilmProcessor(img, is_negative=True)
    out = processor.get_processed_image()
    assert out.dtype == np.uint8
    assert out.shape == img.shape


def run_all():
    tests = [(name, fn) for name, fn in sorted(globals().items())
             if name.startswith('test_') and callable(fn)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"[PASS] {name}")
        except Exception as e:
            failed += 1
            print(f"[FAIL] {name}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} tests passed")
    return failed == 0


if __name__ == "__main__":
    sys.exit(0 if run_all() else 1)
