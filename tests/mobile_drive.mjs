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
const JPEG = path.join(os.tmpdir(), 'film_mobile_test.jpg');
const PNG = path.join(os.tmpdir(), 'film_mobile_test.png');
execSync(`uv run python -c "import numpy as np, tifffile; from PIL import Image; h,w=800,1200; yy,xx=np.mgrid[0:h,0:w]; s=np.stack([xx/(w-1),yy/(h-1),(xx+yy)/(w+h-2)],axis=-1).astype(np.float32); tifffile.imwrite(r'${TIFF.replace(/\\/g, '/')}', np.round((1.0-s)*65535).astype(np.uint16), photometric='rgb'); im=Image.fromarray((s*255).astype(np.uint8)); im.resize((600,400)).save(r'${JPEG.replace(/\\/g, '/')}', quality=92); im.resize((300,200)).save(r'${PNG.replace(/\\/g, '/')}')"`,
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

    // The visible version label must match the service worker's cache
    // version - it's how a phone user verifies an update actually landed
    const swVer = fs.readFileSync(path.join(APP_DIR, 'mobile', 'sw.js'), 'utf8')
        .match(/CACHE_VERSION = 'film-mobile-(v\d+)'/)[1];
    const shownVer = await page.evaluate(() =>
        document.getElementById('appVersion').textContent);
    check('start screen shows the app version, in step with sw.js',
        shownVer === 'film processor · ' + swVer, `"${shownVer}" vs sw.js ${swVer}`);

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

    // The crop box initially covers the FULL image
    const fullBox = await page.evaluate(() => {
        const b = document.getElementById('cropBox').getBoundingClientRect();
        const w = document.getElementById('canvasWrap').getBoundingClientRect();
        return { dl: b.left - w.left, dt: b.top - w.top,
            dw: w.width - b.width, dh: w.height - b.height };
    });
    check('crop box opens covering the full image',
        Object.values(fullBox).every(v => Math.abs(v) < 3), JSON.stringify(fullBox));

    // Aspect ratio chips constrain the box
    await page.evaluate(() => document.querySelector('.ratio-btn[data-ratio="1"]').click());
    const sq = await page.evaluate(() => {
        const b = document.getElementById('cropBox').getBoundingClientRect();
        const w = document.getElementById('canvasWrap').getBoundingClientRect();
        return { w: b.width, h: b.height, min: Math.min(w.width, w.height) };
    });
    check('1:1 chip snaps to a max centered square',
        Math.abs(sq.w - sq.h) < 1.5 && Math.abs(sq.h - sq.min) < 2, JSON.stringify(sq));
    await page.evaluate(() => document.querySelector('.ratio-btn[data-ratio="1.5"]').click());
    const r32 = await page.evaluate(() => {
        const b = document.getElementById('cropBox').getBoundingClientRect();
        return b.width / b.height;
    });
    check('3:2 chip applies', Math.abs(r32 - 1.5) < 0.02, r32.toFixed(3));
    await page.evaluate(() => {
        document.getElementById('ratioSwapBtn').click();
    });
    const r23 = await page.evaluate(() => {
        const b = document.getElementById('cropBox').getBoundingClientRect();
        return b.width / b.height;
    });
    check('ratio swap flips to 2:3', Math.abs(r23 - 2 / 3) < 0.02, r23.toFixed(3));
    await page.evaluate(() => {
        document.getElementById('ratioSwapBtn').click(); // swap back
        document.querySelector('.ratio-btn[data-ratio="free"]').click();
    });

    // Viewport lock: record content scale + viewport size before rotating
    const scaleBefore = await page.evaluate(() => {
        const r = document.getElementById('viewCanvas').getBoundingClientRect();
        const w = document.getElementById('canvasWrap').getBoundingClientRect();
        return { content: r.width / mobileApp.renderer.imageWidth, wrapW: w.width, wrapH: w.height };
    });

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

    // No zoom: content scale and crop viewport unchanged after the bake
    const scaleAfter = await page.evaluate(() => {
        const r = document.getElementById('viewCanvas').getBoundingClientRect();
        const w = document.getElementById('canvasWrap').getBoundingClientRect();
        return { content: r.width / mobileApp.renderer.imageWidth, wrapW: w.width, wrapH: w.height };
    });
    check('straighten keeps content scale (no zoom)',
        Math.abs(scaleAfter.content - scaleBefore.content) / scaleBefore.content < 0.01
        && Math.abs(scaleAfter.wrapW - scaleBefore.wrapW) < 1
        && Math.abs(scaleAfter.wrapH - scaleBefore.wrapH) < 1,
        `scale ${scaleBefore.content.toFixed(4)} -> ${scaleAfter.content.toFixed(4)}`);
    await page.evaluate(() => {
        const s = document.getElementById('straighten');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() =>
        mobileApp.renderer.imageWidth === 1200, null, { timeout: 30_000 });
    check('straighten reset restores dims', true);

    // --- Crop: set the classic 80% box, apply, then undo ---
    await page.evaluate(() => {
        const wrap = document.getElementById('canvasWrap');
        const box = document.getElementById('cropBox');
        box.style.left = (wrap.clientWidth * 0.1) + 'px';
        box.style.top = (wrap.clientHeight * 0.1) + 'px';
        box.style.width = (wrap.clientWidth * 0.8) + 'px';
        box.style.height = (wrap.clientHeight * 0.8) + 'px';
    });
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

    // --- Rotate 90 (and verify the rotation is CLOCKWISE: the source's
    // bottom-left pixel must land at the destination's top-left) ---
    const blBefore = await page.evaluate(() =>
        mobileApp.renderer.getSourcePixel(2, mobileApp.renderer.imageHeight - 3));
    await page.click('#rotate90Btn');
    await page.waitForTimeout(500);
    check('rotate 90 swaps dims', await page.evaluate(() =>
        mobileApp.renderer.imageWidth === 800 && mobileApp.renderer.imageHeight === 1200));
    const tlAfter = await page.evaluate(() => mobileApp.renderer.getSourcePixel(2, 2));
    check('rotation direction is clockwise',
        blBefore.every((v, i) => Math.abs(v - tlAfter[i]) <= 3),
        `src bottom-left ${blBefore} -> dest top-left ${tlAfter}`);
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

    // --- Settings file (per-photo JSON, desktop-compatible) ---
    const settingsRT = await page.evaluate(() => {
        // Edit, capture, reset, re-apply - a full save/load round trip
        for (const [id, v] of [['contrast', 0.2], ['whites', 0.4]]) {
            const s = document.getElementById(id);
            s.value = v;
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }
        mobileApp.blackPoint = [12, 10, 8];
        mobileApp.curves.rgb.splice(1, 0, { x: 0.5, y: 0.6 });
        const json = JSON.stringify(mobileApp.getParameters(), null, 2);

        for (const id of ['contrast', 'whites']) {
            const s = document.getElementById(id);
            s.value = 0;
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }
        mobileApp.blackPoint = null;
        mobileApp.curves = mobileApp.defaultCurves();
        mobileApp.drawCurves();

        mobileApp.applySettings(JSON.parse(json));
        return {
            contrast: document.getElementById('contrast').value,
            whites: document.getElementById('whites').value,
            black: mobileApp.blackPoint && [...mobileApp.blackPoint],
            curvePts: mobileApp.curves.rgb.length,
        };
    });
    check('settings JSON round-trips (sliders, points, curves)',
        settingsRT.contrast === '0.2' && settingsRT.whites === '0.4'
        && JSON.stringify(settingsRT.black) === '[12,10,8]' && settingsRT.curvePts === 3,
        JSON.stringify(settingsRT));

    // Save button opens a save dialog for <name>_settings.json with the
    // current edits (showSaveFilePicker stubbed - Electron would show a
    // real native dialog)
    const savedFile = await page.evaluate(async () => {
        const orig = window.showSaveFilePicker;
        let captured = null;
        window.showSaveFilePicker = async (opts) => ({
            createWritable: async () => ({
                write: async (blob) => {
                    captured = { filename: opts.suggestedName, text: await blob.text() };
                },
                close: async () => {},
            }),
        });
        document.getElementById('saveSettingsBtn').click();
        await new Promise(res => setTimeout(res, 150));
        window.showSaveFilePicker = orig;
        return captured && { filename: captured.filename,
            contrast: JSON.parse(captured.text).contrast };
    });
    check('save settings opens a save dialog for <name>_settings.json',
        !!savedFile && savedFile.filename.endsWith('_settings.json')
        && savedFile.contrast === 0.2,
        JSON.stringify(savedFile));

    // The export dialog must open BEFORE the pixels render: the browser
    // only allows it within a few seconds of the tap, and a big scan
    // renders for longer (regression: large exports silently fell back
    // to a bare download instead of the pick-a-location dialog)
    const exportOrder = await page.evaluate(async () => {
        const seq = [];
        const origPicker = window.showSaveFilePicker;
        const origRender = mobileApp.exportPixels.bind(mobileApp);
        window.showSaveFilePicker = async () => {
            seq.push('picker');
            return { createWritable: async () => ({
                write: async () => { seq.push('write'); },
                close: async () => {},
            }) };
        };
        mobileApp.exportPixels = async () => { seq.push('render'); return origRender(); };
        document.getElementById('exportTiffBtn').click();
        await new Promise(res => setTimeout(res, 1000));
        window.showSaveFilePicker = origPicker;
        delete mobileApp.exportPixels;
        return seq;
    });
    check('export opens the save dialog before rendering the pixels',
        exportOrder.join(',') === 'picker,render,write', exportOrder.join(','));

    // Settings restore straighten by baking it (presets skip straighten)
    await page.evaluate(() => mobileApp.applySettings({ straighten: 1.5 }));
    await page.waitForFunction(() => mobileApp.bakedStraighten === 1.5,
        null, { timeout: 30_000 });
    check('settings restore straighten (baked)', true);
    await page.evaluate(() => mobileApp.applySettings({ straighten: 0 }));
    await page.waitForFunction(() => mobileApp.renderer.imageWidth === 1200,
        null, { timeout: 30_000 });

    // Reopening the same photo auto-loads the settings the save button
    // remembered (contrast 0.2, whites 0.4, black point, extra curve point)
    await page.evaluate(() => {
        for (const id of ['contrast', 'whites']) {
            const s = document.getElementById(id);
            s.value = 0;
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
    await page.setInputFiles('#fileInput', TIFF);
    await page.waitForFunction(() =>
        document.getElementById('contrast').value === '0.2', null, { timeout: 60_000 });
    const autoLoaded = await page.evaluate(() => ({
        whites: document.getElementById('whites').value,
        black: mobileApp.blackPoint && [...mobileApp.blackPoint],
        curvePts: mobileApp.curves.rgb.length,
    }));
    check('reopening a photo auto-loads its saved settings',
        autoLoaded.whites === '0.4' && JSON.stringify(autoLoaded.black) === '[12,10,8]'
        && autoLoaded.curvePts === 3,
        JSON.stringify(autoLoaded));

    // Clean up the edits and remembered settings this block made
    await page.evaluate(() => {
        Object.keys(localStorage)
            .filter(k => k.startsWith('filmSettings:'))
            .forEach(k => localStorage.removeItem(k));
        for (const id of ['contrast', 'whites']) {
            const s = document.getElementById(id);
            s.value = 0;
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }
        mobileApp.blackPoint = null;
        mobileApp.curves = mobileApp.defaultCurves();
        mobileApp.drawCurves();
        mobileApp.updateImage();
    });

    // --- Press-and-hold the IMAGE shows the original ---
    const cmp = await page.evaluate(async () => {
        const pane = document.getElementById('viewerPane');
        const r = pane.getBoundingClientRect();
        const opts = {
            bubbles: true, pointerId: 31, isPrimary: true,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        };
        pane.dispatchEvent(new PointerEvent('pointerdown', opts));
        await new Promise(res => setTimeout(res, 550));
        const during = mobileApp.renderer.params.showOriginal;
        pane.dispatchEvent(new PointerEvent('pointerup', opts));
        const after = mobileApp.renderer.params.showOriginal;
        return { during, after };
    });
    check('holding the image shows original', cmp.during === true && cmp.after === false,
        JSON.stringify(cmp));

    // --- Slider reset: double-tap the LABEL resets, taps or micro-drags
    // on the slider itself never do ---
    const labelReset = await page.evaluate(async () => {
        const s = document.getElementById('exposure');
        s.value = 0.5;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        const label = s.closest('label');
        const tap = () => label.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }));
        tap();
        await new Promise(r => setTimeout(r, 100));
        tap();
        return s.value;
    });
    check('double-tap on the label resets the slider', labelReset === '0',
        `value ${labelReset}`);
    const microNoReset = await page.evaluate(async () => {
        const s = document.getElementById('exposure');
        const microDrag = (v) => {
            s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            s.value = v;
            s.dispatchEvent(new Event('input', { bubbles: true }));
            s.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        };
        microDrag(0.3);
        await new Promise(r => setTimeout(r, 100));
        microDrag(0.31);
        return s.value;
    });
    check('micro-drags never reset a slider', microNoReset === '0.31', `value ${microNoReset}`);
    await page.evaluate(() => {
        const s = document.getElementById('exposure');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // --- Clipping threshold preview (Photoshop Alt-drag style): shown
    // only while HOLDING a tone slider with the Clip toggle on ---
    await page.evaluate(() => {
        const s = document.getElementById('exposure');
        s.value = 0.5; // clips the bright corner, center stays mid-gray
        s.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('clipBtn').click(); // enable
        document.getElementById('whites').dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    const thresh = await page.evaluate(() => {
        const c = document.getElementById('viewCanvas');
        const N = 60;
        const t = document.createElement('canvas'); t.width = N; t.height = N;
        const ctx = t.getContext('2d');
        ctx.drawImage(c, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        let sat = 0, white = 0, black = 0;
        for (let i = 0; i < d.length; i += 4) {
            if ([d[i], d[i + 1], d[i + 2]].every(v => v < 10 || v > 245)) sat++;
            if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) white++;
            if (d[i] < 10 && d[i + 1] < 10 && d[i + 2] < 10) black++;
        }
        return { satFrac: sat / (N * N), white, black,
            mode: mobileApp.renderer.params.clipMode };
    });
    check('holding whites shows the threshold view',
        thresh.mode === 1 && thresh.satFrac > 0.95 && thresh.white > 0 && thresh.black > 0,
        JSON.stringify(thresh));
    const exportClean = await page.evaluate(() => {
        // Export while the threshold view is up must still be the real image
        const { data, width, height } = mobileApp.renderer.renderToPixels();
        const i = ((height >> 1) * width + (width >> 1)) * 3;
        return [data[i], data[i + 1], data[i + 2]];
    });
    check('threshold view is not exported',
        exportClean.every(v => v > 0.5 && v < 0.7), JSON.stringify(exportClean));
    const releaseAndBlacks = await page.evaluate(() => {
        const up = (id) => document.getElementById(id).dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true }));
        const down = (id) => document.getElementById(id).dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }));
        up('whites');
        const afterRelease = mobileApp.renderer.params.clipMode;
        down('blacks');
        const blacksMode = mobileApp.renderer.params.clipMode;
        up('blacks');
        document.getElementById('clipBtn').click(); // disable
        down('whites');
        const disabledMode = mobileApp.renderer.params.clipMode;
        up('whites');
        return { afterRelease, blacksMode, disabledMode };
    });
    check('release restores; blacks = shadow mode; toggle off = no preview',
        releaseAndBlacks.afterRelease === 0 && releaseAndBlacks.blacksMode === 2
        && releaseAndBlacks.disabledMode === 0,
        JSON.stringify(releaseAndBlacks));
    await page.evaluate(() => {
        const s = document.getElementById('exposure');
        s.value = 0;
        s.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // --- Layout: the viewer pane always shows the image, controls scroll
    // in their own pane, and the canvas fills the available space ---
    // Normalize to a known CONTENT size (outer size includes the frame)
    await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(430, 930));
    await page.waitForTimeout(400);
    const fit = await page.evaluate(() => {
        const pane = document.getElementById('viewerPane').getBoundingClientRect();
        const c = document.getElementById('viewCanvas').getBoundingClientRect();
        return {
            paneW: pane.width, paneH: pane.height, w: c.width, h: c.height,
            inside: c.left >= pane.left - 1 && c.top >= pane.top - 1
                && c.right <= pane.right + 1 && c.bottom <= pane.bottom + 1,
        };
    });
    check('canvas fits inside the viewer pane', fit.inside, JSON.stringify(fit));
    check('canvas fills the viewer pane on one axis',
        fit.w >= (fit.paneW - 12) * 0.98 || fit.h >= (fit.paneH - 12) * 0.98,
        `${fit.w.toFixed(0)}x${fit.h.toFixed(0)} in pane ${fit.paneW.toFixed(0)}x${fit.paneH.toFixed(0)}`);

    const curvesVis = await page.evaluate(() => {
        document.getElementById('curvesCanvas').scrollIntoView({ block: 'center' });
        const v = document.getElementById('viewerPane').getBoundingClientRect();
        const p = document.getElementById('controlsPane').getBoundingClientRect();
        const cu = document.getElementById('curvesCanvas').getBoundingClientRect();
        const visibleCurve = Math.min(cu.bottom, p.bottom) - Math.max(cu.top, p.top);
        return { imgH: v.height, imgBottom: v.bottom, panelTop: p.top, visibleCurve };
    });
    check('curves usable while the image stays visible',
        curvesVis.imgH > 120 && curvesVis.visibleCurve > 150
        && curvesVis.imgBottom <= curvesVis.panelTop + 2,
        JSON.stringify(curvesVis));

    // --- Fold/rotate: resizing the window refits the canvas and switches
    // to the landscape layout (controls beside the image) ---
    await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(900, 700));
    await page.waitForTimeout(400);
    const wide = await page.evaluate(() => {
        const v = document.getElementById('viewerPane').getBoundingClientRect();
        const p = document.getElementById('controlsPane').getBoundingClientRect();
        const c = document.getElementById('viewCanvas').getBoundingClientRect();
        return { canvasW: c.width, sideBySide: p.left >= v.right - 2 };
    });
    check('bigger window grows the image (fold-out refit)',
        wide.canvasW > fit.w * 1.2, `${fit.w.toFixed(0)} -> ${wide.canvasW.toFixed(0)}px`);
    check('landscape puts controls beside the image', wide.sideBySide);

    await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(430, 930));
    await page.waitForTimeout(400);
    const narrowW = await page.evaluate(() =>
        document.getElementById('viewCanvas').getBoundingClientRect().width);
    check('shrinking the window refits the canvas',
        Math.abs(narrowW - fit.w) < 8, `${wide.canvasW.toFixed(0)} -> ${narrowW.toFixed(0)}px`);

    // --- Pinch zoom (view-only) and double-tap reset ---
    const pinchRes = await page.evaluate(() => {
        const pane = document.getElementById('viewerPane');
        const r = pane.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const ev = (type, id, x, y) => pane.dispatchEvent(new PointerEvent(type,
            { bubbles: true, pointerId: id, clientX: x, clientY: y }));
        ev('pointerdown', 11, cx - 30, cy);
        ev('pointerdown', 12, cx + 30, cy);
        ev('pointermove', 11, cx - 90, cy);
        ev('pointermove', 12, cx + 90, cy);
        ev('pointerup', 11, cx - 90, cy);
        ev('pointerup', 12, cx + 90, cy);
        return {
            zoom: mobileApp.viewZoom,
            transform: document.getElementById('viewCanvas').style.transform,
        };
    });
    check('pinch zooms the view',
        pinchRes.zoom > 2 && pinchRes.transform.includes('scale'),
        `zoom ${pinchRes.zoom.toFixed(2)}`);
    const dtap = await page.evaluate(async () => {
        const pane = document.getElementById('viewerPane');
        const r = pane.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const tap = (id) => {
            pane.dispatchEvent(new PointerEvent('pointerdown',
                { bubbles: true, pointerId: id, clientX: cx, clientY: cy }));
            pane.dispatchEvent(new PointerEvent('pointerup',
                { bubbles: true, pointerId: id, clientX: cx, clientY: cy }));
        };
        tap(21);
        await new Promise(res => setTimeout(res, 80));
        tap(22);
        return {
            zoom: mobileApp.viewZoom,
            transform: document.getElementById('viewCanvas').style.transform,
        };
    });
    check('double-tap resets zoom', dtap.zoom === 1 && dtap.transform === '',
        `zoom ${dtap.zoom}`);

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

    // --- Local-luminance map (drives the local Shadows/Highlights masks):
    // the JS implementation must produce the same 8-bit grid as
    // film_processing._local_lum_grid, or preview and export drift ---
    const jsMap = await page.evaluate(() => {
        const w = 300, h = 200;
        const data = new Float32Array(w * h * 3);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 3;
                data[i] = ((x * 13 + y * 7) % 101) / 101;
                data[i + 1] = ((x * 5 + y * 17) % 89) / 89;
                data[i + 2] = ((x * 3 + y * 29) % 97) / 97;
            }
        }
        const map = computeLocalLumMap(data, w, h);
        return { w: map.width, h: map.height, d: Array.from(map.data) };
    });
    const mapScript = path.join(os.tmpdir(), 'film_mobile_lummap.py');
    fs.writeFileSync(mapScript, `
import numpy as np, sys
sys.path.insert(0, r'${APP_DIR.replace(/\\/g, '/')}/src')
from film_processing import _local_lum_grid
w, h = 300, 200
xx, yy = np.meshgrid(np.arange(w), np.arange(h))
img = np.stack([
    ((xx * 13 + yy * 7) % 101) / 101,
    ((xx * 5 + yy * 17) % 89) / 89,
    ((xx * 3 + yy * 29) % 97) / 97,
], axis=-1).astype(np.float32)
grid = _local_lum_grid(img)
print('MAP', grid.shape[1], grid.shape[0], ','.join(map(str, grid.flatten().tolist())))
`);
    const mapOut = execSync(`uv run python "${mapScript}"`, { cwd: APP_DIR }).toString();
    const mm = mapOut.match(/MAP (\d+) (\d+) ([\d,]+)/);
    let mapMaxDiff = -1;
    if (mm && Number(mm[1]) === jsMap.w && Number(mm[2]) === jsMap.h) {
        const pyMap = mm[3].split(',').map(Number);
        if (pyMap.length === jsMap.d.length) {
            mapMaxDiff = 0;
            for (let i = 0; i < pyMap.length; i++) {
                mapMaxDiff = Math.max(mapMaxDiff, Math.abs(pyMap[i] - jsMap.d[i]));
            }
        }
    }
    check('local-luminance map matches the Python implementation',
        mapMaxDiff >= 0 && mapMaxDiff <= 1,
        mm ? `grid ${jsMap.w}x${jsMap.h}, max diff ${mapMaxDiff}` : mapOut.trim());

    // --- Big-endian 16-bit TIFF (regression: Nikon scans are 'MM' order
    // and decoded as rainbow noise before the byte-order fix) ---
    const BE_TIFF = path.join(os.tmpdir(), 'film_mobile_test_be.tif');
    execSync(`uv run python -c "import numpy as np, tifffile; img=np.full((40,40,3),[30000,45000,20000],dtype=np.uint16); tifffile.imwrite(r'${BE_TIFF.replace(/\\/g, '/')}', img, photometric='rgb', byteorder='>')"`,
        { cwd: APP_DIR, stdio: 'inherit' });
    await page.click('.mode-btn[data-mode="photo"]');
    await page.setInputFiles('#fileInput', BE_TIFF);
    await page.waitForFunction(() => mobileApp.renderer.imageWidth === 40, null, { timeout: 30_000 });
    const bePixel = await page.evaluate(() => mobileApp.renderer.getSourcePixel(20, 20));
    // 30000/65535*255=117, 45000->175, 20000->78
    check('big-endian 16-bit TIFF decodes correctly',
        JSON.stringify(bePixel) === JSON.stringify([117, 175, 78]), JSON.stringify(bePixel));

    // --- Full-resolution export: a medium-format-sized scan (9000x6000)
    // is EDITED at the 4096 working cap but must EXPORT at native size
    // via the banded renderer, and with no edits the export must be
    // pixel-identical to the source (regression: exports came out at
    // 4096, e.g. 140MB scans exporting as 60MB files) ---
    const BIG_TIFF = path.join(os.tmpdir(), 'film_mobile_test_big.tif');
    execSync(`uv run python -c "import numpy as np, tifffile; h,w=6000,9000; yy,xx=np.mgrid[0:h,0:w]; s=np.stack([xx/(w-1),yy/(h-1),(xx+yy)/(w+h-2)],axis=-1).astype(np.float32); tifffile.imwrite(r'${BIG_TIFF.replace(/\\/g, '/')}', np.rint(s*65535).astype(np.uint16), photometric='rgb')"`,
        { cwd: APP_DIR, stdio: 'inherit' });
    await page.evaluate(() => {
        // Identity: zero every slider left over from earlier checks
        document.querySelectorAll('.pro-slider').forEach(s => {
            s.value = 0;
            s.dispatchEvent(new Event('input', { bubbles: true }));
        });
    });
    await page.setInputFiles('#fileInput', BIG_TIFF);
    await page.waitForFunction(() =>
        mobileApp.renderer.imageWidth === 4096, null, { timeout: 120_000 });
    check('big scan previews at the working cap', true);
    const fullExport = await page.evaluate(async () => {
        const p = await mobileApp.exportPixels();
        // Round-trip: with no edits the export must equal a fresh native
        // decode of the source file, sample-compared in 16-bit units
        const src = await decodeImageFile(mobileApp.sourceFile, 99999);
        let maxErr = 0;
        if (src.width === p.width && src.height === p.height) {
            for (let i = 0; i < p.data16.length; i += 1237) {
                maxErr = Math.max(maxErr, Math.abs(p.data16[i] - src.data[i] * 65535));
            }
        }
        return { w: p.width, h: p.height, maxErr };
    });
    check('export renders at native resolution (beyond the old 8192 cap)',
        fullExport.w === 9000 && fullExport.h === 6000, `${fullExport.w}x${fullExport.h}`);
    check('no-edit export is pixel-identical to the source',
        fullExport.maxErr <= 1, `max err ${fullExport.maxErr.toFixed(3)}/65535`);

    // A crop applied at working resolution scales up to native on export
    await page.click('#cropBtn');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        const wrap = document.getElementById('canvasWrap');
        const box = document.getElementById('cropBox');
        box.style.left = (wrap.clientWidth * 0.1) + 'px';
        box.style.top = (wrap.clientHeight * 0.1) + 'px';
        box.style.width = (wrap.clientWidth * 0.8) + 'px';
        box.style.height = (wrap.clientHeight * 0.8) + 'px';
    });
    await page.click('#applyCropBtn');
    await page.waitForTimeout(500);
    const croppedDims = await page.evaluate(async () => {
        const p = await mobileApp.exportPixels();
        return [p.width, p.height];
    });
    check('cropped export stays native-res (80% of 9000x6000)',
        Math.abs(croppedDims[0] - 7200) <= 12 && Math.abs(croppedDims[1] - 4800) <= 12,
        croppedDims.join('x'));
    await page.click('#undoCropBtn');
    await page.waitForTimeout(300);

    // --- Non-TIFF formats load too (regression: closed-bitmap 0x0 bug) ---
    await page.click('.mode-btn[data-mode="photo"]');
    await page.setInputFiles('#fileInput', JPEG);
    await page.waitForFunction(() =>
        mobileApp.renderer.imageWidth === 600 && mobileApp.renderer.imageHeight === 400,
        null, { timeout: 30_000 });
    check('JPEG loads at correct size', true);
    await page.setInputFiles('#fileInput', PNG);
    await page.waitForFunction(() =>
        mobileApp.renderer.imageWidth === 300 && mobileApp.renderer.imageHeight === 200,
        null, { timeout: 30_000 });
    check('PNG loads at correct size', true);
    // Re-picking the same file must work (input resets after change)
    await page.setInputFiles('#fileInput', JPEG);
    await page.waitForFunction(() =>
        mobileApp.renderer.imageWidth === 600, null, { timeout: 30_000 });
    check('re-picking a file works', true);

    // --- Folder browser (fake directory handle; no native picker) ---
    const tiffB64 = fs.readFileSync(TIFF).toString('base64');
    const jpegB64 = fs.readFileSync(JPEG).toString('base64');
    await page.evaluate(([tb, jb]) => {
        const bytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const mk = (name, data, type) => {
            const file = new File([data], name, { type, lastModified: 1234567 });
            return { kind: 'file', name, getFile: async () => file };
        };
        window.__sideFiles = {}; // sidecars written into the fake folder
        window.__browseDir = {
            name: 'test-scans',
            values: async function* () {
                // Out of order + one non-image: tests sorting and filtering.
                // The "._" entries are macOS AppleDouble junk (magic
                // 00 05 16 07) left on USB drives - they must never
                // reach the grid or the sidecar set.
                yield mk('._a_frame1.tif',
                    new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]), 'image/tiff');
                yield mk('._b_settings.json',
                    new Uint8Array([0, 5, 22, 7]), 'application/json');
                yield mk('b_frame2.jpg', bytes(jb), 'image/jpeg');
                yield mk('notes.txt', new Uint8Array([1]), 'text/plain');
                yield mk('a_frame1.tif', bytes(tb), 'image/tiff');
                for (const [n, f] of Object.entries(window.__sideFiles)) {
                    yield { kind: 'file', name: n, getFile: async () => f };
                }
            },
            getFileHandle: async (name, opts) => {
                if (!window.__sideFiles[name] && !(opts && opts.create)) {
                    throw new DOMException(name, 'NotFoundError');
                }
                return {
                    getFile: async () => window.__sideFiles[name],
                    createWritable: async () => ({
                        write: async (blob) => {
                            window.__sideFiles[name] = new File([blob], name,
                                { type: 'application/json', lastModified: Date.now() });
                        },
                        close: async () => {},
                    }),
                };
            },
        };
    }, [tiffB64, jpegB64]);

    // The fast reader handles the 16-bit TIFF without a full decode
    const fastThumb = await page.evaluate(async () => {
        let tif = null;
        for await (const e of window.__browseDir.values()) {
            if (e.name.endsWith('.tif')) tif = await e.getFile();
        }
        const c = await readTiffSubsampled(tif, 320);
        if (!c) return null;
        const px = c.getContext('2d').getImageData(
            Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        return { w: c.width, h: c.height, px: Array.from(px.slice(0, 3)) };
    });
    check('subsampled TIFF reader thumbnails without full decode',
        !!fastThumb && fastThumb.w === 320 && fastThumb.h === 213
        && fastThumb.px.every(v => v > 100 && v < 155),
        JSON.stringify(fastThumb));

    // The thumbnail cache persists in the Electron profile across runs;
    // clear it so the cache-count check below is deterministic
    await page.evaluate(async () => {
        const db = await new Promise((res, rej) => {
            const r = indexedDB.open('filmBrowser', 1);
            r.onupgradeneeded = () => {
                r.result.createObjectStore('handles');
                r.result.createObjectStore('thumbs');
            };
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
        await new Promise((res) => {
            const tx = db.transaction('thumbs', 'readwrite');
            tx.objectStore('thumbs').clear();
            tx.oncomplete = res;
        });
    });

    // The real Browse BUTTON must open the panel (regression: a startup
    // crash in the browser's constructor left the button silently dead)
    await page.click('#browseBtn');
    await page.waitForTimeout(500);
    check('Browse button opens the panel',
        await page.evaluate(() =>
            document.getElementById('browsePanel').style.display === ''
            && !!mobileApp.browser));
    await page.click('#browseCloseBtn');

    await page.evaluate(() => mobileApp.browser.openWithHandle(window.__browseDir));
    await page.waitForFunction(() =>
        document.querySelectorAll('#browseGrid .browse-cell img').length === 2,
        null, { timeout: 60_000 });
    const gridState = await page.evaluate(() => ({
        cells: document.querySelectorAll('#browseGrid .browse-cell').length,
        names: [...document.querySelectorAll('#browseGrid .browse-name')]
            .map(e => e.textContent),
        title: document.getElementById('browseTitle').textContent,
    }));
    check('grid lists images sorted; non-images and ._AppleDouble junk filtered',
        gridState.cells === 2 && gridState.title === 'test-scans'
        && gridState.names[0] === 'a_frame1.tif' && gridState.names[1] === 'b_frame2.jpg'
        && await page.evaluate(() => ![...mobileApp.browser.sidecars]
            .some(n => n.startsWith('.'))),
        JSON.stringify(gridState));

    // Thumbnails are cached in IndexedDB for instant revisits
    const cached = await page.evaluate(async () => {
        const db = await new Promise((res, rej) => {
            const r = indexedDB.open('filmBrowser', 1);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
        return new Promise((res) => {
            const r = db.transaction('thumbs').objectStore('thumbs').count();
            r.onsuccess = () => res(r.result);
        });
    });
    check('thumbnails cached in IndexedDB', cached === 2, `${cached} cached`);

    // Tap -> full-screen preview with prev/next
    await page.click('#browseGrid .browse-cell');
    await page.waitForFunction(() => {
        const img = document.getElementById('browsePreviewImg');
        return document.getElementById('browsePreview').style.display !== 'none'
            && img.naturalWidth > 0 && getComputedStyle(img).opacity === '1';
    }, null, { timeout: 60_000 });
    const preview1 = await page.evaluate(() => ({
        name: document.getElementById('previewName').textContent,
        w: document.getElementById('browsePreviewImg').naturalWidth,
    }));
    check('tap opens a full-screen preview',
        preview1.name === 'a_frame1.tif (1/2)' && preview1.w === 1200,
        JSON.stringify(preview1));

    await page.click('#previewNextBtn');
    await page.waitForFunction(() =>
        document.getElementById('previewName').textContent.startsWith('b_frame2.jpg'),
        null, { timeout: 60_000 });
    check('next moves to the following frame', true);
    await page.click('#previewPrevBtn');
    await page.waitForFunction(() =>
        document.getElementById('previewName').textContent.startsWith('a_frame1.tif'),
        null, { timeout: 60_000 });

    // Edit opens the frame in the editor and closes the browser
    await page.click('#previewEditBtn');
    await page.waitForFunction(() =>
        mobileApp.renderer.imageWidth === 1200 && mobileApp.renderer.imageHeight === 800,
        null, { timeout: 60_000 });
    const closed = await page.evaluate(() => ({
        panel: document.getElementById('browsePanel').style.display,
        preview: document.getElementById('browsePreview').style.display,
    }));
    check('edit loads the frame and closes the browser',
        closed.panel === 'none' && closed.preview === 'none',
        JSON.stringify(closed));

    // --- Auto crop: synthetic scan, white border, frame slanted 0.6°,
    // with a bright blob inside the frame (the "white flag" trap that
    // must not shrink the crop) ---
    const FRAME_TIFF = path.join(os.tmpdir(), 'film_mobile_test_frame.tif');
    execSync(`uv run python -c "import numpy as np, tifffile, math; h,w=1100,1600; phi=math.radians(0.6); c,s=math.cos(phi),math.sin(phi); yy,xx=np.mgrid[0:h,0:w]; dx=xx-w/2; dy=yy-h/2; qx=dx*c+dy*s; qy=-dx*s+dy*c; inside=(np.abs(qx)<700)&(np.abs(qy)<460); grad=(0.2+0.5*xx/(w-1)).astype(np.float32); img=np.where(inside[...,None], np.stack([grad]*3,axis=-1), np.float32(1.0)); blob=inside&(qx>-690)&(qx<-640)&(np.abs(qy)<80); img[blob]=0.9; tifffile.imwrite(r'${FRAME_TIFF.replace(/\\/g, '/')}', np.round(img*65535).astype(np.uint16), photometric='rgb')"`,
        { cwd: APP_DIR, stdio: 'inherit' });
    await page.click('.mode-btn[data-mode="photo"]');
    await page.setInputFiles('#fileInput', FRAME_TIFF);
    await page.waitForFunction(() =>
        mobileApp.renderer.imageWidth === 1600, null, { timeout: 60_000 });
    const detSynth = await page.evaluate(() => {
        const r = mobileApp.renderer;
        return detectFrame({ data: r.imageData, width: r.imageWidth, height: r.imageHeight });
    });
    check('detector measures the 0.6° slant',
        !!detSynth && Math.abs(detSynth.angle + 0.6) < 0.1,
        detSynth ? detSynth.angle.toFixed(3) + '°' : 'null');
    await page.evaluate(() => mobileApp.autoCrop());
    await page.waitForFunction(() =>
        document.getElementById('status').textContent.includes('Frame detected'),
        null, { timeout: 60_000 });
    await page.click('#applyCropBtn');
    await page.waitForFunction(() =>
        document.getElementById('status').textContent === 'Cropped', null, { timeout: 60_000 });
    const autoRes = await page.evaluate(() => {
        const r = mobileApp.renderer, d = r.imageData, W = r.imageWidth, H = r.imageHeight;
        let sat = 0;
        const chk = (x, y) => {
            const i = (y * W + x) * 3;
            if (Math.min(d[i], d[i + 1], d[i + 2]) > 0.97) sat++;
        };
        for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) { chk(x, k); chk(x, H - 1 - k); }
        for (let y = 0; y < H; y++) for (let k = 0; k < 3; k++) { chk(k, y); chk(W - 1 - k, y); }
        return { W, H, sat, angle: mobileApp.bakedOps[0] && mobileApp.bakedOps[0].angle };
    });
    check('auto crop straightens the frame and excludes the whole border',
        Math.abs(autoRes.angle + 0.6) < 0.11
        && autoRes.W >= 1330 && autoRes.W <= 1400
        && autoRes.H >= 850 && autoRes.H <= 920
        && autoRes.sat === 0,
        JSON.stringify(autoRes));

    // --- Batch: long-press multi-select, badges, preset apply ---
    const tiffSize = fs.statSync(TIFF).size;
    const jpegSize = fs.statSync(JPEG).size;
    await page.evaluate(([ts]) => {
        // a_frame1 gets saved settings incl. a baked crop (mobile extension)
        localStorage.setItem(`filmSettings:a_frame1.tif:${ts}`, JSON.stringify({
            contrast: 0.2, straighten: 0,
            baked_ops: [{ angle: 1.5, rect: { x: 10, y: 10, width: 500, height: 400 } }],
            ops_width: 1200,
        }));
        return mobileApp.browser.openWithHandle(window.__browseDir);
    }, [tiffSize]);
    await page.waitForFunction(() =>
        document.querySelectorAll('#browseGrid .browse-cell img').length === 2,
        null, { timeout: 60_000 });
    check('edited badge shows on frames with saved settings',
        await page.evaluate(() => {
            const cells = document.querySelectorAll('#browseGrid .browse-cell');
            return !!cells[0].querySelector('.dot.edited')
                && !cells[1].querySelector('.dot.edited');
        }));

    const lp = await page.evaluate(async () => {
        const cell = document.querySelectorAll('#browseGrid .browse-cell')[0];
        cell.dispatchEvent(new PointerEvent('pointerdown',
            { bubbles: true, clientX: 60, clientY: 200 }));
        await new Promise(r => setTimeout(r, 600));
        cell.dispatchEvent(new PointerEvent('pointerup',
            { bubbles: true, clientX: 60, clientY: 200 }));
        cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return {
            mode: mobileApp.browser.selectMode,
            count: document.getElementById('batchCount').textContent,
            bar: document.getElementById('batchBar').style.display,
            marked: cell.classList.contains('selected'),
        };
    });
    check('long-press enters select mode with the frame selected',
        lp.mode && lp.count === '1 selected' && lp.bar === '' && lp.marked,
        JSON.stringify(lp));

    // Presets saved in the editor apply to the whole selection; a
    // straighten smuggled into a preset must never move a frame's crop
    const preset = await page.evaluate(async ([ts, js]) => {
        localStorage.setItem('filmProcessorPresets', JSON.stringify({
            warm: { contrast: 0.35, exposure: 0.3, straighten: 5 },
        }));
        document.querySelectorAll('#browseGrid .browse-cell')[1]
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.getElementById('batchPresetBtn').click();
        const dialogShown = document.getElementById('presetDialog').style.display === '';
        const btns = [...document.querySelectorAll('#presetDialogList .tb-btn')];
        btns[0].click();
        await new Promise(r => setTimeout(r, 400));
        return {
            dialogShown, names: btns.map(b => b.textContent),
            count: document.getElementById('batchCount').textContent,
            dialogAfter: document.getElementById('presetDialog').style.display,
            a: JSON.parse(localStorage.getItem(`filmSettings:a_frame1.tif:${ts}`)),
            b: JSON.parse(localStorage.getItem(`filmSettings:b_frame2.jpg:${js}`)),
        };
    }, [tiffSize, jpegSize]);
    check('preset applies its look to every selected frame',
        preset.dialogShown && preset.names.join() === 'warm'
        && preset.dialogAfter === 'none' && preset.count === '2 selected'
        && preset.a.contrast === 0.35 && preset.b.contrast === 0.35
        && preset.b.exposure === 0.3,
        JSON.stringify(preset));
    check('preset never touches a frame\'s geometry',
        preset.a.baked_ops && preset.a.baked_ops.length === 1
        && preset.a.straighten === 0
        && preset.b.baked_ops === undefined && preset.b.straighten === undefined,
        JSON.stringify({ a: preset.a, b: preset.b }));
    check('batch edits write settings sidecars into the folder',
        await page.evaluate(async () => {
            const f = window.__sideFiles['a_frame1_settings.json'];
            if (!f || !window.__sideFiles['b_frame2_settings.json']) return false;
            const p = JSON.parse(await f.text());
            return p.contrast === 0.35 && typeof p.saved_at === 'number';
        }));

    const deselExit = await page.evaluate(() => {
        const cells = document.querySelectorAll('#browseGrid .browse-cell');
        cells[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        cells[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { mode: mobileApp.browser.selectMode,
            bar: document.getElementById('batchBar').style.display };
    });
    check('deselecting the last frame leaves select mode',
        !deselExit.mode && deselExit.bar === 'none', JSON.stringify(deselExit));

    const allT = await page.evaluate(() => {
        mobileApp.browser.enterSelect(0);
        document.getElementById('batchAllBtn').click(); // -> selects all
        const a = document.getElementById('batchCount').textContent;
        document.getElementById('batchAllBtn').click(); // all selected -> clears
        const b = document.getElementById('batchCount').textContent;
        document.getElementById('batchDoneBtn').click();
        return { a, b, mode: mobileApp.browser.selectMode,
            bar: document.getElementById('batchBar').style.display };
    });
    check('select-all toggles and ✕ Done leaves select mode',
        allT.a === '2 selected' && allT.b === '0 selected'
        && !allT.mode && allT.bar === 'none', JSON.stringify(allT));

    // Opening a photo whose settings carry a baked crop restores the crop
    await page.evaluate(async () => {
        let f = null;
        for await (const e of window.__browseDir.values()) {
            if (e.name === 'a_frame1.tif') f = await e.getFile();
        }
        await mobileApp.loadFile(f);
    });
    await page.waitForFunction(() =>
        mobileApp.renderer.imageWidth === 500 && mobileApp.renderer.imageHeight === 400,
        null, { timeout: 60_000 });
    const opsLoaded = await page.evaluate(() => ({
        ops: mobileApp.bakedOps.length,
        contrast: document.getElementById('contrast').value,
        undoBtn: document.getElementById('undoCropBtn').style.display,
    }));
    check('auto-loaded settings restore the saved crop',
        opsLoaded.ops === 1 && opsLoaded.contrast === '0.35' && opsLoaded.undoBtn === '',
        JSON.stringify(opsLoaded));

    // --- Phone<->PC sync via settings sidecars ---
    // A newer sidecar (as the desktop app writes: look only, no
    // baked_ops, no saved_at) wins over the phone's local copy, and the
    // phone's baked crop is merged back in rather than lost
    const sync1 = await page.evaluate(async () => {
        window.__sideFiles['a_frame1_settings.json'] = new File(
            [JSON.stringify({ contrast: -0.1, exposure: 0.55 })],
            'a_frame1_settings.json',
            { type: 'application/json', lastModified: Date.now() + 60_000 });
        let f = null;
        for await (const e of window.__browseDir.values()) {
            if (e.name === 'a_frame1.tif') f = await e.getFile();
        }
        await mobileApp.loadFile(f, { dir: window.__browseDir, canWrite: true });
        return {
            contrast: document.getElementById('contrast').value,
            exposure: document.getElementById('exposure').value,
            ops: mobileApp.bakedOps.length,
            w: mobileApp.renderer.imageWidth,
        };
    });
    check('newer PC sidecar wins and keeps the phone\'s crop',
        sync1.contrast === '-0.1' && sync1.exposure === '0.55'
        && sync1.ops === 1 && sync1.w === 500,
        JSON.stringify(sync1));

    // Save settings on a browse-opened photo writes the sidecar in
    // place (no save dialog), stamped for the freshness comparison
    const sync2 = await page.evaluate(async () => {
        const s = document.getElementById('exposure');
        s.value = 0.8;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('saveSettingsBtn').click();
        await new Promise(r => setTimeout(r, 400));
        const p = JSON.parse(
            await window.__sideFiles['a_frame1_settings.json'].text());
        return {
            status: document.getElementById('status').textContent,
            exposure: p.exposure, savedAt: typeof p.saved_at,
            ops: Array.isArray(p.baked_ops),
        };
    });
    check('Save settings writes the sidecar next to the photo',
        sync2.status === 'Settings saved next to the photo'
        && sync2.exposure === 0.8 && sync2.savedAt === 'number' && sync2.ops,
        JSON.stringify(sync2));

    // When the phone's local copy is the newer one, it wins
    const sync3 = await page.evaluate(async ([js]) => {
        const key = `filmSettings:b_frame2.jpg:${js}`;
        const local = JSON.parse(localStorage.getItem(key));
        local.contrast = 0.11;
        local.saved_at = Date.now() + 120_000;
        localStorage.setItem(key, JSON.stringify(local));
        const p = await resolveSettings(window.__browseDir, 'b_frame2.jpg', js);
        return p.contrast;
    }, [jpegSize]);
    check('newer phone edit wins over an older sidecar', sync3 === 0.11,
        String(sync3));

    // A frame edited only on the PC (sidecar, nothing local) still gets
    // the edited badge in the grid
    await page.evaluate(async ([js]) => {
        localStorage.removeItem(`filmSettings:b_frame2.jpg:${js}`);
        return mobileApp.browser.openWithHandle(window.__browseDir);
    }, [jpegSize]);
    await page.waitForFunction(() =>
        document.querySelectorAll('#browseGrid .browse-cell img').length === 2,
        null, { timeout: 60_000 });
    check('sidecar-only (PC-edited) frames show the edited badge',
        await page.evaluate(() => {
            const cells = document.querySelectorAll('#browseGrid .browse-cell');
            return !!cells[1].querySelector('.dot.edited');
        }));

    // --- Roll metadata: roll.json in the folder, shown under the bar
    // and stamped into exported TIFFs ---
    const roll = await page.evaluate(async () => {
        document.getElementById('rollBtn').click();
        const shown = document.getElementById('rollDialog').style.display === '';
        document.getElementById('rollFilm').value = 'Portra 400';
        document.getElementById('rollCamera').value = 'Canon AE-1';
        document.getElementById('rollIso').value = '800';
        document.getElementById('rollShot').value = 'June 2026';
        document.getElementById('rollNotes').value = 'test roll';
        document.getElementById('rollSaveBtn').click();
        await new Promise(r => setTimeout(r, 300));
        const f = window.__sideFiles['roll.json'];
        return {
            shown,
            saved: f ? JSON.parse(await f.text()) : null,
            line: document.getElementById('rollLine').textContent,
            lineShown: document.getElementById('rollLine').style.display !== 'none',
            toast: document.getElementById('browseToast').textContent,
        };
    });
    check('roll info saves as roll.json in the folder',
        roll.shown && !!roll.saved && roll.saved.film === 'Portra 400'
        && roll.saved.iso === '800'
        && roll.toast === 'Roll info saved to the folder',
        JSON.stringify(roll));
    check('roll line summarizes under the browse bar',
        roll.lineShown && roll.line
            === '🎞️ Portra 400 · Canon AE-1 · ISO 800 · June 2026 · test roll',
        roll.line);

    // Re-opening the folder reads roll.json back (not the local copy)
    const rollBack = await page.evaluate(async () => {
        localStorage.removeItem('filmRoll:test-scans');
        mobileApp.browser.roll = null;
        await mobileApp.browser.openWithHandle(window.__browseDir);
        return mobileApp.browser.rollLine();
    });
    check('roll.json is read back when the folder opens',
        rollBack === 'Portra 400 · Canon AE-1 · ISO 800 · June 2026 · test roll',
        rollBack);

    // The editor's own TIFF export stamps the roll as ImageDescription
    const stamped = await page.evaluate(async () => {
        let f = null;
        for await (const e of window.__browseDir.values()) {
            if (e.name === 'a_frame1.tif') f = await e.getFile();
        }
        await mobileApp.loadFile(f, { dir: window.__browseDir, canWrite: true });
        const blob = await mobileApp.makeTiffBlob();
        const ifd = UTIF.decode(await blob.arrayBuffer())[0];
        return ifd.t270 ? String(ifd.t270) : null;
    });
    check('editor TIFF export carries the roll in ImageDescription',
        !!stamped && stamped.includes('Portra 400') && stamped.includes('ISO 800'),
        String(stamped));

    // --- USB-drive regression: some Android storage providers mis-serve
    // byte-range reads through a folder handle (slice() comes back empty),
    // which made real TIFFs look "not supported". Whole-file reads work,
    // so both the thumbnailer and the decoder must fall back to them. ---
    const brokenSlice = await page.evaluate(async () => {
        let real = null;
        for await (const e of window.__browseDir.values()) {
            if (e.name === 'a_frame1.tif') real = await e.getFile();
        }
        const bad = new File([await real.arrayBuffer()], 'usb_scan.tif',
            { type: 'image/tiff', lastModified: 99 });
        bad.slice = () => new Blob([]); // the provider's broken range reads
        const c = await imageThumbCanvas(bad, 320);
        const img = await decodeImageFile(bad);
        return { w: c.width, h: c.height, dw: img.width, dh: img.height };
    });
    check('TIFF thumbnails survive a provider with broken range reads',
        brokenSlice.w === 320 && brokenSlice.h === 213,
        JSON.stringify(brokenSlice));
    check('TIFFs still open when the provider breaks range reads',
        brokenSlice.dw === 1200 && brokenSlice.dh === 800,
        JSON.stringify(brokenSlice));

    // Worse provider: even whole-file reads come back empty, only a
    // sequential stream works (how SAF serves USB drives on Android)
    const streamFallback = await page.evaluate(async () => {
        let real = null;
        for await (const e of window.__browseDir.values()) {
            if (e.name === 'a_frame1.tif') real = await e.getFile();
        }
        const bytes = await real.arrayBuffer();
        const mk = () => {
            const f = new File([bytes], 'usb2.tif', { type: 'image/tiff' });
            f.arrayBuffer = async () => new ArrayBuffer(0);
            f.slice = () => new Blob([]);
            return f;
        };
        const img = await decodeImageFile(mk()); // stream() still native
        const dead = mk();
        dead.stream = () => new ReadableStream({ start(c) { c.close(); } });
        let msg = '';
        try { await decodeImageFile(dead); } catch (e) { msg = e.message; }
        return { w: img.width, h: img.height, size: bytes.byteLength, msg };
    });
    check('whole-file reads fall back to sequential streaming',
        streamFallback.w === 1200 && streamFallback.h === 800,
        JSON.stringify({ w: streamFallback.w, h: streamFallback.h }));
    check('a fully broken provider reports how much was actually read',
        streamFallback.msg.includes(`0 of ${streamFallback.size} bytes`),
        streamFallback.msg);

    // Nastier still: reads "succeed" with the right byte count but junk
    // content (seen in the wild as "ImageData: width is zero"). Content
    // validation must reject it and re-read via the stream; if that's
    // junk too, the error must show the bytes actually seen.
    const garbage = await page.evaluate(async () => {
        let real = null;
        for await (const e of window.__browseDir.values()) {
            if (e.name === 'a_frame1.tif') real = await e.getFile();
        }
        const bytes = new Uint8Array(await real.arrayBuffer());
        const junk = new ArrayBuffer(bytes.byteLength); // right size, zeros
        const mk = () => {
            const f = new File([bytes], 'junk.tif', { type: 'image/tiff' });
            f.slice = () => new Blob([]);
            f.arrayBuffer = async () => junk.slice(0);
            return f;
        };
        const img = await decodeImageFile(mk()); // stream() has real bytes
        const dead = mk();
        dead.stream = () => new Blob([junk]).stream();
        let msg = '';
        try { await decodeImageFile(dead); } catch (e) { msg = e.message; }
        return { w: img.width, h: img.height, msg };
    });
    check('size-matching garbage reads are re-read via the stream',
        garbage.w === 1200 && garbage.h === 800,
        JSON.stringify({ w: garbage.w, h: garbage.h }));
    check('garbage-everywhere reads report the bytes actually seen',
        garbage.msg.includes('starting [00 00 00 00'), garbage.msg);

    // A provider that serves each range read slowly (the USB-drive
    // pattern: ~100ms per call, fast streaming) must get detected after
    // the first row batch and switched to one whole-file read - the
    // difference between ~20s and a couple of seconds per thumbnail
    const slowReads = await page.evaluate(async () => {
        let real = null;
        for await (const e of window.__browseDir.values()) {
            if (e.name === 'a_frame1.tif') real = await e.getFile();
        }
        const bytes = await real.arrayBuffer();
        const f = new File([bytes], 'slow_usb.tif', { type: 'image/tiff' });
        let sliceCalls = 0;
        let lock = Promise.resolve();
        f.slice = (a, b) => {
            sliceCalls++;
            const part = bytes.slice(a, b);
            return { arrayBuffer: () => (lock = lock.then(async () => {
                await new Promise(r => setTimeout(r, 40));
                return part.slice(0);
            })) };
        };
        const t0 = performance.now();
        const c = await imageThumbCanvas(f, 320);
        const ms = Math.round(performance.now() - t0);
        const verdict = READ_TUNING.slowRangeReads;
        // With the verdict in, the next file must not try range reads
        const g = new File([bytes], 'slow_usb2.tif', { type: 'image/tiff' });
        let gSlices = 0;
        g.slice = (a, b) => { gSlices++; return new Blob([bytes.slice(a, b)]); };
        const c2 = await imageThumbCanvas(g, 320);
        READ_TUNING.slowRangeReads = false; // don't leak into later tests
        return { w: c.width, h: c.height, ms, verdict, sliceCalls, gSlices,
            w2: c2.width };
    });
    check('slow range reads switch to one whole-file read mid-thumbnail',
        slowReads.verdict && slowReads.w === 320 && slowReads.h === 213
        && slowReads.sliceCalls < 30 && slowReads.ms < 5000,
        JSON.stringify(slowReads));
    check('later files skip range reads once a provider is known slow',
        slowReads.gSlices === 0 && slowReads.w2 === 320,
        JSON.stringify(slowReads));

    // ...and in the grid that failure surfaces as ⚠ plus a toast with
    // the real cause (phones have no console to check)
    const toastDiag = await page.evaluate(async () => {
        const f = new File([new Uint8Array(100)], 'dead_scan.tif',
            { type: 'image/tiff' });
        f.arrayBuffer = async () => { throw new DOMException('x', 'NotReadableError'); };
        f.slice = () => new Blob([]);
        f.stream = () => new ReadableStream({
            start(c) { c.error(new DOMException('x', 'NotReadableError')); },
        });
        await mobileApp.browser.openWithHandle({
            name: 'dead-usb',
            values: async function* () {
                yield { kind: 'file', name: 'dead_scan.tif', getFile: async () => f };
            },
        });
        return {
            warn: document.querySelector('#browseGrid .browse-thumb').textContent,
            toast: document.getElementById('browseToast').textContent,
            shown: document.getElementById('browseToast').style.display !== 'none',
        };
    });
    check('a dead folder shows ⚠ plus a diagnostic toast',
        toastDiag.warn === '⚠' && toastDiag.shown
        && toastDiag.toast.includes('0 of 100 bytes'),
        JSON.stringify(toastDiag));

    // --- Browsing must only ever ask to READ the folder; write access
    // (for settings sidecars) is requested at the moment something saves.
    // Asking for readwrite up front broke reads entirely on USB drives. ---
    const perm = await page.evaluate(async () => {
        const calls = [];
        const h = {
            name: 'perm-scans',
            values: window.__browseDir.values,
            getFileHandle: window.__browseDir.getFileHandle,
            queryPermission: async ({ mode }) => { calls.push('q:' + mode); return 'prompt'; },
            requestPermission: async ({ mode }) => { calls.push('r:' + mode); return 'granted'; },
        };
        await mobileApp.browser.openWithHandle(h);
        const afterOpen = calls.slice();
        const canWriteAfterOpen = mobileApp.browser.canWrite;
        const okWrite = await mobileApp.browser.ensureWrite();
        return { afterOpen, calls, canWriteAfterOpen, okWrite,
            canWrite: mobileApp.browser.canWrite };
    });
    check('browsing asks only for read access',
        perm.afterOpen.join() === 'q:read,r:read' && !perm.canWriteAfterOpen,
        JSON.stringify(perm));
    check('write access is requested only when something saves',
        perm.okWrite && perm.canWrite
        && perm.calls.slice(2).join() === 'q:readwrite,r:readwrite',
        JSON.stringify(perm.calls));

    // --- Batch: auto-crop all + export all (framed synthetic, photo mode) ---
    const frameB64 = fs.readFileSync(FRAME_TIFF).toString('base64');
    const frameSize = fs.statSync(FRAME_TIFF).size;
    await page.evaluate(([fb]) => {
        const bytes = Uint8Array.from(atob(fb), c => c.charCodeAt(0));
        const file = new File([bytes], 'roll_01.tif',
            { type: 'image/tiff', lastModified: 42 });
        window.__rollDir = {
            name: 'roll',
            values: async function* () {
                yield { kind: 'file', name: 'roll_01.tif', getFile: async () => file };
            },
        };
        window.__batchOut = {};
        window.__batchOutDir = {
            getFileHandle: async (name) => ({
                createWritable: async () => ({
                    write: async (blob) => { window.__batchOut[name] = blob; },
                    close: async () => {},
                }),
            }),
        };
        // A saved look: the exported file must come out brighter
        localStorage.setItem(`filmSettings:roll_01.tif:${bytes.length}`,
            JSON.stringify({ exposure: 1 }));
        // Roll info via the phone-local fallback (no roll.json here):
        // batch exports must still stamp it
        localStorage.setItem('filmRoll:roll',
            JSON.stringify({ film: 'HP5', iso: '1600' }));
        return mobileApp.browser.openWithHandle(window.__rollDir);
    }, [frameB64]);
    await page.waitForFunction(() =>
        document.querySelectorAll('#browseGrid .browse-cell img').length === 1,
        null, { timeout: 60_000 });

    await page.evaluate(() => {
        mobileApp.browser.enterSelect(0);
        document.getElementById('batchCropBtn').click();
    });
    await page.waitForFunction((fsz) => {
        const s = JSON.parse(
            localStorage.getItem(`filmSettings:roll_01.tif:${fsz}`) || '{}');
        return !!s.baked_ops;
    }, frameSize, { timeout: 120_000 });
    const bops = await page.evaluate((fsz) =>
        JSON.parse(localStorage.getItem(`filmSettings:roll_01.tif:${fsz}`)), frameSize);
    check('batch auto-crop saves the detected crop into the frame\'s settings',
        Math.abs(bops.baked_ops[0].angle + 0.6) < 0.11
        && bops.baked_ops[0].rect.width >= 1330 && bops.baked_ops[0].rect.width <= 1400
        && bops.baked_ops[0].rect.height >= 850 && bops.baked_ops[0].rect.height <= 920
        && bops.ops_width === 1600 && bops.exposure === 1 && bops.straighten === 0,
        JSON.stringify(bops.baked_ops) + ` exposure=${bops.exposure}`);

    await page.evaluate(() => {
        document.getElementById('batchExportBtn').click(); // opens the dialog
        document.getElementById('batchDialogGo').click();  // 16-bit TIFF default
    });
    await page.waitForFunction(() =>
        window.__batchOut && Object.keys(window.__batchOut).length === 1,
        null, { timeout: 120_000 });
    const exp = await page.evaluate(async (fsz) => {
        const blob = window.__batchOut['roll_01_edit.tif'];
        if (!blob) return { names: Object.keys(window.__batchOut) };
        const ifd = UTIF.decode(await blob.arrayBuffer())[0];
        const desc = ifd.t270 ? String(ifd.t270) : null;
        await mobileApp.loadFile(new File([blob], 'roll_01_edit.tif',
            { type: 'image/tiff' }));
        const r = mobileApp.renderer;
        let sum = 0, n = 0;
        for (let i = 0; i < r.imageData.length; i += 997) { sum += r.imageData[i]; n++; }
        return {
            w: r.imageWidth, h: r.imageHeight, mean: sum / n, desc,
            exported: !!localStorage.getItem(`filmExported:roll_01.tif:${fsz}`),
            badge: !!document.querySelector('#browseGrid .browse-cell .dot.exported'),
        };
    }, frameSize);
    check('batch export writes the auto-cropped frame at the right size',
        exp.w >= 1330 && exp.w <= 1400 && exp.h >= 850 && exp.h <= 920,
        JSON.stringify(exp));
    check('batch export applies the frame\'s saved look (exposure +1)',
        exp.mean > 0.55, `mean ${exp.mean && exp.mean.toFixed(3)}`);
    check('exported flag recorded and badge shown', exp.exported && exp.badge,
        JSON.stringify(exp));
    check('batch export stamps the roll into ImageDescription',
        !!exp.desc && exp.desc.includes('HP5') && exp.desc.includes('ISO 1600'),
        String(exp.desc));

    // Clean up batch-test state
    await page.evaluate(() => {
        mobileApp.browser.close();
        localStorage.removeItem('filmProcessorPresets');
        Object.keys(localStorage)
            .filter(k => k.startsWith('filmSettings:') || k.startsWith('filmExported:')
                || k.startsWith('filmRoll:'))
            .forEach(k => localStorage.removeItem(k));
    });

    const realErrors = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('Autofill'));
    check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} finally {
    await app.close().catch(() => {});
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} mobile checks passed`);
process.exit(failed.length ? 1 : 0);
