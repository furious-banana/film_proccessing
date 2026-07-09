// Image pipeline for the standalone mobile app: decoding, geometry and the
// "baked" source preparation (inversion, film base correction, straighten,
// crops). Per-pixel *adjustments* are NOT here - they live in the WebGL
// shader (webgl-renderer.js), which is the same pipeline as the desktop app.
//
// All images are { data: Float32Array (RGB interleaved, 0..1), width, height }.

'use strict';

// Working resolution cap. Phones can't hold a 22MP float pipeline in
// browser memory; editing and export happen at this size.
const MAX_WORK_SIZE = 4096;

// ---------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------

// Adobe RGB -> sRGB matrix (same values as the desktop server)
const ADOBE_TO_SRGB = [
    1.39822014, -0.39830039, -0.00006393,
    0.00010625, 0.99991441, 0.00000183,
    0.00003334, -0.04293803, 1.04296793,
];

function convertAdobeRGB(img) {
    const d = img.data;
    const m = ADOBE_TO_SRGB;
    for (let i = 0; i < d.length; i += 3) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        d[i] = Math.min(1, Math.max(0, m[0] * r + m[1] * g + m[2] * b));
        d[i + 1] = Math.min(1, Math.max(0, m[3] * r + m[4] * g + m[5] * b));
        d[i + 2] = Math.min(1, Math.max(0, m[6] * r + m[7] * g + m[8] * b));
    }
    return img;
}

function bufferContainsAscii(bytes, text) {
    outer:
    for (let i = 0; i + text.length <= bytes.length; i++) {
        for (let j = 0; j < text.length; j++) {
            if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
        }
        return true;
    }
    return false;
}

function decodeTiff(arrayBuffer) {
    const ifds = UTIF.decode(arrayBuffer);
    if (!ifds.length) throw new Error('No image found in TIFF');
    // Pick the largest sub-image (some scanners embed thumbnails)
    let ifd = ifds[0];
    for (const cand of ifds) {
        if ((cand.t256?.[0] || 0) * (cand.t257?.[0] || 0)
            > (ifd.t256?.[0] || 0) * (ifd.t257?.[0] || 0)) ifd = cand;
    }
    UTIF.decodeImage(arrayBuffer, ifd);

    const width = ifd.width, height = ifd.height;
    const bps = ifd.t258 ? (ifd.t258[0] || 8) : 8;
    const spp = ifd.t277 ? (ifd.t277[0] || 1) : 1;
    const n = width * height;
    const out = new Float32Array(n * 3);
    const raw = ifd.data; // Uint8Array of decompressed sample data

    if (bps === 16) {
        // UTIF converts big-endian 16-bit data to little-endian during
        // decodeImage, so samples are read directly - do NOT swap again
        // (a double swap shows as rainbow noise in the shadows)
        const src16 = new Uint16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
        for (let i = 0; i < n; i++) {
            for (let c = 0; c < 3; c++) {
                const s = spp >= 3 ? i * spp + c : i * spp;
                out[i * 3 + c] = src16[s] / 65535;
            }
        }
    } else {
        for (let i = 0; i < n; i++) {
            for (let c = 0; c < 3; c++) {
                const s = spp >= 3 ? i * spp + c : i * spp;
                out[i * 3 + c] = raw[s] / 255;
            }
        }
    }

    const img = { data: out, width, height, bitDepth: bps };

    // Convert Adobe RGB scans to sRGB (same behavior as the desktop app)
    const icc = ifd.t34675;
    if (icc && bufferContainsAscii(icc instanceof Uint8Array ? icc : new Uint8Array(icc), 'Adobe RGB')) {
        convertAdobeRGB(img);
        img.colorConverted = 'AdobeRGB->sRGB';
    }
    return img;
}

async function decodeBrowserImage(file) {
    // createImageBitmap is fastest, but some formats a browser can display
    // (e.g. HEIC on iOS) aren't supported by it - fall back to an <img>
    let source, width, height;
    let objectUrl = null;
    try {
        source = await createImageBitmap(file);
        width = source.width;
        height = source.height;
    } catch {
        objectUrl = URL.createObjectURL(file);
        source = new Image();
        source.src = objectUrl;
        try {
            await source.decode();
        } catch {
            URL.revokeObjectURL(objectUrl);
            throw new Error(`This image format isn't supported by your browser`
                + (file.name ? ` (${file.name})` : ''));
        }
        width = source.naturalWidth;
        height = source.naturalHeight;
    }
    if (!width || !height) throw new Error('Image decoded to an empty size');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    if (source.close) source.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);

    const { data } = ctx.getImageData(0, 0, width, height);
    const n = width * height;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        out[i * 3] = data[i * 4] / 255;
        out[i * 3 + 1] = data[i * 4 + 1] / 255;
        out[i * 3 + 2] = data[i * 4 + 2] / 255;
    }
    return { data: out, width, height, bitDepth: 8 };
}

// Decode any supported file to float RGB, capped to the working resolution
async function decodeImageFile(file) {
    // Detect TIFF by magic bytes, not filename - phone pickers sometimes
    // hand over files with unhelpful names
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isTiff = (head[0] === 0x49 && head[1] === 0x49 && head[2] === 42)
        || (head[0] === 0x4D && head[1] === 0x4D && head[3] === 42);

    const img = isTiff
        ? decodeTiff(await file.arrayBuffer())
        : await decodeBrowserImage(file);

    if (Math.max(img.width, img.height) > MAX_WORK_SIZE) {
        const scale = MAX_WORK_SIZE / Math.max(img.width, img.height);
        return resizeBilinear(img, Math.round(img.width * scale), Math.round(img.height * scale));
    }
    return img;
}

// ---------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------

function resizeBilinear(img, newW, newH) {
    const { data, width, height } = img;
    const out = new Float32Array(newW * newH * 3);
    const sx = width / newW, sy = height / newH;
    for (let y = 0; y < newH; y++) {
        const fy = Math.min(height - 1.001, (y + 0.5) * sy - 0.5);
        const y0 = Math.max(0, Math.floor(fy));
        const wy = fy - y0;
        const y1 = Math.min(height - 1, y0 + 1);
        for (let x = 0; x < newW; x++) {
            const fx = Math.min(width - 1.001, (x + 0.5) * sx - 0.5);
            const x0 = Math.max(0, Math.floor(fx));
            const wx = fx - x0;
            const x1 = Math.min(width - 1, x0 + 1);
            const i00 = (y0 * width + x0) * 3, i10 = (y0 * width + x1) * 3;
            const i01 = (y1 * width + x0) * 3, i11 = (y1 * width + x1) * 3;
            const o = (y * newW + x) * 3;
            for (let c = 0; c < 3; c++) {
                const top = data[i00 + c] * (1 - wx) + data[i10 + c] * wx;
                const bot = data[i01 + c] * (1 - wx) + data[i11 + c] * wx;
                out[o + c] = top * (1 - wy) + bot * wy;
            }
        }
    }
    return {
        data: out, width: newW, height: newH,
        bitDepth: img.bitDepth, colorConverted: img.colorConverted,
    };
}

// Rotate clockwise by `angleDeg`, expanding the canvas (same semantics as
// the desktop server's _rotate_cpu, incl. the border fill convention)
function rotateImage(img, angleDeg, fill) {
    if (!angleDeg) return img;
    const { data, width, height } = img;
    const rad = angleDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const newW = Math.round(height * Math.abs(sin) + width * Math.abs(cos));
    const newH = Math.round(height * Math.abs(cos) + width * Math.abs(sin));
    const out = new Float32Array(newW * newH * 3).fill(fill);
    const cx = width / 2, cy = height / 2;
    const ncx = newW / 2, ncy = newH / 2;

    for (let y = 0; y < newH; y++) {
        const dy = y + 0.5 - ncy;
        for (let x = 0; x < newW; x++) {
            const dx = x + 0.5 - ncx;
            // Inverse rotation (dest -> source), clockwise display rotation
            const sxF = dx * cos - dy * sin + cx - 0.5;
            const syF = dx * sin + dy * cos + cy - 0.5;
            if (sxF < 0 || syF < 0 || sxF > width - 1 || syF > height - 1) continue;
            const x0 = Math.floor(sxF), y0 = Math.floor(syF);
            const wx = sxF - x0, wy = syF - y0;
            const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
            const i00 = (y0 * width + x0) * 3, i10 = (y0 * width + x1) * 3;
            const i01 = (y1 * width + x0) * 3, i11 = (y1 * width + x1) * 3;
            const o = (y * newW + x) * 3;
            for (let c = 0; c < 3; c++) {
                const top = data[i00 + c] * (1 - wx) + data[i10 + c] * wx;
                const bot = data[i01 + c] * (1 - wx) + data[i11 + c] * wx;
                out[o + c] = top * (1 - wy) + bot * wy;
            }
        }
    }
    return { data: out, width: newW, height: newH, bitDepth: img.bitDepth };
}

function cropImage(img, rect) {
    const { data, width } = img;
    const x = Math.max(0, Math.min(Math.round(rect.x), img.width - 1));
    const y = Math.max(0, Math.min(Math.round(rect.y), img.height - 1));
    const w = Math.max(1, Math.min(Math.round(rect.width), img.width - x));
    const h = Math.max(1, Math.min(Math.round(rect.height), img.height - y));
    const out = new Float32Array(w * h * 3);
    for (let row = 0; row < h; row++) {
        const src = ((y + row) * width + x) * 3;
        out.set(data.subarray(src, src + w * 3), row * w * 3);
    }
    return { data: out, width: w, height: h, bitDepth: img.bitDepth };
}

// ---------------------------------------------------------------------
// Film base detection (port of the desktop algorithm: median color of the
// brightest 5% of the raw negative)
// ---------------------------------------------------------------------

function detectFilmBase(img) {
    const { data, width, height } = img;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 200000)));
    const lums = [];
    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const i = (y * width + x) * 3;
            lums.push((data[i] + data[i + 1] + data[i + 2]) / 3);
        }
    }
    const sorted = [...lums].sort((a, b) => a - b);
    const threshold = sorted[Math.floor(sorted.length * 0.95)];

    const rs = [], gs = [], bs = [];
    let k = 0;
    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            if (lums[k++] >= threshold) {
                const i = (y * width + x) * 3;
                rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
            }
        }
    }
    if (!rs.length) return null;
    const median = (arr) => {
        arr.sort((a, b) => a - b);
        return arr[Math.floor(arr.length / 2)];
    };
    return [median(rs), median(gs), median(bs)];
}

// ---------------------------------------------------------------------
// Source preparation
//
// original     : decoded scan (scanner space, positive or negative)
// bakedOps     : [{ angle, rect }] - each crop bakes the straighten angle
//                that was active when it was applied (desktop semantics)
// state        : { isNegative, filmCorrection, straighten }
//
// Returns the image the shader receives as its input texture.
// ---------------------------------------------------------------------

function prepareSource(original, bakedOps, state) {
    const fill = state.isNegative ? 1.0 : 0.0;

    let img = original;
    for (const op of bakedOps) {
        img = rotateImage(img, op.angle, fill);
        if (op.rect) img = cropImage(img, op.rect); // 90-degree turns have no crop
    }
    img = rotateImage(img, state.straighten || 0, fill);

    // From here on everything is per-pixel; copy so the geometry result
    // could be cached by callers if they want
    const out = new Float32Array(img.data);
    const result = { data: out, width: img.width, height: img.height, bitDepth: img.bitDepth };

    let base = null;
    if (state.isNegative && state.filmCorrection > 0) {
        base = detectFilmBase(result); // detect on the raw negative
    }

    if (state.isNegative) {
        for (let i = 0; i < out.length; i++) out[i] = 1.0 - out[i];
    }

    if (base) {
        const s = state.filmCorrection;
        for (let i = 0; i < out.length; i += 3) {
            out[i] = Math.max(0, out[i] - base[0] * s);
            out[i + 1] = Math.max(0, out[i + 1] - base[1] * s);
            out[i + 2] = Math.max(0, out[i + 2] - base[2] * s);
        }
    }
    return result;
}
