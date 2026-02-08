// Professional Film Processor JavaScript with WebGL GPU Rendering
class ProfessionalFilmProcessor {
    constructor() {
        this.currentImage = null;
        this.originalImage = null;
        this.showingOriginal = false;  // Track if we're showing before/after
        this.isProcessing = false;
        this.currentRequest = null; // Track current processing request
        this.eyedropperMode = null; // 'black', 'white', or 'gray'
        this.blackPoint = null;
        this.whitePoint = null;
        this.grayPoint = null;
        this.history = [];
        this.maxHistorySize = 50;
        this.zoom = 1.0;
        this.rotation = 0;
        this.cropMode = false;
        this.cropRect = null;
        
        // Loupe update throttling
        this.loupeUpdateScheduled = false;
        this.lastLoupeEvent = null;
        
        // WebGL GPU Rendering (client-side, instant updates, zero transfer!)
        this.webglRenderer = null;
        this.webglEnabled = false;
        
        // WebGL GPU Rendering (client-side, zero transfer lag)
        this.webglEnabled = false;
        this.gl = null;
        this.glProgram = null;
        this.glTexture = null;
        this.imageWidth = 0;
        this.imageHeight = 0;
                this.curves = { 
                    rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
                    red: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
                    green: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
                    blue: [{ x: 0, y: 0 }, { x: 1, y: 1 }]
                };
                this.currentCurveChannel = 'rgb';
                this.selectedPoint = -1;
                this.isDragging = false;
                this.layers = [];
                this.activeLayer = 0;
                this.imageHistogram = null;
                
                this.init();
            }
            
            init() {
                this.setupEventListeners();
                this.setupTabSystem();
                this.setupCurves();
                // PROXY RENDERING SYSTEM (like Photoshop)
                // Track whether user is actively dragging a slider
                this.isSliderActive = false;
                // Instant update while dragging (uses proxy)
                this.debouncedProxyUpdate = this.debounce(() => this.updateImage(true), 0);
                // Debounced update for non-slider interactions (curves, eyedropper, etc.)
                this.debouncedUpdateImage = this.debounce(() => this.updateImage(), 50);
                // Track pending debounce timer for cancellation
                this.pendingProxyTimer = null;
                console.log('Professional Film Processor initialized with proxy rendering');
            }
            
            setupEventListeners() {
                // File upload
                const fileInput = document.getElementById('fileInput');
                const uploadZone = document.getElementById('uploadZone');
                
                fileInput.addEventListener('change', (e) => this.handleFileUpload(e.target.files[0]));
                
                // Drag and drop
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
                
                // Preview image - attach to img element now, canvas will be attached after WebGL init
                const previewImage = document.getElementById('previewImage');
                
                if (previewImage) {
                    console.log('Attaching mouse handlers to previewImage');
                    previewImage.addEventListener('mousedown', this.handlePreviewMouseDown.bind(this));
                    previewImage.addEventListener('mouseup', this.handlePreviewMouseUp.bind(this));
                    previewImage.addEventListener('mouseleave', this.handlePreviewMouseLeave.bind(this));
                    previewImage.addEventListener('mousemove', this.handlePreviewMouseMove.bind(this));
                }
                
                // Sliders with PROXY RENDERING (like Photoshop)
                document.querySelectorAll('.pro-slider').forEach(slider => {
                    slider.addEventListener('mousedown', () => {
                        // Save state before user starts changing a slider
                        this.saveHistory();
                        // Mark slider as active (dragging)
                        this.isSliderActive = true;
                    });
                    
                    slider.addEventListener('input', () => {
                        this.updateValueDisplay(slider.id, slider.value);
                        // INSTANT UPDATE: WebGL renders immediately, no debouncing needed
                        if (this.webglEnabled) {
                            this.updateImage(false); // Instant GPU render
                        } else {
                            // While dragging: use low-res proxy (fast)
                            if (this.isSliderActive) {
                                this.debouncedProxyUpdate();
                            }
                        }
                    });
                    
                    slider.addEventListener('mouseup', () => {
                        // Slider released: render high-res once (only for CPU mode)
                        this.isSliderActive = false;
                        if (!this.webglEnabled) {
                            this.updateImage(false); // Full resolution
                        }
                    });
                    
                    // Handle mouse leaving slider while dragging
                    slider.addEventListener('mouseleave', () => {
                        if (this.isSliderActive) {
                            this.isSliderActive = false;
                            this.updateImage(false); // Full resolution
                        }
                    });
                    
                    // Initialize displays
                    this.updateValueDisplay(slider.id, slider.value);
                });
                
                // Auto buttons
                document.getElementById('autoToneBtn')?.addEventListener('click', () => this.autoTone());
                document.getElementById('autoBtn')?.addEventListener('click', () => this.autoAdjust());
                
                // Debug button for testing
                document.getElementById('debugBtn')?.addEventListener('click', () => this.debugParams());
                
                // Eyedropper buttons
                document.getElementById('blackPointBtn')?.addEventListener('click', () => this.activateEyedropper('black'));
                document.getElementById('grayPointBtn')?.addEventListener('click', () => this.activateEyedropper('gray'));
                document.getElementById('whitePointBtn')?.addEventListener('click', () => this.activateEyedropper('white'));
                document.getElementById('resetEyedroppersBtn')?.addEventListener('click', () => this.resetEyedroppers());
                
                // Reset curves button
                document.getElementById('resetCurvesBtn')?.addEventListener('click', () => this.resetCurves());
                
                // Undo button
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
                    if (e.key === 'c' || e.key === 'C') {
                        if (!e.ctrlKey && !e.metaKey) {
                            e.preventDefault();
                            this.toggleCropMode();
                        }
                    }
                });
                
                // Zoom and rotate controls
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
                
                // Mouse wheel zoom
                const imageContainer = document.getElementById('imageContainer');
                if (imageContainer) {
                    imageContainer.addEventListener('wheel', (e) => {
                        if (e.ctrlKey || e.metaKey) {
                            e.preventDefault();
                            
                            const wrapper = document.getElementById('imageWrapper');
                            const canvas = document.getElementById('webglCanvas');
                            const img = document.getElementById('previewImage');
                            
                            // Determine which element is currently visible
                            const canvasVisible = canvas && canvas.style.display !== 'none';
                            const imgVisible = img && img.style.display !== 'none';
                            const activeElement = canvasVisible ? canvas : (imgVisible ? img : null);
                            if (!wrapper || !activeElement) return;
                            
                            console.log('=== ZOOM DEBUG ===');
                            
                            // Get current scroll position
                            const oldScrollX = imageContainer.scrollLeft;
                            const oldScrollY = imageContainer.scrollTop;
                            console.log('Before zoom - Scroll:', oldScrollX, oldScrollY);
                            
                            // Get container position
                            const containerRect = imageContainer.getBoundingClientRect();
                            console.log('Container rect:', containerRect);
                            
                            // Get image position and size BEFORE zoom
                            const oldRect = activeElement.getBoundingClientRect();
                            console.log('Image rect BEFORE zoom:', oldRect);
                            console.log('Image size BEFORE:', oldRect.width, 'x', oldRect.height);
                            
                            // Mouse position in viewport
                            console.log('Mouse viewport pos:', e.clientX, e.clientY);
                            
                            // Mouse position relative to container viewport
                            const mouseViewportX = e.clientX - containerRect.left;
                            const mouseViewportY = e.clientY - containerRect.top;
                            console.log('Mouse in container viewport:', mouseViewportX, mouseViewportY);
                            
                            // Mouse position relative to image viewport
                            const mouseImgViewportX = e.clientX - oldRect.left;
                            const mouseImgViewportY = e.clientY - oldRect.top;
                            console.log('Mouse in image viewport:', mouseImgViewportX, mouseImgViewportY);
                            
                            // Mouse position within image (0-1 range)
                            const relX = mouseImgViewportX / oldRect.width;
                            const relY = mouseImgViewportY / oldRect.height;
                            console.log('Mouse relative (0-1):', relX, relY);
                            
                            // Apply zoom
                            const oldZoom = this.zoom;
                            if (e.deltaY < 0) {
                                this.zoom = Math.min(this.zoom * 1.1, 20);
                            } else {
                                this.zoom = Math.max(this.zoom / 1.1, 0.1);
                            }
                            
                            console.log('Zoom:', oldZoom, '->', this.zoom);
                            
                            // Only adjust scroll if zoom actually changed
                            if (this.zoom === oldZoom) return;
                            
                            this.applyZoom();
                            
                            // Wait for layout update
                            requestAnimationFrame(() => {
                                console.log('--- AFTER ZOOM ---');
                                
                                // Get image position and size AFTER zoom  
                                const newRect = activeElement.getBoundingClientRect();
                                console.log('Image rect AFTER zoom:', newRect);
                                console.log('Image size AFTER:', newRect.width, 'x', newRect.height);
                                
                                // Get wrapper size (might have grown)
                                const wrapperRect = wrapper.getBoundingClientRect();
                                console.log('Wrapper rect AFTER zoom:', wrapperRect);
                                
                                console.log('Scroll AFTER applyZoom (before adjustment):', imageContainer.scrollLeft, imageContainer.scrollTop);
                                
                                // Where the point is now in the zoomed image (viewport coords)
                                const newPointViewportX = newRect.left + relX * newRect.width;
                                const newPointViewportY = newRect.top + relY * newRect.height;
                                console.log('Point viewport pos AFTER zoom:', newPointViewportX, newPointViewportY);
                                console.log('Target viewport pos (mouse):', e.clientX, e.clientY);
                                
                                // How much to scroll to align point with mouse
                                const scrollDeltaX = newPointViewportX - e.clientX;
                                const scrollDeltaY = newPointViewportY - e.clientY;
                                console.log('Scroll delta needed:', scrollDeltaX, scrollDeltaY);
                                
                                imageContainer.scrollLeft += scrollDeltaX;
                                imageContainer.scrollTop += scrollDeltaY;
                                
                                console.log('Final scroll:', imageContainer.scrollLeft, imageContainer.scrollTop);
                            });
                        }
                    }, { passive: false });
                }
                
                // Crop tool setup
                this.setupCropTool();
                
                // Film stock dropdown
                const filmStock = document.getElementById('filmStock');
                if (filmStock) {
                    filmStock.addEventListener('change', () => {
                        this.debouncedUpdateImage();
                    });
                }
                
                // Film intensity slider
                const filmIntensity = document.getElementById('film_intensity');
                if (filmIntensity) {
                    filmIntensity.addEventListener('input', () => {
                        this.updateValueDisplay('film_intensity', filmIntensity.value);
                        this.debouncedUpdateImage();
                    });
                    this.updateValueDisplay('film_intensity', filmIntensity.value);
                }
            }
            
            setupTabSystem() {
                document.querySelectorAll('.panel-tab').forEach(tab => {
                    tab.addEventListener('click', () => {
                        const tabId = tab.id.replace('Tab', '');
                        this.switchTab(tabId);
                    });
                });
            }
            
            switchTab(tabName) {
                // Update tab buttons
                document.querySelectorAll('.panel-tab').forEach(tab => {
                    tab.classList.remove('active');
                });
                document.getElementById(tabName + 'Tab').classList.add('active');
                
                // Update panels
                document.querySelectorAll('.tab-panel').forEach(panel => {
                    panel.classList.remove('active');
                });
                
                const targetPanel = document.getElementById(tabName + 'Panel');
                if (targetPanel) {
                    targetPanel.classList.add('active');
                }
            }
            
            setupCurves() {
                const canvas = document.getElementById('curvesCanvas');
                const histogramCanvas = document.getElementById('histogramCanvas');
                
                if (!canvas) return;
                
                this.curvesCtx = canvas.getContext('2d');
                this.histogramCtx = histogramCanvas ? histogramCanvas.getContext('2d') : null;
                
                this.drawCurves();
                this.drawHistogram();
                
                // Channel selector buttons
                document.querySelectorAll('.curve-channel-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        document.querySelectorAll('.curve-channel-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        this.currentCurveChannel = btn.dataset.channel;
                        this.drawCurves();
                    });
                });
                
                // Preset buttons
                document.querySelectorAll('.curve-preset-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        this.applyCurvePreset(btn.dataset.preset);
                    });
                });
                
                // Professional curve interaction
                canvas.addEventListener('mousedown', (e) => this.startCurveEdit(e));
                canvas.addEventListener('mousemove', (e) => this.updateCurveEdit(e));
                canvas.addEventListener('mouseup', () => this.endCurveEdit());
                canvas.addEventListener('mouseleave', () => this.endCurveEdit());
                canvas.addEventListener('dblclick', (e) => this.removeCurvePoint(e));
            }
            
            startCurveEdit(e) {
                // Save history before editing curve
                this.saveHistory();
                
                const rect = this.curvesCtx.canvas.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width;
                const y = 1 - (e.clientY - rect.top) / rect.height;
                
                const curve = this.curves[this.currentCurveChannel];
                
                // Find closest point
                let closestIndex = -1;
                let closestDistance = Infinity;
                
                curve.forEach((point, index) => {
                    const distance = Math.sqrt(Math.pow(point.x - x, 2) + Math.pow(point.y - y, 2));
                    if (distance < 0.05 && distance < closestDistance) {
                        closestDistance = distance;
                        closestIndex = index;
                    }
                });
                
                if (closestIndex >= 0) {
                    // Select existing point
                    this.selectedPoint = closestIndex;
                    this.isDragging = true;
                    this.curvesCtx.canvas.style.cursor = 'grabbing';
                } else {
                    // Add new point at click location
                    const insertIndex = curve.findIndex(p => p.x > x);
                    const targetIndex = insertIndex === -1 ? curve.length : insertIndex;
                    
                    // Don't add if too close to existing points
                    const tooClose = curve.some(point => 
                        Math.abs(point.x - x) < 0.03
                    );
                    
                    if (!tooClose && curve.length < 16 && x > 0 && x < 1) {
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
            }
            
            updateCurveEdit(e) {
                if (!this.isDragging || this.selectedPoint < 0) {
                    this.curvesCtx.canvas.style.cursor = 'crosshair';
                    // Update coordinate display
                    const rect = this.curvesCtx.canvas.getBoundingClientRect();
                    const x = (e.clientX - rect.left) / rect.width;
                    const y = 1 - (e.clientY - rect.top) / rect.height;
                    this.updateCurvePointInfo(x, y);
                    return;
                }
                
                const rect = this.curvesCtx.canvas.getBoundingClientRect();
                const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
                
                const curve = this.curves[this.currentCurveChannel];
                
                // Prevent moving endpoint x coordinates
                if (this.selectedPoint === 0) {
                    curve[this.selectedPoint].y = y;
                } else if (this.selectedPoint === curve.length - 1) {
                    curve[this.selectedPoint].y = y;
                } else {
                    // For middle points, constrain x to be between adjacent points
                    const prevX = curve[this.selectedPoint - 1].x;
                    const nextX = curve[this.selectedPoint + 1].x;
                    curve[this.selectedPoint].x = Math.max(prevX + 0.01, Math.min(nextX - 0.01, x));
                    curve[this.selectedPoint].y = y;
                }
                
                this.drawCurves();
                this.updateCurvePointInfo(x, y);
                // Update image in real-time (no debounce for smooth dragging)
                this.updateImage();
            }
            
            endCurveEdit() {
                const wasDragging = this.isDragging;
                console.log('endCurveEdit called, wasDragging:', wasDragging);
                
                // Prevent duplicate calls from mouseup+mouseleave
                if (!this.isDragging && !wasDragging) {
                    console.log('Already ended, ignoring duplicate call');
                    return;
                }
                
                this.isDragging = false;
                this.selectedPoint = -1;
                this.curvesCtx.canvas.style.cursor = 'crosshair';
                document.getElementById('curvePointInfo').textContent = 'Click and drag to edit, double-click to remove points';
                
                // Update image if we were dragging (curve was modified)
                if (wasDragging) {
                    console.log('Curve was modified, calling updateImage()');
                    this.updateImage();
                }
            }
            
            addCurvePoint(e) {
                const rect = this.curvesCtx.canvas.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width;
                const y = 1 - (e.clientY - rect.top) / rect.height;
                
                const curve = this.curves[this.currentCurveChannel];
                
                // Find insertion point to maintain x order
                let insertIndex = curve.length;
                for (let i = 0; i < curve.length; i++) {
                    if (curve[i].x > x) {
                        insertIndex = i;
                        break;
                    }
                }
                
                // Don't add if too close to existing points
                const tooClose = curve.some(point => 
                    Math.abs(point.x - x) < 0.05 && Math.abs(point.y - y) < 0.05
                );
                
                if (!tooClose && curve.length < 16) {
                    curve.splice(insertIndex, 0, { 
                        x: Math.max(0, Math.min(1, x)), 
                        y: Math.max(0, Math.min(1, y)) 
                    });
                    this.drawCurves();
                    this.debouncedUpdateImage();
                }
                
                e.preventDefault();
            }
            
            removeCurvePoint(e) {
                // Save history before removing point
                this.saveHistory();
                
                const rect = this.curvesCtx.canvas.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width;
                const y = 1 - (e.clientY - rect.top) / rect.height;
                
                const curve = this.curves[this.currentCurveChannel];
                
                // Find closest point (excluding endpoints)
                let closestIndex = -1;
                let closestDistance = Infinity;
                
                for (let i = 1; i < curve.length - 1; i++) {
                    const point = curve[i];
                    const distance = Math.sqrt(Math.pow(point.x - x, 2) + Math.pow(point.y - y, 2));
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
            
            applyCurvePreset(preset) {
                const channel = this.currentCurveChannel;
                
                switch(preset) {
                    case 'linear':
                        this.curves[channel] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
                        break;
                    case 'contrast':
                        this.curves[channel] = [
                            { x: 0, y: 0 },
                            { x: 0.25, y: 0.2 },
                            { x: 0.75, y: 0.8 },
                            { x: 1, y: 1 }
                        ];
                        break;
                    case 's-curve':
                        this.curves[channel] = [
                            { x: 0, y: 0 },
                            { x: 0.25, y: 0.15 },
                            { x: 0.5, y: 0.5 },
                            { x: 0.75, y: 0.85 },
                            { x: 1, y: 1 }
                        ];
                        break;
                    case 'film':
                        this.curves[channel] = [
                            { x: 0, y: 0.05 },
                            { x: 0.2, y: 0.18 },
                            { x: 0.5, y: 0.52 },
                            { x: 0.8, y: 0.85 },
                            { x: 1, y: 0.98 }
                        ];
                        break;
                }
                
                this.drawCurves();
                this.debouncedUpdateImage();
            }
            
            drawHistogram() {
                if (!this.histogramCtx || !this.imageHistogram) return;
                
                const ctx = this.histogramCtx;
                const canvas = ctx.canvas;
                
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                
                // Draw histogram bars
                const barWidth = canvas.width / 256;
                const maxHeight = Math.max(...this.imageHistogram);
                
                ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
                
                for (let i = 0; i < 256; i++) {
                    const barHeight = (this.imageHistogram[i] / maxHeight) * canvas.height;
                    ctx.fillRect(i * barWidth, canvas.height - barHeight, barWidth, barHeight);
                }
            }
            
            resetToneCurve() {
                // Reset all curve channels
                this.curves = {
                    rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
                    red: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
                    green: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
                    blue: [{ x: 0, y: 0 }, { x: 1, y: 1 }]
                };
                
                // Reset levels
                document.getElementById('black_level').value = 0;
                document.getElementById('white_level').value = 1;
                document.getElementById('curve_gamma').value = 1;
                document.getElementById('output_black').value = 0;
                document.getElementById('output_white').value = 1;
                
                this.updateValueDisplay('black_level', 0);
                this.updateValueDisplay('white_level', 1);
                this.updateValueDisplay('curve_gamma', 1);
                this.updateValueDisplay('output_black', 0);
                this.updateValueDisplay('output_white', 1);
                
                this.drawCurves();
                this.debouncedUpdateImage();
            }
            
            resetCurves() {
                // Save history before resetting
                this.saveHistory();
                
                // Reset current channel curve to linear
                this.curves[this.currentCurveChannel] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
                this.drawCurves();
                this.debouncedUpdateImage();
            }
            
            drawCurves() {
                if (!this.curvesCtx) return;
                
                const ctx = this.curvesCtx;
                const canvas = ctx.canvas;
                
                // Clear canvas
                ctx.fillStyle = '#242424';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                
                // Draw grid
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
                
                // Draw diagonal reference line
                ctx.strokeStyle = '#555';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(0, canvas.height);
                ctx.lineTo(canvas.width, 0);
                ctx.stroke();
                ctx.setLineDash([]);
                
                // Draw curve for current channel
                const curve = this.curves[this.currentCurveChannel];
                if (curve && curve.length >= 2) {
                    // Set color based on channel
                    const channelColors = {
                        rgb: '#007acc',
                        red: '#ff4444',
                        green: '#00c851',
                        blue: '#4285f4'
                    };
                    
                    ctx.strokeStyle = channelColors[this.currentCurveChannel];
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    
                    // Convert normalized coordinates to canvas coordinates
                    const toCanvasX = (x) => x * canvas.width;
                    const toCanvasY = (y) => (1 - y) * canvas.height;
                    
                    // Draw smooth curve using monotone cubic interpolation
                    ctx.moveTo(toCanvasX(curve[0].x), toCanvasY(curve[0].y));
                    
                    if (curve.length === 2) {
                        // Simple line for 2 points
                        ctx.lineTo(toCanvasX(curve[1].x), toCanvasY(curve[1].y));
                    } else {
                        // Use monotone cubic Hermite spline (same as backend)
                        const interpolated = this.buildMonotoneCubicSpline(curve);
                        
                        // Draw the interpolated curve with many small segments
                        const steps = 200;
                        for (let i = 1; i <= steps; i++) {
                            const x = i / steps;
                            const y = interpolated(x);
                            ctx.lineTo(toCanvasX(x), toCanvasY(y));
                        }
                    }
                    
                    ctx.stroke();
                    
                    // Draw control points
                    curve.forEach((point, index) => {
                        const isSelected = index === this.selectedPoint;
                        const isEndpoint = index === 0 || index === curve.length - 1;
                        
                        ctx.fillStyle = isSelected ? '#ff9500' : channelColors[this.currentCurveChannel];
                        ctx.strokeStyle = isEndpoint ? '#fff' : channelColors[this.currentCurveChannel];
                        ctx.lineWidth = isEndpoint ? 2 : 1;
                        
                        ctx.beginPath();
                        ctx.arc(toCanvasX(point.x), toCanvasY(point.y), isSelected ? 6 : 4, 0, Math.PI * 2);
                        ctx.fill();
                        
                        if (isEndpoint) {
                            ctx.stroke();
                        }
                    });
                }
            }
            
            buildMonotoneCubicSpline(points) {
                // Sort points by x
                const sorted = [...points].sort((a, b) => a.x - b.x);
                const n = sorted.length;
                
                if (n < 2) return (x) => 0;
                if (n === 2) {
                    // Linear interpolation
                    const x0 = sorted[0].x, y0 = sorted[0].y;
                    const x1 = sorted[1].x, y1 = sorted[1].y;
                    const slope = (y1 - y0) / (x1 - x0);
                    return (x) => y0 + slope * (x - x0);
                }
                
                // Extract x and y arrays
                const xs = sorted.map(p => p.x);
                const ys = sorted.map(p => p.y);
                
                // Compute secant slopes
                const dxs = [];
                const dys = [];
                const ms = [];
                for (let i = 0; i < n - 1; i++) {
                    const dx = xs[i + 1] - xs[i];
                    const dy = ys[i + 1] - ys[i];
                    dxs.push(dx);
                    dys.push(dy);
                    ms.push(dy / dx);
                }
                
                // Compute tangents (c1s)
                const c1s = [ms[0]];
                for (let i = 1; i < n - 1; i++) {
                    const mLeft = ms[i - 1];
                    const mRight = ms[i];
                    
                    if (mLeft * mRight <= 0) {
                        c1s.push(0);
                    } else {
                        const dxLeft = dxs[i - 1];
                        const dxRight = dxs[i];
                        const common = dxLeft + dxRight;
                        c1s.push(3 * common / ((common + dxRight) / mLeft + (common + dxLeft) / mRight));
                    }
                }
                c1s.push(ms[n - 2]);
                
                // Apply monotonicity constraints
                for (let i = 0; i < n - 1; i++) {
                    if (Math.abs(ms[i]) < 1e-10) {
                        c1s[i] = 0;
                        c1s[i + 1] = 0;
                    } else {
                        const alpha = c1s[i] / ms[i];
                        const beta = c1s[i + 1] / ms[i];
                        
                        if (alpha * alpha + beta * beta > 9) {
                            const tau = 3 / Math.sqrt(alpha * alpha + beta * beta);
                            c1s[i] = tau * alpha * ms[i];
                            c1s[i + 1] = tau * beta * ms[i];
                        }
                    }
                }
                
                // Compute cubic coefficients
                const c2s = [];
                const c3s = [];
                for (let i = 0; i < n - 1; i++) {
                    const invDx = 1 / dxs[i];
                    const common = c1s[i] + c1s[i + 1] - 2 * ms[i];
                    c2s.push((ms[i] - c1s[i] - common) * invDx);
                    c3s.push(common * invDx * invDx);
                }
                
                // Return interpolation function
                return (x) => {
                    if (x <= xs[0]) return ys[0];
                    if (x >= xs[n - 1]) return ys[n - 1];
                    
                    // Find segment
                    let i = 0;
                    for (let j = 0; j < n - 1; j++) {
                        if (xs[j] <= x && x <= xs[j + 1]) {
                            i = j;
                            break;
                        }
                    }
                    
                    // Evaluate cubic polynomial
                    const dx = x - xs[i];
                    return ys[i] + dx * (c1s[i] + dx * (c2s[i] + dx * c3s[i]));
                };
            }
            
            updateCurvePointInfo(x, y) {
                const info = document.getElementById('curvePointInfo');
                if (info) {
                    info.textContent = `Input: ${(x * 100).toFixed(1)}% → Output: ${(y * 100).toFixed(1)}%`;
                }
            }
            
            updateValueDisplay(sliderId, value) {
                const display = document.getElementById(sliderId + '_value');
                if (display) {
                    const numValue = parseFloat(value);
                    if (sliderId.includes('level')) {
                        display.textContent = numValue.toFixed(3);
                    } else if (sliderId === 'film_intensity' || sliderId === 'film_profile_strength' || 
                              sliderId === 'orange_mask_removal' || sliderId === 'base_fog_removal' ||
                              sliderId === 'grain_simulation' || sliderId === 'halation_effect') {
                        display.textContent = numValue + '%';
                    } else if (sliderId === 'selective_hue_shift') {
                        display.textContent = numValue + '°';
                    } else {
                        display.textContent = numValue % 1 === 0 ? numValue.toString() : numValue.toFixed(2);
                    }
                    
                    // Color-code the display based on value
                    if (numValue > 0) {
                        display.style.color = '#00c851';
                    } else if (numValue < 0) {
                        display.style.color = '#ff4444';
                    } else {
                        display.style.color = '#999';
                    }
                }
            }
            
            debugParams() {
                const params = this.getParameters();
                const colorParams = Object.keys(params).filter(k => 
                    k.includes('shadows') || k.includes('midtones') || k.includes('highlights')
                );
                
                console.log('=== DEBUG PARAMETERS ===');
                console.log(`Total parameters: ${Object.keys(params).length}`);
                console.log('Color parameters:');
                colorParams.forEach(key => {
                    console.log(`  ${key}: ${params[key]}`);
                });
            }
            
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
                const img = document.getElementById('previewImage');
                const container = document.getElementById('imageContainer');
                if (!img || !container) return;
                
                this.zoom = 1.0;
                this.applyZoom(true); // True = actual 1:1 pixels
            }
            
            applyZoom(actualSize = false) {
                const img = document.getElementById('previewImage');
                const canvas = document.getElementById('webglCanvas');
                const wrapper = document.getElementById('imageWrapper');
                const container = document.getElementById('imageContainer');
                if (!wrapper || !container) return;
                
                // Determine which element is currently visible (check display style)
                const canvasVisible = canvas && canvas.style.display !== 'none';
                const imgVisible = img && img.style.display !== 'none';
                
                // Get the active display element based on what's actually visible
                const activeElement = canvasVisible ? canvas : (imgVisible ? img : null);
                if (!activeElement) return;
                
                // Get natural dimensions from the visible element
                const naturalWidth = canvasVisible && this.webglRenderer ? this.webglRenderer.imageWidth : 
                                    (img && img.naturalWidth ? img.naturalWidth : 1);
                const naturalHeight = canvasVisible && this.webglRenderer ? this.webglRenderer.imageHeight : 
                                     (img && img.naturalHeight ? img.naturalHeight : 1);
                
                if (actualSize) {
                    // Show at actual pixel size
                    activeElement.style.width = naturalWidth + 'px';
                    activeElement.style.height = naturalHeight + 'px';
                    activeElement.style.maxWidth = 'none';
                    activeElement.style.maxHeight = 'none';
                    // Make wrapper 3x image size for scroll room
                    wrapper.style.width = (naturalWidth * 3) + 'px';
                    wrapper.style.height = (naturalHeight * 3) + 'px';
                } else if (this.zoom === 1.0) {
                    // Fit to container
                    activeElement.style.width = '';
                    activeElement.style.height = '';
                    activeElement.style.maxWidth = '100%';
                    activeElement.style.maxHeight = '100%';
                    // Wrapper fills container
                    wrapper.style.width = '100%';
                    wrapper.style.height = '100%';
                } else {
                    // Apply zoom - calculate based on fitted size
                    const containerWidth = container.clientWidth;
                    const containerHeight = container.clientHeight;
                    const imgAspect = naturalWidth / naturalHeight;
                    const containerAspect = containerWidth / containerHeight;
                    
                    let fittedWidth, fittedHeight;
                    if (imgAspect > containerAspect) {
                        // Image is wider - fit to width
                        fittedWidth = containerWidth;
                        fittedHeight = containerWidth / imgAspect;
                    } else {
                        // Image is taller - fit to height
                        fittedHeight = containerHeight;
                        fittedWidth = containerHeight * imgAspect;
                    }
                    
                    const zoomedWidth = fittedWidth * this.zoom;
                    const zoomedHeight = fittedHeight * this.zoom;
                    
                    activeElement.style.width = zoomedWidth + 'px';
                    activeElement.style.height = zoomedHeight + 'px';
                    activeElement.style.maxWidth = 'none';
                    activeElement.style.maxHeight = 'none';
                    
                    // Make wrapper 3x zoomed image size to allow scrolling in all directions
                    wrapper.style.width = (zoomedWidth * 3) + 'px';
                    wrapper.style.height = (zoomedHeight * 3) + 'px';
                }
                
                wrapper.style.transform = `rotate(${this.rotation}deg)`;
                
                // Update zoom display
                const zoomPercent = actualSize ? 100 : Math.round(this.zoom * 100);
                document.getElementById('zoomLevel').textContent = zoomPercent + '%';
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
            
            async exportImage() {
                try {
                    // Show loading indicator
                    const exportBtn = document.getElementById('exportBtn');
                    if (exportBtn) {
                        exportBtn.textContent = '⏳ Exporting...';
                        exportBtn.disabled = true;
                    }
                    
                    // Get current parameters
                    const params = this.getParameters();
                    
                    // Request full-quality export from server
                    const response = await fetch('/export', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            ...params,
                            format: 'tiff',  // Request 16-bit TIFF
                            quality: 100
                        })
                    });
                    
                    if (!response.ok) {
                        throw new Error(`Export failed: ${response.status}`);
                    }
                    
                    // Get the blob
                    const blob = await response.blob();
                    const arrayBuffer = await blob.arrayBuffer();
                    
                    // Check if running in Electron
                    if (window.electronAPI) {
                        // Use Electron file save dialog
                        let defaultName = 'processed_image.tif';
                        
                        // If we have original file path, use same directory and name
                        if (this.originalFilePath) {
                            const pathParts = this.originalFilePath.split(/[\\/]/);
                            const fileName = pathParts[pathParts.length - 1];
                            const nameParts = fileName.split('.');
                            nameParts.pop(); // Remove extension
                            defaultName = nameParts.join('.') + '_processed.tif';
                        }
                        
                        const savePath = await window.electronAPI.saveFileDialog(defaultName);
                        
                        if (savePath) {
                            const result = await window.electronAPI.writeFile(savePath, arrayBuffer);
                            if (result.success) {
                                console.log('Export completed successfully to:', savePath);
                                alert('Image exported successfully!');
                            } else {
                                throw new Error(result.error);
                            }
                        }
                    } else {
                        // Fallback to browser download
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `processed_image_${Date.now()}.tif`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        window.URL.revokeObjectURL(url);
                        console.log('Export completed successfully');
                    }
                    
                } catch (error) {
                    console.error('Export error:', error);
                    alert('Failed to export image: ' + error.message);
                } finally {
                    // Restore button
                    const exportBtn = document.getElementById('exportBtn');
                    if (exportBtn) {
                        exportBtn.textContent = '💾 Export';
                        exportBtn.disabled = false;
                    }
                }
            }
            
            setupCropTool() {
                const cropArea = document.getElementById('cropArea');
                const cropOverlay = document.getElementById('cropOverlay');
                
                if (!cropArea || !cropOverlay) return;
                
                let isDragging = false;
                let isResizing = false;
                let resizeHandle = null;
                let startX, startY, startLeft, startTop, startWidth, startHeight;
                
                // Drag crop area
                cropArea.addEventListener('mousedown', (e) => {
                    if (e.target.classList.contains('crop-handle')) {
                        isResizing = true;
                        resizeHandle = e.target.classList[1]; // nw, ne, sw, se
                    } else {
                        isDragging = true;
                    }
                    
                    startX = e.clientX;
                    startY = e.clientY;
                    startLeft = cropArea.offsetLeft;
                    startTop = cropArea.offsetTop;
                    startWidth = cropArea.offsetWidth;
                    startHeight = cropArea.offsetHeight;
                    
                    e.preventDefault();
                });
                
                document.addEventListener('mousemove', (e) => {
                    if (!isDragging && !isResizing) return;
                    
                    const dx = e.clientX - startX;
                    const dy = e.clientY - startY;
                    
                    if (isDragging) {
                        cropArea.style.left = (startLeft + dx) + 'px';
                        cropArea.style.top = (startTop + dy) + 'px';
                    } else if (isResizing) {
                        const img = document.getElementById('previewImage');
                        const maxWidth = img.offsetWidth;
                        const maxHeight = img.offsetHeight;
                        
                        if (resizeHandle.includes('e')) {
                            cropArea.style.width = Math.min(startWidth + dx, maxWidth - startLeft) + 'px';
                        }
                        if (resizeHandle.includes('w')) {
                            const newWidth = Math.max(50, startWidth - dx);
                            cropArea.style.left = (startLeft + dx) + 'px';
                            cropArea.style.width = newWidth + 'px';
                        }
                        if (resizeHandle.includes('s')) {
                            cropArea.style.height = Math.min(startHeight + dy, maxHeight - startTop) + 'px';
                        }
                        if (resizeHandle.includes('n')) {
                            const newHeight = Math.max(50, startHeight - dy);
                            cropArea.style.top = (startTop + dy) + 'px';
                            cropArea.style.height = newHeight + 'px';
                        }
                    }
                });
                
                document.addEventListener('mouseup', () => {
                    isDragging = false;
                    isResizing = false;
                    resizeHandle = null;
                });
            }
            
            toggleCropMode() {
                this.cropMode = !this.cropMode;
                const cropOverlay = document.getElementById('cropOverlay');
                const cropArea = document.getElementById('cropArea');
                const img = document.getElementById('previewImage');
                
                if (this.cropMode) {
                    // Show crop overlay
                    cropOverlay.style.display = 'block';
                    
                    // Initialize crop area to center 80% of image
                    const width = img.offsetWidth * 0.8;
                    const height = img.offsetHeight * 0.8;
                    cropArea.style.width = width + 'px';
                    cropArea.style.height = height + 'px';
                    cropArea.style.left = (img.offsetWidth - width) / 2 + 'px';
                    cropArea.style.top = (img.offsetHeight - height) / 2 + 'px';
                    
                    // Show crop buttons
                    document.getElementById('cropBtn').style.display = 'none';
                    document.getElementById('applyCropBtn').style.display = 'block';
                    document.getElementById('cancelCropBtn').style.display = 'block';
                } else {
                    this.cancelCrop();
                }
            }
            
            async applyCrop() {
                const cropArea = document.getElementById('cropArea');
                const img = document.getElementById('previewImage');
                
                const scaleX = img.naturalWidth / img.offsetWidth;
                const scaleY = img.naturalHeight / img.offsetHeight;
                
                const cropData = {
                    x: parseInt(cropArea.style.left) * scaleX,
                    y: parseInt(cropArea.style.top) * scaleY,
                    width: cropArea.offsetWidth * scaleX,
                    height: cropArea.offsetHeight * scaleY
                };
                
                try {
                    const response = await fetch('/crop', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(cropData)
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        this.currentImage = data.image;
                        this.originalImage = data.image;
                        this.displayImage(data.image);
                        this.cancelCrop();
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
            
            saveHistory() {
                const state = {
                    sliders: {},
                    curves: JSON.parse(JSON.stringify(this.curves)),
                    blackPoint: this.blackPoint ? [...this.blackPoint] : null,
                    whitePoint: this.whitePoint ? [...this.whitePoint] : null,
                    grayPoint: this.grayPoint ? [...this.grayPoint] : null
                };
                
                // Save all slider values
                document.querySelectorAll('.pro-slider').forEach(slider => {
                    state.sliders[slider.id] = parseFloat(slider.value);
                });
                
                // Save toggle states
                const filmCorrectionToggle = document.getElementById('film_correction_basic');
                if (filmCorrectionToggle) {
                    state.filmCorrection = filmCorrectionToggle.classList.contains('active');
                }
                
                this.history.push(state);
                
                // Limit history size
                if (this.history.length > this.maxHistorySize) {
                    this.history.shift();
                }
                
                this.updateUndoButton();
            }
            
            undo() {
                if (this.history.length === 0) return;
                
                const state = this.history.pop();
                
                // Restore slider values
                for (const [id, value] of Object.entries(state.sliders)) {
                    const slider = document.getElementById(id);
                    if (slider) {
                        slider.value = value;
                        this.updateValueDisplay(id, value);
                    }
                }
                
                // Restore curves
                this.curves = JSON.parse(JSON.stringify(state.curves));
                this.drawCurves();
                
                // Restore eyedropper points
                this.blackPoint = state.blackPoint ? [...state.blackPoint] : null;
                this.whitePoint = state.whitePoint ? [...state.whitePoint] : null;
                this.grayPoint = state.grayPoint ? [...state.grayPoint] : null;
                
                // Restore toggle states
                if (state.filmCorrection !== undefined) {
                    const filmCorrectionToggle = document.getElementById('film_correction_basic');
                    if (filmCorrectionToggle) {
                        if (state.filmCorrection) {
                            filmCorrectionToggle.classList.add('active');
                        } else {
                            filmCorrectionToggle.classList.remove('active');
                        }
                    }
                }
                
                this.updateUndoButton();
                this.updateImage();
            }
            
            updateUndoButton() {
                const undoBtn = document.getElementById('undoBtn');
                if (undoBtn) {
                    undoBtn.disabled = this.history.length === 0;
                    undoBtn.style.opacity = this.history.length === 0 ? '0.5' : '1';
                    undoBtn.style.cursor = this.history.length === 0 ? 'not-allowed' : 'pointer';
                }
            }
            
            activateEyedropper(mode) {
                // Deactivate all buttons first
                document.querySelectorAll('.eyedropper-btn').forEach(btn => btn.classList.remove('active'));
                
                const loupe = document.getElementById('eyedropperLoupe');
                
                // If clicking the same mode, deactivate
                if (this.eyedropperMode === mode) {
                    this.eyedropperMode = null;
                    document.getElementById('previewImage').style.cursor = 'pointer';
                    if (loupe) loupe.style.display = 'none';
                } else {
                    this.eyedropperMode = mode;
                    document.getElementById(mode + 'PointBtn').classList.add('active');
                    document.getElementById('previewImage').style.cursor = 'crosshair';
                    // Loupe will show on mousemove
                }
            }
            
            attachCanvasEventListeners() {
                const canvas = document.getElementById('webglCanvas');
                if (canvas) {
                    console.log('Attaching mouse handlers to WebGL canvas');
                    canvas.addEventListener('mousedown', this.handlePreviewMouseDown.bind(this));
                    canvas.addEventListener('mouseup', this.handlePreviewMouseUp.bind(this));
                    canvas.addEventListener('mouseleave', this.handlePreviewMouseLeave.bind(this));
                    canvas.addEventListener('mousemove', this.handlePreviewMouseMove.bind(this));
                } else {
                    console.warn('WebGL canvas not found!');
                }
            }
            
            handlePreviewMouseDown(e) {
                console.log('handlePreviewMouseDown called, eyedropperMode:', this.eyedropperMode, 'webglEnabled:', this.webglEnabled);
                if (this.eyedropperMode) {
                    this.handleEyedropperClick(e);
                } else {
                    // Show original (before) - just set flag to bypass all adjustments
                    this.showingOriginal = true;
                    if (this.webglEnabled && this.webglRenderer) {
                        console.log('Showing original (bypassing all adjustments)');
                        this.webglRenderer.updateParams({
                            showOriginal: true
                        });
                    } else if (this.originalImage) {
                        this.displayImage(this.originalImage);
                    }
                }
            }
            
            handlePreviewMouseUp() {
                if (!this.eyedropperMode && this.showingOriginal) {
                    this.showingOriginal = false;
                    if (this.webglEnabled && this.webglRenderer) {
                        // Re-enable adjustments and update
                        this.webglRenderer.updateParams({ showOriginal: false });
                        this.updateImage();
                    } else if (this.currentImage) {
                        this.displayImage(this.currentImage);
                    }
                }
            }
            
            handlePreviewMouseLeave() {
                // Hide loupe
                const loupe = document.getElementById('eyedropperLoupe');
                if (loupe) loupe.style.display = 'none';
                
                if (!this.eyedropperMode && this.showingOriginal) {
                    this.showingOriginal = false;
                    if (this.webglEnabled && this.webglRenderer) {
                        // Re-enable adjustments and update
                        this.webglRenderer.updateParams({ showOriginal: false });
                        this.updateImage();
                    } else if (this.currentImage) {
                        this.displayImage(this.currentImage);
                    }
                }
            }
            
            handlePreviewMouseMove(e) {
                // Update eyedropper loupe directly (fast path)
                if (this.eyedropperMode) {
                    this.updateEyedropperLoupe(e);
                }
            }
            
            updateEyedropperLoupe(e) {
                const loupe = document.getElementById('eyedropperLoupe');
                if (!loupe) return;
                
                // Show loupe
                loupe.style.display = 'block';
                
                // Position loupe near cursor (offset so it doesn't block the pixel we're selecting)
                const offset = 80; // Distance from cursor
                loupe.style.left = (e.clientX + offset) + 'px';
                loupe.style.top = (e.clientY - offset) + 'px';
                
                // Get the image element (WebGL canvas or regular image)
                const canvas = document.getElementById('webglCanvas');
                const imgElement = canvas && canvas.style.display !== 'none' ? canvas : document.getElementById('previewImage');
                if (!imgElement) return;
                
                // Get mouse position relative to image viewport (displayed size)
                const rect = imgElement.getBoundingClientRect();
                const mouseXDisplay = e.clientX - rect.left;
                const mouseYDisplay = e.clientY - rect.top;
                
                // Check if mouse is within image bounds
                if (mouseXDisplay < 0 || mouseYDisplay < 0 || mouseXDisplay >= rect.width || mouseYDisplay >= rect.height) {
                    loupe.style.display = 'none';
                    return;
                }
                
                // Scale mouse position from display size to actual canvas size
                const scaleX = imgElement.width / rect.width;
                const scaleY = imgElement.height / rect.height;
                const mouseX = mouseXDisplay * scaleX;
                const mouseY = mouseYDisplay * scaleY;
                
                // Draw magnified view
                const loupeCanvas = document.getElementById('loupeCanvas');
                const loupeCtx = loupeCanvas.getContext('2d', { willReadFrequently: true });
                
                // Zoom factor (how much to magnify)
                const loupeSize = 120;
                const zoomFactor = 6;
                const sourceSize = loupeSize / zoomFactor; // Size of area to capture from source (in canvas pixels)
                
                // Clear
                loupeCtx.fillStyle = '#000';
                loupeCtx.fillRect(0, 0, loupeSize, loupeSize);
                
                // Calculate source rectangle on actual canvas
                const srcX = mouseX - sourceSize / 2;
                const srcY = mouseY - sourceSize / 2;
                
                // Draw magnified portion (from canvas to loupe)
                loupeCtx.imageSmoothingEnabled = false; // Pixelated zoom for precise pixel viewing
                try {
                    loupeCtx.drawImage(
                        imgElement,
                        srcX, srcY, sourceSize, sourceSize,  // Source rect in canvas pixels
                        0, 0, loupeSize, loupeSize  // Destination (fill loupe)
                    );
                    
                    // Get pixel color at exact center of loupe
                    const centerPixel = loupeCtx.getImageData(loupeSize / 2, loupeSize / 2, 1, 1).data;
                    const rgbText = document.getElementById('loupeRGB');
                    if (rgbText) {
                        rgbText.textContent = `RGB: ${centerPixel[0]}, ${centerPixel[1]}, ${centerPixel[2]}`;
                    }
                } catch (err) {
                    console.warn('Could not read pixel data for loupe:', err);
                }
            }
            
            async handleEyedropperClick(event) {
                console.log('handleEyedropperClick called, mode:', this.eyedropperMode);
                if (!this.eyedropperMode || !this.currentImage) return;
                
                // Don't process if already processing eyedropper (prevents spam clicks)
                if (this.isProcessing) {
                    console.log('Already processing, ignoring click');
                    return;
                }
                
                // Save history before making change
                this.saveHistory();
                
                // Get pixel color from the loupe (more accurate than trying to read from canvas)
                const loupeCanvas = document.getElementById('loupeCanvas');
                if (!loupeCanvas) {
                    console.warn('Loupe canvas not found');
                    return;
                }
                
                const loupeCtx = loupeCanvas.getContext('2d', { willReadFrequently: true });
                const loupeSize = 120;
                
                try {
                    // Read the exact center pixel of the loupe (what the user sees)
                    const centerPixel = loupeCtx.getImageData(loupeSize / 2, loupeSize / 2, 1, 1).data;
                    const rgb = [centerPixel[0], centerPixel[1], centerPixel[2]];
                    
                    console.log('Eyedropper sampled RGB:', rgb);
                    
                    // Store the point
                    if (this.eyedropperMode === 'black') {
                        this.blackPoint = rgb;
                        console.log('Black point set to:', rgb);
                    } else if (this.eyedropperMode === 'white') {
                        this.whitePoint = rgb;
                        console.log('White point set to:', rgb);
                    } else if (this.eyedropperMode === 'gray') {
                        this.grayPoint = rgb;
                        console.log('Gray point set to:', rgb);
                    }
                    
                    // Keep eyedropper mode active for multiple clicks
                    await this.updateImage();
                } catch (error) {
                    console.error('Error getting pixel value:', error);
                }
            }
            
            updateProcessingStatus(message) {
                const status = document.getElementById('processingStatus');
                if (status) {
                    const timestamp = new Date().toLocaleTimeString();
                    status.innerHTML = `<div>${timestamp}: ${message}</div>`;
                }
            }

            // AI-powered color correction methods
            async runAIAutoCorrect() {
                if (!this.currentImage) {
                    alert('Please upload an image first');
                    return;
                }

                const apiKey = prompt('Enter your OpenAI API key for AI correction:\n(or set OPENAI_API_KEY environment variable)');
                if (!apiKey) {
                    this.updateProcessingStatus('AI correction cancelled - no API key provided');
                    return;
                }

                this.updateProcessingStatus('Running AI auto-correction...');
                
                try {
                    const response = await fetch('/ai-correct', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ api_key: apiKey })
                    });

                    const result = await response.json();

                    if (result.success) {
                        // Update the displayed image
                        const imgElement = document.getElementById('processedImage');
                        if (imgElement) {
                            imgElement.src = 'data:image/jpeg;base64,' + result.image;
                        }

                        // Update the UI controls to reflect the AI suggestions
                        this.updateControlsFromSuggestions(result.suggestions);

                        // Show the reasoning
                        if (result.reasoning && result.reasoning.length > 0) {
                            const reasoningText = result.reasoning.join('\n• ');
                            this.updateProcessingStatus(`AI correction applied (confidence: ${(result.confidence * 100).toFixed(1)}%):\n• ${reasoningText}`);
                        } else {
                            this.updateProcessingStatus(`AI correction applied with ${(result.confidence * 100).toFixed(1)}% confidence`);
                        }

                        console.log('AI Analysis:', result.analysis);
                        console.log('AI Suggestions:', result.suggestions);
                    } else {
                        this.updateProcessingStatus(`AI correction failed: ${result.error}`);
                        alert(`AI correction failed: ${result.error}`);
                    }
                } catch (error) {
                    this.updateProcessingStatus(`AI correction error: ${error.message}`);
                    alert(`AI correction error: ${error.message}`);
                }
            }

            async runAIAnalysis() {
                if (!this.currentImage) {
                    alert('Please upload an image first');
                    return;
                }

                this.updateProcessingStatus('Running AI image analysis...');
                
                try {
                    const response = await fetch('/ai-analyze', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        }
                    });

                    const result = await response.json();

                    if (result.success) {
                        // Display analysis results
                        this.showAIAnalysisResults(result);
                        this.updateProcessingStatus(`AI analysis complete (confidence: ${(result.confidence * 100).toFixed(1)}%)`);
                    } else {
                        this.updateProcessingStatus(`AI analysis failed: ${result.error}`);
                        alert(`AI analysis failed: ${result.error}`);
                    }
                } catch (error) {
                    this.updateProcessingStatus(`AI analysis error: ${error.message}`);
                    alert(`AI analysis error: ${error.message}`);
                }
            }

            updateControlsFromSuggestions(suggestions) {
                // Update sliders and toggles based on AI suggestions
                Object.entries(suggestions).forEach(([param, value]) => {
                    const element = document.getElementById(param);
                    if (element) {
                        if (element.type === 'range') {
                            // Handle slider controls
                            element.value = value;
                            
                            // Update display value
                            const display = document.querySelector(`[data-for="${param}"]`);
                            if (display) {
                                display.textContent = value;
                            }
                        } else if (element.classList.contains('pro-toggle')) {
                            // Handle toggle controls
                            if (value > 0.5) {
                                element.classList.add('active');
                            } else {
                                element.classList.remove('active');
                            }
                        }
                    }
                    
                    // Handle three-way color correction arrays
                    if (param.includes('three_way_') && Array.isArray(value)) {
                        const baseParam = param.replace('three_way_', '');
                        ['red', 'green', 'blue'].forEach((color, index) => {
                            const colorSlider = document.getElementById(`${baseParam}_${color}`);
                            if (colorSlider) {
                                colorSlider.value = value[index];
                                
                                // Update display
                                const display = document.querySelector(`[data-for="${baseParam}_${color}"]`);
                                if (display) {
                                    display.textContent = value[index].toFixed(2);
                                }
                            }
                        });
                    }
                });
            }

            showAIAnalysisResults(result) {
                const analysis = result.analysis;
                const suggestions = result.suggestions;
                
                let analysisText = `AI Image Analysis Results:\n\n`;
                
                // Color cast analysis
                if (analysis.color_cast_analysis && analysis.color_cast_analysis.overall) {
                    const cast = analysis.color_cast_analysis.overall;
                    analysisText += `Color Cast: ${cast.dominant_cast || 'neutral'}\n`;
                    analysisText += `RGB Balance: R:${cast.avg_rgb[0].toFixed(0)} G:${cast.avg_rgb[1].toFixed(0)} B:${cast.avg_rgb[2].toFixed(0)}\n\n`;
                }
                
                // Exposure analysis
                if (analysis.exposure_analysis) {
                    const exp = analysis.exposure_analysis;
                    analysisText += `Exposure Analysis:\n`;
                    analysisText += `Mean Luminance: ${exp.mean_luminance.toFixed(0)}\n`;
                    analysisText += `Dynamic Range: ${exp.dynamic_range.toFixed(0)}\n`;
                    analysisText += `Recommendation: ${exp.exposure_recommendation}\n\n`;
                }
                
                // Skin tone analysis
                if (analysis.skin_tone_analysis && analysis.skin_tone_analysis.skin_detected) {
                    const skin = analysis.skin_tone_analysis;
                    analysisText += `Skin Tones Detected:\n`;
                    analysisText += `Coverage: ${skin.skin_percentage.toFixed(1)}% of image\n`;
                    analysisText += `Naturalness: ${(skin.skin_tone_assessment.naturalness_score * 100).toFixed(0)}%\n\n`;
                }
                
                // Suggestions summary
                analysisText += `AI Suggestions:\n`;
                Object.entries(suggestions).forEach(([param, value]) => {
                    if (param !== 'reasoning' && typeof value === 'number' && Math.abs(value) > 0.01) {
                        analysisText += `${param}: ${value.toFixed(2)}\n`;
                    }
                });
                
                // Show in a modal or alert
                alert(analysisText);
                console.log('Full AI Analysis:', result);
            }
            
            // Professional debouncing for smooth performance
            debounce(func, wait) {
                return (...args) => {
                    // CANCEL any pending debounced call
                    if (this.pendingProxyTimer) {
                        clearTimeout(this.pendingProxyTimer);
                    }
                    // Schedule new call
                    this.pendingProxyTimer = setTimeout(() => {
                        this.pendingProxyTimer = null;
                        func(...args);
                    }, wait);
                };
            }
            
            hasCurveEdits() {
                // Check if any curve has been modified from default (straight line with just 2 points)
                return this.curves && (
                    this.curves.rgb.length > 2 || 
                    this.curves.red.length > 2 || 
                    this.curves.green.length > 2 || 
                    this.curves.blue.length > 2
                );
            }
            
            getParameters(fullResolution = false) {
                const params = {};
                
                // No preview mode - always full resolution
                
                // Get all slider values
                document.querySelectorAll('.pro-slider').forEach(slider => {
                    let value = parseFloat(slider.value);
                    params[slider.id] = value;
                });
                
                // Add toggle parameters (film correction)
                const filmCorrectionToggle = document.getElementById('film_correction_basic');
                if (filmCorrectionToggle) {
                    params['film_correction'] = filmCorrectionToggle.classList.contains('active') ? 1.0 : 0.0;
                }
                
                // Add eyedropper points if set
                if (this.blackPoint) {
                    params['black_point_r'] = this.blackPoint[0];
                    params['black_point_g'] = this.blackPoint[1];
                    params['black_point_b'] = this.blackPoint[2];
                }
                if (this.whitePoint) {
                    params['white_point_r'] = this.whitePoint[0];
                    params['white_point_g'] = this.whitePoint[1];
                    params['white_point_b'] = this.whitePoint[2];
                }
                if (this.grayPoint) {
                    params['gray_point_r'] = this.grayPoint[0];
                    params['gray_point_g'] = this.grayPoint[1];
                    params['gray_point_b'] = this.grayPoint[2];
                }
                
                // Add curves data
                params['curves'] = JSON.stringify(this.curves);
                
                return params;
            }
            
            async saveSettings() {
                if (!this.currentImage) {
                    alert('No image loaded');
                    return;
                }
                
                const params = this.getParameters();
                const json = JSON.stringify(params, null, 2);
                
                // Generate default filename
                let defaultName = 'image_settings.json';
                if (this.originalFilePath) {
                    const pathParts = this.originalFilePath.replace(/\\/g, '/').split('/');
                    const filename = pathParts[pathParts.length - 1];
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
                    // Browser fallback - download as file
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
                    // Generate settings file path (same directory, _settings.json suffix)
                    const pathParts = imagePath.replace(/\\/g, '/').split('/');
                    const filename = pathParts[pathParts.length - 1];
                    const baseName = filename.substring(0, filename.lastIndexOf('.')) || filename;
                    const directory = pathParts.slice(0, -1).join('/');
                    const settingsPath = directory + '/' + baseName + '_settings.json';
                    
                    // Try to read settings file
                    const jsonData = await window.electronAPI.readFile(settingsPath);
                    if (jsonData.success) {
                        const params = JSON.parse(jsonData.content);
                        this.applySettings(params);
                        this.updateProcessingStatus('Settings auto-loaded');
                        setTimeout(() => this.updateProcessingStatus(''), 2000);
                        console.log('Auto-loaded settings from:', settingsPath);
                    }
                } catch (e) {
                    // Settings file doesn't exist or couldn't be read - that's fine
                    console.log('No settings file found (this is normal for new images)');
                }
            }
            
            async loadSettings() {
                if (window.electronAPI) {
                    const result = await window.electronAPI.openFileDialog();
                    if (result && result.filePath) {
                        const jsonData = await window.electronAPI.readFile(result.filePath);
                        if (jsonData.success) {
                            const params = JSON.parse(jsonData.content);
                            this.applySettings(params);
                            this.updateProcessingStatus('Settings loaded');
                            setTimeout(() => this.updateProcessingStatus(''), 2000);
                        } else {
                            alert('Failed to load settings: ' + jsonData.error);
                        }
                    }
                } else {
                    // Browser fallback - file input
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = '.json';
                    input.onchange = async (e) => {
                        const file = e.target.files[0];
                        if (file) {
                            const text = await file.text();
                            const params = JSON.parse(text);
                            this.applySettings(params);
                        }
                    };
                    input.click();
                }
            }
            
            applySettings(params) {
                console.log('Applying settings:', params);
                
                // Apply slider values (sliders use id, not data-param)
                Object.keys(params).forEach(key => {
                    const slider = document.getElementById(key);
                    if (slider && slider.classList.contains('pro-slider')) {
                        slider.value = params[key];
                        // Update value display
                        const valueDisplay = document.getElementById(key + '_value');
                        if (valueDisplay) {
                            valueDisplay.textContent = parseFloat(params[key]).toFixed(2);
                        }
                    }
                });
                
                // Apply film correction toggle
                if (params.hasOwnProperty('film_correction')) {
                    const toggle = document.getElementById('filmCorrectionToggle');
                    if (toggle) {
                        toggle.checked = params.film_correction === 1.0;
                    }
                }
                
                // Apply eyedropper points (reconstruct arrays from individual r/g/b values)
                if (params.black_point_r !== undefined && params.black_point_g !== undefined && params.black_point_b !== undefined) {
                    this.blackPoint = [params.black_point_r, params.black_point_g, params.black_point_b];
                }
                if (params.white_point_r !== undefined && params.white_point_g !== undefined && params.white_point_b !== undefined) {
                    this.whitePoint = [params.white_point_r, params.white_point_g, params.white_point_b];
                }
                if (params.gray_point_r !== undefined && params.gray_point_g !== undefined && params.gray_point_b !== undefined) {
                    this.grayPoint = [params.gray_point_r, params.gray_point_g, params.gray_point_b];
                }
                
                // Apply curves
                if (params.curves) {
                    try {
                        const curvesData = typeof params.curves === 'string' ? 
                            JSON.parse(params.curves) : params.curves;
                        this.curves = curvesData;
                        
                        // Redraw curve UI
                        this.drawCurves();
                    } catch (e) {
                        console.error('Failed to parse curves:', e);
                    }
                }
                
                // Update image with new settings
                this.updateImage();
            }
            
            // Essential missing methods for file upload and image processing
            async handleFileUpload(file) {
                if (!file) return;
                
                this.updateProcessingStatus('Uploading image...');
                
                // Store file path if running in Electron
                if (file.path) {
                    this.originalFilePath = file.path;
                }
                
                const formData = new FormData();
                formData.append('image', file);
                formData.append('is_negative', currentImageMode === 'negative' ? 'true' : 'false');
                
                try {
                    const response = await fetch('/upload', {
                        method: 'POST',
                        body: formData
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        this.currentImage = result.image;
                        this.originalImage = result.image; // Store original
                        
                        // Try to initialize WebGL renderer for instant updates
                        await this.initializeWebGL();
                        
                        // If WebGL succeeded, use it; otherwise fall back to JPEG
                        if (!this.webglEnabled) {
                            this.displayImage(result.image);
                        }
                        
                        this.updateProcessingStatus('Image uploaded successfully' + 
                            (this.webglEnabled ? ' [WebGL GPU]' : ' [CPU]'));
                        
                        // Initialize film type dropdown
                        this.initializeFilmTypes();
                        
                        // Auto-load settings if they exist
                        if (file.path && window.electronAPI) {
                            await this.autoLoadSettings(file.path);
                        }
                    } else {
                        this.updateProcessingStatus('Upload failed: ' + result.error);
                        console.error('Upload failed:', result.error);
                    }
                } catch (error) {
                    this.updateProcessingStatus('Upload failed: ' + error.message);
                    console.error('Upload error:', error);
                }
            }
            
            async initializeWebGL() {
                try {
                    // Create WebGL renderer if not already created
                    if (!this.webglRenderer) {
                        console.log('Initializing WebGL GPU renderer...');
                        this.webglRenderer = new WebGLRenderer('webglCanvas');
                    }
                    
                    // Load raw image data into GPU
                    const success = await this.webglRenderer.loadImage('/get_raw_image');
                    
                    if (success) {
                        this.webglEnabled = true;
                        
                        // Show WebGL canvas, hide JPEG image
                        document.getElementById('webglCanvas').style.display = 'block';
                        document.getElementById('previewImage').style.display = 'none';
                        
                        // NOW attach event listeners to the WebGL canvas (it exists now!)
                        this.attachCanvasEventListeners();
                        
                        console.log('WebGL GPU rendering enabled - instant slider updates!');
                        return true;
                    } else {
                        throw new Error('WebGL initialization failed');
                    }
                } catch (e) {
                    console.warn('WebGL not available, falling back to server-side rendering:', e);
                    this.webglEnabled = false;
                    
                    // Show JPEG image, hide WebGL canvas
                    document.getElementById('webglCanvas').style.display = 'none';
                    document.getElementById('previewImage').style.display = 'block';
                    
                    return false;
                }
            }
            
            async updateImage(useProxy = false) {
                if (!this.currentImage) return;
                
                // INSTANT WebGL UPDATE - now supports eyedropper AND sliders!
                if (this.webglEnabled && this.webglRenderer) {
                    // Get current parameters
                    const params = this.getParameters();
                    
                    console.log('WebGL update with params:', params);
                    
                    // Update WebGL shader uniforms (instant, no server round-trip!)
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
                        clarity: params.clarity || 0,
                        vibrance: params.vibrance || 0,
                        // Eyedropper points (convert from 0-255 to 0-1)
                        blackPoint: this.blackPoint ? [
                            this.blackPoint[0] / 255.0,
                            this.blackPoint[1] / 255.0,
                            this.blackPoint[2] / 255.0
                        ] : [0, 0, 0],
                        whitePoint: this.whitePoint ? [
                            this.whitePoint[0] / 255.0,
                            this.whitePoint[1] / 255.0,
                            this.whitePoint[2] / 255.0
                        ] : [1, 1, 1],
                        grayPoint: this.grayPoint ? [
                            this.grayPoint[0] / 255.0,
                            this.grayPoint[1] / 255.0,
                            this.grayPoint[2] / 255.0
                        ] : [0.5, 0.5, 0.5],
                        hasBlackPoint: !!this.blackPoint,
                        hasWhitePoint: !!this.whitePoint,
                        hasGrayPoint: !!this.grayPoint,
                        // Curves data (pass as JSON string for caching)
                        curves: params.curves
                    });
                    
                    // Hide the regular img element, show WebGL canvas
                    const previewImage = document.getElementById('previewImage');
                    const webglCanvas = document.getElementById('webglCanvas');
                    if (previewImage) previewImage.style.display = 'none';
                    if (webglCanvas) webglCanvas.style.display = 'block';
                    
                    this.updateProcessingStatus('GPU Rendering [WebGL]');
                    
                    // Everything is now instant on GPU - no server needed!
                    return;
                }
                
                // FALLBACK: Server-side rendering (old way)
                // KILL any old processing - always process the latest slider position!
                if (this.pendingProxyTimer) {
                    clearTimeout(this.pendingProxyTimer);
                    this.pendingProxyTimer = null;
                }
                if (this.currentRequest) {
                    this.currentRequest.abort();  // Kill in-progress request
                }
                if (this.isProcessing) {
                    console.log('Aborting old request, processing latest position');
                }
                
                // Create new AbortController for this request
                this.currentRequest = new AbortController();
                
                this.isProcessing = true;
                this.updateProcessingStatus(useProxy ? 'Proxy preview...' : 'Processing full-res...');
                
                try {
                    const params = this.getParameters();
                    // PROXY FLAG: true = low-res proxy, false = full resolution
                    params.use_proxy = useProxy;
                    
                    const response = await fetch('/process', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(params),
                        signal: this.currentRequest.signal // Pass abort signal
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        this.currentImage = result.image; // Update current processed image
                        this.displayImage(result.image);
                        this.updateProcessingStatus('Processing complete');
                    } else {
                        this.updateProcessingStatus('Processing failed: ' + result.error);
                        console.error('Processing failed:', result.error);
                    }
                } catch (error) {
                    // Don't show error if request was aborted (we cancelled it ourselves)
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
                
                if (previewImage) {
                    const newSrc = 'data:image/jpeg;base64,' + base64Image;
                    
                    // Preload image to prevent flashing
                    const tempImg = new Image();
                    tempImg.onload = () => {
                        previewImage.src = newSrc;
                        previewImage.style.display = 'block';
                        // Hide WebGL canvas when showing server-rendered image
                        if (webglCanvas) webglCanvas.style.display = 'none';
                    };
                    tempImg.src = newSrc;
                }
            }
            
            initializeFilmTypes() {
                const filmType = document.getElementById('filmType');
                if (filmType && filmType.children.length === 0) {
                    const filmTypes = [
                        { value: 'none', label: 'No Film Emulation' },
                        { value: 'kodak_portra_400', label: 'Kodak Portra 400' },
                        { value: 'kodak_portra_800', label: 'Kodak Portra 800' },
                        { value: 'fuji_pro_400h', label: 'Fuji Pro 400H' },
                        { value: 'fuji_superia_400', label: 'Fuji Superia 400' },
                        { value: 'kodak_tri_x', label: 'Kodak Tri-X (B&W)' },
                        { value: 'ilford_hp5', label: 'Ilford HP5 (B&W)' },
                        { value: 'kodak_ektar_100', label: 'Kodak Ektar 100' },
                        { value: 'fuji_velvia_50', label: 'Fuji Velvia 50' }
                    ];
                    
                    filmTypes.forEach(film => {
                        const option = document.createElement('option');
                        option.value = film.value;
                        option.textContent = film.label;
                        filmType.appendChild(option);
                    });
                }
            }
            
            addAdjustmentLayer(type) {
                const newLayer = {
                    id: 'layer_' + Date.now(),
                    name: type + ' Layer',
                    type: type.toLowerCase(),
                    opacity: 100,
                    blendMode: 'normal',
                    visible: true
                };
                
                this.layers.push(newLayer);
                this.updateLayersPanel();
                this.debouncedUpdateImage();
            }
            
            updateLayersPanel() {
                const layersList = document.querySelector('.layers-list');
                if (!layersList) return;
                
                layersList.innerHTML = '';
                
                // Add background layer
                const backgroundLayer = document.createElement('div');
                backgroundLayer.className = 'layer-item';
                backgroundLayer.innerHTML = `
                    <div class="layer-preview"></div>
                    <span class="layer-name">Background</span>
                    <input type="range" class="layer-opacity" min="0" max="100" value="100" disabled>
                `;
                layersList.appendChild(backgroundLayer);
                
                // Add adjustment layers
                this.layers.forEach((layer, index) => {
                    const layerElement = document.createElement('div');
                    layerElement.className = 'layer-item';
                    layerElement.innerHTML = `
                        <div class="layer-preview"></div>
                        <span class="layer-name">${layer.name}</span>
                        <input type="range" class="layer-opacity" min="0" max="100" value="${layer.opacity}"
                               onchange="processor.updateLayerOpacity('${layer.id}', this.value)">
                        <select class="layer-blend" onchange="processor.updateLayerBlendMode('${layer.id}', this.value)">
                            <option value="normal" ${layer.blendMode === 'normal' ? 'selected' : ''}>Normal</option>
                            <option value="multiply" ${layer.blendMode === 'multiply' ? 'selected' : ''}>Multiply</option>
                            <option value="screen" ${layer.blendMode === 'screen' ? 'selected' : ''}>Screen</option>
                            <option value="overlay" ${layer.blendMode === 'overlay' ? 'selected' : ''}>Overlay</option>
                            <option value="soft-light" ${layer.blendMode === 'soft-light' ? 'selected' : ''}>Soft Light</option>
                            <option value="hard-light" ${layer.blendMode === 'hard-light' ? 'selected' : ''}>Hard Light</option>
                            <option value="color-dodge" ${layer.blendMode === 'color-dodge' ? 'selected' : ''}>Color Dodge</option>
                            <option value="color-burn" ${layer.blendMode === 'color-burn' ? 'selected' : ''}>Color Burn</option>
                            <option value="darken" ${layer.blendMode === 'darken' ? 'selected' : ''}>Darken</option>
                            <option value="lighten" ${layer.blendMode === 'lighten' ? 'selected' : ''}>Lighten</option>
                            <option value="difference" ${layer.blendMode === 'difference' ? 'selected' : ''}>Difference</option>
                            <option value="exclusion" ${layer.blendMode === 'exclusion' ? 'selected' : ''}>Exclusion</option>
                        </select>
                        <button class="layer-delete" onclick="processor.deleteLayer('${layer.id}')">🗑️</button>
                    `;
                    layersList.appendChild(layerElement);
                });
            }
            
            updateLayerOpacity(layerId, opacity) {
                const layer = this.layers.find(l => l.id === layerId);
                if (layer) {
                    layer.opacity = parseInt(opacity);
                    this.debouncedUpdateImage();
                }
            }
            
            updateLayerBlendMode(layerId, blendMode) {
                const layer = this.layers.find(l => l.id === layerId);
                if (layer) {
                    layer.blendMode = blendMode;
                    this.debouncedUpdateImage();
                }
            }
            
            deleteLayer(layerId) {
                this.layers = this.layers.filter(l => l.id !== layerId);
                this.updateLayersPanel();
                this.debouncedUpdateImage();
            }
        }

        // Toggle control function for auto adjustment switches
        function toggleControl(controlId) {
            const toggle = document.getElementById(controlId);
            const isActive = toggle.classList.contains('active');
            
            if (isActive) {
                toggle.classList.remove('active');
            } else {
                toggle.classList.add('active');
            }
            
            // Synchronize film correction toggles
            if (controlId === 'film_correction' || controlId === 'film_correction_basic') {
                const basicToggle = document.getElementById('film_correction_basic');
                const advancedToggle = document.getElementById('film_correction');
                
                if (controlId === 'film_correction_basic' && basicToggle) {
                    // Sync advanced toggle with basic
                    if (advancedToggle) {
                        if (basicToggle.classList.contains('active')) {
                            advancedToggle.classList.add('active');
                        } else {
                            advancedToggle.classList.remove('active');
                        }
                    }
                } else if (controlId === 'film_correction' && advancedToggle) {
                    // Sync basic toggle with advanced
                    if (basicToggle) {
                        if (advancedToggle.classList.contains('active')) {
                            basicToggle.classList.add('active');
                        } else {
                            basicToggle.classList.remove('active');
                        }
                    }
                }
            }
            
            // Synchronize auto levels toggles
            if (controlId === 'auto_levels' || controlId === 'auto_levels_basic') {
                const basicToggle = document.getElementById('auto_levels_basic');
                const advancedToggle = document.getElementById('auto_levels');
                
                if (controlId === 'auto_levels_basic' && basicToggle) {
                    if (advancedToggle) {
                        if (basicToggle.classList.contains('active')) {
                            advancedToggle.classList.add('active');
                        } else {
                            advancedToggle.classList.remove('active');
                        }
                    }
                } else if (controlId === 'auto_levels' && advancedToggle) {
                    if (basicToggle) {
                        if (advancedToggle.classList.contains('active')) {
                            basicToggle.classList.add('active');
                        } else {
                            basicToggle.classList.remove('active');
                        }
                    }
                }
            }
            
            // Synchronize auto white balance toggles
            if (controlId === 'auto_white_balance' || controlId === 'auto_white_balance_basic') {
                const basicToggle = document.getElementById('auto_white_balance_basic');
                const advancedToggle = document.getElementById('auto_white_balance');
                
                if (controlId === 'auto_white_balance_basic' && basicToggle) {
                    if (advancedToggle) {
                        if (basicToggle.classList.contains('active')) {
                            advancedToggle.classList.add('active');
                        } else {
                            advancedToggle.classList.remove('active');
                        }
                    }
                } else if (controlId === 'auto_white_balance' && advancedToggle) {
                    if (basicToggle) {
                        if (advancedToggle.classList.contains('active')) {
                            basicToggle.classList.add('active');
                        } else {
                            basicToggle.classList.remove('active');
                        }
                    }
                }
            }
            
            // Update the processor if it exists
            if (processor) {
                processor.debouncedUpdateImage();
            }
        }
        
        // Apply professional presets
        function applyPreset(presetName) {
            if (!processor) return;
            
            const presets = {
                'portrait_natural': {
                    exposure: 0.2,
                    contrast: 10,
                    highlight_recovery: -15,
                    shadow_recovery: 15,
                    temperature: 5,
                    vibrance: 15
                },
                'portrait_warm': {
                    exposure: 0.3,
                    contrast: 15,
                    temperature: 20,
                    tint: 5,
                    vibrance: 20,
                    clarity: 10
                },
                'landscape_vivid': {
                    exposure: 0,
                    contrast: 25,
                    vibrance: 30,
                    saturation: 15,
                    clarity: 20,
                    dehaze: 10
                },
                'vintage_film': {
                    exposure: -0.2,
                    contrast: -10,
                    highlight_recovery: -25,
                    temperature: 15,
                    saturation: -15,
                    grain_simulation: 40
                },
                'high_contrast_bw': {
                    contrast: 40,
                    clarity: 35,
                    saturation: -100,
                    blacks: -20,
                    whites: 20
                }
            };
            
            const preset = presets[presetName];
            if (preset) {
                Object.keys(preset).forEach(param => {
                    const slider = document.getElementById(param);
                    if (slider) {
                        slider.value = preset[param];
                        processor.updateValueDisplay(param, preset[param]);
                    }
                });
                processor.debouncedUpdateImage();
            }
        }
        
        // Toggle section visibility
        function toggleSection(sectionId) {
            const section = document.getElementById(sectionId);
            if (section) {
                if (section.style.display === 'none') {
                    section.style.display = 'block';
                } else {
                    section.style.display = 'none';
                }
            }
        }
        
        // Layer management functions
        function addAdjustmentLayer(type) {
            if (processor) {
                processor.addAdjustmentLayer(type);
            }
        }
        
        function addNewLayer() {
            // Show layer type selection
            const layerTypes = ['Curves', 'Levels', 'Color Balance', 'Hue/Saturation'];
            const selectedType = prompt('Select layer type:\n' + layerTypes.map((type, i) => `${i + 1}. ${type}`).join('\n'));
            
            if (selectedType && layerTypes[parseInt(selectedType) - 1]) {
                addAdjustmentLayer(layerTypes[parseInt(selectedType) - 1]);
            }
        }

        // Initialize the professional processor when page loads
        let processor;
        
        document.addEventListener('DOMContentLoaded', () => {
            processor = new ProfessionalFilmProcessor();
        });

// Image mode management - Global function
let currentImageMode = 'negative'; // default to negative mode

function switchImageMode(mode) {
    currentImageMode = mode;
    const body = document.body;
    const photoBtn = document.getElementById('modePhoto');
    const negativeBtn = document.getElementById('modeNegative');
    const uploadText = document.getElementById('uploadText');
    const uploadBtn = document.getElementById('uploadBtn');
    
    // Update body class
    body.classList.remove('photo-mode', 'negative-mode');
    body.classList.add(mode + '-mode');
    
    // Update button states
    photoBtn.classList.toggle('active', mode === 'photo');
    negativeBtn.classList.toggle('active', mode === 'negative');
    
    // Update upload text
    if (mode === 'photo') {
        uploadText.textContent = 'Drag & drop your photo here';
        uploadBtn.textContent = 'Select Photo';
    } else {
        uploadText.textContent = 'Drag & drop your film negative here';
        uploadBtn.textContent = 'Select Film Negative';
    }
    
    // Disable film correction when in photo mode
    if (mode === 'photo') {
        const filmCorrectionBasic = document.getElementById('film_correction_basic');
        const filmCorrection = document.getElementById('film_correction');
        if (filmCorrectionBasic && filmCorrectionBasic.classList.contains('active')) {
            filmCorrectionBasic.classList.remove('active');
        }
        if (filmCorrection && filmCorrection.classList.contains('active')) {
            filmCorrection.classList.remove('active');
        }
    }
    
    // Update image if one is loaded
    if (typeof processor !== 'undefined' && processor && processor.currentImage) {
        processor.debouncedUpdateImage();
    }
    
    console.log('Switched to ' + mode + ' mode');
}

// Initialize with negative mode on page load
window.addEventListener('DOMContentLoaded', function() {
    setTimeout(function() {
        switchImageMode('negative');
    }, 100);
});
