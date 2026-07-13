// Auto frame detection: finds the exposed image inside a scan that
// includes the film-holder border (and possibly a sliver of film edge),
// slanted by up to a few degrees.
//
// How: the border color is sampled from the outermost ring of pixels
// (adaptive - works on raw negatives, positives and inverted sources
// alike). Each row/column is scanned inward for the first sustained
// run of non-border pixels; a robust line fit per edge gives the four
// frame edges. The line slopes yield the slant angle; the lines'
// conservative inner rectangle is the crop.
//
// detectFrame(img, opts) -> { angle, rect: {x, y, width, height} } | null
//   img:  { data: Float32Array RGB [0,1], width, height }
//   opts: { debug, ignore: [[r,g,b], ...] } - ignore lists colors that
//         are NOT frame content, e.g. the black fill wedges a baked
//         straighten adds outside the scan boundary (without this the
//         detector locks onto the rotated scan boundary instead of the
//         frame edge)
//   angle: degrees to ADD to the straighten slider (positive = image
//          turns clockwise, matching the pipeline convention)
//   rect:  full-resolution pixel rect of the frame, valid once the
//          image is straightened (re-run after baking for best results)

'use strict';

function detectFrame(img, opts = {}) {
    const fail = (stage, info) => (opts.debug ? { fail: stage, ...info } : null);
    const ignore = opts.ignore || [];
    const { data, width, height } = img;

    // --- 1. Downsample to <= ~1000px on the long edge ---
    const stride = Math.max(1, Math.ceil(Math.max(width, height) / 1000));
    const W = Math.floor(width / stride), H = Math.floor(height / stride);
    if (W < 40 || H < 40) return null;
    const small = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const si = (y * stride * width + x * stride) * 3;
            const di = (y * W + x) * 3;
            small[di] = data[si];
            small[di + 1] = data[si + 1];
            small[di + 2] = data[si + 2];
        }
    }

    // --- 2. Border color: per-channel median of the outer 2px ring.
    // Ignored colors (rotation fill) are excluded - after a baked
    // straighten the ring is largely fill, which must not be mistaken
    // for the border or the white holder would read as content. ---
    const IGNORE_DELTA = 0.04;
    const isIgnored = (r, g, b) => ignore.some(ig =>
        Math.abs(r - ig[0]) <= IGNORE_DELTA && Math.abs(g - ig[1]) <= IGNORE_DELTA
        && Math.abs(b - ig[2]) <= IGNORE_DELTA);
    const ring = [[], [], []];
    const pushPx = (x, y) => {
        const i = (y * W + x) * 3;
        if (isIgnored(small[i], small[i + 1], small[i + 2])) return;
        ring[0].push(small[i]); ring[1].push(small[i + 1]); ring[2].push(small[i + 2]);
    };
    for (let x = 0; x < W; x++) { pushPx(x, 0); pushPx(x, 1); pushPx(x, H - 1); pushPx(x, H - 2); }
    for (let y = 2; y < H - 2; y++) { pushPx(0, y); pushPx(1, y); pushPx(W - 1, y); pushPx(W - 2, y); }
    if (ring[0].length < 50) return fail('ring', { ringSamples: ring[0].length });
    const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
    const border = [median(ring[0]), median(ring[1]), median(ring[2])];
    const mads = border.map((b, c) => median(ring[c].map(v => Math.abs(v - b))));
    const delta = Math.max(0.08, 6 * Math.max(...mads));
    // No recognizable uniform border ring at all -> nothing to detect
    if (Math.max(...mads) > 0.15) return fail('ring', { border, mads });

    const isContent = (x, y) => {
        const i = (y * W + x) * 3;
        const r = small[i], g = small[i + 1], b = small[i + 2];
        if (Math.abs(r - border[0]) <= delta && Math.abs(g - border[1]) <= delta
            && Math.abs(b - border[2]) <= delta) return false;
        return !isIgnored(r, g, b);
    };

    // --- 3. Inward scans: first run of 3 content pixels per row/column.
    // Only the middle 80% of each edge is used (corners are messy). ---
    const RUN = 3;
    const scan = (fixed, limit, probe) => {
        for (let v = 0; v <= limit - RUN; v++) {
            if (probe(v, fixed) && probe(v + 1, fixed) && probe(v + 2, fixed)) return v;
        }
        return -1;
    };
    const leftPts = [], rightPts = [], topPts = [], botPts = [];
    const y0 = Math.floor(H * 0.1), y1 = Math.ceil(H * 0.9);
    for (let y = y0; y < y1; y++) {
        const l = scan(y, W, (x, yy) => isContent(x, yy));
        if (l >= 0) leftPts.push([y, l]);
        const r = scan(y, W, (x, yy) => isContent(W - 1 - x, yy));
        if (r >= 0) rightPts.push([y, W - 1 - r]);
    }
    const x0 = Math.floor(W * 0.1), x1 = Math.ceil(W * 0.9);
    for (let x = x0; x < x1; x++) {
        const t = scan(x, H, (y, xx) => isContent(xx, y));
        if (t >= 0) topPts.push([x, t]);
        const b = scan(x, H, (y, xx) => isContent(xx, H - 1 - y));
        if (b >= 0) botPts.push([x, H - 1 - b]);
    }
    const minPts = Math.floor(Math.min(W, H) * 0.4);
    if (leftPts.length < minPts || rightPts.length < minPts
        || topPts.length < minPts || botPts.length < minPts) {
        return fail('points', { border, delta, minPts, counts:
            [leftPts.length, rightPts.length, topPts.length, botPts.length] });
    }

    // --- 4. Robust line fit: value = a + slope*coord, least squares with
    // two rounds of outlier rejection (content touching the border shows
    // up as isolated far-off points) ---
    // `inward` (+1/-1): which residual direction points INTO the frame.
    // The fitted line runs through the middle of the physically ragged
    // film edge; `shift` is how far inward the raggedness reaches among
    // kept points, so line+shift is the edge's clean inner envelope.
    const fitLine = (pts, inward) => {
        let cur = pts;
        let a = 0, slope = 0;
        for (let round = 0; round < 3; round++) {
            let sc = 0, sv = 0, scc = 0, scv = 0;
            const n = cur.length;
            for (const [c, v] of cur) { sc += c; sv += v; scc += c * c; scv += c * v; }
            const den = n * scc - sc * sc;
            if (!den) return null;
            slope = (n * scv - sc * sv) / den;
            a = (sv - slope * sc) / n;
            if (round === 2) break;
            const resid = cur.map(([c, v]) => Math.abs(v - (a + slope * c)));
            const tol = Math.max(2, 3 * median(resid));
            const kept = cur.filter((_, i) => resid[i] <= tol);
            if (kept.length < minPts / 2) return null;
            cur = kept;
        }
        let shift = 0;
        for (const [c, v] of cur) {
            shift = Math.max(shift, (v - (a + slope * c)) * inward);
        }
        return { a, slope, shift: Math.min(shift, 8) };
    };
    const L = fitLine(leftPts, 1), R = fitLine(rightPts, -1);
    const T = fitLine(topPts, 1), B = fitLine(botPts, -1);
    if (!L || !R || !T || !B) return fail('fit', { L, R, T, B });

    // --- 5. Slant angle from the edge slopes (pipeline convention:
    // positive straighten turns the image clockwise on screen).
    // Vertical edges x = a + n*y need atan(n); horizontal edges
    // y = a + m*x need -atan(m). ---
    const deg = 180 / Math.PI;
    const edgeAngles = [
        Math.atan(L.slope) * deg, Math.atan(R.slope) * deg,
        -Math.atan(T.slope) * deg, -Math.atan(B.slope) * deg,
    ];
    // An edge that "slants" more than this hit content, not the frame
    const candidates = edgeAngles.filter(a => Math.abs(a) <= 3);
    const angle = candidates.length ? median(candidates) : 0;
    if (opts.debug) {
        console.log('detectFrame edges [L,R,T,B]:',
            edgeAngles.map(a => a.toFixed(3)).join(' '),
            'shifts:', [L.shift, R.shift, T.shift, B.shift].map(v => v.toFixed(1)).join(' '),
            'pts:', [leftPts.length, rightPts.length, topPts.length, botPts.length].join(' '));
    }

    // --- 6. Conservative inner rect from the fitted lines (valid once
    // straightened; residual slant is covered by the margin) ---
    // Inside means: below the top envelope's highest point, above the
    // bottom's lowest, right of the left's rightmost, and so on - plus
    // ~2 small pixels for the on-screen crop box quantization
    const yTop = Math.max(T.a + T.slope * x0, T.a + T.slope * x1) + T.shift + 2;
    const yBot = Math.min(B.a + B.slope * x0, B.a + B.slope * x1) - B.shift - 2;
    const xL = Math.max(L.a + L.slope * y0, L.a + L.slope * y1) + L.shift + 2;
    const xR = Math.min(R.a + R.slope * y0, R.a + R.slope * y1) - R.shift - 2;
    if (xR - xL < W * 0.4 || yBot - yTop < H * 0.4) {
        return fail('rect', { xL, xR, yTop, yBot, W, H, angle });
    }

    const rect = {
        x: Math.max(0, xL * stride),
        y: Math.max(0, yTop * stride),
        width: Math.min(width, (xR - xL) * stride),
        height: Math.min(height, (yBot - yTop) * stride),
    };
    return { angle, rect };
}
