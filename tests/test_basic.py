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


def test_exposure_doubles_values():
    img = make_test_image() * 0.4  # keep below clipping
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(exposure=1.0)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    assert np.allclose(out, img * 2.0, atol=1e-5), "+1 stop should double values"


def test_contrast_matches_shader_formula():
    img = make_test_image() * 0.5 + 0.25  # mid-range, avoid clipping
    processor = FilmProcessor(img, is_negative=False)
    processor.update_params(contrast=0.5)
    out = processor.apply_adjustments(processor.get_full_res())
    if hasattr(out, 'get'):
        out = out.get()
    expected = (img - 0.5) * 1.5 + 0.5
    assert np.allclose(out, expected, atol=1e-5)


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
