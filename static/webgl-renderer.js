// WebGL GPU Renderer for Real-Time Image Processing
// Eliminates GPU→CPU transfer lag by processing entirely on client GPU

// Monotone cubic Hermite spline (Fritsch-Carlson). This is the single curve
// interpolation used everywhere: the curve editor's drawn line (app.js), the
// shader's lookup textures (below), and the server's export LUT
// (film_processing._build_curve_lut) all implement this same algorithm.
function buildMonotoneCubicSpline(points) {
    const sorted = [...points].sort((a, b) => a.x - b.x);
    const n = sorted.length;

    if (n < 2) return () => 0;
    if (n === 2) {
        const x0 = sorted[0].x, y0 = sorted[0].y;
        const slope = (sorted[1].y - y0) / (sorted[1].x - x0);
        return (x) => y0 + slope * (x - x0);
    }

    const xs = sorted.map(p => p.x);
    const ys = sorted.map(p => p.y);

    // Secant slopes
    const dxs = [];
    const ms = [];
    for (let i = 0; i < n - 1; i++) {
        const dx = xs[i + 1] - xs[i];
        dxs.push(dx);
        ms.push((ys[i + 1] - ys[i]) / dx);
    }

    // Tangents
    const c1s = [ms[0]];
    for (let i = 1; i < n - 1; i++) {
        const mLeft = ms[i - 1];
        const mRight = ms[i];
        if (mLeft * mRight <= 0) {
            c1s.push(0);
        } else {
            const common = dxs[i - 1] + dxs[i];
            c1s.push(3 * common / ((common + dxs[i]) / mLeft + (common + dxs[i - 1]) / mRight));
        }
    }
    c1s.push(ms[n - 2]);

    // Monotonicity constraints
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

    // Cubic coefficients per segment
    const c2s = [];
    const c3s = [];
    for (let i = 0; i < n - 1; i++) {
        const invDx = 1 / dxs[i];
        const common = c1s[i] + c1s[i + 1] - 2 * ms[i];
        c2s.push((ms[i] - c1s[i] - common) * invDx);
        c3s.push(common * invDx * invDx);
    }

    return (x) => {
        if (x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];

        let i = 0;
        for (let j = 0; j < n - 1; j++) {
            if (xs[j] <= x && x <= xs[j + 1]) {
                i = j;
                break;
            }
        }

        const dx = x - xs[i];
        return ys[i] + dx * (c1s[i] + dx * (c2s[i] + dx * c3s[i]));
    };
}

class WebGLRenderer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            console.error('WebGL canvas not found:', canvasId);
            return;
        }
        
        this.gl = null;
        this.program = null;
        this.texture = null;
        this.curveTextureRgb = null;
        this.curveTextureRed = null;
        this.curveTextureGreen = null;
        this.curveTextureBlue = null;
        this.imageWidth = 0;
        this.imageHeight = 0;
        this.imageData = null;
        this.lastCurvesJSON = null; // Cache for curve change detection
        
        // Adjustment parameters (passed as uniforms to shader)
        this.params = {
            showOriginal: false,  // Bypass all adjustments when true
            exposure: 0.0,
            contrast: 0.0,
            brightness: 0.0,
            saturation: 0.0,
            temperature: 0.0,
            tint: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            red: 0.0,
            green: 0.0,
            blue: 0.0,
            clarity: 0.0,
            vibrance: 0.0,
            // Eyedropper levels
            blackPoint: [0, 0, 0],
            whitePoint: [1, 1, 1],
            grayPoint: [0.5, 0.5, 0.5],
            hasBlackPoint: false,
            hasWhitePoint: false,
            hasGrayPoint: false,
            // Curves (will be uploaded as 1D textures)
            curvesRgb: null,
            curvesRed: null,
            curvesGreen: null,
            curvesBlue: null
        };
        
        this.initWebGL();
    }
    
    initWebGL() {
        try {
            // Request WebGL context with optimal settings for quality
            const contextAttributes = {
                alpha: true,
                depth: false,
                stencil: false,
                antialias: false,  // We do our own filtering
                premultipliedAlpha: false,  // Preserve color precision
                preserveDrawingBuffer: true,  // Keep buffer for screenshots/export
                powerPreference: 'high-performance'  // Use dedicated GPU if available
            };
            
            this.gl = this.canvas.getContext('webgl2', contextAttributes) || 
                      this.canvas.getContext('webgl', contextAttributes);
            if (!this.gl) {
                console.error('WebGL not supported');
                return false;
            }
            
            console.log('WebGL version:', this.gl.getParameter(this.gl.VERSION));
            console.log('GLSL version:', this.gl.getParameter(this.gl.SHADING_LANGUAGE_VERSION));
            
            // Enable float texture extension for full 16-bit→float32 precision
            const floatExt = this.gl.getExtension('OES_texture_float') || 
                             this.gl.getExtension('OES_texture_half_float');
            if (!floatExt) {
                console.warn('Float textures not supported, quality may be reduced');
            } else {
                console.log('Float texture support:', floatExt.constructor.name);
            }
            
            // Enable float color buffer for higher precision framebuffer (WebGL 2)
            const colorBufferFloat = this.gl.getExtension('EXT_color_buffer_float');
            if (colorBufferFloat) {
                console.log('Float color buffer supported (higher precision rendering)');
            }
            
            // Enable anisotropic filtering for better texture quality
            const anisotropicExt = this.gl.getExtension('EXT_texture_filter_anisotropic') ||
                                   this.gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
            if (anisotropicExt) {
                this.maxAnisotropy = this.gl.getParameter(anisotropicExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
                console.log('Anisotropic filtering available, max:', this.maxAnisotropy);
                this.anisotropicExt = anisotropicExt;
            }
            
            console.log('WebGL initialized successfully');
            
            // Create shader program
            this.program = this.createProgram(this.vertexShaderSource, this.fragmentShaderSource);
            if (!this.program) {
                console.error('Failed to create shader program');
                return false;
            }
            
            // Set up geometry (full-screen quad)
            this.setupGeometry();
            
            return true;
        } catch (e) {
            console.error('WebGL initialization error:', e);
            return false;
        }
    }
    
    // Vertex shader (simple pass-through)
    get vertexShaderSource() {
        return `
            precision highp float;  // Maximum precision in vertex shader too
            
            attribute vec2 a_position;
            attribute vec2 a_texCoord;
            varying highp vec2 v_texCoord;  // Ensure highp for texture coordinates
            
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                v_texCoord = a_texCoord;
            }
        `;
    }
    
    // Fragment shader (all image processing happens here on GPU)
    get fragmentShaderSource() {
        return `
            precision highp float;
            
            uniform sampler2D u_image;
            uniform float u_showOriginal;  // Bypass all adjustments when 1.0
            uniform float u_exposure;
            uniform float u_contrast;
            uniform float u_brightness;
            uniform float u_saturation;
            uniform float u_temperature;
            uniform float u_tint;
            uniform float u_highlights;
            uniform float u_shadows;
            uniform float u_whites;
            uniform float u_blacks;
            uniform float u_red;
            uniform float u_green;
            uniform float u_blue;
            uniform float u_clarity;
            uniform float u_vibrance;
            
            // Eyedropper levels adjustment
            uniform vec3 u_blackPoint;   // RGB black point (0-1)
            uniform vec3 u_whitePoint;   // RGB white point (0-1)
            uniform vec3 u_grayPoint;    // RGB gray point (0-1)
            uniform float u_hasBlackPoint;
            uniform float u_hasWhitePoint;
            uniform float u_hasGrayPoint;
            
            // Curve lookup textures (1D textures, 256 samples each)
            uniform sampler2D u_curveRgb;
            uniform sampler2D u_curveRed;
            uniform sampler2D u_curveGreen;
            uniform sampler2D u_curveBlue;
            uniform float u_hasCurves;
            
            varying highp vec2 v_texCoord;  // Match vertex shader precision
            
            // Color space conversions
            vec3 rgb2hsv(vec3 c) {
                vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
                vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
                vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
                float d = q.x - min(q.w, q.y);
                float e = 1.0e-10;
                return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
            }
            
            vec3 hsv2rgb(vec3 c) {
                vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
                vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
                return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
            }
            
            // Apply exposure adjustment
            vec3 applyExposure(vec3 color, float exposure) {
                return color * pow(2.0, exposure);
            }
            
            // Apply contrast
            vec3 applyContrast(vec3 color, float contrast) {
                float factor = (1.0 + contrast);
                return (color - 0.5) * factor + 0.5;
            }
            
            // Apply saturation
            vec3 applySaturation(vec3 color, float saturation) {
                float gray = dot(color, vec3(0.299, 0.587, 0.114));
                return mix(vec3(gray), color, 1.0 + saturation);
            }
            
            // Apply temperature (blue-yellow shift)
            vec3 applyTemperature(vec3 color, float temp) {
                // Warm (positive) = more yellow, less blue
                // Cool (negative) = more blue, less yellow
                color.r += temp * 0.05;
                color.b -= temp * 0.05;
                return color;
            }
            
            // Apply tint (green-magenta shift)
            vec3 applyTint(vec3 color, float tint) {
                // Positive = more green
                // Negative = more magenta (red+blue)
                color.g += tint * 0.05;
                return color;
            }
            
            // Tone curve (highlights/shadows/whites/blacks)
            vec3 applyToneCurve(vec3 color, float highlights, float shadows, float whites, float blacks) {
                // Compute luminance to determine tone region
                float lum = dot(color, vec3(0.299, 0.587, 0.114));
                
                // Shadows affect darker tones (0-0.5)
                float shadowMask = 1.0 - smoothstep(0.0, 0.5, lum);
                color += shadows * shadowMask * 0.3;
                
                // Blacks affect darkest tones (0-0.25)
                float blackMask = 1.0 - smoothstep(0.0, 0.25, lum);
                color += blacks * blackMask * 0.3;
                
                // Highlights affect brighter tones (0.5-1.0)
                float highlightMask = smoothstep(0.5, 1.0, lum);
                color += highlights * highlightMask * 0.3;
                
                // Whites affect brightest tones (0.75-1.0)
                float whiteMask = smoothstep(0.75, 1.0, lum);
                color += whites * whiteMask * 0.3;
                
                return color;
            }
            
            // Apply levels adjustment (eyedropper black/white/gray points)
            vec3 applyLevels(vec3 color, vec3 blackPt, vec3 whitePt, vec3 grayPt, 
                            float hasBlack, float hasWhite, float hasGray) {
                // Apply black point - remap black point to 0
                if (hasBlack > 0.5) {
                    color = (color - blackPt) / (1.0 - blackPt);
                    color = max(color, vec3(0.0));
                }
                
                // Apply white point - remap white point to 1
                if (hasWhite > 0.5) {
                    color = color / whitePt;
                    color = min(color, vec3(1.0));
                }
                
                // Apply gray point - removes color casts
                if (hasGray > 0.5) {
                    // Calculate gray point average
                    float grayAvg = (grayPt.r + grayPt.g + grayPt.b) / 3.0;
                    // Apply per-channel correction to make gray point neutral
                    color.r *= grayAvg / max(grayPt.r, 0.001);
                    color.g *= grayAvg / max(grayPt.g, 0.001);
                    color.b *= grayAvg / max(grayPt.b, 0.001);
                }
                
                return clamp(color, 0.0, 1.0);
            }
            
            // Apply curves using lookup textures
            vec3 applyCurves(vec3 color) {
                if (u_hasCurves < 0.5) return color;
                
                // Sample curve textures (1D lookup, stored as 1-pixel-high 2D texture)
                float r = texture2D(u_curveRgb, vec2(color.r, 0.5)).r;
                float g = texture2D(u_curveRgb, vec2(color.g, 0.5)).g;
                float b = texture2D(u_curveRgb, vec2(color.b, 0.5)).b;
                
                // Apply RGB curve
                color = vec3(r, g, b);
                
                // Apply per-channel curves
                color.r = texture2D(u_curveRed, vec2(color.r, 0.5)).r;
                color.g = texture2D(u_curveGreen, vec2(color.g, 0.5)).g;
                color.b = texture2D(u_curveBlue, vec2(color.b, 0.5)).b;
                
                return clamp(color, 0.0, 1.0);
            }
            
            void main() {
                // Sample input texture
                vec3 color = texture2D(u_image, v_texCoord).rgb;
                
                // If showing original, skip all adjustments
                if (u_showOriginal > 0.5) {
                    gl_FragColor = vec4(color, 1.0);
                    return;
                }
                
                // Apply adjustments in proper order (like Photoshop/Lightroom)
                
                // 0. Levels adjustment first (eyedropper points)
                color = applyLevels(color, u_blackPoint, u_whitePoint, u_grayPoint,
                                   u_hasBlackPoint, u_hasWhitePoint, u_hasGrayPoint);
                
                // 1. Exposure (affects overall brightness)
                color = applyExposure(color, u_exposure);
                
                // 2. Tone curve (highlights/shadows/whites/blacks)
                color = applyToneCurve(color, u_highlights, u_shadows, u_whites, u_blacks);
                
                // 3. Contrast
                color = applyContrast(color, u_contrast);
                
                // 4. Brightness
                color += u_brightness;
                
                // 5. Temperature and Tint
                color = applyTemperature(color, u_temperature);
                color = applyTint(color, u_tint);
                
                // 6. RGB adjustments
                color.r += u_red;
                color.g += u_green;
                color.b += u_blue;
                
                // 7. Saturation
                color = applySaturation(color, u_saturation);
                
                // 8. Custom curves (after other adjustments)
                color = applyCurves(color);
                
                // Clamp to valid range
                color = clamp(color, 0.0, 1.0);
                
                gl_FragColor = vec4(color, 1.0);
            }
        `;
    }
    
    createShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            console.error('Shader compilation error:', this.gl.getShaderInfoLog(shader));
            this.gl.deleteShader(shader);
            return null;
        }
        
        return shader;
    }
    
    createProgram(vertexSource, fragmentSource) {
        const vertexShader = this.createShader(this.gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this.createShader(this.gl.FRAGMENT_SHADER, fragmentSource);
        
        if (!vertexShader || !fragmentShader) {
            return null;
        }
        
        const program = this.gl.createProgram();
        this.gl.attachShader(program, vertexShader);
        this.gl.attachShader(program, fragmentShader);
        this.gl.linkProgram(program);
        
        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            console.error('Program linking error:', this.gl.getProgramInfoLog(program));
            this.gl.deleteProgram(program);
            return null;
        }
        
        return program;
    }
    
    setupGeometry() {
        // Full-screen quad (2 triangles)
        const positions = new Float32Array([
            -1, -1,
             1, -1,
            -1,  1,
            -1,  1,
             1, -1,
             1,  1
        ]);
        
        const texCoords = new Float32Array([
            0, 1,
            1, 1,
            0, 0,
            0, 0,
            1, 1,
            1, 0
        ]);
        
        // Position buffer
        const positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);
        
        const positionLoc = this.gl.getAttribLocation(this.program, 'a_position');
        this.gl.enableVertexAttribArray(positionLoc);
        this.gl.vertexAttribPointer(positionLoc, 2, this.gl.FLOAT, false, 0, 0);
        
        // Texture coordinate buffer
        const texCoordBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, texCoordBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, texCoords, this.gl.STATIC_DRAW);
        
        const texCoordLoc = this.gl.getAttribLocation(this.program, 'a_texCoord');
        this.gl.enableVertexAttribArray(texCoordLoc);
        this.gl.vertexAttribPointer(texCoordLoc, 2, this.gl.FLOAT, false, 0, 0);
    }
    
    // Load raw float32 image data from server
    async loadImage(imageUrl) {
        try {
            console.log('Loading raw image data for WebGL...');
            const response = await fetch(imageUrl);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            // Get metadata from headers
            this.imageWidth = parseInt(response.headers.get('X-Image-Width'));
            this.imageHeight = parseInt(response.headers.get('X-Image-Height'));
            const channels = parseInt(response.headers.get('X-Image-Channels'));
            
            console.log(`Loading ${this.imageWidth}x${this.imageHeight} image with ${channels} channels`);
            
            // Get raw bytes
            const arrayBuffer = await response.arrayBuffer();
            
            // Convert to Float32Array
            const float32Data = new Float32Array(arrayBuffer);
            
            // Upload to GPU texture
            this.uploadTexture(float32Data, this.imageWidth, this.imageHeight);
            
            // Resize canvas to match image aspect ratio (but scaled for screen)
            this.resizeCanvas();
            
            // Initial render
            this.render();
            
            console.log('WebGL image loaded and rendered');
            return true;
            
        } catch (e) {
            console.error('Error loading WebGL image:', e);
            return false;
        }
    }
    
    uploadTexture(data, width, height) {
        const gl = this.gl;
        
        // Try to use float textures for full precision
        const floatExt = gl.getExtension('OES_texture_float');
        const useFloat = floatExt !== null;
        
        // Create or update texture
        if (!this.texture) {
            this.texture = gl.createTexture();
        }
        
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        
        // Set pixel store parameters - CRITICAL for non-aligned row widths
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);  // No padding, pack tightly
        
        if (useFloat) {
            // Upload float32 RGB data directly (full precision!)
            // Use RGBA32F for WebGL2 or RGBA for WebGL1 (RGB doesn't support float in all browsers)
            const internalFormat = this.gl.RGB32F || gl.RGBA;  // WebGL2 supports RGB32F, WebGL1 needs RGBA
            const format = internalFormat === gl.RGBA ? gl.RGBA : gl.RGB;
            
            // Convert RGB to RGBA if needed (add alpha=1.0)
            let textureData = data;
            if (format === gl.RGBA) {
                textureData = new Float32Array(width * height * 4);
                for (let i = 0; i < width * height; i++) {
                    textureData[i * 4 + 0] = data[i * 3 + 0];  // R
                    textureData[i * 4 + 1] = data[i * 3 + 1];  // G
                    textureData[i * 4 + 2] = data[i * 3 + 2];  // B
                    textureData[i * 4 + 3] = 1.0;              // A (always 1.0)
                }
            }
            
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,                    // level
                internalFormat,       // internal format (RGB32F or RGBA - full float precision!)
                width,
                height,
                0,                    // border
                format,               // format (RGB or RGBA)
                gl.FLOAT,             // type (float32 - full precision!)
                textureData
            );
            console.log(`Texture uploaded to GPU: ${width}x${height} ${format === gl.RGBA ? 'RGBA' : 'RGB'} float32 (full precision)`);
        } else {
            // Fallback: convert to uint8 (some quality loss)
            console.warn('Float textures not supported, converting to 8-bit');
            const uint8Data = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) {
                uint8Data[i] = Math.max(0, Math.min(255, Math.round(data[i] * 255)));
            }
            
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,                    // level
                gl.RGB,               // internal format
                width,
                height,
                0,                    // border
                gl.RGB,               // format
                gl.UNSIGNED_BYTE,     // type
                uint8Data
            );
            console.log(`Texture uploaded to GPU: ${width}x${height} RGB uint8 (8-bit fallback)`);
        }
        
        // Check for WebGL errors
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
            console.error('WebGL texture upload error:', error);
        }
        
        // Set texture parameters (no mipmaps, linear filtering for smooth scaling)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        
        // Enable anisotropic filtering for highest quality texture sampling
        if (this.anisotropicExt && this.maxAnisotropy) {
            gl.texParameterf(gl.TEXTURE_2D, this.anisotropicExt.TEXTURE_MAX_ANISOTROPY_EXT, this.maxAnisotropy);
            console.log(`Anisotropic filtering enabled: ${this.maxAnisotropy}x`);
        }
    }
    
    resizeCanvas() {
        // Set canvas INTERNAL resolution to full image size (render quality)
        this.canvas.width = this.imageWidth;
        this.canvas.height = this.imageHeight;
        
        // Update WebGL viewport to match
        this.gl.viewport(0, 0, this.imageWidth, this.imageHeight);
        
        // Use CSS to scale canvas for DISPLAY (screen size)
        // This keeps full resolution but fits on screen
        const maxWidth = window.innerWidth * 0.6;  // Center panel is ~60% width
        const maxHeight = window.innerHeight * 0.8;
        
        const aspectRatio = this.imageWidth / this.imageHeight;
        
        let displayWidth = maxWidth;
        let displayHeight = displayWidth / aspectRatio;
        
        if (displayHeight > maxHeight) {
            displayHeight = maxHeight;
            displayWidth = displayHeight * aspectRatio;
        }
        
        // Apply display size via CSS (scales the full-res canvas)
        this.canvas.style.width = displayWidth + 'px';
        this.canvas.style.height = displayHeight + 'px';
        
        console.log(`Canvas: ${this.imageWidth}x${this.imageHeight} rendered, displayed at ${displayWidth.toFixed(0)}x${displayHeight.toFixed(0)}`);
    }
    
    // Create 1D curve lookup texture from curve points.
    // Uses the same monotone cubic spline as the curve editor and the
    // server-side export LUT, so preview and export match.
    createCurveTexture(curvePoints, existingTexture = null) {
        const gl = this.gl;
        const LUT_SIZE = 256;

        const spline = buildMonotoneCubicSpline(curvePoints);
        const lut = new Uint8Array(LUT_SIZE * 4); // RGBA

        for (let i = 0; i < LUT_SIZE; i++) {
            const x = i / (LUT_SIZE - 1); // 0 to 1
            const y = Math.max(0, Math.min(1, spline(x)));

            // Store in all RGB channels (makes lookup simpler)
            const value = Math.round(y * 255);
            lut[i * 4 + 0] = value; // R
            lut[i * 4 + 1] = value; // G
            lut[i * 4 + 2] = value; // B
            lut[i * 4 + 3] = 255;   // A
        }

        // Reuse the existing texture object when possible (avoids leaking
        // one texture per slider/curve update)
        const texture = existingTexture || gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
        
        // Linear filtering for smooth curve lookups
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        
        return texture;
    }
    
    // Update adjustment parameters and re-render
    updateParams(newParams) {
        Object.assign(this.params, newParams);

        // Rebuild curve textures only when the curves actually changed
        // (updateParams runs on every slider move)
        const curvesJSON = typeof newParams.curves === 'string'
            ? newParams.curves
            : (newParams.curves ? JSON.stringify(newParams.curves) : null);

        if (curvesJSON && curvesJSON !== this.lastCurvesJSON) {
            try {
                const curvesData = JSON.parse(curvesJSON);

                if (curvesData.rgb) this.curveTextureRgb = this.createCurveTexture(curvesData.rgb, this.curveTextureRgb);
                if (curvesData.red) this.curveTextureRed = this.createCurveTexture(curvesData.red, this.curveTextureRed);
                if (curvesData.green) this.curveTextureGreen = this.createCurveTexture(curvesData.green, this.curveTextureGreen);
                if (curvesData.blue) this.curveTextureBlue = this.createCurveTexture(curvesData.blue, this.curveTextureBlue);

                this.params.hasCurves = true;
                this.lastCurvesJSON = curvesJSON;
            } catch (e) {
                console.warn('Failed to parse curves:', e);
                this.params.hasCurves = false;
            }
        }

        this.render();
    }
    
    // Render with current parameters (INSTANT, no transfer!)
    render() {
        if (!this.gl || !this.program || !this.texture) {
            console.warn('WebGL not ready for rendering');
            return;
        }
        
        const gl = this.gl;
        
        // Use shader program
        gl.useProgram(this.program);
        
        // Bind texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);
        
        // Upload show original flag (bypasses all adjustments)
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_showOriginal'), this.params.showOriginal ? 1.0 : 0.0);
        
        // Upload all uniform parameters
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_exposure'), this.params.exposure || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_contrast'), this.params.contrast || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_brightness'), this.params.brightness || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_saturation'), this.params.saturation || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_temperature'), this.params.temperature || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_tint'), this.params.tint || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_highlights'), this.params.highlights || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_shadows'), this.params.shadows || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_whites'), this.params.whites || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_blacks'), this.params.blacks || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_red'), this.params.red || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_green'), this.params.green || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_blue'), this.params.blue || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_clarity'), this.params.clarity || 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_vibrance'), this.params.vibrance || 0.0);
        
        // Upload eyedropper levels uniforms
        gl.uniform3fv(gl.getUniformLocation(this.program, 'u_blackPoint'), this.params.blackPoint || [0, 0, 0]);
        gl.uniform3fv(gl.getUniformLocation(this.program, 'u_whitePoint'), this.params.whitePoint || [1, 1, 1]);
        gl.uniform3fv(gl.getUniformLocation(this.program, 'u_grayPoint'), this.params.grayPoint || [0.5, 0.5, 0.5]);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_hasBlackPoint'), this.params.hasBlackPoint ? 1.0 : 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_hasWhitePoint'), this.params.hasWhitePoint ? 1.0 : 0.0);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_hasGrayPoint'), this.params.hasGrayPoint ? 1.0 : 0.0);
        
        // Bind curve textures
        if (this.curveTextureRgb) {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.curveTextureRgb);
            gl.uniform1i(gl.getUniformLocation(this.program, 'u_curveRgb'), 1);
        }
        if (this.curveTextureRed) {
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, this.curveTextureRed);
            gl.uniform1i(gl.getUniformLocation(this.program, 'u_curveRed'), 2);
        }
        if (this.curveTextureGreen) {
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, this.curveTextureGreen);
            gl.uniform1i(gl.getUniformLocation(this.program, 'u_curveGreen'), 3);
        }
        if (this.curveTextureBlue) {
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_2D, this.curveTextureBlue);
            gl.uniform1i(gl.getUniformLocation(this.program, 'u_curveBlue'), 4);
        }
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_hasCurves'), this.params.hasCurves ? 1.0 : 0.0);
        
        // Clear and render
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        
        // Done - image now visible on canvas, all processing happened on GPU!
    }
}
