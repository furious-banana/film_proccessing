// End-to-end UI test: launches the real Electron app and drives every
// interactive feature (upload, sliders, eyedroppers, curves, undo, rotate,
// zoom, crop, film correction toggle, export).
//
// Run from the repo root:   node tests/ui_drive.mjs [path-to-test-image]
//
// Needs dev deps installed (npm install). Generates a synthetic 16-bit
// negative TIFF via uv/python if no image is given.
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

    // --- Upload the negative ---
    await page.setInputFiles('#fileInput', TIFF);
    await page.waitForFunction(() => typeof processor !== 'undefined' && processor.webglEnabled === true,
        null, { timeout: 60_000 });
    check('upload + WebGL preview enabled', true);
    await page.waitForTimeout(500);

    // Disable film base correction for the slider probes: on a synthetic
    // gradient the detected "base" is near-white and correctly crushes the
    // image to black, which would mask the slider effects.
    await page.evaluate(() => toggleControl('film_correction_basic'));
    await page.waitForFunction(() => processor.lastFilmCorrection === 0, null, { timeout: 15_000 });
    await page.waitForTimeout(1000);
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
    await page.evaluate(() => {
        const s = document.getElementById('exposure');
        s.dispatchEvent(new Event('dblclick', { bubbles: true }));
    });
    check('dblclick resets exposure', await page.evaluate(() => document.getElementById('exposure').value) === '0');

    // --- Each tone/color slider changes the rendered image ---
    // Sample a pixel in the tonal range the slider targets, pushing away
    // from clipping (bright pixels get negative values, dark positive).
    const sliderProbes = [
        { id: 'contrast', fx: 0.33, fy: 0.33, value: 'max' },
        { id: 'highlights', fx: 0.78, fy: 0.78, value: 'min' },
        { id: 'shadows', fx: 0.33, fy: 0.33, value: 'max' },
        { id: 'whites', fx: 0.9, fy: 0.9, value: 'min' },
        { id: 'blacks', fx: 0.12, fy: 0.12, value: 'max' },
        { id: 'red', fx: 0.33, fy: 0.33, value: 'max' },
        { id: 'green', fx: 0.33, fy: 0.33, value: 'max' },
        { id: 'blue', fx: 0.33, fy: 0.33, value: 'max' },
    ];
    for (const probe of sliderProbes) {
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
    await page.waitForTimeout(150);
    const showingOrig = await page.evaluate(() =>
        processor.showingOriginal && processor.webglRenderer.params.showOriginal);
    await page.mouse.up();
    await page.waitForTimeout(150);
    const backToEdit = await page.evaluate(() =>
        !processor.showingOriginal && !processor.webglRenderer.params.showOriginal);
    check('hold shows original, release restores', showingOrig && backToEdit);

    // --- Crop: toggle (C key), apply, verify dims, undo ---
    const dimsBefore = await page.evaluate(() =>
        [processor.webglRenderer.imageWidth, processor.webglRenderer.imageHeight]);
    await page.keyboard.press('c');
    await page.waitForTimeout(400);
    check('crop mode opens (C key)', await page.evaluate(() =>
        processor.cropMode && document.getElementById('cropOverlay').style.display === 'block'));
    await page.click('#applyCropBtn');
    await page.waitForFunction((prev) => {
        const r = processor.webglRenderer;
        return r.imageWidth < prev[0] && r.imageHeight < prev[1];
    }, dimsBefore, { timeout: 15_000 });
    const dimsAfter = await page.evaluate(() =>
        [processor.webglRenderer.imageWidth, processor.webglRenderer.imageHeight]);
    check('apply crop shrinks image (~80%)',
        Math.abs(dimsAfter[0] - dimsBefore[0] * 0.8) < 8 && Math.abs(dimsAfter[1] - dimsBefore[1] * 0.8) < 8,
        `${dimsBefore} -> ${dimsAfter}`);
    await page.waitForFunction(() =>
        document.getElementById('undoCropBtn').style.display !== 'none', null, { timeout: 5_000 });
    check('undo crop button appears', true);
    await page.click('#undoCropBtn');
    await page.waitForFunction((prev) =>
        processor.webglRenderer.imageWidth === prev[0], dimsBefore, { timeout: 15_000 });
    check('undo crop restores dimensions', true);

    // --- Film base correction toggle syncs + reloads texture ---
    const fcBefore = await page.evaluate(() => processor.lastFilmCorrection);
    await page.evaluate(() => toggleControl('film_correction_basic'));
    await page.waitForTimeout(1500);
    const fcAfter = await page.evaluate(() => processor.lastFilmCorrection);
    check('film correction toggle syncs to server', fcBefore !== fcAfter, `${fcBefore} -> ${fcAfter}`);

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
