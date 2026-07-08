// Professional Film Processor frontend.
//
// All live preview adjustments run in the WebGL shader (webgl-renderer.js).
// The server re-applies the identical pipeline for CPU-fallback preview and
// for 16-bit TIFF export, so what you see is what you export.

class ProfessionalFilmProcessor {
    constructor() {
        this.currentImage = null;      // base64 of last server-rendered image
        this.originalImage = null;
        this.showingOriginal = false;  // before/after (hold mouse on image)
        this.isProcessing = false;
        this.currentRequest = null;    // in-flight /process request
        this.originalFilePath = null;  // set in Electron

        // Eyedropper state
        this.eyedropperMode = null;    // 'black', 'white', or 'gray'
        this.blackPoint = null;
        this.whitePoint = null;
        this.grayPoint = null;
        this.loupeRafPending = false;

        // Edit history (undo)
        this.history = [];
        this.maxHistorySize = 50;

        // View state
        this.zoom = 1.0;
        this.rotation = 0;
        this.cropMode = false;

        // WebGL GPU rendering (client-side, instant updates)
        this.webglRenderer = null;
        this.webglEnabled = false;
        // Film base correction is baked into the raw image server-side, so
        // the WebGL texture must be reloaded when it changes.
        this.lastFilmCorrection = null;

        // Tone curves per channel, normalized [0,1] control points
        this.curves = this.defaultCurves();
        this.currentCurveChannel = 'rgb';
        this.selectedPoint = -1;
        this.isDragging = false;

        this.init();
    }

    defaultCurves() {
        return {
            rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            red: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            green: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            blue: [{ x: 0, y: 0 }, { x: 1, y: 1 }]
        };
    }

    init() {
        this.setupEventListeners();
        this.setupCurves();

        // CPU-fallback proxy rendering (only used when WebGL is unavailable):
        // low-res proxy while dragging, full-res on release.
        this.isSliderActive = false;
        this.debouncedProxyUpdate = this.debounce(() => this.updateImage(true), 0);
        this.debouncedUpdateImage = this.debounce(() => this.updateImage(), 50);
    }

    setupEventListeners() {
        // File upload
        const fileInput = document.getElementById('fileInput');
        const uploadZone = document.getElementById('uploadZone');

        fileInput.addEventListener('change', (e) => this.handleFileUpload(e.target.files[0]));

        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.classList.add('dragover');
        });
        uploadZone.addEventListener('dragleave', () => {
            uploadZone.classList.remove('dragover');
        });
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                this.handleFileUpload(e.dataTransfer.files[0]);
            }
        });
        uploadZone.addEventListener('click', () => fileInput.click());

        // Preview image (the WebGL canvas gets its listeners after init)
        const previewImage = document.getElementById('previewImage');
        if (previewImage) {
            previewImage.addEventListener('mousedown', this.handlePreviewMouseDown.bind(this));
            previewImage.addEventListener('mouseup', this.handlePreviewMouseUp.bind(this));
            previewImage.addEventListener('mouseleave', this.handlePreviewMouseLeave.bind(this));
            previewImage.addEventListener('mousemove', this.handlePreviewMouseMove.bind(this));
        }

        // Sliders
        document.querySelectorAll('.pro-slider').forEach(slider => {
            slider.addEventListener('mousedown', () => {
                this.saveHistory();
                this.isSliderActive = true;
            });

            slider.addEventListener('input', () => {
                this.updateValueDisplay(slider.id, slider.value);
                if (this.webglEnabled) {
                    this.updateImage(); // instant GPU render
                } else if (this.isSliderActive) {
                    this.debouncedProxyUpdate(); // low-res proxy while dragging
                }
            });

            slider.addEventListener('dblclick', () => {
                slider.value = 0;
                this.updateValueDisplay(slider.id, 0);
                this.updateImage();
            });

            slider.addEventListener('mouseup', () => {
                this.isSliderActive = false;
                if (!this.webglEnabled) {
                    this.updateImage(); // full resolution on release
                }
            });

            slider.addEventListener('mouseleave', () => {
                if (this.isSliderActive) {
                    this.isSliderActive = false;
                    if (!this.webglEnabled) {
                        this.updateImage();
                    }
                }
            });

            this.updateValueDisplay(slider.id, slider.value);
        });

        // Eyedropper buttons
        document.getElementById('blackPointBtn')?.addEventListener('click', () => this.activateEyedropper('black'));
        document.getElementById('grayPointBtn')?.addEventListener('click', () => this.activateEyedropper('gray'));
        document.getElementById('whitePointBtn')?.addEventListener('click', () => this.activateEyedropper('white'));
        document.getElementById('resetEyedroppersBtn')?.addEventListener('click', () => this.resetEyedroppers());

        // Curves / undo
        document.getElementById('resetCurvesBtn')?.addEventListener('click', () => this.resetCurves());
        document.getElementById('undoBtn')?.addEventListener('click', () => this.undo());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                this.undo();
            }
            if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                this.zoomIn();
            }
            if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                this.zoomOut();
            }
            if (e.key === '0') {
                e.preventDefault();
                this.zoomFit();
            }
            if (e.key === '1') {
                e.preventDefault();
                this.zoom100();
            }
            if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this.toggleCropMode();
            }
        });

        // Toolbar
        document.getElementById('zoomInBtn')?.addEventListener('click', () => this.zoomIn());
        document.getElementById('zoomOutBtn')?.addEventListener('click', () => this.zoomOut());
        document.getElementById('zoomFitBtn')?.addEventListener('click', () => this.zoomFit());
        document.getElementById('zoom100Btn')?.addEventListener('click', () => this.zoom100());
        document.getElementById('exportBtn')?.addEventListener('click', () => this.exportImage());
        document.getElementById('saveSettingsBtn')?.addEventListener('click', () => this.saveSettings());
        document.getElementById('loadSettingsBtn')?.addEventListener('click', () => this.loadSettings());
        document.getElementById('rotateLeftBtn')?.addEventListener('click', () => this.rotateLeft());
        document.getElementById('rotateRightBtn')?.addEventListener('click', () => this.rotateRight());
        document.getElementById('cropBtn')?.addEventListener('click', () => this.toggleCropMode());
        document.getElementById('applyCropBtn')?.addEventListener('click', () => this.applyCrop());
        document.getElementById('cancelCropBtn')?.addEventListener('click', () => this.cancelCrop());
        document.getElementById('undoCropBtn')?.addEventListener('click', () => this.undoCrop());

        this.setupWheelZoom();
        this.setupCropTool();
    }

    setupWheelZoom() {
        const imageContainer = document.getElementById('imageContainer');
        if (!imageContainer) return;

        imageContainer.addEventListener('wheel', (e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();

            const wrapper = document.getElementById('imageWrapper');
            const activeElement = this.getActiveImageElement();
            if (!wrapper || !activeElement) return;

            // Mouse position within image (0-1) before zooming
            const oldRect = activeElement.getBoundingClientRect();
            const relX = (e.clientX - oldRect.left) / oldRect.width;
            const relY = (e.clientY - oldRect.top) / oldRect.height;

            const oldZoom = this.zoom;
            if (e.deltaY < 0) {
                this.zoom = Math.min(this.zoom * 1.1, 20);
            } else {
                this.zoom = Math.max(this.zoom / 1.1, 0.1);
            }
            if (this.zoom === oldZoom) return;

            this.applyZoom();

            // After layout, scroll so the point under the cursor stays put
            requestAnimationFrame(() => {
                const newRect = activeElement.getBoundingClientRect();
                const newPointX = newRect.left + relX * newRect.width;
                const newPointY = newRect.top + relY * newRect.height;
                imageContainer.scrollLeft += newPointX - e.clientX;
                imageContainer.scrollTop += newPointY - e.clientY;
            });
        }, { passive: false });
    }

    // The visible preview element: WebGL canvas if active, else the <img>
    getActiveImageElement() {
        const canvas = document.getElementById('webglCanvas');
        const img = document.getElementById('previewImage');
        if (canvas && canvas.style.display !== 'none') return canvas;
        if (img && img.style.display !== 'none') return img;
        return null;
    }

    // ------------------------------------------------------------------
    // Curves editor
    // ------------------------------------------------------------------

    setupCurves() {
        const canvas = document.getElementById('curvesCanvas');
        if (!canvas) return;

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

        canvas.addEventListener('mousedown', (e) => this.startCurveEdit(e));
        canvas.addEventListener('mousemove', (e) => this.updateCurveEdit(e));
        canvas.addEventListener('mouseup', () => this.endCurveEdit());
        canvas.addEventListener('mouseleave', () => this.endCurveEdit());
        canvas.addEventListener('dblclick', (e) => this.removeCurvePoint(e));
    }

    curveEventPosition(e) {
        const rect = this.curvesCtx.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / rect.width,
            y: 1 - (e.clientY - rect.top) / rect.height
        };
    }

    startCurveEdit(e) {
        this.saveHistory();

        const { x, y } = this.curveEventPosition(e);
        const curve = this.curves[this.currentCurveChannel];

        // Find closest existing point
        let closestIndex = -1;
        let closestDistance = Infinity;
        curve.forEach((point, index) => {
            const distance = Math.hypot(point.x - x, point.y - y);
            if (distance < 0.05 && distance < closestDistance) {
                closestDistance = distance;
                closestIndex = index;
            }
        });

        if (closestIndex >= 0) {
            this.selectedPoint = closestIndex;
            this.isDragging = true;
            this.curvesCtx.canvas.style.cursor = 'grabbing';
            return;
        }

        // Add a new point at the click location
        const tooClose = curve.some(point => Math.abs(point.x - x) < 0.03);
        if (!tooClose && curve.length < 16 && x > 0 && x < 1) {
            const insertIndex = curve.findIndex(p => p.x > x);
            const targetIndex = insertIndex === -1 ? curve.length : insertIndex;
            curve.splice(targetIndex, 0, {
                x: Math.max(0, Math.min(1, x)),
                y: Math.max(0, Math.min(1, y))
            });
            this.selectedPoint = targetIndex;
            this.isDragging = true;
            this.curvesCtx.canvas.style.cursor = 'grabbing';
            this.drawCurves();
        }
    }

    updateCurveEdit(e) {
        const { x, y } = this.curveEventPosition(e);

        if (!this.isDragging || this.selectedPoint < 0) {
            this.curvesCtx.canvas.style.cursor = 'crosshair';
            this.updateCurvePointInfo(x, y);
            return;
        }

        const cx = Math.max(0, Math.min(1, x));
        const cy = Math.max(0, Math.min(1, y));
        const curve = this.curves[this.currentCurveChannel];

        if (this.selectedPoint === 0 || this.selectedPoint === curve.length - 1) {
            // Endpoints only move vertically
            curve[this.selectedPoint].y = cy;
        } else {
            // Middle points stay between their neighbors
            const prevX = curve[this.selectedPoint - 1].x;
            const nextX = curve[this.selectedPoint + 1].x;
            curve[this.selectedPoint].x = Math.max(prevX + 0.01, Math.min(nextX - 0.01, cx));
            curve[this.selectedPoint].y = cy;
        }

        this.drawCurves();
        this.updateCurvePointInfo(cx, cy);
        this.updateImage(); // real-time while dragging (instant on WebGL)
    }

    endCurveEdit() {
        if (!this.isDragging) return;

        this.isDragging = false;
        this.selectedPoint = -1;
        this.curvesCtx.canvas.style.cursor = 'crosshair';
        const info = document.getElementById('curvePointInfo');
        if (info) info.textContent = 'Click and drag to edit, double-click to remove points';
        this.updateImage();
    }

    removeCurvePoint(e) {
        this.saveHistory();

        const { x, y } = this.curveEventPosition(e);
        const curve = this.curves[this.currentCurveChannel];

        // Closest point, excluding endpoints
        let closestIndex = -1;
        let closestDistance = Infinity;
        for (let i = 1; i < curve.length - 1; i++) {
            const distance = Math.hypot(curve[i].x - x, curve[i].y - y);
            if (distance < 0.05 && distance < closestDistance) {
                closestDistance = distance;
                closestIndex = i;
            }
        }

        if (closestIndex >= 0) {
            curve.splice(closestIndex, 1);
            this.drawCurves();
            this.debouncedUpdateImage();
        }
        e.preventDefault();
    }

    resetCurves() {
        this.saveHistory();
        this.curves[this.currentCurveChannel] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
        this.drawCurves();
        this.debouncedUpdateImage();
    }

    drawCurves() {
        if (!this.curvesCtx) return;

        const ctx = this.curvesCtx;
        const canvas = ctx.canvas;

        ctx.fillStyle = '#242424';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Grid
        ctx.strokeStyle = '#3a3a3a';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const pos = (canvas.width / 4) * i;
            ctx.beginPath();
            ctx.moveTo(pos, 0);
            ctx.lineTo(pos, canvas.height);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, pos);
            ctx.lineTo(canvas.width, pos);
            ctx.stroke();
        }

        // Diagonal reference line
        ctx.strokeStyle = '#555';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, canvas.height);
        ctx.lineTo(canvas.width, 0);
        ctx.stroke();
        ctx.setLineDash([]);

        const curve = this.curves[this.currentCurveChannel];
        if (!curve || curve.length < 2) return;

        const channelColors = {
            rgb: '#007acc',
            red: '#ff4444',
            green: '#00c851',
            blue: '#4285f4'
        };
        const toCanvasX = (x) => x * canvas.width;
        const toCanvasY = (y) => (1 - y) * canvas.height;

        // Curve line (same monotone cubic spline as the shader LUT and export)
        ctx.strokeStyle = channelColors[this.currentCurveChannel];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(toCanvasX(curve[0].x), toCanvasY(curve[0].y));

        if (curve.length === 2) {
            ctx.lineTo(toCanvasX(curve[1].x), toCanvasY(curve[1].y));
        } else {
            const interpolated = buildMonotoneCubicSpline(curve);
            const steps = 200;
            for (let i = 1; i <= steps; i++) {
                const x = i / steps;
                ctx.lineTo(toCanvasX(x), toCanvasY(interpolated(x)));
            }
        }
        ctx.stroke();

        // Control points
        curve.forEach((point, index) => {
            const isSelected = index === this.selectedPoint;
            const isEndpoint = index === 0 || index === curve.length - 1;

            ctx.fillStyle = isSelected ? '#ff9500' : channelColors[this.currentCurveChannel];
            ctx.strokeStyle = isEndpoint ? '#fff' : channelColors[this.currentCurveChannel];
            ctx.lineWidth = isEndpoint ? 2 : 1;

            ctx.beginPath();
            ctx.arc(toCanvasX(point.x), toCanvasY(point.y), isSelected ? 6 : 4, 0, Math.PI * 2);
            ctx.fill();
            if (isEndpoint) ctx.stroke();
        });
    }

    updateCurvePointInfo(x, y) {
        const info = document.getElementById('curvePointInfo');
        if (info) {
            info.textContent = `Input: ${(x * 100).toFixed(1)}% → Output: ${(y * 100).toFixed(1)}%`;
        }
    }

    // ------------------------------------------------------------------
    // Slider displays
    // ------------------------------------------------------------------

    updateValueDisplay(sliderId, value) {
        const display = document.getElementById(sliderId + '_value');
        if (!display) return;

        const numValue = parseFloat(value);
        display.textContent = numValue % 1 === 0 ? numValue.toString() : numValue.toFixed(2);

        if (numValue > 0) {
            display.style.color = '#00c851';
        } else if (numValue < 0) {
            display.style.color = '#ff4444';
        } else {
            display.style.color = '#999';
        }
    }

    // ------------------------------------------------------------------
    // Zoom / rotate
    // ------------------------------------------------------------------

    zoomIn() {
        this.zoom = Math.min(this.zoom * 1.2, 20);
        this.applyZoom();
    }

    zoomOut() {
        this.zoom = Math.max(this.zoom / 1.2, 0.1);
        this.applyZoom();
    }

    zoomFit() {
        this.zoom = 1.0;
        this.applyZoom();
    }

    zoom100() {
        this.zoom = 1.0;
        this.applyZoom(true); // actual 1:1 pixels
    }

    applyZoom(actualSize = false) {
        // Remember crop area's relative position so it survives the resize
        let cropRelative = null;
        if (this.cropMode) {
            const cropArea = document.getElementById('cropArea');
            const cropOverlay = document.getElementById('cropOverlay');
            if (cropArea && cropOverlay && cropOverlay.offsetWidth > 0) {
                cropRelative = {
                    left: parseFloat(cropArea.style.left) / cropOverlay.offsetWidth,
                    top: parseFloat(cropArea.style.top) / cropOverlay.offsetHeight,
                    width: cropArea.offsetWidth / cropOverlay.offsetWidth,
                    height: cropArea.offsetHeight / cropOverlay.offsetHeight
                };
            }
        }

        const wrapper = document.getElementById('imageWrapper');
        const container = document.getElementById('imageContainer');
        const activeElement = this.getActiveImageElement();
        if (!wrapper || !container || !activeElement) return;

        const usingCanvas = activeElement.id === 'webglCanvas';
        const img = document.getElementById('previewImage');
        const naturalWidth = usingCanvas && this.webglRenderer ? this.webglRenderer.imageWidth
            : (img && img.naturalWidth ? img.naturalWidth : 1);
        const naturalHeight = usingCanvas && this.webglRenderer ? this.webglRenderer.imageHeight
            : (img && img.naturalHeight ? img.naturalHeight : 1);

        if (actualSize) {
            activeElement.style.width = naturalWidth + 'px';
            activeElement.style.height = naturalHeight + 'px';
            activeElement.style.maxWidth = 'none';
            activeElement.style.maxHeight = 'none';
            wrapper.style.width = (naturalWidth * 3) + 'px';
            wrapper.style.height = (naturalHeight * 3) + 'px';
        } else if (this.zoom === 1.0) {
            // Fit to container
            activeElement.style.width = '';
            activeElement.style.height = '';
            activeElement.style.maxWidth = '100%';
            activeElement.style.maxHeight = '100%';
            wrapper.style.width = '100%';
            wrapper.style.height = '100%';
        } else {
            const containerWidth = container.clientWidth;
            const containerHeight = container.clientHeight;
            const imgAspect = naturalWidth / naturalHeight;

            let fittedWidth, fittedHeight;
            if (imgAspect > containerWidth / containerHeight) {
                fittedWidth = containerWidth;
                fittedHeight = containerWidth / imgAspect;
            } else {
                fittedHeight = containerHeight;
                fittedWidth = containerHeight * imgAspect;
            }

            const zoomedWidth = fittedWidth * this.zoom;
            const zoomedHeight = fittedHeight * this.zoom;

            activeElement.style.width = zoomedWidth + 'px';
            activeElement.style.height = zoomedHeight + 'px';
            activeElement.style.maxWidth = 'none';
            activeElement.style.maxHeight = 'none';
            // 3x wrapper so the image can be scrolled in all directions
            wrapper.style.width = (zoomedWidth * 3) + 'px';
            wrapper.style.height = (zoomedHeight * 3) + 'px';
        }

        wrapper.style.transform = `rotate(${this.rotation}deg)`;

        const zoomPercent = actualSize ? 100 : Math.round(this.zoom * 100);
        document.getElementById('zoomLevel').textContent = zoomPercent + '%';

        // Reposition crop overlay after layout settles
        if (this.cropMode && cropRelative) {
            setTimeout(() => this.positionCropOverlay(cropRelative), 0);
        }
    }

    rotateLeft() {
        this.saveHistory();
        this.rotation = (this.rotation - 90) % 360;
        this.applyZoom();
    }

    rotateRight() {
        this.saveHistory();
        this.rotation = (this.rotation + 90) % 360;
        this.applyZoom();
    }

    // ------------------------------------------------------------------
    // Export
    // ------------------------------------------------------------------

    async exportImage() {
        const exportBtn = document.getElementById('exportBtn');
        try {
            if (exportBtn) {
                exportBtn.textContent = '⏳ Exporting...';
                exportBtn.disabled = true;
            }

            const params = this.getParameters();
            params.rotation = this.rotation; // export matches on-screen rotation

            const response = await fetch('/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });
            if (!response.ok) {
                throw new Error(`Export failed: ${response.status}`);
            }

            const blob = await response.blob();

            if (window.electronAPI) {
                let defaultName = 'processed_image.tif';
                if (this.originalFilePath) {
                    const fileName = this.originalFilePath.split(/[\\/]/).pop();
                    const base = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
                    defaultName = base + '_processed.tif';
                }

                const savePath = await window.electronAPI.saveFileDialog(defaultName);
                if (savePath) {
                    const arrayBuffer = await blob.arrayBuffer();
                    const result = await window.electronAPI.writeFile(savePath, arrayBuffer);
                    if (!result.success) {
                        throw new Error(result.error);
                    }
                    alert('Image exported successfully!');
                }
            } else {
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `processed_image_${Date.now()}.tif`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            }
        } catch (error) {
            console.error('Export error:', error);
            alert('Failed to export image: ' + error.message);
        } finally {
            if (exportBtn) {
                exportBtn.textContent = '💾 Export';
                exportBtn.disabled = false;
            }
        }
    }

    // ------------------------------------------------------------------
    // Crop tool
    // ------------------------------------------------------------------

    setupCropTool() {
        const cropArea = document.getElementById('cropArea');
        if (!cropArea) return;

        let isDragging = false;
        let isResizing = false;
        let resizeHandle = null;
        let startX, startY, startLeft, startTop, startWidth, startHeight;

        cropArea.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('crop-handle')) {
                isResizing = true;
                resizeHandle = e.target.classList[1]; // nw, ne, sw, se
            } else if (e.target.classList.contains('crop-edge')) {
                isResizing = true;
                resizeHandle = e.target.classList[1]; // n, s, e, w
            } else if (e.target === cropArea || e.target.parentElement === cropArea) {
                isDragging = true;
            } else {
                return;
            }

            startX = e.clientX;
            startY = e.clientY;
            startLeft = cropArea.offsetLeft;
            startTop = cropArea.offsetTop;
            startWidth = cropArea.offsetWidth;
            startHeight = cropArea.offsetHeight;

            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging && !isResizing) return;

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const cropOverlay = document.getElementById('cropOverlay');
            const maxWidth = cropOverlay.offsetWidth;
            const maxHeight = cropOverlay.offsetHeight;

            if (isDragging) {
                const newLeft = Math.max(0, Math.min(startLeft + dx, maxWidth - startWidth));
                const newTop = Math.max(0, Math.min(startTop + dy, maxHeight - startHeight));
                cropArea.style.left = newLeft + 'px';
                cropArea.style.top = newTop + 'px';
            } else {
                if (resizeHandle.includes('e')) {
                    cropArea.style.width = Math.max(50, Math.min(startWidth + dx, maxWidth - startLeft)) + 'px';
                }
                if (resizeHandle.includes('w')) {
                    const maxLeft = startLeft + startWidth - 50;
                    const newLeft = Math.max(0, Math.min(startLeft + dx, maxLeft));
                    cropArea.style.left = newLeft + 'px';
                    cropArea.style.width = (startLeft + startWidth - newLeft) + 'px';
                }
                if (resizeHandle.includes('s')) {
                    cropArea.style.height = Math.max(50, Math.min(startHeight + dy, maxHeight - startTop)) + 'px';
                }
                if (resizeHandle.includes('n')) {
                    const maxTop = startTop + startHeight - 50;
                    const newTop = Math.max(0, Math.min(startTop + dy, maxTop));
                    cropArea.style.top = newTop + 'px';
                    cropArea.style.height = (startTop + startHeight - newTop) + 'px';
                }
            }
            e.preventDefault();
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            isResizing = false;
            resizeHandle = null;
        });
    }

    positionCropOverlay(cropRelative = null) {
        const cropArea = document.getElementById('cropArea');
        const cropOverlay = document.getElementById('cropOverlay');
        const container = document.getElementById('imageContainer');
        const img = this.getActiveImageElement();
        if (!cropArea || !cropOverlay || !img || !container) return;

        // Position overlay to exactly match the on-screen image
        const imgRect = img.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        cropOverlay.style.left = (imgRect.left - containerRect.left + container.scrollLeft) + 'px';
        cropOverlay.style.top = (imgRect.top - containerRect.top + container.scrollTop) + 'px';
        cropOverlay.style.width = img.offsetWidth + 'px';
        cropOverlay.style.height = img.offsetHeight + 'px';

        // Restore relative crop area, or default to 80% centered
        const rel = cropRelative || { left: 0.1, top: 0.1, width: 0.8, height: 0.8 };
        cropArea.style.left = (rel.left * img.offsetWidth) + 'px';
        cropArea.style.top = (rel.top * img.offsetHeight) + 'px';
        cropArea.style.width = (rel.width * img.offsetWidth) + 'px';
        cropArea.style.height = (rel.height * img.offsetHeight) + 'px';
    }

    toggleCropMode() {
        this.cropMode = !this.cropMode;

        if (this.cropMode) {
            document.getElementById('cropOverlay').style.display = 'block';
            setTimeout(() => this.positionCropOverlay(), 0);
            document.getElementById('cropBtn').style.display = 'none';
            document.getElementById('applyCropBtn').style.display = 'block';
            document.getElementById('cancelCropBtn').style.display = 'block';
        } else {
            this.cancelCrop();
        }
    }

    async applyCrop() {
        this.saveHistory();

        const cropArea = document.getElementById('cropArea');
        const img = this.getActiveImageElement();
        if (!cropArea || !img) return;

        const usingCanvas = img.id === 'webglCanvas';
        const previewImage = document.getElementById('previewImage');
        const naturalWidth = usingCanvas
            ? (this.webglRenderer ? this.webglRenderer.imageWidth : img.width)
            : previewImage.naturalWidth;
        const naturalHeight = usingCanvas
            ? (this.webglRenderer ? this.webglRenderer.imageHeight : img.height)
            : previewImage.naturalHeight;

        const imgRect = img.getBoundingClientRect();
        const cropRect = cropArea.getBoundingClientRect();
        const normalizedRotation = ((this.rotation % 360) + 360) % 360;

        // Convert screen-space points into unrotated image CSS-space coordinates
        const screenToImageCss = (screenX, screenY) => {
            const centerX = imgRect.left + imgRect.width / 2;
            const centerY = imgRect.top + imgRect.height / 2;

            let cssW, cssH;
            if (normalizedRotation === 90 || normalizedRotation === 270) {
                cssW = imgRect.height;
                cssH = imgRect.width;
            } else {
                cssW = imgRect.width;
                cssH = imgRect.height;
            }

            const dx = screenX - centerX;
            const dy = screenY - centerY;
            const radians = (-this.rotation * Math.PI) / 180;
            const cosR = Math.cos(radians);
            const sinR = Math.sin(radians);

            return {
                x: dx * cosR - dy * sinR + cssW / 2,
                y: dx * sinR + dy * cosR + cssH / 2,
                cssW,
                cssH
            };
        };

        const corners = [
            screenToImageCss(cropRect.left, cropRect.top),
            screenToImageCss(cropRect.right, cropRect.top),
            screenToImageCss(cropRect.left, cropRect.bottom),
            screenToImageCss(cropRect.right, cropRect.bottom)
        ];

        const cssW = corners[0].cssW;
        const cssH = corners[0].cssH;
        const xs = corners.map(p => Math.max(0, Math.min(cssW, p.x)));
        const ys = corners.map(p => Math.max(0, Math.min(cssH, p.y)));

        const cropX = Math.min(...xs);
        const cropY = Math.min(...ys);
        const cropW = Math.max(1, Math.max(...xs) - cropX);
        const cropH = Math.max(1, Math.max(...ys) - cropY);

        const scaleX = naturalWidth / cssW;
        const scaleY = naturalHeight / cssH;

        const cropData = {
            x: Math.round(cropX * scaleX),
            y: Math.round(cropY * scaleY),
            width: Math.round(cropW * scaleX),
            height: Math.round(cropH * scaleY)
        };

        try {
            const response = await fetch('/crop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...cropData, webgl: !!(this.webglEnabled && this.webglRenderer) })
            });
            const data = await response.json();

            if (data.success) {
                if (data.image) {
                    this.currentImage = data.image;
                    this.originalImage = data.image;
                }

                if (this.webglEnabled && this.webglRenderer) {
                    // Reload the cropped raw image; adjustments re-apply on top
                    await this.webglRenderer.loadImage('/get_raw_image');
                    await this.updateImage();
                } else {
                    this.displayImage(data.image);
                }

                this.cancelCrop();
                document.getElementById('undoCropBtn').style.display = 'inline-block';
            }
        } catch (error) {
            console.error('Error cropping image:', error);
        }
    }

    cancelCrop() {
        this.cropMode = false;
        document.getElementById('cropOverlay').style.display = 'none';
        document.getElementById('cropBtn').style.display = 'block';
        document.getElementById('applyCropBtn').style.display = 'none';
        document.getElementById('cancelCropBtn').style.display = 'none';
    }

    async undoCrop() {
        try {
            const response = await fetch('/undo_crop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ webgl: !!(this.webglEnabled && this.webglRenderer) })
            });
            const data = await response.json();
            if (data.success) {
                if (data.image) {
                    this.currentImage = data.image;
                    this.originalImage = data.image;
                }

                if (this.webglEnabled && this.webglRenderer) {
                    await this.webglRenderer.loadImage('/get_raw_image');
                    await this.updateImage();
                } else {
                    this.displayImage(data.image);
                }

                if (!data.undoAvailable) {
                    document.getElementById('undoCropBtn').style.display = 'none';
                }
            }
        } catch (error) {
            console.error('Error undoing crop:', error);
        }
    }

    // ------------------------------------------------------------------
    // History (undo)
    // ------------------------------------------------------------------

    saveHistory() {
        const state = {
            sliders: {},
            curves: JSON.parse(JSON.stringify(this.curves)),
            blackPoint: this.blackPoint ? [...this.blackPoint] : null,
            whitePoint: this.whitePoint ? [...this.whitePoint] : null,
            grayPoint: this.grayPoint ? [...this.grayPoint] : null
        };

        document.querySelectorAll('.pro-slider').forEach(slider => {
            state.sliders[slider.id] = parseFloat(slider.value);
        });

        const filmCorrectionToggle = document.getElementById('film_correction_basic');
        if (filmCorrectionToggle) {
            state.filmCorrection = filmCorrectionToggle.classList.contains('active');
        }

        this.history.push(state);
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
        }
        this.updateUndoButton();
    }

    undo() {
        if (this.history.length === 0) return;

        const state = this.history.pop();

        for (const [id, value] of Object.entries(state.sliders)) {
            const slider = document.getElementById(id);
            if (slider) {
                slider.value = value;
                this.updateValueDisplay(id, value);
            }
        }

        this.curves = JSON.parse(JSON.stringify(state.curves));
        this.drawCurves();

        this.blackPoint = state.blackPoint ? [...state.blackPoint] : null;
        this.whitePoint = state.whitePoint ? [...state.whitePoint] : null;
        this.grayPoint = state.grayPoint ? [...state.grayPoint] : null;

        if (state.filmCorrection !== undefined) {
            const toggle = document.getElementById('film_correction_basic');
            if (toggle) toggle.classList.toggle('active', state.filmCorrection);
        }

        this.updateUndoButton();
        this.updateImage();
    }

    updateUndoButton() {
        const undoBtn = document.getElementById('undoBtn');
        if (undoBtn) {
            const empty = this.history.length === 0;
            undoBtn.disabled = empty;
            undoBtn.style.opacity = empty ? '0.5' : '1';
            undoBtn.style.cursor = empty ? 'not-allowed' : 'pointer';
        }
    }

    // ------------------------------------------------------------------
    // Eyedroppers
    // ------------------------------------------------------------------

    activateEyedropper(mode) {
        document.querySelectorAll('.eyedropper-btn').forEach(btn => btn.classList.remove('active'));
        const loupe = document.getElementById('eyedropperLoupe');
        const previewImage = document.getElementById('previewImage');
        const webglCanvas = document.getElementById('webglCanvas');

        if (this.eyedropperMode === mode) {
            // Clicking the active mode again deactivates it
            this.eyedropperMode = null;
            if (previewImage) previewImage.style.cursor = 'pointer';
            if (webglCanvas) webglCanvas.style.cursor = '';
            if (loupe) loupe.style.display = 'none';
        } else {
            this.eyedropperMode = mode;
            document.getElementById(mode + 'PointBtn').classList.add('active');
            if (previewImage) previewImage.style.cursor = 'crosshair';
            if (webglCanvas) webglCanvas.style.cursor = 'crosshair';
        }
    }

    resetEyedroppers() {
        this.saveHistory();

        this.blackPoint = null;
        this.whitePoint = null;
        this.grayPoint = null;
        this.eyedropperMode = null;

        document.querySelectorAll('.eyedropper-btn').forEach(btn => btn.classList.remove('active'));
        const loupe = document.getElementById('eyedropperLoupe');
        if (loupe) loupe.style.display = 'none';
        const previewImage = document.getElementById('previewImage');
        if (previewImage) previewImage.style.cursor = 'pointer';
        const webglCanvas = document.getElementById('webglCanvas');
        if (webglCanvas) webglCanvas.style.cursor = '';

        this.updateImage();
    }

    attachCanvasEventListeners() {
        const canvas = document.getElementById('webglCanvas');
        if (!canvas || canvas.dataset.listenersAttached) return;
        canvas.dataset.listenersAttached = 'true';
        canvas.addEventListener('mousedown', this.handlePreviewMouseDown.bind(this));
        canvas.addEventListener('mouseup', this.handlePreviewMouseUp.bind(this));
        canvas.addEventListener('mouseleave', this.handlePreviewMouseLeave.bind(this));
        canvas.addEventListener('mousemove', this.handlePreviewMouseMove.bind(this));
    }

    handlePreviewMouseDown(e) {
        if (this.eyedropperMode) {
            this.handleEyedropperClick(e);
        } else {
            // Hold to show the unadjusted original (before/after)
            this.showingOriginal = true;
            if (this.webglEnabled && this.webglRenderer) {
                this.webglRenderer.updateParams({ showOriginal: true });
            } else if (this.originalImage) {
                this.displayImage(this.originalImage);
            }
        }
    }

    handlePreviewMouseUp() {
        this.stopShowingOriginal();
    }

    handlePreviewMouseLeave() {
        const loupe = document.getElementById('eyedropperLoupe');
        if (loupe) loupe.style.display = 'none';
        this.stopShowingOriginal();
    }

    stopShowingOriginal() {
        if (this.eyedropperMode || !this.showingOriginal) return;
        this.showingOriginal = false;
        if (this.webglEnabled && this.webglRenderer) {
            this.webglRenderer.updateParams({ showOriginal: false });
            this.updateImage();
        } else if (this.currentImage) {
            this.displayImage(this.currentImage);
        }
    }

    handlePreviewMouseMove(e) {
        if (!this.eyedropperMode) return;
        // Throttle loupe redraws to animation frames
        if (!this.loupeRafPending) {
            this.loupeRafPending = true;
            requestAnimationFrame(() => {
                this.loupeRafPending = false;
                this.updateEyedropperLoupe(e);
            });
        }
    }

    updateEyedropperLoupe(e) {
        const loupe = document.getElementById('eyedropperLoupe');
        if (!loupe) return;

        loupe.style.display = 'block';
        // Offset so the loupe doesn't cover the pixel being picked
        const offset = 80;
        loupe.style.left = (e.clientX + offset) + 'px';
        loupe.style.top = (e.clientY - offset) + 'px';

        const imgElement = this.getActiveImageElement();
        if (!imgElement) return;

        const normalizedRotation = ((this.rotation % 360) + 360) % 360;
        const canvasW = imgElement.width;   // native drawing buffer size
        const canvasH = imgElement.height;

        // getBoundingClientRect accounts for all CSS transforms (incl. the
        // wrapper rotation) and gives the exact screen rect.
        const rect = imgElement.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        // CSS display size before rotation (at 90/270° the rect is swapped)
        let cssW, cssH;
        if (normalizedRotation === 90 || normalizedRotation === 270) {
            cssW = rect.height;
            cssH = rect.width;
        } else {
            cssW = rect.width;
            cssH = rect.height;
        }

        // Inverse-rotate the mouse vector back into unrotated canvas space
        const dx = e.clientX - centerX;
        const dy = e.clientY - centerY;
        const radians = (-this.rotation * Math.PI) / 180;
        const cosR = Math.cos(radians);
        const sinR = Math.sin(radians);
        const cssMx = dx * cosR - dy * sinR + cssW / 2;
        const cssMy = dx * sinR + dy * cosR + cssH / 2;

        if (cssMx < 0 || cssMy < 0 || cssMx >= cssW || cssMy >= cssH) {
            loupe.style.display = 'none';
            return;
        }

        // Scale from CSS display pixels to native canvas pixels
        const mouseX = (cssMx / cssW) * canvasW;
        const mouseY = (cssMy / cssH) * canvasH;

        const loupeCanvas = document.getElementById('loupeCanvas');
        const loupeCtx = loupeCanvas.getContext('2d', { willReadFrequently: true });
        const loupeSize = 120;
        const zoomFactor = 6;
        const sourceSize = loupeSize / zoomFactor;

        loupeCtx.fillStyle = '#000';
        loupeCtx.fillRect(0, 0, loupeSize, loupeSize);

        const srcX = mouseX - sourceSize / 2;
        const srcY = mouseY - sourceSize / 2;

        loupeCtx.save();
        loupeCtx.imageSmoothingEnabled = false;

        // Rotate the loupe patch to match what the user sees on screen
        if (this.rotation !== 0) {
            loupeCtx.translate(loupeSize / 2, loupeSize / 2);
            loupeCtx.rotate((this.rotation * Math.PI) / 180);
            loupeCtx.translate(-loupeSize / 2, -loupeSize / 2);
        }

        try {
            loupeCtx.drawImage(imgElement, srcX, srcY, sourceSize, sourceSize, 0, 0, loupeSize, loupeSize);
            loupeCtx.restore();

            const centerPixel = loupeCtx.getImageData(loupeSize / 2, loupeSize / 2, 1, 1).data;
            const rgbText = document.getElementById('loupeRGB');
            if (rgbText) {
                rgbText.textContent = `RGB: ${centerPixel[0]}, ${centerPixel[1]}, ${centerPixel[2]}`;
            }
        } catch (err) {
            loupeCtx.restore();
            console.warn('Could not read pixel data for loupe:', err);
        }
    }

    async handleEyedropperClick() {
        if (!this.eyedropperMode || !this.currentImage) return;

        this.saveHistory();

        // Sample the loupe's center pixel (exactly what the user sees)
        const loupeCanvas = document.getElementById('loupeCanvas');
        if (!loupeCanvas) return;

        const loupeCtx = loupeCanvas.getContext('2d', { willReadFrequently: true });
        const loupeSize = 120;

        try {
            const centerPixel = loupeCtx.getImageData(loupeSize / 2, loupeSize / 2, 1, 1).data;
            const rgb = [centerPixel[0], centerPixel[1], centerPixel[2]];

            if (this.eyedropperMode === 'black') {
                this.blackPoint = rgb;
            } else if (this.eyedropperMode === 'white') {
                this.whitePoint = rgb;
            } else if (this.eyedropperMode === 'gray') {
                this.grayPoint = rgb;
            }

            // Eyedropper mode stays active for repeated picks
            await this.updateImage();
        } catch (error) {
            console.error('Error getting pixel value:', error);
        }
    }

    // ------------------------------------------------------------------
    // Status / helpers
    // ------------------------------------------------------------------

    updateProcessingStatus(message) {
        const status = document.getElementById('processingStatus');
        if (status) {
            const timestamp = new Date().toLocaleTimeString();
            status.innerHTML = `<div>${timestamp}: ${message}</div>`;
        }
    }

    debounce(func, wait) {
        let timer = null;
        const wrapped = (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                func(...args);
            }, wait);
        };
        wrapped.cancel = () => {
            clearTimeout(timer);
            timer = null;
        };
        return wrapped;
    }

    getParameters() {
        const params = {};

        document.querySelectorAll('.pro-slider').forEach(slider => {
            params[slider.id] = parseFloat(slider.value);
        });

        const filmCorrectionToggle = document.getElementById('film_correction_basic');
        if (filmCorrectionToggle) {
            params.film_correction = filmCorrectionToggle.classList.contains('active') ? 1.0 : 0.0;
        }

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

    // ------------------------------------------------------------------
    // Settings save/load
    // ------------------------------------------------------------------

    async saveSettings() {
        if (!this.currentImage) {
            alert('No image loaded');
            return;
        }

        const json = JSON.stringify(this.getParameters(), null, 2);

        let defaultName = 'image_settings.json';
        if (this.originalFilePath) {
            const filename = this.originalFilePath.replace(/\\/g, '/').split('/').pop();
            const baseName = filename.substring(0, filename.lastIndexOf('.')) || filename;
            defaultName = baseName + '_settings.json';
        }

        if (window.electronAPI) {
            const savePath = await window.electronAPI.saveFileDialog(defaultName);
            if (savePath) {
                const buffer = new TextEncoder().encode(json);
                const result = await window.electronAPI.writeFile(savePath, buffer);
                if (result.success) {
                    this.updateProcessingStatus('Settings saved');
                    setTimeout(() => this.updateProcessingStatus(''), 2000);
                } else {
                    alert('Failed to save settings: ' + result.error);
                }
            }
        } else {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = defaultName;
            a.click();
            URL.revokeObjectURL(url);
        }
    }

    async autoLoadSettings(imagePath) {
        try {
            // Settings live next to the image as <name>_settings.json
            const parts = imagePath.replace(/\\/g, '/').split('/');
            const filename = parts.pop();
            const baseName = filename.substring(0, filename.lastIndexOf('.')) || filename;
            const settingsPath = parts.join('/') + '/' + baseName + '_settings.json';

            const jsonData = await window.electronAPI.readFile(settingsPath);
            if (jsonData.success) {
                this.applySettings(JSON.parse(jsonData.content));
                this.updateProcessingStatus('Settings auto-loaded');
                setTimeout(() => this.updateProcessingStatus(''), 2000);
            }
        } catch (e) {
            // No settings file - normal for new images
        }
    }

    async loadSettings() {
        if (window.electronAPI) {
            const result = await window.electronAPI.openFileDialog();
            if (result && result.filePath) {
                const jsonData = await window.electronAPI.readFile(result.filePath);
                if (jsonData.success) {
                    this.applySettings(JSON.parse(jsonData.content));
                    this.updateProcessingStatus('Settings loaded');
                    setTimeout(() => this.updateProcessingStatus(''), 2000);
                } else {
                    alert('Failed to load settings: ' + jsonData.error);
                }
            }
        } else {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = async (e) => {
                const file = e.target.files[0];
                if (file) {
                    this.applySettings(JSON.parse(await file.text()));
                }
            };
            input.click();
        }
    }

    applySettings(params) {
        Object.keys(params).forEach(key => {
            const slider = document.getElementById(key);
            if (slider && slider.classList.contains('pro-slider')) {
                slider.value = params[key];
                this.updateValueDisplay(key, params[key]);
            }
        });

        if (Object.prototype.hasOwnProperty.call(params, 'film_correction')) {
            const toggle = document.getElementById('film_correction_basic');
            if (toggle) toggle.classList.toggle('active', params.film_correction === 1.0);
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
            } catch (e) {
                console.error('Failed to parse curves:', e);
            }
        }

        this.updateImage();
    }

    // ------------------------------------------------------------------
    // Upload & rendering
    // ------------------------------------------------------------------

    resetEditState() {
        this.history = [];
        this.blackPoint = null;
        this.whitePoint = null;
        this.grayPoint = null;
        this.eyedropperMode = null;
        this.curves = this.defaultCurves();
        this.rotation = 0;
        this.zoom = 1.0;
        this.drawCurves();
        this.updateUndoButton();
        document.querySelectorAll('.eyedropper-btn').forEach(btn => btn.classList.remove('active'));
    }

    async handleFileUpload(file) {
        if (!file) return;

        this.updateProcessingStatus('Uploading image...');

        // Electron exposes the real path for auto-loading sidecar settings
        this.originalFilePath = file.path || null;

        const formData = new FormData();
        formData.append('image', file);
        formData.append('is_negative', currentImageMode === 'negative' ? 'true' : 'false');

        try {
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });
            const result = await response.json();

            if (!result.success) {
                this.updateProcessingStatus('Upload failed: ' + result.error);
                console.error('Upload failed:', result.error);
                return;
            }

            this.currentImage = result.image;
            this.originalImage = result.image;
            this.resetEditState();

            document.getElementById('undoCropBtn').style.display = 'none';

            // Bake film base correction (if enabled) into the source before
            // the WebGL texture is first loaded.
            this.lastFilmCorrection = this.getParameters().film_correction;
            await this.syncSourceParams();

            await this.initializeWebGL();
            if (!this.webglEnabled) {
                this.displayImage(result.image);
            }
            this.applyZoom();

            this.updateProcessingStatus('Image uploaded successfully'
                + (this.webglEnabled ? ' [WebGL GPU]' : ' [CPU]'));

            if (this.originalFilePath && window.electronAPI) {
                await this.autoLoadSettings(this.originalFilePath);
            }
        } catch (error) {
            this.updateProcessingStatus('Upload failed: ' + error.message);
            console.error('Upload error:', error);
        }
    }

    // Push parameters that are baked into the source image (film base
    // correction) to the server without rendering; the WebGL texture is
    // reloaded from /get_raw_image afterwards.
    async syncSourceParams() {
        try {
            await fetch('/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...this.getParameters(), webgl: true })
            });
        } catch (e) {
            console.warn('Failed to sync source params:', e);
        }
    }

    async initializeWebGL() {
        try {
            if (!this.webglRenderer) {
                this.webglRenderer = new WebGLRenderer('webglCanvas');
            }

            const success = await this.webglRenderer.loadImage('/get_raw_image');
            if (!success) {
                throw new Error('WebGL initialization failed');
            }

            this.webglEnabled = true;
            document.getElementById('webglCanvas').style.display = 'block';
            document.getElementById('previewImage').style.display = 'none';
            this.attachCanvasEventListeners();
            return true;
        } catch (e) {
            console.warn('WebGL not available, falling back to server-side rendering:', e);
            this.webglEnabled = false;
            document.getElementById('webglCanvas').style.display = 'none';
            document.getElementById('previewImage').style.display = 'block';
            return false;
        }
    }

    async updateImage(useProxy = false) {
        if (!this.currentImage) return;

        // WebGL path: update shader uniforms, render instantly on the GPU
        if (this.webglEnabled && this.webglRenderer) {
            const params = this.getParameters();

            // Film base correction changed: rebuild the source server-side
            // and reload the texture, so preview and export stay identical.
            if (params.film_correction !== this.lastFilmCorrection) {
                this.lastFilmCorrection = params.film_correction;
                await this.syncSourceParams();
                await this.webglRenderer.loadImage('/get_raw_image');
            }

            this.webglRenderer.updateParams({
                exposure: params.exposure || 0,
                contrast: params.contrast || 0,
                brightness: params.brightness || 0,
                saturation: params.saturation || 0,
                temperature: params.temperature || 0,
                tint: params.tint || 0,
                highlights: params.highlights || 0,
                shadows: params.shadows || 0,
                whites: params.whites || 0,
                blacks: params.blacks || 0,
                red: params.red || 0,
                green: params.green || 0,
                blue: params.blue || 0,
                // Eyedropper points (0-255 -> 0-1)
                blackPoint: this.blackPoint ? this.blackPoint.map(v => v / 255) : [0, 0, 0],
                whitePoint: this.whitePoint ? this.whitePoint.map(v => v / 255) : [1, 1, 1],
                grayPoint: this.grayPoint ? this.grayPoint.map(v => v / 255) : [0.5, 0.5, 0.5],
                hasBlackPoint: !!this.blackPoint,
                hasWhitePoint: !!this.whitePoint,
                hasGrayPoint: !!this.grayPoint,
                curves: params.curves
            });

            const previewImage = document.getElementById('previewImage');
            const webglCanvas = document.getElementById('webglCanvas');
            if (previewImage) previewImage.style.display = 'none';
            if (webglCanvas) webglCanvas.style.display = 'block';

            this.updateProcessingStatus('GPU Rendering [WebGL]');
            return;
        }

        // CPU fallback: render server-side (proxy while dragging)
        this.debouncedProxyUpdate.cancel();
        if (this.currentRequest) {
            this.currentRequest.abort(); // latest request wins
        }
        this.currentRequest = new AbortController();
        this.isProcessing = true;
        this.updateProcessingStatus(useProxy ? 'Proxy preview...' : 'Processing full-res...');

        try {
            const params = this.getParameters();
            params.use_proxy = useProxy;

            const response = await fetch('/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
                signal: this.currentRequest.signal
            });
            const result = await response.json();

            if (result.success) {
                this.currentImage = result.image;
                this.displayImage(result.image);
                this.updateProcessingStatus('Processing complete');
            } else {
                this.updateProcessingStatus('Processing failed: ' + result.error);
                console.error('Processing failed:', result.error);
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                this.updateProcessingStatus('Processing failed: ' + error.message);
                console.error('Processing error:', error);
            }
        } finally {
            this.isProcessing = false;
            this.currentRequest = null;
        }
    }

    displayImage(base64Image) {
        const previewImage = document.getElementById('previewImage');
        const webglCanvas = document.getElementById('webglCanvas');
        if (!previewImage) return;

        const newSrc = 'data:image/png;base64,' + base64Image;

        // Preload to prevent flashing
        const tempImg = new Image();
        tempImg.onload = () => {
            previewImage.src = newSrc;
            previewImage.style.display = 'block';
            if (webglCanvas) webglCanvas.style.display = 'none';
        };
        tempImg.src = newSrc;
    }
}

// ----------------------------------------------------------------------
// Global UI functions (used by inline onclick handlers in index.html)
// ----------------------------------------------------------------------

// Toggle switch handler (film base correction)
function toggleControl(controlId) {
    const toggle = document.getElementById(controlId);
    if (!toggle) return;

    if (processor) processor.saveHistory(); // capture pre-change state
    toggle.classList.toggle('active');
    if (processor) processor.updateImage();
}

// Image mode: 'photo' (positive) or 'negative'
let currentImageMode = 'negative';

function switchImageMode(mode) {
    currentImageMode = mode;

    document.body.classList.remove('photo-mode', 'negative-mode');
    document.body.classList.add(mode + '-mode');

    document.getElementById('modePhoto').classList.toggle('active', mode === 'photo');
    document.getElementById('modeNegative').classList.toggle('active', mode === 'negative');

    const uploadText = document.getElementById('uploadText');
    const uploadBtn = document.getElementById('uploadBtn');
    if (mode === 'photo') {
        uploadText.textContent = 'Drag & drop your photo here';
        uploadBtn.textContent = 'Select Photo';
        // Film base correction only makes sense for negatives
        document.getElementById('film_correction_basic')?.classList.remove('active');
    } else {
        uploadText.textContent = 'Drag & drop your film negative here';
        uploadBtn.textContent = 'Select Film Negative';
    }

    // Note: the mode applies to the NEXT upload; the current image keeps
    // the inversion it was loaded with.
}

// ----------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------

let processor;

document.addEventListener('DOMContentLoaded', () => {
    processor = new ProfessionalFilmProcessor();
    switchImageMode('negative');

    fetch('/version').then(r => r.json()).then(data => {
        const el = document.getElementById('versionLabel');
        if (el) el.textContent = 'v' + data.version;
    }).catch(() => {});
});
