// Film Processor Mobile - standalone, fully client-side.
//
// Baked source (inversion, film base, straighten, crops) is computed in
// pipeline.js; live adjustments run in the WebGL shader (webgl-renderer.js,
// identical to the desktop pipeline); export reads the shader output back
// at working resolution and encodes a 16-bit TIFF (tiff.js).

'use strict';

// Shown on the start screen so an update can be verified at a glance.
// Keep in step with CACHE_VERSION in sw.js.
const APP_VERSION = 'v42';

// Auto Grade: fit an automatic correction for a scanned film positive.
// Scanner positives keep the film-base fog floor (blacks near ~0.1, never
// 0), a color cast, and mismatched per-channel gammas (color crossover).
// Fit per-channel black/white points from histogram percentiles, then
// per-channel gammas. Two deliberate softenings (the scan has usually
// been through the scanner's own auto-correction already, so a second
// hard stretch compounds its clipping): the black percentile lands on a
// ~2% pedestal instead of pure 0, and the gamma fit corrects CROSSOVER
// ONLY - shadow/midtone tints are aligned to the highlight tint, not
// forced to gray. A dye-layer mismatch always converges to neutral at
// the top (the white stretch pins it), while a genuinely warm scene
// stays tinted in its highlights - so anchoring there fixes the film
// defect without stripping scene warmth (the gray-point eyedropper
// still neutralizes absolutely on demand). Same algorithm as
// FilmProcessor.auto_grade() in the desktop backend. Input is the
// renderer's Float32Array RGB source; returns fitted params (not
// applied).
function computeAutoGrade(data, width, height) {
    const n = width * height;
    const BINS = 2048;

    // Per-channel histograms -> black/white percentiles
    const hist = [new Float64Array(BINS), new Float64Array(BINS), new Float64Array(BINS)];
    for (let i = 0; i < n * 3; i += 3) {
        for (let c = 0; c < 3; c++) {
            const v = Math.min(Math.max(data[i + c], 0), 1);
            hist[c][Math.min(BINS - 1, (v * BINS) | 0)]++;
        }
    }
    const percentile = (h, frac) => {
        const target = frac * n;
        let acc = 0;
        for (let b = 0; b < BINS; b++) {
            acc += h[b];
            if (acc >= target) return (b + 0.5) / BINS;
        }
        return 1;
    };
    const black = hist.map(h => percentile(h, 0.001));
    const white = hist.map(h => percentile(h, 0.9985));
    // Shadow headroom: lower the black point so the black percentile maps
    // to PEDESTAL instead of 0 - detail at the floor stays separated
    // instead of being crushed to pure black
    const PEDESTAL = 0.02;
    const blackEff = black.map((b, c) =>
        Math.max(b - PEDESTAL * (white[c] - b) / (1 - PEDESTAL), 0));
    const span = blackEff.map((b, c) => Math.max(white[c] - b, 1e-3));

    // Neutral-pixel medians of the normalized image, in three luminance
    // bands (shadow / midtone / highlight) -> per-channel gammas. Two
    // passes: strict chroma window, widened if the cast is extreme.
    const fitMedians = (satLimit) => {
        const mkBand = () => ({
            h: [new Float64Array(BINS), new Float64Array(BINS), new Float64Array(BINS)],
            count: 0,
        });
        const bands = [mkBand(), mkBand(), mkBand()];
        let count = 0;
        for (let i = 0; i < n * 3; i += 3) {
            const y = [0, 1, 2].map(c =>
                Math.min(Math.max((data[i + c] - blackEff[c]) / span[c], 0), 1));
            const lum = (y[0] + y[1] + y[2]) / 3;
            const sat = Math.max(y[0], y[1], y[2]) - Math.min(y[0], y[1], y[2]);
            if (sat < satLimit && lum > 0.05 && lum < 0.9) {
                count++;
                const band = bands[lum <= 0.35 ? 0 : (lum <= 0.65 ? 1 : 2)];
                band.count++;
                for (let c = 0; c < 3; c++) {
                    band.h[c][Math.min(BINS - 1, (y[c] * BINS) | 0)]++;
                }
            }
        }
        if (!count) return null;
        const median = (h, cnt) => {
            let acc = 0;
            for (let b = 0; b < BINS; b++) {
                acc += h[b];
                if (acc >= cnt / 2) return (b + 0.5) / BINS;
            }
            return 0.5;
        };
        return { bands: bands.map(b => ({
            count: b.count,
            h: b.h,
            medians: b.h.map(h => median(h, b.count)),
        })), count };
    };
    let fit = fitMedians(0.12);
    if (!fit || fit.count < 0.02 * n) fit = fitMedians(0.25) || fit;

    // The highlight band's tint is the anchor (scene warmth lives there;
    // crossover doesn't); shadow/midtone bands vote for the gamma that
    // bends their tint to match it. Green is the reference channel.
    const gammas = [1, 1, 1];
    if (fit) {
        const minCount = Math.max(50, 0.002 * n);
        const valid = fit.bands.map(b => (b.count >= minCount
            && b.medians[1] > 1e-4 && b.medians[1] < 0.999) ? b : null);
        const anchor = valid[2] || valid[1] || null;
        if (!anchor) {
            // Not enough tonal spread to tell crossover from scene tint:
            // fall back to neutralizing the pooled medians
            if (fit.count >= minCount) {
                const pooled = [0, 1, 2].map(c => {
                    let acc = 0;
                    for (let k = 0; k < BINS; k++) {
                        acc += fit.bands[0].h[c][k] + fit.bands[1].h[c][k]
                             + fit.bands[2].h[c][k];
                        if (acc >= fit.count / 2) return (k + 0.5) / BINS;
                    }
                    return 0.5;
                });
                if (pooled[1] > 1e-4 && pooled[1] < 0.999) {
                    for (const c of [0, 2]) {
                        if (pooled[c] > 1e-4 && pooled[c] < 0.999) {
                            gammas[c] = Math.min(2, Math.max(0.5,
                                Math.log(pooled[1]) / Math.log(pooled[c])));
                        }
                    }
                }
            }
        } else {
            for (const c of [0, 2]) {
                // Clamped so one bright colored surface can't drag the fit
                const r = Math.min(1.25, Math.max(0.8,
                    anchor.medians[c] / anchor.medians[1]));
                const votes = [];
                for (const b of valid) {
                    if (!b || b === anchor) continue;
                    const t = b.medians[1] * r;
                    if (b.medians[c] > 1e-4 && b.medians[c] < 0.999
                        && t > 1e-4 && t < 0.999) {
                        votes.push(Math.min(2, Math.max(0.5,
                            Math.log(t) / Math.log(b.medians[c]))));
                    }
                }
                if (votes.length) {
                    gammas[c] = Math.min(2, Math.max(0.5,
                        votes.reduce((a, v) => a + v, 0) / votes.length));
                }
            }
        }
    }

    // Express the stretch through the eyedropper levels chain (black remap
    // then white divide): dividing by (white-black)/(1-black) after the
    // black remap equals a direct (c-black)/(white-black) stretch
    const whitePt = blackEff.map((b, c) => 255 * span[c] / Math.max(1 - b, 1e-3));
    return {
        black_point_r: blackEff[0] * 255, black_point_g: blackEff[1] * 255, black_point_b: blackEff[2] * 255,
        white_point_r: whitePt[0], white_point_g: whitePt[1], white_point_b: whitePt[2],
        density_r: gammas[0], density_g: gammas[1], density_b: gammas[2],
    };
}

// Stamp text into a JPEG as a COM (comment) segment - the JPEG
// equivalent of the TIFF ImageDescription roll line, since the canvas
// encoder has no metadata support of its own. Inserted after any
// leading APPn segments so the JFIF header stays first.
async function jpegWithComment(blob, text) {
    if (!text) return blob;
    const buf = new Uint8Array(await blob.arrayBuffer());
    let at = 2; // past SOI
    while (at + 4 <= buf.length && buf[at] === 0xFF
           && buf[at + 1] >= 0xE0 && buf[at + 1] <= 0xEF) {
        at += 2 + ((buf[at + 2] << 8) | buf[at + 3]);
    }
    const bytes = new TextEncoder().encode(text);
    const seg = new Uint8Array(4 + bytes.length);
    seg[0] = 0xFF;
    seg[1] = 0xFE;
    seg[2] = (bytes.length + 2) >> 8;
    seg[3] = (bytes.length + 2) & 0xFF;
    seg.set(bytes, 4);
    return new Blob([buf.slice(0, at), seg, buf.slice(at)],
        { type: 'image/jpeg' });
}

class MobileFilmProcessor {
    constructor() {
        this.renderer = null;

        // Image state
        this.original = null;     // decoded scan (scanner space)
        this.bakedOps = [];       // [{ angle, rect|null }] applied in order
        this.isNegative = true;
        this.filmCorrection = 0;  // 0/1
        this.bakedStraighten = 0; // angle baked into the current source

        // Tool state
        this.eyedropperMode = null;
        this.blackPoint = null;
        this.whitePoint = null;
        this.grayPoint = null;
        this.cropMode = false;
        this.showingOriginal = false;
        this.cropRatio = null;         // crop aspect ratio (w/h), null = free
        this.cropRatioSwapped = false; // ⇄ orientation flip

        // View zoom (inspection only - never affects the pipeline/exports)
        this.viewZoom = 1;
        this.viewPanX = 0;
        this.viewPanY = 0;

        this.curves = this.defaultCurves();
        this.currentCurveChannel = 'rgb';
        this.selectedPoint = -1;
        this.curveDragging = false;

        this.history = [];
        this.maxHistorySize = 30;

        this.init();
    }

    defaultCurves() {
        return {
            rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            red: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            green: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            blue: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        };
    }

    init() {
        const ver = document.getElementById('appVersion');
        if (ver) ver.textContent = 'film processor · ' + APP_VERSION;
        this.setupFileInput();
        this.setupModeToggle();
        this.setupSliders();
        this.setupEyedroppers();
        this.setupCurves();
        this.setupCropTool();
        this.setupPresets();
        this.setupSettingsFile();
        this.setupExport();
        this.setupViewZoom();
        this.setupMisc();
        try {
            this.browser = new FolderBrowser(this);
        } catch (e) {
            // A half-applied update (mixed-version cache) must not leave a
            // dead button with no explanation
            console.error('Folder browser failed to start', e);
            document.getElementById('browseBtn').addEventListener('click', () =>
                alert('Browse could not start — the app update was only half '
                    + 'applied. Close the app fully and reopen it while online '
                    + 'to finish updating.\n\n(' + e.message + ')'));
        }
    }

    status(msg) {
        const el = document.getElementById('status');
        if (el) el.textContent = msg;
    }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    setupFileInput() {
        const input = document.getElementById('fileInput');
        document.getElementById('loadBtn').addEventListener('click', () => input.click());
        input.addEventListener('change', (e) => {
            if (e.target.files[0]) this.loadFile(e.target.files[0]);
            e.target.value = ''; // allow re-picking the same file
        });
    }

    // folder ({ dir, canWrite }) is set when the file was opened from the
    // folder browser: it lets settings sync via a sidecar next to the photo
    async loadFile(file, folder = null) {
        try {
            this.status('Loading ' + file.name + '…');
            this.original = await decodeImageFile(file);
            // Kept so exports can re-decode at native resolution (the
            // working copy above is capped for phone memory/perf)
            this.sourceFile = file;
            this.sourceFolder = folder;
            this.bakedOps = [];
            this.bakedStraighten = 0;
            this.filmCorrection = this.isNegative ? 1 : 0;
            document.getElementById('filmCorrToggle').checked = this.filmCorrection === 1;
            this.resetEditState();

            if (!this.renderer) {
                this.renderer = new MobileRenderer(document.getElementById('viewCanvas'));
            }
            // Show the editor before fitting so the viewer pane has its size
            document.getElementById('editorUI').style.display = '';
            document.getElementById('emptyHint').style.display = 'none';
            this.rebuildSource();
            this.updateImage();
            // Same behaviour as the desktop app: a photo with previously
            // saved settings opens with them already applied
            const restored = await this.autoLoadSettings();
            this.status(`${this.original.width}×${this.original.height}`
                + ` · ${this.original.bitDepth}-bit`
                + (this.original.colorConverted ? ' · ' + this.original.colorConverted : '')
                + (restored ? ' · settings restored' : ''));
        } catch (err) {
            console.error(err);
            this.status('Failed to load: ' + err.message);
            alert('Could not load this image: ' + err.message);
        }
    }

    resetEditState() {
        this.history = [];
        this.blackPoint = null;
        this.whitePoint = null;
        this.grayPoint = null;
        this.eyedropperMode = null;
        this.curves = this.defaultCurves();
        // A newly loaded image starts untouched: every slider back to
        // neutral (saved sidecar settings are re-applied afterwards)
        document.querySelectorAll('.pro-slider[id]').forEach(s => {
            s.value = s.dataset.neutral || 0;
            this.updateValueDisplay(s.id, parseFloat(s.value));
        });
        document.querySelectorAll('.eyedropper-btn').forEach(b => b.classList.remove('active'));
        this.setStraightenValue(0);
        this.drawCurves();
        this.cancelCrop();
        this.resetViewZoom();
    }

    // Rebuild the shader's input image from the original + baked state
    rebuildSource() {
        const source = prepareSource(this.original, this.bakedOps, {
            isNegative: this.isNegative,
            filmCorrection: this.filmCorrection,
            straighten: this.bakedStraighten,
        });
        this.renderer.setImage(source.data, source.width, source.height);
        if (!this.cropMode) this.fitCanvasToPane();
        this.syncCropOverlayBox();
    }

    // Size the canvas so the image fills as much of the viewer pane as
    // possible (crop mode manages its own locked size instead)
    fitCanvasToPane() {
        if (!this.renderer || !this.original || this.cropMode) return;
        const pane = document.getElementById('viewerPane');
        const canvas = document.getElementById('viewCanvas');
        const cs = getComputedStyle(pane);
        const availW = pane.clientWidth
            - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const availH = pane.clientHeight
            - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        if (availW < 10 || availH < 10) return;
        const scale = Math.min(availW / this.renderer.imageWidth,
            availH / this.renderer.imageHeight);
        canvas.style.width = (this.renderer.imageWidth * scale) + 'px';
        canvas.style.height = (this.renderer.imageHeight * scale) + 'px';
    }

    setupModeToggle() {
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.isNegative = btn.dataset.mode === 'negative';
                document.getElementById('filmCorrRow').style.display =
                    this.isNegative ? '' : 'none';
                if (this.original) {
                    this.filmCorrection = this.isNegative
                        ? (document.getElementById('filmCorrToggle').checked ? 1 : 0) : 0;
                    this.rebuildSource();
                    this.updateImage();
                }
            });
        });

        document.getElementById('filmCorrToggle').addEventListener('change', (e) => {
            this.saveHistory();
            this.filmCorrection = e.target.checked ? 1 : 0;
            if (this.original) {
                this.rebuildSource();
                this.updateImage();
            }
        });
    }

    // ------------------------------------------------------------------
    // Sliders
    // ------------------------------------------------------------------

    setupSliders() {
        // Tone sliders that show the Photoshop-style threshold clipping
        // preview while held (when the Clip toggle is on): 1 = highlight
        // threshold, 2 = shadow threshold
        const CLIP_MODES = { exposure: 1, highlights: 1, whites: 1, shadows: 2, blacks: 2 };

        document.querySelectorAll('.pro-slider').forEach(slider => {
            slider.addEventListener('pointerdown', () => {
                this.saveHistory();
                if (this.clipEnabled && CLIP_MODES[slider.id] && this.renderer) {
                    this.renderer.updateParams({ clipMode: CLIP_MODES[slider.id] });
                }
            });
            const endClipPreview = () => {
                if (this.renderer && this.renderer.params.clipMode) {
                    this.renderer.updateParams({ clipMode: 0 });
                }
            };
            slider.addEventListener('pointerup', endClipPreview);
            slider.addEventListener('pointercancel', endClipPreview);

            slider.addEventListener('input', () => {
                this.updateValueDisplay(slider.id, slider.value);
                if (slider.id === 'straighten') {
                    this.updateCanvasRotationPreview();
                    return;
                }
                this.updateImage();
            });
            if (slider.id === 'straighten') {
                slider.addEventListener('change', () => this.bakeStraighten());
            }

            // Double-tap the slider's LABEL (the words / the value) to
            // reset it - tapping the thumb itself is too easy to nudge
            const holder = slider.closest('label') || slider.parentElement;
            holder.addEventListener('pointerdown', (e) => {
                if (e.target === slider) return;
                const now = Date.now();
                if (now - (holder._tapTs || 0) < 400) {
                    holder._tapTs = 0;
                    this.saveHistory();
                    const neutral = parseFloat(slider.dataset.neutral || '0');
                    slider.value = neutral;
                    this.updateValueDisplay(slider.id, neutral);
                    if (slider.id === 'straighten') this.bakeStraighten();
                    else this.updateImage();
                } else {
                    holder._tapTs = now;
                }
            });

            this.updateValueDisplay(slider.id, slider.value);
        });
    }

    updateValueDisplay(id, value) {
        const el = document.getElementById(id + '_value');
        if (!el) return;
        const v = parseFloat(value);
        el.textContent = id === 'straighten'
            ? v.toFixed(1) + '°'
            : (v % 1 === 0 ? v.toString() : v.toFixed(2));
        // Color relative to the slider's neutral value (density rests at 1)
        const s = document.getElementById(id);
        const neutral = s ? parseFloat(s.dataset.neutral || '0') : 0;
        el.style.color = v > neutral ? '#00c851' : (v < neutral ? '#ff4444' : '#888');
    }

    getParameters() {
        const params = {};
        document.querySelectorAll('.pro-slider').forEach(s => {
            params[s.id] = parseFloat(s.value);
        });
        params.film_correction = this.filmCorrection;
        if (this.blackPoint) {
            [params.black_point_r, params.black_point_g, params.black_point_b] = this.blackPoint;
        }
        if (this.whitePoint) {
            [params.white_point_r, params.white_point_g, params.white_point_b] = this.whitePoint;
        }
        if (this.grayPoint) {
            [params.gray_point_r, params.gray_point_g, params.gray_point_b] = this.grayPoint;
        }
        params.curves = JSON.stringify(this.curves);
        return params;
    }

    updateImage() {
        if (!this.renderer || !this.original) return;
        const p = this.getParameters();
        this.renderer.updateParams({
            exposure: p.exposure || 0,
            contrast: p.contrast || 0,
            highlights: p.highlights || 0,
            shadows: p.shadows || 0,
            whites: p.whites || 0,
            blacks: p.blacks || 0,
            red: p.red || 0,
            green: p.green || 0,
            blue: p.blue || 0,
            density: [p.density_r || 1, p.density_g || 1, p.density_b || 1],
            blackPoint: this.blackPoint ? this.blackPoint.map(v => v / 255) : [0, 0, 0],
            whitePoint: this.whitePoint ? this.whitePoint.map(v => v / 255) : [1, 1, 1],
            grayPoint: this.grayPoint ? this.grayPoint.map(v => v / 255) : [0.5, 0.5, 0.5],
            hasBlackPoint: !!this.blackPoint,
            hasWhitePoint: !!this.whitePoint,
            hasGrayPoint: !!this.grayPoint,
            curves: p.curves,
        });
    }

    autoGrade() {
        if (!this.renderer || !this.renderer.imageData) return;
        this.saveHistory();
        const p = computeAutoGrade(this.renderer.imageData,
            this.renderer.imageWidth, this.renderer.imageHeight);
        this.blackPoint = [p.black_point_r, p.black_point_g, p.black_point_b];
        this.whitePoint = [p.white_point_r, p.white_point_g, p.white_point_b];
        for (const id of ['density_r', 'density_g', 'density_b']) {
            const s = document.getElementById(id);
            if (s && p[id] !== undefined) {
                s.value = p[id];
                this.updateValueDisplay(id, p[id]);
            }
        }
        this.updateImage();
        this.status('Auto grade applied');
    }

    // ------------------------------------------------------------------
    // History
    // ------------------------------------------------------------------

    saveHistory() {
        const state = {
            sliders: {},
            curves: JSON.parse(JSON.stringify(this.curves)),
            blackPoint: this.blackPoint && [...this.blackPoint],
            whitePoint: this.whitePoint && [...this.whitePoint],
            grayPoint: this.grayPoint && [...this.grayPoint],
            filmCorrection: this.filmCorrection,
        };
        document.querySelectorAll('.pro-slider').forEach(s => {
            state.sliders[s.id] = parseFloat(s.value);
        });
        this.history.push(state);
        if (this.history.length > this.maxHistorySize) this.history.shift();
    }

    undo() {
        const state = this.history.pop();
        if (!state) return;
        for (const [id, value] of Object.entries(state.sliders)) {
            const s = document.getElementById(id);
            if (s) {
                s.value = value;
                this.updateValueDisplay(id, value);
            }
        }
        this.curves = JSON.parse(JSON.stringify(state.curves));
        this.blackPoint = state.blackPoint || null;
        this.whitePoint = state.whitePoint || null;
        this.grayPoint = state.grayPoint || null;
        this.drawCurves();

        const straightenNow = parseFloat(document.getElementById('straighten').value);
        let rebuild = false;
        if (state.filmCorrection !== this.filmCorrection) {
            this.filmCorrection = state.filmCorrection;
            document.getElementById('filmCorrToggle').checked = this.filmCorrection === 1;
            rebuild = true;
        }
        if (straightenNow !== this.bakedStraighten) {
            this.bakedStraighten = straightenNow;
            rebuild = true;
        }
        if (rebuild && this.original) this.rebuildSource();
        this.updateImage();
    }

    // ------------------------------------------------------------------
    // Eyedroppers (tap image to pick, loupe follows the finger)
    // ------------------------------------------------------------------

    setupEyedroppers() {
        for (const mode of ['black', 'gray', 'white']) {
            document.getElementById(mode + 'PointBtn').addEventListener('click', () => {
                const wasActive = this.eyedropperMode === mode;
                document.querySelectorAll('.eyedropper-btn').forEach(b => b.classList.remove('active'));
                this.eyedropperMode = wasActive ? null : mode;
                if (!wasActive) {
                    document.getElementById(mode + 'PointBtn').classList.add('active');
                    this.status('Tap the image to set the ' + mode + ' point');
                } else {
                    this.hideLoupe();
                }
            });
        }
        document.getElementById('resetEyedroppersBtn').addEventListener('click', () => {
            this.saveHistory();
            this.blackPoint = this.whitePoint = this.grayPoint = null;
            this.eyedropperMode = null;
            document.querySelectorAll('.eyedropper-btn').forEach(b => b.classList.remove('active'));
            this.hideLoupe();
            this.updateImage();
        });

        document.getElementById('autoGradeBtn').addEventListener('click', () => this.autoGrade());

        const canvas = document.getElementById('viewCanvas');
        canvas.addEventListener('pointerdown', (e) => {
            if (this.eyedropperMode) {
                e.preventDefault();
                this.showLoupe(e);
            }
        });
        canvas.addEventListener('pointermove', (e) => {
            if (this.eyedropperMode && e.pressure > 0) {
                e.preventDefault();
                this.showLoupe(e);
            }
        });
        canvas.addEventListener('pointerup', (e) => {
            if (this.eyedropperMode) {
                e.preventDefault();
                this.pickEyedropper(e);
                this.hideLoupe();
            }
        });
    }

    canvasPixelFromEvent(e) {
        const canvas = document.getElementById('viewCanvas');
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width * this.renderer.imageWidth;
        const y = (e.clientY - rect.top) / rect.height * this.renderer.imageHeight;
        if (x < 0 || y < 0 || x >= this.renderer.imageWidth || y >= this.renderer.imageHeight) return null;
        return { x, y };
    }

    showLoupe(e) {
        const pos = this.canvasPixelFromEvent(e);
        const loupe = document.getElementById('loupe');
        if (!pos) { loupe.style.display = 'none'; return; }

        loupe.style.display = 'block';
        loupe.style.left = (e.clientX - 60) + 'px';
        loupe.style.top = (e.clientY - 150) + 'px'; // above the finger

        const canvas = document.getElementById('viewCanvas');
        const ctx = document.getElementById('loupeCanvas').getContext('2d', { willReadFrequently: true });
        const size = 120, zoom = 6, src = size / zoom;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = false;
        try {
            ctx.drawImage(canvas, pos.x - src / 2, pos.y - src / 2, src, src, 0, 0, size, size);
        } catch { /* ignore */ }

        const rgb = this.renderer.getSourcePixel(pos.x, pos.y);
        if (rgb) {
            document.getElementById('loupeRGB').textContent = `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`;
        }
        this._loupePos = pos;
    }

    hideLoupe() {
        document.getElementById('loupe').style.display = 'none';
    }

    pickEyedropper(e) {
        const pos = this.canvasPixelFromEvent(e) || this._loupePos;
        if (!pos) return;
        const rgb = this.renderer.getSourcePixel(pos.x, pos.y);
        if (!rgb) return;
        this.saveHistory();
        if (this.eyedropperMode === 'black') this.blackPoint = rgb;
        else if (this.eyedropperMode === 'white') this.whitePoint = rgb;
        else if (this.eyedropperMode === 'gray') this.grayPoint = rgb;
        this.status(`${this.eyedropperMode} point: ${rgb.join(', ')}`);
        this.updateImage();
    }

    // ------------------------------------------------------------------
    // Curves (pointer events - works for both touch and mouse)
    // ------------------------------------------------------------------

    setupCurves() {
        const canvas = document.getElementById('curvesCanvas');
        this.curvesCtx = canvas.getContext('2d');
        this.drawCurves();

        document.querySelectorAll('.curve-channel-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.curve-channel-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentCurveChannel = btn.dataset.channel;
                this.drawCurves();
            });
        });
        document.getElementById('resetCurvesBtn').addEventListener('click', () => {
            this.saveHistory();
            this.curves[this.currentCurveChannel] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
            this.drawCurves();
            this.updateImage();
        });

        const posFromEvent = (e) => {
            const rect = canvas.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left) / rect.width,
                y: 1 - (e.clientY - rect.top) / rect.height,
            };
        };

        canvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            canvas.setPointerCapture(e.pointerId);
            this.saveHistory();
            const { x, y } = posFromEvent(e);
            const curve = this.curves[this.currentCurveChannel];

            let closest = -1, dist = Infinity;
            curve.forEach((p, i) => {
                const d = Math.hypot(p.x - x, p.y - y);
                if (d < 0.08 && d < dist) { dist = d; closest = i; } // touch-sized hit area
            });

            if (closest >= 0) {
                this.selectedPoint = closest;
                this.curveDragging = true;
            } else if (!curve.some(p => Math.abs(p.x - x) < 0.03) && curve.length < 16 && x > 0 && x < 1) {
                const idx = curve.findIndex(p => p.x > x);
                const at = idx === -1 ? curve.length : idx;
                curve.splice(at, 0, {
                    x: Math.min(1, Math.max(0, x)),
                    y: Math.min(1, Math.max(0, y)),
                });
                this.selectedPoint = at;
                this.curveDragging = true;
                this.drawCurves();
            }
        });

        canvas.addEventListener('pointermove', (e) => {
            if (!this.curveDragging || this.selectedPoint < 0) return;
            e.preventDefault();
            const { x, y } = posFromEvent(e);
            const cx = Math.min(1, Math.max(0, x));
            const cy = Math.min(1, Math.max(0, y));
            const curve = this.curves[this.currentCurveChannel];

            if (this.selectedPoint === 0 || this.selectedPoint === curve.length - 1) {
                curve[this.selectedPoint].y = cy;
            } else {
                const prevX = curve[this.selectedPoint - 1].x;
                const nextX = curve[this.selectedPoint + 1].x;
                curve[this.selectedPoint].x = Math.max(prevX + 0.01, Math.min(nextX - 0.01, cx));
                curve[this.selectedPoint].y = cy;
            }
            this.drawCurves();
            this.updateImage();
        });

        const endDrag = () => {
            if (!this.curveDragging) return;
            this.curveDragging = false;
            this.selectedPoint = -1;
            this.updateImage();
        };
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);

        // Double-tap a point to remove it
        let lastTap = 0;
        canvas.addEventListener('pointerdown', (e) => {
            const now = Date.now();
            if (now - lastTap < 300) {
                const { x, y } = posFromEvent(e);
                const curve = this.curves[this.currentCurveChannel];
                for (let i = 1; i < curve.length - 1; i++) {
                    if (Math.hypot(curve[i].x - x, curve[i].y - y) < 0.08) {
                        curve.splice(i, 1);
                        this.curveDragging = false;
                        this.selectedPoint = -1;
                        this.drawCurves();
                        this.updateImage();
                        break;
                    }
                }
            }
            lastTap = now;
        });
    }

    drawCurves() {
        const ctx = this.curvesCtx;
        if (!ctx) return;
        const c = ctx.canvas;

        ctx.fillStyle = '#1c1c1e';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const p = (c.width / 4) * i;
            ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, c.height); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(c.width, p); ctx.stroke();
        }
        ctx.strokeStyle = '#444';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, c.height); ctx.lineTo(c.width, 0); ctx.stroke();
        ctx.setLineDash([]);

        const colors = { rgb: '#0a84ff', red: '#ff453a', green: '#32d74b', blue: '#5e9eff' };
        const curve = this.curves[this.currentCurveChannel];
        const X = (x) => x * c.width, Y = (y) => (1 - y) * c.height;

        ctx.strokeStyle = colors[this.currentCurveChannel];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(X(curve[0].x), Y(curve[0].y));
        if (curve.length === 2) {
            ctx.lineTo(X(curve[1].x), Y(curve[1].y));
        } else {
            const spline = buildMonotoneCubicSpline(curve);
            for (let i = 1; i <= 100; i++) {
                ctx.lineTo(X(i / 100), Y(spline(i / 100)));
            }
        }
        ctx.stroke();

        curve.forEach((p, i) => {
            ctx.fillStyle = i === this.selectedPoint ? '#ff9f0a' : colors[this.currentCurveChannel];
            ctx.beginPath();
            ctx.arc(X(p.x), Y(p.y), i === this.selectedPoint ? 8 : 6, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // ------------------------------------------------------------------
    // Crop + straighten
    // ------------------------------------------------------------------

    setupCropTool() {
        document.getElementById('cropBtn').addEventListener('click', () => this.toggleCrop());
        document.getElementById('applyCropBtn').addEventListener('click', () => this.applyCrop());
        document.getElementById('autoCropBtn').addEventListener('click', () => this.autoCrop());
        document.getElementById('cancelCropBtn').addEventListener('click', () => this.cancelCrop());
        document.getElementById('undoCropBtn').addEventListener('click', () => this.undoCrop());
        document.getElementById('rotate90Btn').addEventListener('click', () => this.rotate90());

        const box = document.getElementById('cropBox');
        let drag = null;

        box.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            box.setPointerCapture(e.pointerId);
            const handle = e.target.dataset.handle || 'move';
            drag = {
                handle,
                startX: e.clientX,
                startY: e.clientY,
                left: box.offsetLeft,
                top: box.offsetTop,
                width: box.offsetWidth,
                height: box.offsetHeight,
            };
        });

        box.addEventListener('pointermove', (e) => {
            if (!drag) return;
            e.preventDefault();
            const wrap = document.getElementById('canvasWrap');
            const maxW = wrap.clientWidth, maxH = wrap.clientHeight;
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;
            const MIN = 40;
            let { left, top, width, height } = drag;

            const ratio = this.effectiveCropRatio();
            if (drag.handle === 'move') {
                left = Math.max(0, Math.min(left + dx, maxW - width));
                top = Math.max(0, Math.min(top + dy, maxH - height));
            } else if (!ratio) {
                if (drag.handle.includes('e')) width = Math.max(MIN, Math.min(width + dx, maxW - left));
                if (drag.handle.includes('s')) height = Math.max(MIN, Math.min(height + dy, maxH - top));
                if (drag.handle.includes('w')) {
                    const newLeft = Math.max(0, Math.min(left + dx, left + width - MIN));
                    width = left + width - newLeft;
                    left = newLeft;
                }
                if (drag.handle.includes('n')) {
                    const newTop = Math.max(0, Math.min(top + dy, top + height - MIN));
                    height = top + height - newTop;
                    top = newTop;
                }
            } else {
                // Fixed aspect ratio: the anchored (opposite) corner stays
                // put; follow the dominant axis of the drag
                const right = drag.left + drag.width;
                const bottom = drag.top + drag.height;
                const anchorW = drag.handle.includes('w');
                const anchorN = drag.handle.includes('n');
                // Follow the axis the pointer moved most along
                const pw = drag.width + (anchorW ? -dx : dx);
                const ph = drag.height + (anchorN ? -dy : dy);
                let w = Math.abs(dx) >= Math.abs(dy * ratio) ? pw : ph * ratio;
                const boundW = Math.min(
                    anchorW ? right : maxW - drag.left,
                    (anchorN ? bottom : maxH - drag.top) * ratio);
                w = Math.max(Math.max(MIN, MIN * ratio), Math.min(w, boundW));
                width = w;
                height = w / ratio;
                left = anchorW ? right - width : drag.left;
                top = anchorN ? bottom - height : drag.top;
            }
            box.style.left = left + 'px';
            box.style.top = top + 'px';
            box.style.width = width + 'px';
            box.style.height = height + 'px';
        });

        const endDrag = () => { drag = null; };
        box.addEventListener('pointerup', endDrag);
        box.addEventListener('pointercancel', endDrag);

        // Aspect ratio chips
        document.querySelectorAll('.ratio-btn').forEach(btn => {
            if (btn.id === 'ratioSwapBtn') return;
            btn.addEventListener('click', () => {
                document.querySelectorAll('.ratio-btn').forEach(b => {
                    if (b.id !== 'ratioSwapBtn') b.classList.remove('active');
                });
                btn.classList.add('active');
                this.cropRatio = btn.dataset.ratio === 'free'
                    ? null : parseFloat(btn.dataset.ratio);
                this.snapCropToRatio();
            });
        });
        document.getElementById('ratioSwapBtn').addEventListener('click', () => {
            this.cropRatioSwapped = !this.cropRatioSwapped;
            document.getElementById('ratioSwapBtn')
                .classList.toggle('active', this.cropRatioSwapped);
            this.snapCropToRatio();
        });
    }

    toggleCrop() {
        if (this.cropMode) { this.cancelCrop(); return; }
        if (!this.original) return;

        // The crop controls float over the bottom of the viewer pane:
        // reserve space for them and refit BEFORE locking the viewport
        this.resetViewZoom();
        const pane = document.getElementById('viewerPane');
        const controls = document.getElementById('cropControls');
        controls.style.display = '';
        pane.style.paddingBottom = (controls.offsetHeight + 14) + 'px';
        this.fitCanvasToPane();

        this.cropMode = true;

        // Lock the viewport: the wrapper keeps its current size and clips,
        // and the canvas keeps constant content scale while straightening
        const canvas = document.getElementById('viewCanvas');
        const wrap = document.getElementById('canvasWrap');
        const rect = canvas.getBoundingClientRect();
        this.cropContentScale = rect.width / this.renderer.imageWidth;
        wrap.style.width = rect.width + 'px';
        wrap.style.height = rect.height + 'px';
        wrap.classList.add('cropping');
        this.updateLockedCanvasSize();

        document.getElementById('cropOverlay').style.display = 'block';
        document.getElementById('cropBtn').classList.add('active');
        this.syncCropOverlayBox(true);
    }

    // Keep the on-screen scale of the image content constant: css size
    // follows the (possibly rotation-expanded) working image
    updateLockedCanvasSize() {
        if (!this.cropMode || !this.cropContentScale) return;
        const canvas = document.getElementById('viewCanvas');
        canvas.style.width = (this.renderer.imageWidth * this.cropContentScale) + 'px';
        canvas.style.height = 'auto';
    }

    // Reset the crop box to the FULL (fixed-size) crop viewport, then apply
    // a still-selected aspect ratio
    syncCropOverlayBox(resetBox = false) {
        if (!this.cropMode || !resetBox) return;
        const wrap = document.getElementById('canvasWrap');
        const box = document.getElementById('cropBox');
        box.style.left = '0px';
        box.style.top = '0px';
        box.style.width = wrap.clientWidth + 'px';
        box.style.height = wrap.clientHeight + 'px';
        this.snapCropToRatio();
    }

    // Selected crop ratio as width/height, honoring the ⇄ swap; null = free
    effectiveCropRatio() {
        if (!this.cropRatio) return null;
        return this.cropRatioSwapped ? 1 / this.cropRatio : this.cropRatio;
    }

    // Reshape the crop box to the largest centered rect of the chosen ratio
    snapCropToRatio() {
        const ratio = this.effectiveCropRatio();
        if (!ratio || !this.cropMode) return;
        const wrap = document.getElementById('canvasWrap');
        const box = document.getElementById('cropBox');
        const W = wrap.clientWidth, H = wrap.clientHeight;
        let w = W, h = w / ratio;
        if (h > H) { h = H; w = h * ratio; }
        box.style.left = ((W - w) / 2) + 'px';
        box.style.top = ((H - h) / 2) + 'px';
        box.style.width = w + 'px';
        box.style.height = h + 'px';
    }

    cancelCrop() {
        this.cropMode = false;
        const overlay = document.getElementById('cropOverlay');
        if (overlay) overlay.style.display = 'none';
        const controls = document.getElementById('cropControls');
        if (controls) controls.style.display = 'none';
        document.getElementById('cropBtn')?.classList.remove('active');

        const pane = document.getElementById('viewerPane');
        if (pane) pane.style.paddingBottom = '';
        const wrap = document.getElementById('canvasWrap');
        const canvas = document.getElementById('viewCanvas');
        if (wrap) {
            wrap.classList.remove('cropping');
            wrap.style.width = '';
            wrap.style.height = '';
        }
        if (canvas) {
            canvas.style.width = '';
            canvas.style.height = '';
            canvas.style.removeProperty('--rot');
        }
        this.fitCanvasToPane();
    }

    updateCanvasRotationPreview() {
        const canvas = document.getElementById('viewCanvas');
        const delta = parseFloat(document.getElementById('straighten').value) - this.bakedStraighten;
        if (delta) canvas.style.setProperty('--rot', delta + 'deg');
        else canvas.style.removeProperty('--rot');
    }

    // Resample the source at the slider's angle. Synchronous variant is
    // used by applyCrop so a crop can't race a pending bake.
    bakeStraightenNow() {
        const angle = parseFloat(document.getElementById('straighten').value);
        if (angle === this.bakedStraighten) return;
        this.bakedStraighten = angle;
        document.getElementById('viewCanvas').style.removeProperty('--rot');
        this.rebuildSource();
        this.updateLockedCanvasSize();
        this.updateImage();
    }

    bakeStraighten() {
        if (!this.original) return;
        const angle = parseFloat(document.getElementById('straighten').value);
        if (angle === this.bakedStraighten) return;
        this.status('Rotating…');
        // Let the status paint before the CPU-heavy rebuild
        setTimeout(() => {
            this.bakeStraightenNow();
            this.status(this.bakedStraighten
                ? `Straighten ${this.bakedStraighten.toFixed(1)}°` : 'Ready');
        }, 30);
    }

    setStraightenValue(angle) {
        const s = document.getElementById('straighten');
        s.value = angle;
        this.updateValueDisplay('straighten', angle);
        this.bakedStraighten = angle;
        document.getElementById('viewCanvas').style.removeProperty('--rot');
    }

    // ✨ Auto: detect the frame inside the holder border and propose a
    // straighten angle + crop box; the user reviews, then taps Apply
    async autoCrop() {
        if (!this.original) return;
        if (!this.cropMode) this.toggleCrop();
        this.status('Detecting frame…');
        await new Promise(res => setTimeout(res, 30)); // let the status paint
        const src = () => ({
            data: this.renderer.imageData,
            width: this.renderer.imageWidth,
            height: this.renderer.imageHeight,
        });
        // A baked straighten leaves black fill wedges outside the scan
        // boundary; the detector must not mistake that boundary (which is
        // slanted by exactly -bake) for the frame edge
        const fillIgnore = { ignore: [[0, 0, 0]] };
        let det = detectFrame(src(), this.bakedStraighten ? fillIgnore : {});
        if (!det) { this.status('No frame border detected'); return; }
        if (Math.abs(det.angle) > 0.02) {
            const s = document.getElementById('straighten');
            const target = this.bakedStraighten + det.angle;
            s.value = target;
            this.updateValueDisplay('straighten', target);
            this.bakeStraightenNow();
            // The bake changed the geometry: re-measure the rect on the
            // straightened source, where the crop will actually apply
            det = detectFrame(src(), fillIgnore) || det;
        }
        // The detected box is free-form; clear any selected ratio chip
        this.cropRatio = null;
        document.querySelectorAll('.ratio-btn').forEach(b => {
            if (b.id !== 'ratioSwapBtn') {
                b.classList.toggle('active', b.dataset.ratio === 'free');
            }
        });
        this.setCropBoxToSourceRect(det.rect);
        this.status('Frame detected — adjust if needed, then Apply');
    }

    setCropBoxToSourceRect(rect) {
        const canvas = document.getElementById('viewCanvas');
        const wrap = document.getElementById('canvasWrap');
        const box = document.getElementById('cropBox');
        const cRect = canvas.getBoundingClientRect();
        const wRect = wrap.getBoundingClientRect();
        const scale = cRect.width / this.renderer.imageWidth;
        let left = cRect.left - wRect.left + rect.x * scale;
        let top = cRect.top - wRect.top + rect.y * scale;
        let right = left + rect.width * scale;
        let bottom = top + rect.height * scale;
        left = Math.max(0, left);
        top = Math.max(0, top);
        right = Math.min(wrap.clientWidth, right);
        bottom = Math.min(wrap.clientHeight, bottom);
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        box.style.width = Math.max(40, right - left) + 'px';
        box.style.height = Math.max(40, bottom - top) + 'px';
    }

    applyCrop() {
        if (!this.original) return;
        this.bakeStraightenNow(); // in case Apply is tapped mid-bake

        const canvas = document.getElementById('viewCanvas');
        const box = document.getElementById('cropBox');
        const cRect = canvas.getBoundingClientRect();
        const bRect = box.getBoundingClientRect();
        const sx = this.renderer.imageWidth / cRect.width;
        const sy = this.renderer.imageHeight / cRect.height;

        const rect = {
            x: (bRect.left - cRect.left) * sx,
            y: (bRect.top - cRect.top) * sy,
            width: bRect.width * sx,
            height: bRect.height * sy,
        };

        // The crop bakes the current straighten angle (desktop semantics)
        this.bakedOps.push({ angle: this.bakedStraighten, rect });
        this.setStraightenValue(0);
        this.rebuildSource();
        this.updateImage();
        this.cancelCrop();
        document.getElementById('undoCropBtn').style.display = '';
        this.status('Cropped');
    }

    undoCrop() {
        this.resetViewZoom();
        const op = this.bakedOps.pop();
        // Crop ops carry the user's straighten angle to restore; 90-degree
        // turns (rect-less) don't touch the straighten slider
        if (op && op.rect) this.setStraightenValue(op.angle);
        this.rebuildSource();
        this.updateImage();
        if (!this.bakedOps.length) {
            document.getElementById('undoCropBtn').style.display = 'none';
        }
        this.status('Crop undone');
    }

    rotate90() {
        if (!this.original) return;
        this.resetViewZoom();
        this.bakedOps.push({ angle: 90, rect: null });
        this.rebuildSource();
        this.updateImage();
        this.updateLockedCanvasSize();
        this.syncCropOverlayBox(true);
        document.getElementById('undoCropBtn').style.display = '';
    }

    // ------------------------------------------------------------------
    // Presets (same storage format as the desktop app)
    // ------------------------------------------------------------------

    setupPresets() {
        const doSave = () => {
            const input = document.getElementById('presetName');
            const name = input.value.trim();
            if (!name) { this.status('Type a preset name first'); return; }
            const params = this.getParameters();
            delete params.straighten;
            for (const pt of ['black_point', 'white_point', 'gray_point']) {
                delete params[pt + '_r']; delete params[pt + '_g']; delete params[pt + '_b'];
            }
            const presets = this.loadPresets();
            presets[name] = params;
            localStorage.setItem('filmProcessorPresets', JSON.stringify(presets));
            input.value = '';
            input.blur(); // dismiss the phone keyboard
            this.refreshPresetList(name);
            this.status(`Preset "${name}" saved`);
            const btn = document.getElementById('savePresetBtn');
            const original = btn.textContent;
            btn.textContent = 'Saved ✓';
            setTimeout(() => { btn.textContent = original; }, 1500);
        };
        document.getElementById('savePresetBtn').addEventListener('click', doSave);
        // The phone keyboard's return key saves too
        document.getElementById('presetName').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                doSave();
            }
        });

        document.getElementById('applyPresetBtn').addEventListener('click', () => {
            const name = document.getElementById('presetSelect').value;
            const preset = this.loadPresets()[name];
            if (!preset) return;
            this.saveHistory();
            for (const [key, value] of Object.entries(preset)) {
                const s = document.getElementById(key);
                if (s && s.classList.contains('pro-slider') && key !== 'straighten') {
                    s.value = value;
                    this.updateValueDisplay(key, value);
                }
            }
            if (typeof preset.film_correction === 'number' && this.isNegative) {
                this.filmCorrection = preset.film_correction ? 1 : 0;
                document.getElementById('filmCorrToggle').checked = this.filmCorrection === 1;
                if (this.original) this.rebuildSource();
            }
            if (preset.curves) {
                try {
                    this.curves = typeof preset.curves === 'string'
                        ? JSON.parse(preset.curves) : preset.curves;
                    this.drawCurves();
                } catch { /* keep current curves */ }
            }
            this.updateImage();
            this.status(`Preset "${name}" applied`);
        });

        document.getElementById('deletePresetBtn').addEventListener('click', () => {
            const name = document.getElementById('presetSelect').value;
            if (!name) return;
            const presets = this.loadPresets();
            delete presets[name];
            localStorage.setItem('filmProcessorPresets', JSON.stringify(presets));
            this.refreshPresetList();
            this.status(`Preset "${name}" deleted`);
        });

        this.refreshPresetList();
    }

    loadPresets() {
        try {
            return JSON.parse(localStorage.getItem('filmProcessorPresets')) || {};
        } catch {
            return {};
        }
    }

    refreshPresetList(selected = '') {
        const select = document.getElementById('presetSelect');
        const names = Object.keys(this.loadPresets()).sort();
        select.innerHTML = '';
        if (!names.length) {
            select.appendChild(new Option('— no presets —', ''));
            return;
        }
        names.forEach(n => select.appendChild(new Option(n, n)));
        if (selected && names.includes(selected)) select.value = selected;
    }

    // ------------------------------------------------------------------
    // Settings file (per-photo JSON; same format as the desktop app, so
    // files move freely between phone and PC)
    // ------------------------------------------------------------------

    // Full per-photo settings: the shared slider/point/curve parameters
    // plus the baked geometry (crops + 90° turns) as a mobile extension
    // the desktop app simply ignores. Rects are recorded in working-res
    // pixels; ops_width lets another device rescale them.
    settingsPayload() {
        const params = this.getParameters();
        if (this.bakedOps.length && this.original) {
            params.baked_ops = this.bakedOps.map(op => ({
                angle: op.angle,
                rect: op.rect ? { ...op.rect } : null,
            }));
            params.ops_width = this.original.width;
        }
        return params;
    }

    // Remember the current settings locally and, when the photo came
    // from the folder browser, write the sidecar next to it (asking for
    // write access - must be called from a tap so the permission prompt
    // is allowed). Returns { where: 'sidecar'|'local', params }.
    async persistSettings() {
        const params = this.settingsPayload();
        params.saved_at = Date.now(); // freshness for phone<->PC sync
        // Remembered locally so reopening this photo restores its edits
        this.rememberSettings(params);
        const folder = this.sourceFolder;
        const canWrite = folder && this.sourceFile && (folder.canWrite
            || (folder.requestWrite && await folder.requestWrite()));
        if (canWrite
            && await writeSidecar(folder.dir, this.sourceFile.name, params)) {
            if (folder.sidecars) folder.sidecars.add(
                sidecarName(this.sourceFile.name).toLowerCase());
            return { where: 'sidecar', params };
        }
        return { where: 'local', params };
    }

    setupSettingsFile() {
        document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
            if (!this.original) { this.status('Load an image first'); return; }
            const { where, params } = await this.persistSettings();
            if (where === 'sidecar') {
                this.status('Settings saved next to the photo');
                return;
            }
            // No writable folder: fall back to a save dialog
            const base = this.sourceFile
                ? this.sourceFile.name.replace(/\.[^.]+$/, '') : 'image';
            const ok = await this.saveFileAs(
                new Blob([JSON.stringify(params, null, 2)], { type: 'application/json' }),
                base + '_settings.json',
                [{ description: 'Film settings', accept: { 'application/json': ['.json'] } }]);
            this.status(ok ? 'Settings saved' : 'Save cancelled');
        });

        document.getElementById('loadSettingsBtn').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = async () => {
                const file = input.files[0];
                if (!file) return;
                try {
                    const params = JSON.parse(await file.text());
                    this.applySettings(params);
                    params.saved_at = Date.now(); // loading = a fresh edit
                    this.rememberSettings(params);
                    this.status('Settings loaded');
                } catch (err) {
                    this.status('Could not read settings: ' + err.message);
                }
            };
            input.click();
        });
    }

    // The browser can't read a sidecar file next to the photo (it only
    // gets the one file the user picked), so per-photo settings are also
    // kept in localStorage keyed by the file's name and size.
    settingsStorageKey() {
        const f = this.sourceFile;
        return f ? filmSettingsKey(f.name, f.size) : null; // batch.js helper
    }

    rememberSettings(params) {
        const key = this.settingsStorageKey();
        if (!key) return;
        try {
            localStorage.setItem(key, JSON.stringify(params));
        } catch { /* storage full - the settings file still works */ }
    }

    async autoLoadSettings() {
        const f = this.sourceFile;
        if (!f) return false;
        try {
            // Freshest of the folder sidecar (synced with the PC) and
            // this phone's local copy - batch.js resolveSettings picks
            const folder = this.sourceFolder;
            const params = await resolveSettings(
                folder && folder.dir, f.name, f.size,
                folder && folder.sidecars);
            if (!params) return false;
            this.applySettings(params);
            return true;
        } catch {
            return false;
        }
    }

    applySettings(params) {
        this.saveHistory(); // Undo restores the previous edit

        for (const [key, value] of Object.entries(params)) {
            const s = document.getElementById(key);
            if (s && s.classList.contains('pro-slider') && key !== 'straighten') {
                s.value = value;
                this.updateValueDisplay(key, value);
            }
        }

        if (params.black_point_r !== undefined) {
            this.blackPoint = [params.black_point_r, params.black_point_g, params.black_point_b];
        }
        if (params.white_point_r !== undefined) {
            this.whitePoint = [params.white_point_r, params.white_point_g, params.white_point_b];
        }
        if (params.gray_point_r !== undefined) {
            this.grayPoint = [params.gray_point_r, params.gray_point_g, params.gray_point_b];
        }

        if (params.curves) {
            try {
                this.curves = typeof params.curves === 'string'
                    ? JSON.parse(params.curves) : params.curves;
                this.drawCurves();
            } catch { /* keep current curves */ }
        }

        if (typeof params.film_correction === 'number' && this.isNegative) {
            const fc = params.film_correction ? 1 : 0;
            if (fc !== this.filmCorrection) {
                this.filmCorrection = fc;
                document.getElementById('filmCorrToggle').checked = fc === 1;
                if (this.original) this.rebuildSource();
            }
        }

        // Baked geometry (mobile extension): restore crops / 90° turns,
        // rescaling rects if this device decodes at a different working res
        if (Array.isArray(params.baked_ops) && this.original) {
            const k = params.ops_width ? this.original.width / params.ops_width : 1;
            this.bakedOps = params.baked_ops.map(op => ({
                angle: op.angle || 0,
                rect: op.rect ? {
                    x: op.rect.x * k, y: op.rect.y * k,
                    width: op.rect.width * k, height: op.rect.height * k,
                } : null,
            }));
            document.getElementById('undoCropBtn').style.display =
                this.bakedOps.length ? '' : 'none';
            this.rebuildSource();
        }

        // Straighten is per-photo, so settings restore it (presets don't)
        if (typeof params.straighten === 'number') {
            const s = document.getElementById('straighten');
            if (parseFloat(s.value) !== params.straighten) {
                s.value = params.straighten;
                this.updateValueDisplay('straighten', params.straighten);
                this.bakeStraighten();
            }
        }

        this.updateImage();
    }

    // ------------------------------------------------------------------
    // Export
    // ------------------------------------------------------------------

    // Exports render at the file's NATIVE resolution: the original is
    // re-decoded (only its working copy is kept in memory), the baked
    // crops/rotations are replayed at full scale, and the same shader
    // renders the image in bands - so even medium-format scans fit, up
    // to the GPU texture limit. Falls back to the working resolution if
    // the device can't handle it. Returns { data16: Uint16Array, ... }.
    async exportPixels() {
        const o = this.original;
        const downscaled = o && (o.fullWidth > o.width || o.fullHeight > o.height);
        if (downscaled && this.sourceFile) {
            try {
                this.status('Rendering at full resolution…');
                const native = await decodeImageFile(this.sourceFile,
                    this.renderer.maxSourceSize());
                const full = prepareSource(native, this.bakedOps, {
                    isNegative: this.isNegative,
                    filmCorrection: this.filmCorrection,
                    straighten: this.bakedStraighten,
                }, native.width / o.width);
                return this.renderer.renderToPixels16(full);
            } catch (err) {
                console.warn('Full-resolution export failed; using working size', err);
            }
        }
        return this.renderer.renderToPixels16({
            data: this.renderer.imageData,
            width: this.renderer.imageWidth,
            height: this.renderer.imageHeight,
        });
    }

    // Roll metadata line for exports - only when this photo came from
    // the folder browser and that folder is still the one browsed
    rollDescription() {
        const b = this.browser;
        return b && this.sourceFolder && this.sourceFolder.dir === b.dirHandle
            ? b.rollLine(' - ') : '';
    }

    async makeTiffBlob() {
        const { data16, width, height } = await this.exportPixels();
        return new Blob(
            [encodeTiff16(data16, width, height, this.rollDescription())],
            { type: 'image/tiff' });
    }

    async makeJpegBlob() {
        const { data16, width, height } = await this.exportPixels();
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
        const blob = await new Promise(resolve =>
            canvas.toBlob(resolve, 'image/jpeg', 1.0));
        return jpegWithComment(blob, this.rollDescription());
    }

    // Save with a real pick-the-location dialog where the browser has one
    // (Chrome on Android since M132); otherwise fall back to the share
    // sheet / a download. Returns false if the user cancelled.
    //
    // `blob` may be an async FACTORY: the dialog is only allowed within a
    // few seconds of the tap, so it must open BEFORE any slow work - a
    // big scan renders its export for longer than that, and building the
    // blob first silently demoted the dialog to a bare download.
    async saveFileAs(blob, filename, types) {
        const makeBlob = typeof blob === 'function' ? blob : () => blob;
        if (window.showSaveFilePicker) {
            let handle = null;
            try {
                handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types,
                });
            } catch (e) {
                if (e.name === 'AbortError') return false; // user cancelled
                console.warn('Save dialog failed; falling back to share/download', e);
            }
            if (handle) {
                const writable = await handle.createWritable();
                await writable.write(await makeBlob());
                await writable.close();
                return true;
            }
        }
        return this.deliverFile(await makeBlob(), filename);
    }

    async deliverFile(blob, filename) {
        const file = new File([blob], filename, { type: blob.type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file] });
                return true;
            } catch (e) {
                if (e.name === 'AbortError') return false; // user cancelled
            }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return true;
    }

    setupExport() {
        const base = () => this.sourceFile
            ? this.sourceFile.name.replace(/\.[^.]+$/, '') + '_edit'
            : 'film_' + new Date().toISOString().replace(/[:T-]/g, '').slice(0, 14);
        document.getElementById('exportBtn').addEventListener('click', async () => {
            if (!this.original) return;
            this.status('Exporting…');
            const ok = await this.saveFileAs(() => this.makeJpegBlob(), base() + '.jpg',
                [{ description: 'JPEG image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }]);
            if (!ok) { this.status('Export cancelled'); return; }
            // An export is an edit worth keeping: record the settings too,
            // so reopening the photo restores exactly this look
            const { where } = await this.persistSettings();
            this.status(where === 'sidecar'
                ? 'Exported JPEG - settings saved next to the photo'
                : 'Exported JPEG - settings remembered');
        });
    }

    // Used by the automated test harness
    async exportTiffBase64() {
        const blob = await this.makeTiffBlob();
        return new Promise((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result.split(',')[1]);
            r.readAsDataURL(blob);
        });
    }

    // ------------------------------------------------------------------
    // View zoom: pinch / double-tap / mouse wheel on the image pane.
    // Purely visual (a CSS transform) - the pipeline and exports are
    // untouched, and it is disabled while cropping.
    // ------------------------------------------------------------------

    setupViewZoom() {
        const pane = document.getElementById('viewerPane');
        const pointers = new Map();
        let pinch = null;   // { dist, zoom, midX, midY, panX, panY }
        let pan = null;     // { x, y, panX, panY }
        let down = null;    // tap candidate for double-tap detection
        let lastTap = { t: 0, x: 0, y: 0 };

        // Coordinates relative to the pane centre (= the canvas centre,
        // which is the transform origin)
        const paneOffset = (clientX, clientY) => {
            const r = pane.getBoundingClientRect();
            return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
        };

        pane.addEventListener('pointerdown', (e) => {
            if (this.cropMode || !this.original) return;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2) {
                if (down) down.moved = true; // a pinch is never a tap
                const [a, b] = [...pointers.values()];
                const mid = paneOffset((a.x + b.x) / 2, (a.y + b.y) / 2);
                pinch = {
                    dist: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)),
                    zoom: this.viewZoom,
                    midX: mid.x, midY: mid.y,
                    panX: this.viewPanX, panY: this.viewPanY,
                };
                pan = null;
                for (const id of pointers.keys()) {
                    try { pane.setPointerCapture(id); } catch { /* synthetic ids */ }
                }
            } else if (pointers.size === 1) {
                down = { t: Date.now(), x: e.clientX, y: e.clientY, moved: false };
                if (this.viewZoom > 1 && !this.eyedropperMode) {
                    pan = { x: e.clientX, y: e.clientY, panX: this.viewPanX, panY: this.viewPanY };
                    try { pane.setPointerCapture(e.pointerId); } catch { /* synthetic ids */ }
                }
            }
        });

        pane.addEventListener('pointermove', (e) => {
            if (!pointers.has(e.pointerId)) return;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) {
                down.moved = true;
            }
            if (pinch && pointers.size >= 2) {
                const [a, b] = [...pointers.values()];
                const z = Math.min(8, Math.max(1,
                    pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist));
                // The image point under the start midpoint follows the
                // CURRENT midpoint (pinch-zoom + two-finger pan combined)
                const k = z / pinch.zoom;
                const mid = paneOffset((a.x + b.x) / 2, (a.y + b.y) / 2);
                this.viewPanX = mid.x - (pinch.midX - pinch.panX) * k;
                this.viewPanY = mid.y - (pinch.midY - pinch.panY) * k;
                this.viewZoom = z;
                this.applyViewTransform();
            } else if (pan) {
                this.viewPanX = pan.panX + (e.clientX - pan.x);
                this.viewPanY = pan.panY + (e.clientY - pan.y);
                this.applyViewTransform();
            }
        });

        const release = (e) => {
            if (!pointers.delete(e.pointerId)) return;
            if (pointers.size < 2) pinch = null;
            if (!pointers.size) pan = null;

            // Double-tap toggles 2.5x zoom at the tap point
            if (e.type === 'pointerup' && down && !down.moved
                && Date.now() - down.t < 350
                && !this.eyedropperMode && !this.cropMode && this.original) {
                const now = Date.now();
                if (now - lastTap.t < 320
                    && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 50) {
                    if (this.viewZoom > 1) {
                        this.resetViewZoom();
                    } else {
                        const m = paneOffset(e.clientX, e.clientY);
                        this.viewZoom = 2.5;
                        this.viewPanX = m.x * (1 - 2.5);
                        this.viewPanY = m.y * (1 - 2.5);
                        this.applyViewTransform();
                    }
                    lastTap = { t: 0, x: 0, y: 0 };
                } else {
                    lastTap = { t: now, x: e.clientX, y: e.clientY };
                }
            }
            if (!pointers.size) down = null;
        };
        pane.addEventListener('pointerup', release);
        pane.addEventListener('pointercancel', release);

        // Mouse wheel zooms too (handy when testing in a browser)
        pane.addEventListener('wheel', (e) => {
            if (this.cropMode || !this.original) return;
            e.preventDefault();
            const z = Math.min(8, Math.max(1, this.viewZoom * Math.exp(-e.deltaY * 0.0022)));
            const k = z / this.viewZoom;
            const m = paneOffset(e.clientX, e.clientY);
            this.viewPanX = m.x - (m.x - this.viewPanX) * k;
            this.viewPanY = m.y - (m.y - this.viewPanY) * k;
            this.viewZoom = z;
            this.applyViewTransform();
        }, { passive: false });
    }

    applyViewTransform() {
        const canvas = document.getElementById('viewCanvas');
        const pane = document.getElementById('viewerPane');
        if (this.viewZoom <= 1.02) {
            this.resetViewZoom();
            return;
        }
        // Keep at least a quarter of the pane covered by the image
        const halfW = (canvas.clientWidth * this.viewZoom) / 2;
        const halfH = (canvas.clientHeight * this.viewZoom) / 2;
        const maxX = Math.max(0, halfW - pane.clientWidth * 0.25);
        const maxY = Math.max(0, halfH - pane.clientHeight * 0.25);
        this.viewPanX = Math.max(-maxX, Math.min(maxX, this.viewPanX));
        this.viewPanY = Math.max(-maxY, Math.min(maxY, this.viewPanY));
        canvas.style.transform =
            `translate(${this.viewPanX}px, ${this.viewPanY}px) scale(${this.viewZoom})`;
    }

    resetViewZoom() {
        this.viewZoom = 1;
        this.viewPanX = 0;
        this.viewPanY = 0;
        const canvas = document.getElementById('viewCanvas');
        if (canvas) canvas.style.transform = '';
    }

    // ------------------------------------------------------------------
    // Misc
    // ------------------------------------------------------------------

    setupMisc() {
        document.getElementById('undoBtn').addEventListener('click', () => this.undo());

        // Press-and-hold the IMAGE to compare with the unadjusted original
        const pane = document.getElementById('viewerPane');
        const show = (on) => {
            this.showingOriginal = on;
            if (this.renderer) this.renderer.updateParams({ showOriginal: on });
        };
        let holdTimer = null;
        let holdStart = null;
        pane.addEventListener('pointerdown', (e) => {
            if (this.cropMode || this.eyedropperMode || !this.original) return;
            if (!e.isPrimary) {
                // A second finger means pinch, not a hold
                clearTimeout(holdTimer);
                holdTimer = null;
                if (this.showingOriginal) show(false);
                return;
            }
            holdStart = { x: e.clientX, y: e.clientY };
            clearTimeout(holdTimer);
            holdTimer = setTimeout(() => show(true), 400);
        });
        pane.addEventListener('pointermove', (e) => {
            // Moving before the hold kicks in means drag/pan, not compare
            if (holdTimer && holdStart
                && Math.hypot(e.clientX - holdStart.x, e.clientY - holdStart.y) > 12) {
                clearTimeout(holdTimer);
                holdTimer = null;
            }
        });
        const endHold = () => {
            clearTimeout(holdTimer);
            holdTimer = null;
            if (this.showingOriginal) show(false);
        };
        pane.addEventListener('pointerup', endHold);
        pane.addEventListener('pointercancel', endHold);
        // Long-press must not open the browser context menu
        pane.addEventListener('contextmenu', (e) => e.preventDefault());

        // Clipping preview toggle: while it's on, HOLDING a tone slider
        // shows the threshold view (like Alt-dragging in Photoshop)
        const clipBtn = document.getElementById('clipBtn');
        this.clipEnabled = false;
        clipBtn.addEventListener('click', () => {
            this.clipEnabled = !this.clipEnabled;
            clipBtn.classList.toggle('active', this.clipEnabled);
            if (!this.clipEnabled && this.renderer && this.renderer.params.clipMode) {
                this.renderer.updateParams({ clipMode: 0 });
            }
            this.status(this.clipEnabled
                ? 'Clip preview on: hold a tone slider to see clipped pixels'
                : 'Clip preview off');
        });

        // Refit on any viewport change: rotating the phone, unfolding a
        // foldable, resizing a window
        window.addEventListener('resize', () => {
            this.fitCanvasToPane();
            if (this.viewZoom > 1) this.applyViewTransform();
            this.syncCropOverlayBox();
        });
    }
}

let mobileApp;
document.addEventListener('DOMContentLoaded', () => {
    mobileApp = new MobileFilmProcessor();
    window.mobileApp = mobileApp;

    if ('serviceWorker' in navigator
        && (location.protocol === 'https:' || location.hostname === 'localhost')) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
});
