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

// --- Settings sidecars: <image>_settings.json next to the scan ---
// The desktop app auto-loads (and saves) the same files, so edits sync
// between phone and PC through the scans folder itself.

function sidecarName(imageName) {
    return imageName.replace(/\.[^.]+$/, '') + '_settings.json';
}

async function readSidecar(dirHandle, imageName) {
    try {
        const fh = await dirHandle.getFileHandle(sidecarName(imageName));
        const file = await fh.getFile();
        const params = JSON.parse(await file.text());
        // Phone-written sidecars carry saved_at; desktop-written ones
        // don't, so the file's own timestamp stands in
        return { params, mtime: params.saved_at || file.lastModified || 0 };
    } catch {
        return null; // no sidecar (normal) or unreadable
    }
}

async function writeJsonInDir(dirHandle, fileName, obj) {
    try {
        const fh = await dirHandle.getFileHandle(fileName, { create: true });
        const w = await fh.createWritable();
        await w.write(new Blob([JSON.stringify(obj, null, 2)],
            { type: 'application/json' }));
        await w.close();
        return true;
    } catch (e) {
        console.warn('Could not write ' + fileName + ' into the folder', e);
        return false;
    }
}

function writeSidecar(dirHandle, imageName, params) {
    return writeJsonInDir(dirHandle, sidecarName(imageName), params);
}

// The freshest settings for a frame: the folder sidecar (shared with
// the PC) vs this phone's local copy, whichever was saved last. The
// desktop app doesn't know about baked_ops, so a sidecar it saved
// gets the phone's crop merged back in - a PC round-trip never loses
// a crop made on the phone.
// `known` (a Set of lowercased sidecar names from the folder listing, if
// the caller has one) skips the lookup for frames with no sidecar - on
// some providers every by-name miss is a slow directory query.
async function resolveSettings(dirHandle, name, size, known = null) {
    const local = loadSavedSettings(name, size);
    const exists = !known || known.has(sidecarName(name).toLowerCase());
    const side = dirHandle && exists ? await readSidecar(dirHandle, name) : null;
    if (!side) return local;
    if (local && (local.saved_at || 0) > side.mtime) return local;
    if (local && local.baked_ops && !side.params.baked_ops) {
        side.params.baked_ops = local.baked_ops;
        side.params.ops_width = local.ops_width;
    }
    return side.params;
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
    const gamma = (v) => (typeof v === 'number' ? v : 1);
    return {
        exposure: num(p.exposure), contrast: num(p.contrast),
        highlights: num(p.highlights), shadows: num(p.shadows),
        whites: num(p.whites), blacks: num(p.blacks),
        red: num(p.red), green: num(p.green), blue: num(p.blue),
        density: [gamma(p.density_r), gamma(p.density_g), gamma(p.density_b)],
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
    // Quality 1.0 is the only setting where the browser encoder skips
    // chroma subsampling (full-resolution colour, Photoshop "Maximum").
    return new Promise(res => canvas.toBlob(res, 'image/jpeg', 1.0));
}

// Let a status update reach the screen before the next CPU-heavy file
const nextPaint = () => new Promise(res => setTimeout(res, 30));

class BatchProcessor {
    constructor(app) {
        this.app = app;
        this.renderer = null; // offscreen, created once, reused across runs
        this.cancelled = false;
        this.srcDir = null;   // browse folder handle (sidecar reads)
        this.canWrite = false; // readwrite granted (sidecar writes)
        this.knownSidecars = null; // sidecar names seen in the listing
    }

    // Save a frame's settings locally AND to its folder sidecar, so the
    // desktop app picks the edit up from the scans folder
    async persistSettings(name, size, settings) {
        settings.saved_at = Date.now();
        saveSavedSettings(name, size, settings);
        if (this.srcDir && this.canWrite
            && await writeSidecar(this.srcDir, name, settings)
            && this.knownSidecars) {
            this.knownSidecars.add(sidecarName(name).toLowerCase());
        }
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
                const settings = await resolveSettings(
                    this.srcDir, file.name, file.size, this.knownSidecars) || {};
                const ops = this.detectOps(img, this.stateFor(settings));
                if (!ops) { failed.push(entry.name); continue; }
                settings.baked_ops = ops;
                settings.ops_width = img.width;
                settings.straighten = 0; // the op bakes the angle
                await this.persistSettings(file.name, file.size, settings);
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
    async exportOne(file, settings, format, img = null, desc = '') {
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
        // desc: roll metadata, stamped as the TIFF's ImageDescription
        return new Blob([encodeTiff16(data16, width, height, desc)],
            { type: 'image/tiff' });
    }

    // Render one frame small, with its saved look and baked crop applied -
    // the building block of a contact sheet
    async renderThumbCanvas(file, settings, maxDim) {
        const r = this.offscreen();
        const img = await decodeImageFile(file, maxDim);
        const k = settings.ops_width ? img.width / settings.ops_width : 1;
        const ops = (settings.baked_ops || []).map(op => ({
            angle: op.angle || 0,
            rect: op.rect ? {
                x: op.rect.x * k, y: op.rect.y * k,
                width: op.rect.width * k, height: op.rect.height * k,
            } : null,
        }));
        const prepared = prepareSource(img, ops, this.stateFor(settings));
        r.updateParams(rendererParamsFor(settings));
        const { data16, width, height } = r.renderToPixels16(prepared);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const id = ctx.createImageData(width, height);
        for (let i = 0; i < width * height; i++) {
            id.data[i * 4] = Math.round(data16[i * 3] / 257);
            id.data[i * 4 + 1] = Math.round(data16[i * 3 + 1] / 257);
            id.data[i * 4 + 2] = Math.round(data16[i * 3 + 2] / 257);
            id.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(id, 0, 0);
        return canvas;
    }

    // Compose a classic dark-ground contact sheet: the selected frames in
    // a grid, each with its saved look and crop applied, filename under
    // each frame, roll info in the header. Returns { blob (JPEG), failed }.
    async contactSheet(entries, header, onProgress) {
        this.cancelled = false;
        const CELL = 560, LABEL = 40, GAP = 24;
        const cols = Math.min(6, Math.ceil(Math.sqrt(entries.length)));
        const rows = Math.ceil(entries.length / cols);
        const headerH = header ? 84 : 40;
        const W = GAP + cols * (CELL + GAP);
        const H = headerH + rows * (CELL + LABEL + GAP) + GAP;
        const sheet = document.createElement('canvas');
        sheet.width = W;
        sheet.height = H;
        const ctx = sheet.getContext('2d');
        ctx.fillStyle = '#141414';
        ctx.fillRect(0, 0, W, H);
        if (header) {
            ctx.fillStyle = '#e8e8e8';
            ctx.font = '600 30px system-ui, sans-serif';
            ctx.fillText(header, GAP, 52, W - 2 * GAP);
        }
        const failed = [];
        for (let i = 0; i < entries.length; i++) {
            if (this.cancelled) break;
            onProgress(i, entries.length, entries[i].name);
            await nextPaint();
            const cx = GAP + (i % cols) * (CELL + GAP);
            const cy = headerH + Math.floor(i / cols) * (CELL + LABEL + GAP);
            try {
                const file = await entries[i].handle.getFile();
                const settings = await resolveSettings(
                    this.srcDir, file.name, file.size, this.knownSidecars) || {};
                const c = await this.renderThumbCanvas(file, settings, CELL);
                const s = Math.min(CELL / c.width, CELL / c.height);
                const dw = Math.round(c.width * s), dh = Math.round(c.height * s);
                ctx.drawImage(c, cx + (CELL - dw) / 2, cy + (CELL - dh) / 2, dw, dh);
            } catch (e) {
                console.warn('Contact sheet: frame failed - ' + entries[i].name, e);
                failed.push(entries[i].name);
            }
            ctx.fillStyle = '#9a9a9a';
            ctx.font = '24px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.fillText(entries[i].name.replace(/\.[^.]+$/, ''),
                cx + CELL / 2, cy + CELL + 30, CELL);
            ctx.textAlign = 'left';
        }
        const blob = await new Promise(res => sheet.toBlob(res, 'image/jpeg', 0.92));
        return { blob, failed };
    }

    // opts: { format: 'tiff'|'jpeg', autoCrop, dir: directory handle,
    //         desc: roll metadata line for the TIFFs' description tag }
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
                const settings = await resolveSettings(
                    this.srcDir, file.name, file.size, this.knownSidecars) || {};
                let img = null;
                if (opts.autoCrop && !settings.baked_ops) {
                    img = await decodeImageFile(file);
                    const ops = this.detectOps(img, this.stateFor(settings));
                    if (ops) {
                        settings.baked_ops = ops;
                        settings.ops_width = img.width;
                        settings.straighten = 0;
                        await this.persistSettings(file.name, file.size, settings);
                    }
                }
                const blob = await this.exportOne(file, settings, opts.format,
                    img, opts.desc || '');
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
