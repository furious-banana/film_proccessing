// End-to-end UI test: launches the real Electron app and drives every
// interactive feature (upload, sliders, eyedroppers, curves, undo, rotate,
// zoom, crop, film correction toggle, export).
//
// Run from the repo root:
//   node tests/ui_drive.mjs [path-to-test-image] [negative|photo]
//
// Mode defaults to "negative". Use "photo" for scans your scanner has
// already converted to a positive. Needs dev deps installed (npm install).
// Generates a synthetic 16-bit negative TIFF via uv/python if no image
// is given.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(APP_DIR, 'package.json'));
const { _electron: electron } = require('playwright-core');

const SHOT_DIR = path.join(os.tmpdir(), 'film-processor-ui-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const MODE = (process.argv[3] || 'negative').toLowerCase();

let TIFF = process.argv[2];
if (!TIFF) {
    TIFF = path.join(os.tmpdir(), 'film_processor_test_negative.tif');
    execSync(`uv run python -c "import numpy as np, tifffile; h,w=800,1200; yy,xx=np.mgrid[0:h,0:w]; s=np.stack([xx/(w-1),yy/(h-1),(xx+yy)/(w+h-2)],axis=-1).astype(np.float32); tifffile.imwrite(r'${TIFF.replace(/\\/g, '/')}', np.round((1.0-s)*65535).astype(np.uint16), photometric='rgb')"`,
        { cwd: APP_DIR, stdio: 'inherit' });
}

const results = [];
function check(name, cond, detail = '') {
    results.push({ name, ok: !!cond, detail });
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name} ${detail}`);
}

const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules', 'electron', 'dist',
        process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [APP_DIR],
    cwd: APP_DIR,
    timeout: 60_000,
});

try {
    const page = await app.firstWindow();

    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

    await page.waitForSelector('#uploadZone', { timeout: 60_000 });
    check('app window loaded', true);

    await page.waitForFunction(() =>
        document.getElementById('versionLabel')?.textContent?.startsWith('v'), null, { timeout: 15_000 });

    // --- Upload ---
    if (MODE === 'photo') {
        await page.evaluate(() => switchImageMode('photo'));
    }
    await page.setInputFiles('#fileInput', TIFF);
    // Large 16-bit scans can take a while to decode/convert
    await page.waitForFunction(() => typeof processor !== 'undefined' && processor.webglEnabled === true,
        null, { timeout: 300_000 });
    check('upload + WebGL preview enabled', true);
    await page.waitForTimeout(500);

    if (MODE !== 'photo') {
        // Disable film base correction for the slider probes: on a synthetic
        // gradient the detected "base" is near-white and correctly crushes
        // the image to black, which would mask the slider effects.
        await page.evaluate(() => toggleControl('film_correction_basic'));
        await page.waitForFunction(() =>
            processor.lastBaked && processor.lastBaked.film_correction === 0, null, { timeout: 15_000 });
        await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: path.join(SHOT_DIR, '02-uploaded.png') });

    const samplePixel = (fx, fy) => page.evaluate(([px, py]) => {
        const c = document.getElementById('webglCanvas');
        const t = document.createElement('canvas'); t.width = 1; t.height = 1;
        const ctx = t.getContext('2d');
        ctx.drawImage(c, Math.floor(c.width * px), Math.floor(c.height * py), 1, 1, 0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3).join(',');
    }, [fx, fy]);

    // --- Exposure slider: +1 stop should brighten ---
    const before = await samplePixel(0.25, 0.25);
    await page.evaluate(() => {
        const s = document.getElementById('exposure');
        s.value = 1.0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const after = await samplePixel(0.25, 0.25);
    check('exposure +1 brightens preview', before !== after, `${before} -> ${after}`);

    // Micro-drags (presses that change the value) must NEVER reset the
    // slider, no matter how quickly they repeat (micro-adjustment guard)
    const microNoReset = await page.evaluate(async () => {
        const s = document.getElementById('exposure');
        const microDrag = (v) => {
            s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            s.value = v;
            s.dispatchEvent(new Event('input', { bubbles: true }));
            s.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        };
        microDrag(1.02);
        await new Promise(r => setTimeout(r, 100));
        microDrag(1.04);
        return s.value;
    });
    check('micro-drags never reset the slider', microNoReset === '1.04',
        `value ${microNoReset}`);

    // ... but a double-click on the slider's LABEL resets it
    const labelReset = await page.evaluate(() => {
        const s = document.getElementById('exposure');
        const label = s.closest('.control-row').querySelector('.control-label');
        label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return s.value;
    });
    check('double-click on the label resets exposure', labelReset === '0',
        `value ${labelReset}`);

    // --- Each tone/color slider changes the rendered image ---
    // Each slider only affects a certain tonal range, and additive sliders
    // do nothing on clipped pixels, so search the image for a pixel whose
    // channels sit in the range the slider targets (works on any photo).
    const findProbe = (minC, maxC) => page.evaluate(([lo, hi]) => {
        const c = document.getElementById('webglCanvas');
        const N = 80;
        const t = document.createElement('canvas'); t.width = N; t.height = N;
        const ctx = t.getContext('2d');
        ctx.drawImage(c, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        for (let y = 8; y < N - 8; y++) {
            for (let x = 8; x < N - 8; x++) {
                const i = (y * N + x) * 4;
                const mn = Math.min(d[i], d[i + 1], d[i + 2]);
                const mx = Math.max(d[i], d[i + 1], d[i + 2]);
                if (mn >= lo && mx <= hi) return [(x + 0.5) / N, (y + 0.5) / N];
            }
        }
        return null;
    }, [minC, maxC]);

    const sliderProbes = [
        { id: 'contrast', range: [60, 190], value: 'max' },
        { id: 'highlights', range: [170, 245], value: 'min' }, // bright (min darkens, so clipping is fine)
        { id: 'shadows', range: [30, 120], value: 'max' },     // dark midtones
        { id: 'whites', range: [210, 255], value: 'min' },     // near-white, well inside the mask
        { id: 'blacks', range: [12, 64], value: 'max' },       // deep shadows
        { id: 'red', range: [50, 190], value: 'max' },
        { id: 'green', range: [50, 190], value: 'max' },
        { id: 'blue', range: [50, 190], value: 'max' },
    ];
    for (const probe of sliderProbes) {
        const pos = await findProbe(probe.range[0], probe.range[1]);
        if (!pos) {
            console.log(`[SKIP] slider '${probe.id}': no pixel in range ${probe.range} on this image`);
            continue;
        }
        [probe.fx, probe.fy] = pos;
        const b = await samplePixel(probe.fx, probe.fy);
        await page.evaluate(([sid, dir]) => {
            const s = document.getElementById(sid);
            s.value = dir === 'max' ? s.max : s.min;
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }, [probe.id, probe.value]);
        await page.waitForTimeout(150);
        const a = await samplePixel(probe.fx, probe.fy);
        check(`slider '${probe.id}' affects preview`, b !== a, `${b} -> ${a}`);
        await page.evaluate((sid) => {
            const s = document.getElementById(sid);
            s.value = 0;
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }, probe.id);
    }

    // --- Eyedropper: pick black point, verify idempotence ---
    const canvasBox = await page.evaluate(() => {
        const r = document.getElementById('webglCanvas').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await page.click('#blackPointBtn');
    const pickX = canvasBox.x + canvasBox.w * 0.2;
    const pickY = canvasBox.y + canvasBox.h * 0.2;
    await page.mouse.move(pickX, pickY);
    await page.waitForTimeout(200);
    await page.mouse.move(pickX, pickY); // rAF-throttled loupe needs a move
    await page.waitForTimeout(200);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(300);
    const pick1 = await page.evaluate(() => processor.blackPoint && [...processor.blackPoint]);
    check('black point eyedropper picks a value', Array.isArray(pick1), JSON.stringify(pick1));
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(300);
    const pick2 = await page.evaluate(() => processor.blackPoint && [...processor.blackPoint]);
    check('eyedropper is idempotent (samples source)',
        JSON.stringify(pick1) === JSON.stringify(pick2), `${JSON.stringify(pick1)} vs ${JSON.stringify(pick2)}`);
    await page.click('#resetEyedroppersBtn');
    await page.waitForTimeout(200);
    check('reset eyedroppers clears points',
        await page.evaluate(() => processor.blackPoint === null && processor.eyedropperMode === null));

    // --- Curves: add a point via mouse on the curve canvas ---
    await page.evaluate(() => document.getElementById('curvesCanvas').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    const curveBox = await page.evaluate(() => {
        const r = document.getElementById('curvesCanvas').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await page.mouse.move(curveBox.x + curveBox.w * 0.5, curveBox.y + curveBox.h * 0.4);
    await page.mouse.down();
    await page.mouse.move(curveBox.x + curveBox.w * 0.5, curveBox.y + curveBox.h * 0.35);
    await page.mouse.up();
    await page.waitForTimeout(200);
    check('curve point added by click-drag',
        await page.evaluate(() => processor.curves.rgb.length) === 3);
    await page.click('#resetCurvesBtn');
    await page.waitForTimeout(200);
    check('reset curve restores linear',
        await page.evaluate(() => processor.curves.rgb.length) === 2);

    // --- Undo (Ctrl+Z) restores previous slider state ---
    await page.evaluate(() => {
        const s = document.getElementById('contrast');
        s.dispatchEvent(new Event('mousedown', { bubbles: true }));
        s.value = 0.5;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('mouseup', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    check('Ctrl+Z undoes slider change',
        await page.evaluate(() => document.getElementById('contrast').value) === '0');

    // --- Rotate right, undo restores rotation ---
    await page.click('#rotateRightBtn');
    await page.waitForTimeout(200);
    check('rotate right sets 90deg', await page.evaluate(() => processor.rotation) === 90);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    check('Ctrl+Z undoes rotation', await page.evaluate(() => processor.rotation) === 0);

    // --- Zoom controls ---
    await page.click('#zoomInBtn');
    await page.waitForTimeout(100);
    check('zoom in updates label',
        await page.evaluate(() => document.getElementById('zoomLevel').textContent) === '120%');
    await page.click('#zoomFitBtn');
    await page.waitForTimeout(100);
    check('zoom fit back to 100%',
        await page.evaluate(() => document.getElementById('zoomLevel').textContent) === '100%');

    // --- Before/after hold shows original ---
    await page.mouse.move(canvasBox.x + canvasBox.w / 2, canvasBox.y + canvasBox.h / 2);
    await page.mouse.down();
    let showingOrig = false;
    try {
        await page.waitForFunction(() =>
            processor.showingOriginal && processor.webglRenderer.params.showOriginal,
            null, { timeout: 5_000 });
        showingOrig = true;
    } catch { /* stays false */ }
    await page.mouse.up();
    let backToEdit = false;
    try {
        await page.waitForFunction(() =>
            !processor.showingOriginal && !processor.webglRenderer.params.showOriginal,
            null, { timeout: 5_000 });
        backToEdit = true;
    } catch { /* stays false */ }
    check('hold shows original, release restores', showingOrig && backToEdit);

    // --- Clipping threshold preview (Photoshop Alt-drag style): shown
    // only while HOLDING a tone slider with the Clip toggle on ---
    await page.evaluate(() => {
        const s = document.getElementById('exposure');
        s.value = 2;
        s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#clippingBtn');
    await page.evaluate(() => {
        document.getElementById('whites').dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const thresh = await page.evaluate(() => {
        // Threshold view signature: every pixel is saturated per channel
        const c = document.getElementById('webglCanvas');
        const N = 80;
        const t = document.createElement('canvas'); t.width = N; t.height = N;
        const ctx = t.getContext('2d');
        ctx.drawImage(c, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        let sat = 0;
        for (let i = 0; i < d.length; i += 4) {
            if ([d[i], d[i + 1], d[i + 2]].every(v => v < 10 || v > 245)) sat++;
        }
        return { satFrac: sat / (N * N), mode: processor.webglRenderer.params.clipMode };
    });
    check('holding whites shows the threshold view (clip on)',
        thresh.mode === 1 && thresh.satFrac > 0.95, JSON.stringify(thresh));
    const clipRelease = await page.evaluate(() => {
        const up = (id) => document.getElementById(id).dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true }));
        const down = (id) => document.getElementById(id).dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }));
        up('whites');
        const afterRelease = processor.webglRenderer.params.clipMode;
        down('blacks');
        const blacksMode = processor.webglRenderer.params.clipMode;
        up('blacks');
        return { afterRelease, blacksMode };
    });
    check('release restores; blacks = shadow threshold',
        clipRelease.afterRelease === 0 && clipRelease.blacksMode === 2,
        JSON.stringify(clipRelease));
    await page.click('#clippingBtn'); // toggle back off
    const clipOff = await page.evaluate(() => {
        const w = document.getElementById('whites');
        w.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const mode = processor.webglRenderer.params.clipMode;
        w.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        const s = document.getElementById('exposure');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        return mode;
    });
    check('clip toggle off = no threshold preview', clipOff === 0);

    // --- Straighten: fine rotation bakes server-side, bbox expands ---
    const dimsPreStraighten = await page.evaluate(() =>
        [processor.webglRenderer.imageWidth, processor.webglRenderer.imageHeight]);
    await page.evaluate(() => {
        const s = document.getElementById('straighten');
        s.value = 10;
        s.dispatchEvent(new Event('input', { bubbles: true }));   // CSS preview
        s.dispatchEvent(new Event('change', { bubbles: true }));  // bake
    });
    // Large scans re-transfer a ~200MB float texture on rebake - be patient.
    // Note: the display caps the long side at 5000px, so for big scans only
    // the short side of the bounding box visibly grows.
    await page.waitForFunction((prev) =>
        processor.webglRenderer.imageWidth > prev[0] || processor.webglRenderer.imageHeight > prev[1],
        dimsPreStraighten, { timeout: 120_000 });
    const dimsStraightened = await page.evaluate(() =>
        [processor.webglRenderer.imageWidth, processor.webglRenderer.imageHeight]);
    check('straighten 10deg expands bounding box',
        dimsStraightened[0] > dimsPreStraighten[0] || dimsStraightened[1] > dimsPreStraighten[1],
        `${dimsPreStraighten} -> ${dimsStraightened}`);
    await page.evaluate(() => {
        const s = document.getElementById('straighten');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction((prev) =>
        processor.webglRenderer.imageWidth === prev[0], dimsPreStraighten, { timeout: 120_000 });
    check('straighten reset restores dimensions', true);

    // --- Presets: save, apply, delete ---
    await page.evaluate(() => {
        document.getElementById('contrast').value = 0.25;
        document.getElementById('presetName').value = 'ui-test-preset';
    });
    await page.click('#savePresetBtn');
    await page.evaluate(() => {
        const s = document.getElementById('contrast');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => { document.getElementById('presetSelect').value = 'ui-test-preset'; });
    await page.click('#applyPresetBtn');
    await page.waitForTimeout(400);
    check('preset save + apply restores slider values',
        await page.evaluate(() => document.getElementById('contrast').value) === '0.25');
    await page.click('#deletePresetBtn');
    await page.waitForTimeout(200);
    check('preset delete removes it',
        await page.evaluate(() =>
            ![...document.getElementById('presetSelect').options].some(o => o.value === 'ui-test-preset')));
    // Reset contrast for the remaining checks
    await page.evaluate(() => {
        const s = document.getElementById('contrast');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // --- Crop: toggle (C key), apply, verify dims, undo ---
    const dimsBefore = await page.evaluate(() =>
        [processor.webglRenderer.imageWidth, processor.webglRenderer.imageHeight]);
    await page.keyboard.press('c');
    await page.waitForTimeout(400);
    check('crop mode opens (C key)', await page.evaluate(() =>
        processor.cropMode && document.getElementById('cropOverlay').style.display === 'block'));
    check('straighten bar appears in crop mode', await page.evaluate(() =>
        document.getElementById('straightenBar').style.display === 'flex'));

    // Straighten while cropping: the image rotates behind a FIXED crop box
    const cropRectBefore = await page.evaluate(() => {
        const r = document.getElementById('cropArea').getBoundingClientRect();
        return [r.left, r.top, r.width, r.height].map(Math.round);
    });
    const cssBefore = await page.evaluate(() => {
        const el = processor.getActiveImageElement();
        return [el.offsetWidth, el.offsetHeight];
    });
    await page.evaluate(() => {
        const s = document.getElementById('straighten');
        s.value = 3;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => processor.bakedStraighten === 3, null, { timeout: 120_000 });
    await page.waitForTimeout(600); // overlay reposition settles
    const cropRectAfter = await page.evaluate(() => {
        const r = document.getElementById('cropArea').getBoundingClientRect();
        return [r.left, r.top, r.width, r.height].map(Math.round);
    });
    check('crop box stays fixed while straightening',
        cropRectBefore.every((v, i) => Math.abs(v - cropRectAfter[i]) <= 2),
        `${cropRectBefore} vs ${cropRectAfter}`);

    // No zoom: the content scale is preserved, so the on-screen size must
    // equal the rotated bounding box of the ORIGINAL on-screen size
    const cssAfter = await page.evaluate(() => {
        const el = processor.getActiveImageElement();
        return [el.offsetWidth, el.offsetHeight];
    });
    const th = 3 * Math.PI / 180;
    const expectW = cssBefore[0] * Math.cos(th) + cssBefore[1] * Math.sin(th);
    const expectH = cssBefore[0] * Math.sin(th) + cssBefore[1] * Math.cos(th);
    check('straighten keeps content scale (no zoom)',
        Math.abs(cssAfter[0] - expectW) / expectW < 0.015
        && Math.abs(cssAfter[1] - expectH) / expectH < 0.015,
        `${cssBefore} -> ${cssAfter}, expected ~[${Math.round(expectW)}, ${Math.round(expectH)}]`);
    await page.evaluate(() => {
        const s = document.getElementById('straighten');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => processor.bakedStraighten === 0, null, { timeout: 120_000 });
    await page.waitForTimeout(600);

    // Regression: a REAL held drag that crosses the baked angle (0) must
    // not snap the crop box - the watcher used to wake for the one frame
    // where delta == 0 and "correct" the overlay mid-drag
    const sweepJumps = await page.evaluate(() => {
        window._sweepMon = { jumps: 0, prev: null };
        const tick = () => {
            const a = document.getElementById('cropArea');
            if (a && processor.cropMode) {
                const r = a.getBoundingClientRect();
                const p = window._sweepMon.prev;
                if (p && Math.max(Math.abs(r.left - p.left), Math.abs(r.top - p.top),
                    Math.abs(r.width - p.width), Math.abs(r.height - p.height)) > 2) {
                    window._sweepMon.jumps++;
                }
                window._sweepMon.prev = r;
                window._sweepMon.raf = requestAnimationFrame(tick);
            }
        };
        tick();
        return true;
    });
    const sBox = await page.evaluate(() => {
        const r = document.getElementById('straighten').getBoundingClientRect();
        return { x: r.left, y: r.top + r.height / 2, w: r.width };
    });
    const xForVal = (v) => sBox.x + ((v + 45) / 90) * sBox.w;
    await page.mouse.move(xForVal(2), sBox.y);
    await page.mouse.down();
    for (let i = 0; i <= 30; i++) {
        await page.mouse.move(xForVal(2 - (4 * i) / 30), sBox.y); // 2 -> -2
        await page.waitForTimeout(15);
    }
    for (let i = 0; i <= 15; i++) {
        await page.mouse.move(xForVal(-2 + (3 * i) / 15), sBox.y); // -2 -> +1
        await page.waitForTimeout(15);
    }
    await page.mouse.up(); // release bakes at ~+1 (screen lock pins the box)
    await page.waitForFunction(() => processor.bakedStraighten > 0.5, null, { timeout: 120_000 });
    await page.waitForTimeout(1000); // bake + lock window settle
    const jumps = await page.evaluate(() => {
        cancelAnimationFrame(window._sweepMon.raf);
        return window._sweepMon.jumps;
    });
    check('crop box never jumps while dragging through zero',
        sweepJumps && jumps === 0, `${jumps} jumps`);

    // Normalize back to exactly 0 for the crop steps below
    await page.evaluate(() => {
        const s = document.getElementById('straighten');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => processor.bakedStraighten === 0, null, { timeout: 120_000 });
    await page.waitForTimeout(600);

    await page.click('#applyCropBtn');
    await page.waitForFunction((prev) => {
        const r = processor.webglRenderer;
        return r.imageWidth < prev[0] && r.imageHeight < prev[1];
    }, dimsBefore, { timeout: 15_000 });
    const dimsAfter = await page.evaluate(() =>
        [processor.webglRenderer.imageWidth, processor.webglRenderer.imageHeight]);
    // The default crop is 80% of the displayed image. For scans larger than
    // the 5000px display cap, the cropped result may no longer need
    // downsampling, so the ratio vs the previous DISPLAY dims can be up to
    // 0.8 * (full/display). Both axes must shrink by the same factor.
    const ratioX = dimsAfter[0] / dimsBefore[0];
    const ratioY = dimsAfter[1] / dimsBefore[1];
    check('apply crop shrinks image (~80%)',
        ratioX > 0.7 && ratioX < 0.96 && Math.abs(ratioX - ratioY) < 0.02,
        `${dimsBefore} -> ${dimsAfter} (ratio ${ratioX.toFixed(3)}/${ratioY.toFixed(3)})`);
    await page.waitForFunction(() =>
        document.getElementById('undoCropBtn').style.display !== 'none', null, { timeout: 5_000 });
    check('undo crop button appears', true);
    await page.click('#undoCropBtn');
    await page.waitForFunction((prev) =>
        processor.webglRenderer.imageWidth === prev[0], dimsBefore, { timeout: 15_000 });
    check('undo crop restores dimensions', true);

    // --- Film base correction toggle syncs + reloads texture ---
    if (MODE !== 'photo') {
        const fcBefore = await page.evaluate(() => processor.lastBaked?.film_correction);
        await page.evaluate(() => toggleControl('film_correction_basic'));
        await page.waitForTimeout(1500);
        const fcAfter = await page.evaluate(() => processor.lastBaked?.film_correction);
        check('film correction toggle syncs to server', fcBefore !== fcAfter, `${fcBefore} -> ${fcAfter}`);
    }

    // --- Export via fetch (avoids the native save dialog) ---
    const exportInfo = await page.evaluate(async () => {
        const resp = await fetch('/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(processor.getParameters())
        });
        const buf = await resp.arrayBuffer();
        return { ok: resp.ok, type: resp.headers.get('content-type'), bytes: buf.byteLength };
    });
    check('export returns 16-bit TIFF',
        exportInfo.ok && exportInfo.type === 'image/tiff' && exportInfo.bytes > 100000,
        JSON.stringify(exportInfo));

    // --- Settings round trip ---
    const rt = await page.evaluate(() => {
        document.getElementById('shadows').value = 0.25;
        const saved = processor.getParameters();
        document.getElementById('shadows').value = 0;
        processor.applySettings(saved);
        return document.getElementById('shadows').value;
    });
    check('settings save/apply round-trips slider values', rt === '0.25', rt);

    await page.screenshot({ path: path.join(SHOT_DIR, '06-final.png') });

    const realErrors = consoleErrors.filter(e => !e.includes('favicon'));
    check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));
} finally {
    await app.close().catch(() => {});
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
console.log(`Screenshots: ${SHOT_DIR}`);
process.exit(failed.length ? 1 : 0);
