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

    // --- 4. Consensus (RANSAC) line fit: value = a + slope*coord.
    // The frame edge is the straight line supported by the largest
    // collinear subset of the scan points - tape marks, junk or content
    // crossing part of the edge become outliers instead of dragging the
    // fit, so a partially obstructed film edge is still recovered.
    // `inward` (+1/-1): which residual direction points INTO the frame.
    // `support` is the consensus fraction: a real film edge is straight,
    // so most points agree with one line (measured on real scans: >0.7);
    // scene content that happens to match the border color (a blown sky
    // above a horizon, a steam bank) has no dominant straight line and
    // such a side must not crop anything (`content`).
    const fitLine = (pts, inward) => {
        const n = pts.length;
        const TOL = 2;
        // Deterministic candidates (no RNG - results must reproduce):
        // ~24 anchors spread along the edge, each paired with the point
        // half the edge away for a long, stable baseline
        let bestA = 0, bestSlope = 0, bestCount = -1;
        const step = Math.max(1, Math.floor(n / 24));
        for (let i = 0; i < n; i += step) {
            const j = (i + (n >> 1)) % n;
            const [c1, v1] = pts[i], [c2, v2] = pts[j];
            if (c1 === c2) continue;
            const slope = (v2 - v1) / (c2 - c1);
            const a = v1 - slope * c1;
            let count = 0;
            for (const [c, v] of pts) {
                if (Math.abs(v - (a + slope * c)) <= TOL) count++;
            }
            if (count > bestCount) { bestCount = count; bestA = a; bestSlope = slope; }
        }
        // No consensus line at all: this side is scene content, not a
        // film edge - the other three sides can still crop
        const asContent = { a: 0, slope: 0, shift: 0, content: true };
        if (bestCount < minPts / 2) return asContent;
        // Refine: least squares on the inliers, twice
        let a = bestA, slope = bestSlope;
        for (let round = 0; round < 2; round++) {
            let sc = 0, sv = 0, scc = 0, scv = 0, m = 0;
            for (const [c, v] of pts) {
                if (Math.abs(v - (a + slope * c)) > TOL) continue;
                sc += c; sv += v; scc += c * c; scv += c * v; m++;
            }
            const den = m * scc - sc * sc;
            if (!den) return asContent;
            slope = (m * scv - sc * sv) / den;
            a = (sv - slope * sc) / m;
        }
        const inliers = pts.filter(([c, v]) => Math.abs(v - (a + slope * c)) <= TOL);
        const support = inliers.length / n;
        // 90th percentile of the inliers' inward residuals: the edge's
        // clean inner envelope (physical film-edge raggedness), without
        // one stray point dragging the whole edge inward
        const inw = inliers.map(([c, v]) => (v - (a + slope * c)) * inward)
            .sort((p, q) => p - q);
        const shift = Math.max(0, inw[Math.floor(inw.length * 0.9)]);
        return { a, slope, shift, content: support < 0.55 };
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
    // An edge that "slants" more than this - or that the fit flagged as
    // scene content - hit content, not the frame
    const edges = [L, R, T, B];
    const candidates = edgeAngles.filter((a, i) =>
        Math.abs(a) <= 3 && !edges[i].content);
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
    // bottom's lowest, right of the left's rightmost, and so on.
    // A side flagged as content (or implausibly slanted) has no real
    // border: fall back to the scan boundary there instead of cropping.
    const badEdge = (E, i) => E.content || Math.abs(edgeAngles[i]) > 3;
    const yTop = badEdge(T, 2) ? 0
        : Math.max(T.a + T.slope * x0, T.a + T.slope * x1) + T.shift;
    const yBot = badEdge(B, 3) ? H - 1
        : Math.min(B.a + B.slope * x0, B.a + B.slope * x1) - B.shift;
    const xL = badEdge(L, 0) ? 0
        : Math.max(L.a + L.slope * y0, L.a + L.slope * y1) + L.shift;
    const xR = badEdge(R, 1) ? W - 1
        : Math.min(R.a + R.slope * y0, R.a + R.slope * y1) - R.shift;

    // --- 7. Recover any over-tightening: push each side back outward
    // until the band just outside it touches border pixels. Past the
    // true frame edge everything is border, so this cannot overshoot. ---
    let li = Math.max(0, Math.round(xL)), ri = Math.min(W - 1, Math.round(xR));
    let ti = Math.max(0, Math.round(yTop)), bi = Math.min(H - 1, Math.round(yBot));
    if (ri - li < W * 0.4 || bi - ti < H * 0.4) {
        return fail('rect', { li, ri, ti, bi, W, H, angle });
    }
    const DIRTY = 0.02;
    const rowClean = (y, xa, xb) => {
        let c = 0;
        for (let x = xa; x <= xb; x++) if (!isContent(x, y)) c++;
        return c / (xb - xa + 1) <= DIRTY;
    };
    const colClean = (x, ya, yb) => {
        let c = 0;
        for (let y = ya; y <= yb; y++) if (!isContent(x, y)) c++;
        return c / (yb - ya + 1) <= DIRTY;
    };
    const capX = Math.ceil(W * 0.03), capY = Math.ceil(H * 0.03);
    let k = 0;
    while (li > 0 && k++ < capX && colClean(li - 1, ti, bi)) li--;
    k = 0;
    while (ri < W - 1 && k++ < capX && colClean(ri + 1, ti, bi)) ri++;
    k = 0;
    while (ti > 0 && k++ < capY && rowClean(ti - 1, li, ri)) ti--;
    k = 0;
    while (bi < H - 1 && k++ < capY && rowClean(bi + 1, li, ri)) bi++;

    const rect = {
        x: Math.max(0, li * stride),
        y: Math.max(0, ti * stride),
        width: Math.min(width, (ri - li) * stride),
        height: Math.min(height, (bi - ti) * stride),
    };
    return { angle, rect };
}
