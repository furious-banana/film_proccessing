// Film Processor Mobile - standalone, fully client-side.
//
// Baked source (inversion, film base, straighten, crops) is computed in
// pipeline.js; live adjustments run in the WebGL shader (webgl-renderer.js,
// identical to the desktop pipeline); export reads the shader output back
// at working resolution and encodes a 16-bit TIFF (tiff.js).

'use strict';

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
        this.setupFileInput();
        this.setupModeToggle();
        this.setupSliders();
        this.setupEyedroppers();
        this.setupCurves();
        this.setupCropTool();
        this.setupPresets();
        this.setupExport();
        this.setupMisc();
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
        });
    }

    async loadFile(file) {
        try {
            this.status('Loading ' + file.name + '…');
            this.original = await decodeImageFile(file);
            this.bakedOps = [];
            this.bakedStraighten = 0;
            this.filmCorrection = this.isNegative ? 1 : 0;
            document.getElementById('filmCorrToggle').checked = this.filmCorrection === 1;
            this.resetEditState();

            if (!this.renderer) {
                this.renderer = new MobileRenderer(document.getElementById('viewCanvas'));
            }
            this.rebuildSource();
            this.updateImage();

            document.getElementById('editorUI').style.display = '';
            document.getElementById('emptyHint').style.display = 'none';
            this.status(`${this.original.width}×${this.original.height}`
                + ` · ${this.original.bitDepth}-bit`
                + (this.original.colorConverted ? ' · ' + this.original.colorConverted : ''));
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
        document.querySelectorAll('.eyedropper-btn').forEach(b => b.classList.remove('active'));
        this.setStraightenValue(0);
        this.drawCurves();
        this.cancelCrop();
    }

    // Rebuild the shader's input image from the original + baked state
    rebuildSource() {
        const source = prepareSource(this.original, this.bakedOps, {
            isNegative: this.isNegative,
            filmCorrection: this.filmCorrection,
            straighten: this.bakedStraighten,
        });
        this.renderer.setImage(source.data, source.width, source.height);
        this.syncCropOverlayBox();
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
        document.querySelectorAll('.pro-slider').forEach(slider => {
            slider.addEventListener('pointerdown', () => this.saveHistory());
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
            slider.addEventListener('dblclick', () => {
                this.saveHistory();
                slider.value = 0;
                this.updateValueDisplay(slider.id, 0);
                if (slider.id === 'straighten') this.bakeStraighten();
                else this.updateImage();
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
        el.style.color = v > 0 ? '#00c851' : (v < 0 ? '#ff4444' : '#888');
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
            blackPoint: this.blackPoint ? this.blackPoint.map(v => v / 255) : [0, 0, 0],
            whitePoint: this.whitePoint ? this.whitePoint.map(v => v / 255) : [1, 1, 1],
            grayPoint: this.grayPoint ? this.grayPoint.map(v => v / 255) : [0.5, 0.5, 0.5],
            hasBlackPoint: !!this.blackPoint,
            hasWhitePoint: !!this.whitePoint,
            hasGrayPoint: !!this.grayPoint,
            curves: p.curves,
        });
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

            if (drag.handle === 'move') {
                left = Math.max(0, Math.min(left + dx, maxW - width));
                top = Math.max(0, Math.min(top + dy, maxH - height));
            } else {
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
            }
            box.style.left = left + 'px';
            box.style.top = top + 'px';
            box.style.width = width + 'px';
            box.style.height = height + 'px';
        });

        const endDrag = () => { drag = null; };
        box.addEventListener('pointerup', endDrag);
        box.addEventListener('pointercancel', endDrag);
    }

    toggleCrop() {
        if (this.cropMode) { this.cancelCrop(); return; }
        if (!this.original) return;
        this.cropMode = true;
        document.getElementById('cropOverlay').style.display = 'block';
        document.getElementById('cropControls').style.display = '';
        document.getElementById('cropBtn').classList.add('active');
        this.syncCropOverlayBox(true);
    }

    // Size the overlay to the displayed canvas; optionally reset the box
    syncCropOverlayBox(resetBox = false) {
        if (!this.cropMode) return;
        const canvas = document.getElementById('viewCanvas');
        const overlay = document.getElementById('cropOverlay');
        overlay.style.width = canvas.clientWidth + 'px';
        overlay.style.height = canvas.clientHeight + 'px';
        if (resetBox) {
            const box = document.getElementById('cropBox');
            box.style.left = (canvas.clientWidth * 0.1) + 'px';
            box.style.top = (canvas.clientHeight * 0.1) + 'px';
            box.style.width = (canvas.clientWidth * 0.8) + 'px';
            box.style.height = (canvas.clientHeight * 0.8) + 'px';
        }
    }

    cancelCrop() {
        this.cropMode = false;
        const overlay = document.getElementById('cropOverlay');
        if (overlay) overlay.style.display = 'none';
        const controls = document.getElementById('cropControls');
        if (controls) controls.style.display = 'none';
        document.getElementById('cropBtn')?.classList.remove('active');
    }

    updateCanvasRotationPreview() {
        const canvas = document.getElementById('viewCanvas');
        const delta = parseFloat(document.getElementById('straighten').value) - this.bakedStraighten;
        canvas.style.transform = delta ? `rotate(${delta}deg)` : '';
    }

    bakeStraighten() {
        if (!this.original) return;
        const angle = parseFloat(document.getElementById('straighten').value);
        if (angle === this.bakedStraighten) return;
        this.status('Rotating…');
        // Let the status paint before the CPU-heavy rebuild
        setTimeout(() => {
            this.bakedStraighten = angle;
            document.getElementById('viewCanvas').style.transform = '';
            this.rebuildSource();
            this.updateImage();
            this.status(angle ? `Straighten ${angle.toFixed(1)}°` : 'Ready');
        }, 30);
    }

    setStraightenValue(angle) {
        const s = document.getElementById('straighten');
        s.value = angle;
        this.updateValueDisplay('straighten', angle);
        this.bakedStraighten = angle;
        document.getElementById('viewCanvas').style.transform = '';
    }

    applyCrop() {
        const canvas = document.getElementById('viewCanvas');
        const box = document.getElementById('cropBox');
        const scaleX = this.renderer.imageWidth / canvas.clientWidth;
        const scaleY = this.renderer.imageHeight / canvas.clientHeight;

        const rect = {
            x: box.offsetLeft * scaleX,
            y: box.offsetTop * scaleY,
            width: box.offsetWidth * scaleX,
            height: box.offsetHeight * scaleY,
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
        this.bakedOps.push({ angle: 90, rect: null });
        this.rebuildSource();
        this.updateImage();
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
    // Export
    // ------------------------------------------------------------------

    exportPixels() {
        return this.renderer.renderToPixels();
    }

    makeTiffBlob() {
        const { data, width, height } = this.exportPixels();
        return new Blob([encodeTiff16(data, width, height)], { type: 'image/tiff' });
    }

    async makeJpegBlob() {
        const { data, width, height } = this.exportPixels();
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(width, height);
        for (let i = 0; i < width * height; i++) {
            imgData.data[i * 4] = Math.round(data[i * 3] * 255);
            imgData.data[i * 4 + 1] = Math.round(data[i * 3 + 1] * 255);
            imgData.data[i * 4 + 2] = Math.round(data[i * 3 + 2] * 255);
            imgData.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
        return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    }

    async deliverFile(blob, filename) {
        const file = new File([blob], filename, { type: blob.type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file] });
                return;
            } catch (e) {
                if (e.name === 'AbortError') return; // user cancelled
            }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    setupExport() {
        const stamp = () => new Date().toISOString().replace(/[:T-]/g, '').slice(0, 14);
        document.getElementById('exportTiffBtn').addEventListener('click', async () => {
            if (!this.original) return;
            this.status('Exporting TIFF…');
            await this.deliverFile(this.makeTiffBlob(), `film_${stamp()}.tif`);
            this.status('Exported 16-bit TIFF');
        });
        document.getElementById('exportJpegBtn').addEventListener('click', async () => {
            if (!this.original) return;
            this.status('Exporting JPEG…');
            await this.deliverFile(await this.makeJpegBlob(), `film_${stamp()}.jpg`);
            this.status('Exported JPEG');
        });
    }

    // Used by the automated test harness
    exportTiffBase64() {
        const blob = this.makeTiffBlob();
        return new Promise((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result.split(',')[1]);
            r.readAsDataURL(blob);
        });
    }

    // ------------------------------------------------------------------
    // Misc
    // ------------------------------------------------------------------

    setupMisc() {
        document.getElementById('undoBtn').addEventListener('click', () => this.undo());

        // Press-and-hold compare button
        const btn = document.getElementById('compareBtn');
        const show = (on) => {
            this.showingOriginal = on;
            if (this.renderer) this.renderer.updateParams({ showOriginal: on });
        };
        btn.addEventListener('pointerdown', (e) => { e.preventDefault(); show(true); });
        btn.addEventListener('pointerup', () => show(false));
        btn.addEventListener('pointercancel', () => show(false));
        btn.addEventListener('pointerleave', () => { if (this.showingOriginal) show(false); });

        window.addEventListener('resize', () => this.syncCropOverlayBox());
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
