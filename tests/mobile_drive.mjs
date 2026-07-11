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

    // Save button delivers a <name>_settings.json with the current edits
    const savedFile = await page.evaluate(async () => {
        const orig = mobileApp.deliverFile;
        let captured = null;
        mobileApp.deliverFile = async (blob, filename) => {
            captured = { filename, text: await blob.text() };
            return true;
        };
        document.getElementById('saveSettingsBtn').click();
        await new Promise(res => setTimeout(res, 150));
        mobileApp.deliverFile = orig;
        return captured && { filename: captured.filename,
            contrast: JSON.parse(captured.text).contrast };
    });
    check('save settings delivers <name>_settings.json',
        !!savedFile && savedFile.filename.endsWith('_settings.json')
        && savedFile.contrast === 0.2,
        JSON.stringify(savedFile));

    // Settings restore straighten by baking it (presets skip straighten)
    await page.evaluate(() => mobileApp.applySettings({ straighten: 1.5 }));
    await page.waitForFunction(() => mobileApp.bakedStraighten === 1.5,
        null, { timeout: 30_000 });
    check('settings restore straighten (baked)', true);
    await page.evaluate(() => mobileApp.applySettings({ straighten: 0 }));
    await page.waitForFunction(() => mobileApp.renderer.imageWidth === 1200,
        null, { timeout: 30_000 });

    // Clean up the edits this block made
    await page.evaluate(() => {
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
        exportClean.every(v => v > 0.6 && v < 0.8), JSON.stringify(exportClean));
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

    const realErrors = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('Autofill'));
    check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} finally {
    await app.close().catch(() => {});
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} mobile checks passed`);
process.exit(failed.length ? 1 : 0);
