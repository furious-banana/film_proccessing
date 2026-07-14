// Batch processing: apply saved settings, auto-crop and export across
// many frames selected in the folder browser. Rendering reuses the same
// WebGL pipeline as the editor (via an offscreen canvas), so a batch
// export is pixel-identical to exporting each frame by hand.

'use strict';

// Per-photo storage keys, shared with the editor's remember/auto-load
function filmSettingsKey(name, size) {
    return `filmSettings:${name}:${size}`;
}
function filmExportedKey(name, size) {
    return `filmExported:${name}:${size}`;
}
function loadSavedSettings(name, size) {
    try {
        return JSON.parse(localStorage.getItem(filmSettingsKey(name, size)));
    } catch {
        return null;
    }
}
function saveSavedSettings(name, size, params) {
    try {
        localStorage.setItem(filmSettingsKey(name, size), JSON.stringify(params));
    } catch { /* storage full - batch actions still run */ }
}

// Pasting settings copies the LOOK, never the geometry: crop and
// straighten are per-frame (every scan sits differently in the holder)
function stripGeometry(params) {
    const p = { ...params };
    delete p.straighten;
    delete p.baked_ops;
    delete p.ops_width;
    return p;
}

// Settings JSON -> the shader's parameter set (the same mapping the
// editor's updateImage() does from its live controls)
function rendererParamsFor(p) {
    const num = (v) => (typeof v === 'number' ? v : 0);
    const point = (r, g, b) => p[r] !== undefined
        ? [p[r] / 255, p[g] / 255, p[b] / 255] : null;
    const bp = point('black_point_r', 'black_point_g', 'black_point_b');
    const wp = point('white_point_r', 'white_point_g', 'white_point_b');
    const gp = point('gray_point_r', 'gray_point_g', 'gray_point_b');
    const line = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const curves = p.curves
        ? (typeof p.curves === 'string' ? p.curves : JSON.stringify(p.curves))
        : JSON.stringify({ rgb: line, red: line, green: line, blue: line });
    return {
        exposure: num(p.exposure), contrast: num(p.contrast),
        highlights: num(p.highlights), shadows: num(p.shadows),
        whites: num(p.whites), blacks: num(p.blacks),
        red: num(p.red), green: num(p.green), blue: num(p.blue),
        blackPoint: bp || [0, 0, 0], hasBlackPoint: !!bp,
        whitePoint: wp || [1, 1, 1], hasWhitePoint: !!wp,
        grayPoint: gp || [0.5, 0.5, 0.5], hasGrayPoint: !!gp,
        curves,
        showOriginal: false, clipMode: 0,
    };
}

function pixels16ToJpegBlob(data16, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
        imgData.data[i * 4] = Math.round(data16[i * 3] / 257);
        imgData.data[i * 4 + 1] = Math.round(data16[i * 3 + 1] / 257);
        imgData.data[i * 4 + 2] = Math.round(data16[i * 3 + 2] / 257);
        imgData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95));
}

// Let a status update reach the screen before the next CPU-heavy file
const nextPaint = () => new Promise(res => setTimeout(res, 30));

class BatchProcessor {
    constructor(app) {
        this.app = app;
        this.renderer = null; // offscreen, created once, reused across runs
        this.cancelled = false;
    }

    offscreen() {
        if (!this.renderer) {
            this.renderer = new MobileRenderer(document.createElement('canvas'));
        }
        return this.renderer;
    }

    stateFor(settings) {
        const neg = this.app.isNegative;
        return {
            isNegative: neg,
            filmCorrection: neg ? (settings.film_correction ?? 1) : 0,
            straighten: settings.straighten || 0,
        };
    }

    // Headless version of the editor's ✨ Auto button: detect, straighten,
    // re-detect on the straightened source (where the crop will apply)
    detectOps(img, state) {
        let src = prepareSource(img, [], { ...state, straighten: 0 });
        let det = detectFrame(src);
        if (!det) return null;
        let angle = 0;
        if (Math.abs(det.angle) > 0.02) {
            angle = det.angle;
            src = prepareSource(img, [], { ...state, straighten: angle });
            det = detectFrame(src, { ignore: [[0, 0, 0]] }) || det;
        }
        return [{ angle, rect: det.rect }];
    }

    // Detect every selected frame and save the crop into its settings, so
    // opening the photo (or batch-exporting it) applies the crop
    async autoCropAll(entries, onProgress) {
        this.cancelled = false;
        let done = 0;
        const failed = [];
        for (let i = 0; i < entries.length; i++) {
            if (this.cancelled) break;
            const entry = entries[i];
            onProgress(i, entries.length, entry.name);
            await nextPaint();
            try {
                const file = await entry.handle.getFile();
                const img = await decodeImageFile(file);
                const settings = loadSavedSettings(file.name, file.size) || {};
                const ops = this.detectOps(img, this.stateFor(settings));
                if (!ops) { failed.push(entry.name); continue; }
                settings.baked_ops = ops;
                settings.ops_width = img.width;
                settings.straighten = 0; // the op bakes the angle
                saveSavedSettings(file.name, file.size, settings);
                done++;
            } catch (e) {
                console.warn('Auto-crop failed for ' + entry.name, e);
                failed.push(entry.name);
            }
        }
        return { done, failed };
    }

    // Render one frame exactly like the editor's export path: replay the
    // baked ops on a native-resolution decode when the working copy was
    // downscaled, run the shader in bands, encode
    async exportOne(file, settings, format, img = null) {
        const r = this.offscreen();
        if (!img) img = await decodeImageFile(file);
        const k = settings.ops_width ? img.width / settings.ops_width : 1;
        const ops = (settings.baked_ops || []).map(op => ({
            angle: op.angle || 0,
            rect: op.rect ? {
                x: op.rect.x * k, y: op.rect.y * k,
                width: op.rect.width * k, height: op.rect.height * k,
            } : null,
        }));
        const state = this.stateFor(settings);

        let prepared = null;
        if (img.fullWidth > img.width || img.fullHeight > img.height) {
            try {
                const native = await decodeImageFile(file, r.maxSourceSize());
                prepared = prepareSource(native, ops, state, native.width / img.width);
            } catch (e) {
                console.warn('Full-resolution render failed; using working size', e);
            }
        }
        if (!prepared) prepared = prepareSource(img, ops, state);

        r.updateParams(rendererParamsFor(settings));
        const { data16, width, height } = r.renderToPixels16(prepared);
        if (format === 'jpeg') return pixels16ToJpegBlob(data16, width, height);
        return new Blob([encodeTiff16(data16, width, height)], { type: 'image/tiff' });
    }

    // opts: { format: 'tiff'|'jpeg', autoCrop, dir: directory handle }
    async exportAll(entries, opts, onProgress) {
        this.cancelled = false;
        let done = 0;
        const failed = [];
        for (let i = 0; i < entries.length; i++) {
            if (this.cancelled) break;
            const entry = entries[i];
            onProgress(i, entries.length, entry.name);
            await nextPaint();
            try {
                const file = await entry.handle.getFile();
                const settings = loadSavedSettings(file.name, file.size) || {};
                let img = null;
                if (opts.autoCrop && !settings.baked_ops) {
                    img = await decodeImageFile(file);
                    const ops = this.detectOps(img, this.stateFor(settings));
                    if (ops) {
                        settings.baked_ops = ops;
                        settings.ops_width = img.width;
                        settings.straighten = 0;
                        saveSavedSettings(file.name, file.size, settings);
                    }
                }
                const blob = await this.exportOne(file, settings, opts.format, img);
                const outName = file.name.replace(/\.[^.]+$/, '')
                    + '_edit.' + (opts.format === 'jpeg' ? 'jpg' : 'tif');
                const fh = await opts.dir.getFileHandle(outName, { create: true });
                const w = await fh.createWritable();
                await w.write(blob);
                await w.close();
                localStorage.setItem(filmExportedKey(file.name, file.size),
                    String(Date.now()));
                done++;
            } catch (e) {
                console.warn('Export failed for ' + entry.name, e);
                failed.push(entry.name);
            }
        }
        return { done, failed };
    }
}
