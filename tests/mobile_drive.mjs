// End-to-end test of the standalone mobile app (mobile/): loads it in an
// Electron window, exercises every control, and cross-checks an exported
// 16-bit TIFF pixel-for-pixel against the desktop Python pipeline.
//
// Run from the repo root:   node tests/mobile_drive.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(APP_DIR, 'package.json'));
const { _electron: electron } = require('playwright-core');

const TIFF = path.join(os.tmpdir(), 'film_mobile_test_negative.tif');
execSync(`uv run python -c "import numpy as np, tifffile; h,w=800,1200; yy,xx=np.mgrid[0:h,0:w]; s=np.stack([xx/(w-1),yy/(h-1),(xx+yy)/(w+h-2)],axis=-1).astype(np.float32); tifffile.imwrite(r'${TIFF.replace(/\\/g, '/')}', np.round((1.0-s)*65535).astype(np.uint16), photometric='rgb')"`,
    { cwd: APP_DIR, stdio: 'inherit' });

const results = [];
function check(name, cond, detail = '') {
    results.push({ name, ok: !!cond });
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name} ${detail}`);
}

const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules', 'electron', 'dist',
        process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [path.join(APP_DIR, 'tests', 'mobile_electron_main.cjs')],
    cwd: APP_DIR,
    timeout: 60_000,
});

try {
    const page = await app.firstWindow();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    await page.waitForFunction(() => typeof mobileApp !== 'undefined', null, { timeout: 30_000 });
    check('mobile app boots', true);

    // --- Load the synthetic negative (negative mode is the default) ---
    await page.setInputFiles('#fileInput', TIFF);
    await page.waitForFunction(() =>
        mobileApp.renderer && mobileApp.renderer.imageWidth > 0, null, { timeout: 60_000 });
    const dims = await page.evaluate(() =>
        [mobileApp.renderer.imageWidth, mobileApp.renderer.imageHeight]);
    check('16-bit TIFF decoded at native size', dims[0] === 1200 && dims[1] === 800, dims.join('x'));

    // Open every collapsed section so all controls are clickable
    await page.evaluate(() => {
        document.querySelectorAll('details').forEach(d => { d.open = true; });
    });

    // Film correction defaults ON; disable for deterministic pixel checks
    await page.evaluate(() => {
        const t = document.getElementById('filmCorrToggle');
        t.checked = false;
        t.dispatchEvent(new Event('change'));
    });
    await page.waitForTimeout(400);

    // Canvas shows the INVERTED image
    const px = await page.evaluate(() => {
        const c = document.getElementById('viewCanvas');
        const t = document.createElement('canvas'); t.width = 1; t.height = 1;
        const ctx = t.getContext('2d');
        ctx.drawImage(c, c.width / 2, c.height / 2, 1, 1, 0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    });
    check('preview renders inverted image', px[0] + px[1] + px[2] > 100, JSON.stringify(px));

    // --- Sliders change the preview ---
    const sample = () => page.evaluate(() => {
        const c = document.getElementById('viewCanvas');
        const t = document.createElement('canvas'); t.width = 1; t.height = 1;
        const ctx = t.getContext('2d');
        ctx.drawImage(c, c.width / 3, c.height / 3, 1, 1, 0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3).join(',');
    });
    for (const id of ['exposure', 'contrast', 'shadows', 'red', 'green', 'blue']) {
        const before = await sample();
        await page.evaluate((sid) => {
            const s = document.getElementById(sid);
            s.value = s.max;
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }, id);
        await page.waitForTimeout(120);
        const after = await sample();
        check(`slider '${id}' affects preview`, before !== after, `${before} -> ${after}`);
        await page.evaluate((sid) => {
            const s = document.getElementById(sid);
            s.value = 0;
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }, id);
    }

    // --- Eyedropper: activate, tap image, idempotent source sampling ---
    await page.evaluate(() => document.getElementById('blackPointBtn').scrollIntoView({ block: 'center' }));
    await page.click('#blackPointBtn');
    // Bring the canvas back on screen before tapping it
    await page.evaluate(() => document.getElementById('viewCanvas').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    const box = await page.evaluate(() => {
        const r = document.getElementById('viewCanvas').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const tapX = box.x + box.w * 0.2, tapY = box.y + box.h * 0.2;
    await page.mouse.move(tapX, tapY);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(200);
    const pick1 = await page.evaluate(() => mobileApp.blackPoint && [...mobileApp.blackPoint]);
    check('eyedropper picks black point', Array.isArray(pick1), JSON.stringify(pick1));
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(200);
    const pick2 = await page.evaluate(() => mobileApp.blackPoint && [...mobileApp.blackPoint]);
    check('eyedropper idempotent (source sampling)',
        JSON.stringify(pick1) === JSON.stringify(pick2));
    await page.click('#blackPointBtn'); // deactivate
    await page.click('#resetEyedroppersBtn');
    check('reset eyedroppers', await page.evaluate(() => mobileApp.blackPoint === null));

    // --- Curves: open section, add a point by tapping ---
    await page.evaluate(() => {
        document.querySelectorAll('details').forEach(d => { d.open = true; });
        document.getElementById('curvesCanvas').scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(300);
    const cbox = await page.evaluate(() => {
        const r = document.getElementById('curvesCanvas').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await page.mouse.move(cbox.x + cbox.w * 0.5, cbox.y + cbox.h * 0.4);
    await page.mouse.down();
    await page.mouse.move(cbox.x + cbox.w * 0.5, cbox.y + cbox.h * 0.35);
    await page.mouse.up();
    await page.waitForTimeout(200);
    check('curve point added', await page.evaluate(() => mobileApp.curves.rgb.length) === 3);
    await page.click('#resetCurvesBtn');
    check('curve reset', await page.evaluate(() => mobileApp.curves.rgb.length) === 2);

    // --- Undo restores slider state ---
    await page.evaluate(() => {
        const s = document.getElementById('contrast');
        s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // saves history
        s.value = 0.3;
        s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#undoBtn');
    check('undo restores slider',
        await page.evaluate(() => document.getElementById('contrast').value) === '0');

    // --- Straighten: bake expands bounding box, reset restores ---
    await page.evaluate(() => document.getElementById('cropBtn').scrollIntoView());
    await page.click('#cropBtn');
    await page.waitForTimeout(300);
    check('crop mode opens', await page.evaluate(() => mobileApp.cropMode));
    await page.evaluate(() => {
        const s = document.getElementById('straighten');
        s.value = 10;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() =>
        mobileApp.renderer.imageWidth > 1200, null, { timeout: 30_000 });
    const rotDims = await page.evaluate(() =>
        [mobileApp.renderer.imageWidth, mobileApp.renderer.imageHeight]);
    check('straighten expands bbox', rotDims[0] > 1200 && rotDims[1] > 800, rotDims.join('x'));
    await page.evaluate(() => {
        const s = document.getElementById('straighten');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() =>
        mobileApp.renderer.imageWidth === 1200, null, { timeout: 30_000 });
    check('straighten reset restores dims', true);

    // --- Crop: apply default 80% box, then undo ---
    await page.click('#applyCropBtn');
    await page.waitForTimeout(500);
    const cropDims = await page.evaluate(() =>
        [mobileApp.renderer.imageWidth, mobileApp.renderer.imageHeight]);
    check('crop shrinks to ~80%',
        Math.abs(cropDims[0] - 960) <= 4 && Math.abs(cropDims[1] - 640) <= 4,
        cropDims.join('x'));
    await page.click('#undoCropBtn');
    await page.waitForTimeout(500);
    check('undo crop restores', await page.evaluate(() =>
        mobileApp.renderer.imageWidth === 1200));

    // --- Rotate 90 ---
    await page.click('#rotate90Btn');
    await page.waitForTimeout(500);
    check('rotate 90 swaps dims', await page.evaluate(() =>
        mobileApp.renderer.imageWidth === 800 && mobileApp.renderer.imageHeight === 1200));
    await page.click('#undoCropBtn');
    await page.waitForTimeout(500);
    check('undo rotate 90', await page.evaluate(() =>
        mobileApp.renderer.imageWidth === 1200));

    // --- Presets ---
    await page.evaluate(() => {
        document.getElementById('contrast').value = 0.25;
        document.getElementById('presetName').value = 'mobile-test';
    });
    await page.click('#savePresetBtn');
    await page.evaluate(() => {
        const s = document.getElementById('contrast');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('presetSelect').value = 'mobile-test';
    });
    await page.click('#applyPresetBtn');
    await page.waitForTimeout(200);
    check('preset save+apply',
        await page.evaluate(() => document.getElementById('contrast').value) === '0.25');
    await page.click('#deletePresetBtn');
    await page.evaluate(() => {
        const s = document.getElementById('contrast');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // --- Compare hold shows original ---
    await page.evaluate(() => document.getElementById('compareBtn').scrollIntoView());
    const cmp = await page.evaluate(async () => {
        const btn = document.getElementById('compareBtn');
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const during = mobileApp.renderer.params.showOriginal;
        btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        const after = mobileApp.renderer.params.showOriginal;
        return { during, after };
    });
    check('compare hold toggles original', cmp.during === true && cmp.after === false);

    // --- Export cross-check against the desktop Python pipeline ---
    await page.evaluate(() => {
        const set = (id, v) => {
            const s = document.getElementById(id);
            s.value = v;
            s.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('exposure', 0.5);
        set('contrast', 0.2);
        set('shadows', 0.1);
    });
    await page.waitForTimeout(300);
    const b64 = await page.evaluate(() => mobileApp.exportTiffBase64());
    const exportPath = path.join(os.tmpdir(), 'film_mobile_export.tif');
    fs.writeFileSync(exportPath, Buffer.from(b64, 'base64'));
    check('export produces a TIFF', fs.statSync(exportPath).size > 1000000,
        `${fs.statSync(exportPath).size} bytes`);

    // cmd.exe splits multi-line -c strings at newlines; use a script file
    const pyScript = path.join(os.tmpdir(), 'film_mobile_crosscheck.py');
    fs.writeFileSync(pyScript, `
import numpy as np, tifffile, sys
sys.path.insert(0, r'${APP_DIR.replace(/\\/g, '/')}/src')
from film_processing import FilmProcessor
h, w = 800, 1200
yy, xx = np.mgrid[0:h, 0:w]
scene = np.stack([xx/(w-1), yy/(h-1), (xx+yy)/(w+h-2)], axis=-1).astype(np.float32)
proc = FilmProcessor(1.0 - scene, is_negative=True)
proc.update_params(exposure=0.5, contrast=0.2, shadows=0.1)
expected = proc.apply_adjustments(proc.get_full_res())
if hasattr(expected, 'get'):
    expected = expected.get()
expected16 = np.rint(np.clip(expected, 0, 1) * 65535).astype(np.int64)
mobile = tifffile.imread(r'${exportPath.replace(/\\/g, '/')}').astype(np.int64)
assert mobile.shape == expected16.shape, (mobile.shape, expected16.shape)
diff = np.abs(mobile - expected16)
print(f'RESULT max={diff.max()} mean={diff.mean():.2f}')
`);
    const pyCheck = execSync(`uv run python "${pyScript}"`, { cwd: APP_DIR }).toString();
    const m = pyCheck.match(/RESULT max=(\d+) mean=([\d.]+)/);
    check('mobile export matches desktop Python pipeline',
        m && parseInt(m[1]) <= 16 && parseFloat(m[2]) <= 2,
        m ? `max err ${m[1]}/65535 LSB, mean ${m[2]}` : pyCheck.trim());

    const realErrors = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('Autofill'));
    check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} finally {
    await app.close().catch(() => {});
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} mobile checks passed`);
process.exit(failed.length ? 1 : 0);
