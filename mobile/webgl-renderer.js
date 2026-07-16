// WebGL renderer for the mobile app.
//
// The fragment shader is IDENTICAL to the desktop app's
// (static/webgl-renderer.js): levels -> exposure -> tone (shadows/highlights/
// whites/blacks/contrast/brightness on luminance) -> temp/tint -> RGB ->
// saturation -> curves. Export reads the
// shader's own output back from a float framebuffer, so the exported file
// is exactly what's previewed - there is no second pipeline to drift.

'use strict';

// Monotone cubic Hermite spline (Fritsch-Carlson) - same algorithm as the
// desktop curve editor / shader LUT / server export LUT.
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

    const dxs = [], ms = [];
    for (let i = 0; i < n - 1; i++) {
        const dx = xs[i + 1] - xs[i];
        dxs.push(dx);
        ms.push((ys[i + 1] - ys[i]) / dx);
    }

    const c1s = [ms[0]];
    for (let i = 1; i < n - 1; i++) {
        const mL = ms[i - 1], mR = ms[i];
        if (mL * mR <= 0) {
            c1s.push(0);
        } else {
            const common = dxs[i - 1] + dxs[i];
            c1s.push(3 * common / ((common + dxs[i]) / mL + (common + dxs[i - 1]) / mR));
        }
    }
    c1s.push(ms[n - 2]);

    for (let i = 0; i < n - 1; i++) {
        if (Math.abs(ms[i]) < 1e-10) {
            c1s[i] = 0;
            c1s[i + 1] = 0;
        } else {
            const a = c1s[i] / ms[i], b = c1s[i + 1] / ms[i];
            if (a * a + b * b > 9) {
                const t = 3 / Math.sqrt(a * a + b * b);
                c1s[i] = t * a * ms[i];
                c1s[i + 1] = t * b * ms[i];
            }
        }
    }

    const c2s = [], c3s = [];
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
            if (xs[j] <= x && x <= xs[j + 1]) { i = j; break; }
        }
        const dx = x - xs[i];
        return ys[i] + dx * (c1s[i] + dx * (c2s[i] + dx * c3s[i]));
    };
}

// Local-luminance map for the tone stage: a low-res, heavily blurred
// luminance grid of the source image, used to drive Shadows/Highlights
// locally (Lightroom-style) so texture inside bright/dark regions is
// preserved instead of flattened. Kept in EXACT sync with
// film_processing._local_lum_grid (same grid geometry, box blur, and
// rounding) so the desktop export matches its preview. Byte-identical
// copy in static/webgl-renderer.js.
function computeLocalLumMap(data, width, height) {
    const MAXDIM = 128, PASSES = 3;
    const longSide = Math.max(width, height);
    const gw = Math.min(width, Math.max(1, Math.round(width * MAXDIM / longSide)));
    const gh = Math.min(height, Math.max(1, Math.round(height * MAXDIM / longSide)));

    // Box-average downsample: pixel (x, y) belongs to cell
    // (floor(x*gw/width), floor(y*gh/height))
    const sums = new Float64Array(gw * gh);
    const counts = new Float64Array(gw * gh);
    for (let y = 0; y < height; y++) {
        const cy = Math.min(gh - 1, Math.floor(y * gh / height));
        for (let x = 0; x < width; x++) {
            const cx = Math.min(gw - 1, Math.floor(x * gw / width));
            const i = (y * width + x) * 3;
            sums[cy * gw + cx] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            counts[cy * gw + cx]++;
        }
    }
    let grid = new Float64Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = sums[i] / counts[i];

    // 3 passes of separable box blur (radius ~1/16 of the long side) with
    // replicated edges - a cheap, deterministic Gaussian approximation
    const r = Math.max(1, Math.round(Math.max(gw, gh) / 16));
    const norm = 1 / (2 * r + 1);
    const tmp = new Float64Array(gw * gh);
    for (let pass = 0; pass < PASSES; pass++) {
        for (let y = 0; y < gh; y++) {
            for (let x = 0; x < gw; x++) {
                let s = 0;
                for (let k = -r; k <= r; k++) {
                    s += grid[y * gw + Math.min(gw - 1, Math.max(0, x + k))];
                }
                tmp[y * gw + x] = s * norm;
            }
        }
        for (let x = 0; x < gw; x++) {
            for (let y = 0; y < gh; y++) {
                let s = 0;
                for (let k = -r; k <= r; k++) {
                    s += tmp[Math.min(gh - 1, Math.max(0, y + k)) * gw + x];
                }
                grid[y * gw + x] = s * norm;
            }
        }
    }

    // Quantize to 8-bit: BOTH pipelines interpolate this same quantized
    // grid, so quantization cannot make preview and export drift
    const out = new Uint8Array(gw * gh);
    for (let i = 0; i < grid.length; i++) {
        out[i] = Math.min(255, Math.max(0, Math.floor(grid[i] * 255 + 0.5)));
    }
    return { data: out, width: gw, height: gh };
}

class MobileRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = null;
        this.program = null;
        this.texture = null;
        this.curveTextureRgb = null;
        this.curveTextureRed = null;
        this.curveTextureGreen = null;
        this.curveTextureBlue = null;
        this.localLumTexture = null;
        this._activeLocalRect = null;  // band slice during exports
        this.lastCurvesJSON = null;
        this.imageWidth = 0;
        this.imageHeight = 0;
        this.imageData = null;   // Float32Array RGB - source pixel sampling
        this.isWebGL2 = false;
        this.floatLinear = false;

        this.params = {
            showOriginal: false,
            clipMode: 0,
            exposure: 0, contrast: 0, brightness: 0, saturation: 0,
            temperature: 0, tint: 0,
            highlights: 0, shadows: 0, whites: 0, blacks: 0,
            red: 0, green: 0, blue: 0,
            blackPoint: [0, 0, 0], whitePoint: [1, 1, 1], grayPoint: [0.5, 0.5, 0.5],
            hasBlackPoint: false, hasWhitePoint: false, hasGrayPoint: false,
            hasCurves: false,
        };

        this.initWebGL();
    }

    // Fragment shader: byte-for-byte the same pipeline as the desktop app
    get fragmentShaderSource() {
        return `
            precision highp float;

            uniform sampler2D u_image;
            uniform float u_showOriginal;
            uniform float u_clipMode;
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

            uniform vec3 u_blackPoint;
            uniform vec3 u_whitePoint;
            uniform vec3 u_grayPoint;
            uniform float u_hasBlackPoint;
            uniform float u_hasWhitePoint;
            uniform float u_hasGrayPoint;

            uniform sampler2D u_curveRgb;
            uniform sampler2D u_curveRed;
            uniform sampler2D u_curveGreen;
            uniform sampler2D u_curveBlue;
            uniform float u_hasCurves;

            // Blurred local-luminance map driving Shadows/Highlights.
            // u_localRect maps this draw's texcoords into the map (banded
            // exports draw a slice of the full image): offset.xy + uv * zw.
            uniform sampler2D u_localLum;
            uniform vec4 u_localRect;
            uniform float u_hasLocalLum;

            varying highp vec2 v_texCoord;

            // Exposure: multiply in linear light (true photographic stops),
            // soft shoulder above 0.9 rolls pushed highlights off smoothly
            vec3 applyExposure(vec3 color, float exposure) {
                if (exposure == 0.0) return color;
                vec3 lin = pow(max(color, vec3(0.0)), vec3(2.2)) * pow(2.0, exposure);
                vec3 shoulder = 0.9 + 0.1 * (1.0 - exp(-(lin - 0.9) / 0.1));
                lin = mix(lin, shoulder, step(vec3(0.9), lin));
                return pow(lin, vec3(1.0 / 2.2));
            }

            // Soft-knee endpoint stretch: scale by K (>= 1), rolling smoothly
            // into 1.0; values past 1 + (K-1)/2 still clip. Identity at K == 1.
            float softKnee(float x, float K) {
                float y = x * K;
                float k = 1.0 - (K - 1.0) * 0.5;
                float t = clamp((y - k) / max(K - 1.0, 1e-6), 0.0, 1.0);
                float knee = k + (1.0 - k) * (2.0 * t - t * t);
                return y > k ? knee : y;
            }

            vec3 applySaturation(vec3 color, float saturation) {
                float gray = dot(color, vec3(0.299, 0.587, 0.114));
                return mix(vec3(gray), color, 1.0 + saturation);
            }

            vec3 applyTemperature(vec3 color, float temp) {
                color.r += temp * 0.05;
                color.b -= temp * 0.05;
                return color;
            }

            vec3 applyTint(vec3 color, float tint) {
                color.g += tint * 0.05;
                return color;
            }

            // Tone: computed on luminance, applied as one ratio-preserving
            // gain so hue/saturation survive. Black and white stay pinned
            // unless the op's job is to move that endpoint.
            // Shadows/Highlights are LOCAL: their masks blend in the blurred
            // neighborhood luminance (blum), so detail inside a bright or
            // dark region keeps its contrast instead of flattening. min/max
            // against pixel luminance stops halos across strong edges.
            vec3 applyTone(vec3 color, float blum, float hasLocal, float shadows,
                           float highlights, float whites, float blacks,
                           float contrast, float brightness) {
                float lum = clamp(dot(color, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
                float cl = mix(lum, blum, hasLocal * 0.6);
                float nl = lum;

                // Shadows: multiplicative lift/dip weighted toward dark tones
                float sm = 1.0 - max(cl, lum);
                nl = nl * exp((shadows * 2.0) * sm * sm);

                // Highlights: compress/expand the top end, black stays put.
                // Quartic mask keeps the effect out of mids and shadows;
                // slider is +/-0.5, tripled internally for useful strength
                float hm = min(cl, lum);
                float hm4 = (hm * hm) * (hm * hm);
                float ht = 1.0 - (1.0 - hm) * exp(-(highlights * 3.0) * hm4);
                nl = nl * (ht / max(hm, 1e-4));

                nl = clamp(nl, 0.0, 1.0);

                // Whites: white point. Up = soft-knee stretch, down = scale back
                if (whites > 0.0) {
                    nl = softKnee(nl, 1.0 / (1.0 - 0.25 * whites));
                } else {
                    nl = nl * (1.0 + 0.25 * whites);
                }

                // Blacks: black point. Down = soft toe, up = darkest-tone lift
                if (blacks >= 0.0) {
                    float m = (1.0 - nl) * (1.0 - nl);
                    nl = nl * exp(blacks * m * m * m);
                } else {
                    nl = 1.0 - softKnee(1.0 - nl, 1.0 / (1.0 + 0.25 * blacks));
                }

                // Contrast: up = endpoint-pinned S-curve, down = linear flatten
                if (contrast > 0.0) {
                    float s = nl * nl * (3.0 - 2.0 * nl);
                    nl = mix(nl, s, min(2.0 * contrast, 1.0));
                } else {
                    nl = 0.5 + (nl - 0.5) * (1.0 + contrast);
                }

                // Brightness: midtone gamma, endpoints pinned
                nl = pow(max(nl, 0.0), pow(2.0, -brightness));

                return color * (max(nl, 0.0) / max(lum, 1e-4));
            }

            vec3 applyLevels(vec3 color, vec3 blackPt, vec3 whitePt, vec3 grayPt,
                            float hasBlack, float hasWhite, float hasGray) {
                if (hasBlack > 0.5) {
                    color = (color - blackPt) / (1.0 - blackPt);
                    color = max(color, vec3(0.0));
                }
                if (hasWhite > 0.5) {
                    color = color / whitePt;
                    color = min(color, vec3(1.0));
                }
                if (hasGray > 0.5) {
                    float grayAvg = (grayPt.r + grayPt.g + grayPt.b) / 3.0;
                    color.r *= grayAvg / max(grayPt.r, 0.001);
                    color.g *= grayAvg / max(grayPt.g, 0.001);
                    color.b *= grayAvg / max(grayPt.b, 0.001);
                }
                return clamp(color, 0.0, 1.0);
            }

            vec3 applyCurves(vec3 color) {
                if (u_hasCurves < 0.5) return color;

                float r = texture2D(u_curveRgb, vec2(color.r, 0.5)).r;
                float g = texture2D(u_curveRgb, vec2(color.g, 0.5)).g;
                float b = texture2D(u_curveRgb, vec2(color.b, 0.5)).b;
                color = vec3(r, g, b);

                color.r = texture2D(u_curveRed, vec2(color.r, 0.5)).r;
                color.g = texture2D(u_curveGreen, vec2(color.g, 0.5)).g;
                color.b = texture2D(u_curveBlue, vec2(color.b, 0.5)).b;

                return clamp(color, 0.0, 1.0);
            }

            void main() {
                vec3 color = texture2D(u_image, v_texCoord).rgb;

                if (u_showOriginal > 0.5) {
                    gl_FragColor = vec4(color, 1.0);
                    return;
                }

                color = applyLevels(color, u_blackPoint, u_whitePoint, u_grayPoint,
                                   u_hasBlackPoint, u_hasWhitePoint, u_hasGrayPoint);
                color = applyExposure(color, u_exposure);
                float blum = texture2D(u_localLum,
                    v_texCoord * u_localRect.zw + u_localRect.xy).r;
                color = applyTone(color, blum, u_hasLocalLum, u_shadows,
                                  u_highlights, u_whites, u_blacks,
                                  u_contrast, u_brightness);
                color = applyTemperature(color, u_temperature);
                color = applyTint(color, u_tint);
                color.r += u_red;
                color.g += u_green;
                color.b += u_blue;
                color = applySaturation(color, u_saturation);
                color = applyCurves(color);

                color = clamp(color, 0.0, 1.0);

                // Threshold clipping preview (Photoshop-style Alt-drag view,
                // shown while holding a tone slider; display only, never
                // exported). Mode 1: black screen, channels clipped at 1.0
                // light up (white = all clip). Mode 2: white screen,
                // channels clipped at 0.0 drop out (black = all clip).
                if (u_clipMode > 1.5) {
                    color = step(vec3(0.0005), color);
                } else if (u_clipMode > 0.5) {
                    color = step(vec3(0.9995), color);
                }

                gl_FragColor = vec4(color, 1.0);
            }
        `;
    }

    get vertexShaderSource() {
        return `
            precision highp float;
            attribute vec2 a_position;
            attribute vec2 a_texCoord;
            varying highp vec2 v_texCoord;
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                v_texCoord = a_texCoord;
            }
        `;
    }

    initWebGL() {
        const attrs = {
            alpha: false,
            depth: false,
            stencil: false,
            antialias: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
        };
        this.gl = this.canvas.getContext('webgl2', attrs)
            || this.canvas.getContext('webgl', attrs);
        if (!this.gl) throw new Error('WebGL not supported on this device');

        const gl = this.gl;
        this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
            && gl instanceof WebGL2RenderingContext;
        this.floatLinear = gl.getExtension('OES_texture_float_linear') !== null;
        this.colorBufferFloat = this.isWebGL2
            ? gl.getExtension('EXT_color_buffer_float') !== null
            : false;
        if (!this.isWebGL2) gl.getExtension('OES_texture_float');

        this.program = this.createProgram(this.vertexShaderSource, this.fragmentShaderSource);
        this.setupGeometry();
    }

    createShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error('Shader compile error: ' + gl.getShaderInfoLog(shader));
        }
        return shader;
    }

    createProgram(vsSource, fsSource) {
        const gl = this.gl;
        const program = gl.createProgram();
        gl.attachShader(program, this.createShader(gl.VERTEX_SHADER, vsSource));
        gl.attachShader(program, this.createShader(gl.FRAGMENT_SHADER, fsSource));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
        }
        return program;
    }

    setupGeometry() {
        const gl = this.gl;
        const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
        const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]);

        const posBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        const posLoc = gl.getAttribLocation(this.program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        const texBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
        const texLoc = gl.getAttribLocation(this.program, 'a_texCoord');
        gl.enableVertexAttribArray(texLoc);
        gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
    }

    // Upload float RGB data into a source texture (float when supported)
    _uploadSourceTexture(tex, data, width, height) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

        const useFloat = this.isWebGL2 || gl.getExtension('OES_texture_float') !== null;
        if (useFloat) {
            const rgba = new Float32Array(width * height * 4);
            for (let i = 0; i < width * height; i++) {
                rgba[i * 4] = data[i * 3];
                rgba[i * 4 + 1] = data[i * 3 + 1];
                rgba[i * 4 + 2] = data[i * 3 + 2];
                rgba[i * 4 + 3] = 1;
            }
            gl.texImage2D(gl.TEXTURE_2D, 0,
                this.isWebGL2 ? gl.RGBA32F : gl.RGBA,
                width, height, 0, gl.RGBA, gl.FLOAT, rgba);
        } else {
            const u8 = new Uint8Array(width * height * 3);
            for (let i = 0; i < data.length; i++) {
                u8[i] = Math.max(0, Math.min(255, Math.round(data[i] * 255)));
            }
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, width, height, 0,
                gl.RGB, gl.UNSIGNED_BYTE, u8);
        }

        const filter = (useFloat && !this.floatLinear) ? gl.NEAREST : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    }

    // Upload an 8-bit local-luminance map (from computeLocalLumMap) as a
    // LINEAR-filtered texture; the shader upsamples it bilinearly, exactly
    // like cv2.resize(INTER_LINEAR) in the Python pipeline
    _uploadLumTexture(tex, map) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, map.width, map.height, 0,
            gl.LUMINANCE, gl.UNSIGNED_BYTE, map.data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    // Largest source dimension exports can use (the GPU texture limit;
    // exports render in bands, so this - not memory - is the bound)
    maxSourceSize() {
        return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) || 4096;
    }

    // Render an arbitrarily large prepared image through the shader in
    // full-width BANDS and quantize to uint16. The pipeline is purely
    // per-pixel, so banding is exact, and peak GPU memory stays modest
    // even for medium-format scans.
    renderToPixels16(image) {
        const gl = this.gl;
        const { data, width, height } = image;
        const out = new Uint16Array(width * height * 3);

        // The local-luminance map must cover the WHOLE image while bands
        // draw slices of it, so compute it once here and point each band
        // at its slice of the map via u_localRect
        const fullMap = computeLocalLumMap(data, width, height);
        const fullTex = gl.createTexture();
        this._uploadLumTexture(fullTex, fullMap);
        const previewLumTex = this.localLumTexture;
        this.localLumTexture = fullTex;

        // ~4M pixels per band: 64MB float RGBA staging + readback each
        const bandH = Math.max(1, Math.min(height, Math.floor(4 * 1024 * 1024 / width)));
        for (let y0 = 0; y0 < height; y0 += bandH) {
            const bh = Math.min(bandH, height - y0);
            const band = {
                data: data.subarray(y0 * width * 3, (y0 + bh) * width * 3),
                width, height: bh,
            };
            const rgb = this.renderToPixels(band, [0, y0 / height, 1, bh / height]).data;
            const base = y0 * width * 3;
            for (let i = 0; i < rgb.length; i++) {
                out[base + i] = Math.round(Math.min(1, Math.max(0, rgb[i])) * 65535);
            }
        }

        this.localLumTexture = previewLumTex;
        gl.deleteTexture(fullTex);
        this.render(); // restore the preview with its own map
        return { data16: out, width, height };
    }

    // Load a prepared source image (Float32Array RGB [0,1])
    setImage(data, width, height) {
        const gl = this.gl;
        this.imageWidth = width;
        this.imageHeight = height;
        this.imageData = data;

        if (!this.texture) this.texture = gl.createTexture();
        this._uploadSourceTexture(this.texture, data, width, height);

        if (!this.localLumTexture) this.localLumTexture = gl.createTexture();
        this._uploadLumTexture(this.localLumTexture, computeLocalLumMap(data, width, height));

        this.canvas.width = width;
        this.canvas.height = height;
        gl.viewport(0, 0, width, height);
        this.render();
    }

    // Sample the raw (unadjusted) source pixel; [r,g,b] 0-255
    getSourcePixel(x, y) {
        if (!this.imageData) return null;
        const px = Math.max(0, Math.min(this.imageWidth - 1, Math.floor(x)));
        const py = Math.max(0, Math.min(this.imageHeight - 1, Math.floor(y)));
        const i = (py * this.imageWidth + px) * 3;
        return [
            Math.round(this.imageData[i] * 255),
            Math.round(this.imageData[i + 1] * 255),
            Math.round(this.imageData[i + 2] * 255),
        ];
    }

    createCurveTexture(curvePoints, existingTexture = null) {
        const gl = this.gl;
        const N = 256;
        const spline = buildMonotoneCubicSpline(curvePoints);
        const tex = existingTexture || gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);

        // Float LUT on WebGL2 so curves don't quantize the 16-bit data to
        // 8-bit on their way through the shader
        if (this.isWebGL2) {
            const lut = new Float32Array(N * 4);
            for (let i = 0; i < N; i++) {
                const y = Math.max(0, Math.min(1, spline(i / (N - 1))));
                lut[i * 4] = y; lut[i * 4 + 1] = y; lut[i * 4 + 2] = y; lut[i * 4 + 3] = 1;
            }
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N, 1, 0, gl.RGBA, gl.FLOAT, lut);
        } else {
            const lut = new Uint8Array(N * 4);
            for (let i = 0; i < N; i++) {
                const y = Math.max(0, Math.min(1, spline(i / (N - 1))));
                const v = Math.round(y * 255);
                lut[i * 4] = v; lut[i * 4 + 1] = v; lut[i * 4 + 2] = v; lut[i * 4 + 3] = 255;
            }
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
        }

        const filter = (this.isWebGL2 && !this.floatLinear) ? gl.NEAREST : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        return tex;
    }

    updateParams(newParams) {
        Object.assign(this.params, newParams);

        const curvesJSON = typeof newParams.curves === 'string'
            ? newParams.curves
            : (newParams.curves ? JSON.stringify(newParams.curves) : null);

        if (curvesJSON && curvesJSON !== this.lastCurvesJSON) {
            try {
                const c = JSON.parse(curvesJSON);
                // Skip the curve stage entirely while every channel is
                // linear: even an identity LUT costs precision
                const isLinear = (pts) => pts && pts.length === 2
                    && Math.abs(pts[0].x) < 0.001 && Math.abs(pts[0].y) < 0.001
                    && Math.abs(pts[1].x - 1) < 0.001 && Math.abs(pts[1].y - 1) < 0.001;
                const allLinear = ['rgb', 'red', 'green', 'blue']
                    .every(ch => !c[ch] || isLinear(c[ch]));

                if (allLinear) {
                    this.params.hasCurves = false;
                } else {
                    if (c.rgb) this.curveTextureRgb = this.createCurveTexture(c.rgb, this.curveTextureRgb);
                    if (c.red) this.curveTextureRed = this.createCurveTexture(c.red, this.curveTextureRed);
                    if (c.green) this.curveTextureGreen = this.createCurveTexture(c.green, this.curveTextureGreen);
                    if (c.blue) this.curveTextureBlue = this.createCurveTexture(c.blue, this.curveTextureBlue);
                    this.params.hasCurves = true;
                }
                this.lastCurvesJSON = curvesJSON;
            } catch (e) {
                console.warn('Failed to parse curves:', e);
                this.params.hasCurves = false;
            }
        }

        this.render();
    }

    bindCommonUniforms() {
        const gl = this.gl;
        const u = (name) => gl.getUniformLocation(this.program, name);
        const p = this.params;

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform1i(u('u_image'), 0);

        gl.uniform1f(u('u_showOriginal'), p.showOriginal ? 1 : 0);
        gl.uniform1f(u('u_clipMode'), p.clipMode || 0);
        gl.uniform1f(u('u_exposure'), p.exposure || 0);
        gl.uniform1f(u('u_contrast'), p.contrast || 0);
        gl.uniform1f(u('u_brightness'), p.brightness || 0);
        gl.uniform1f(u('u_saturation'), p.saturation || 0);
        gl.uniform1f(u('u_temperature'), p.temperature || 0);
        gl.uniform1f(u('u_tint'), p.tint || 0);
        gl.uniform1f(u('u_highlights'), p.highlights || 0);
        gl.uniform1f(u('u_shadows'), p.shadows || 0);
        gl.uniform1f(u('u_whites'), p.whites || 0);
        gl.uniform1f(u('u_blacks'), p.blacks || 0);
        gl.uniform1f(u('u_red'), p.red || 0);
        gl.uniform1f(u('u_green'), p.green || 0);
        gl.uniform1f(u('u_blue'), p.blue || 0);

        gl.uniform3fv(u('u_blackPoint'), p.blackPoint || [0, 0, 0]);
        gl.uniform3fv(u('u_whitePoint'), p.whitePoint || [1, 1, 1]);
        gl.uniform3fv(u('u_grayPoint'), p.grayPoint || [0.5, 0.5, 0.5]);
        gl.uniform1f(u('u_hasBlackPoint'), p.hasBlackPoint ? 1 : 0);
        gl.uniform1f(u('u_hasWhitePoint'), p.hasWhitePoint ? 1 : 0);
        gl.uniform1f(u('u_hasGrayPoint'), p.hasGrayPoint ? 1 : 0);

        const bindCurve = (tex, unit, name) => {
            if (!tex) return;
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(u(name), unit);
        };
        bindCurve(this.curveTextureRgb, 1, 'u_curveRgb');
        bindCurve(this.curveTextureRed, 2, 'u_curveRed');
        bindCurve(this.curveTextureGreen, 3, 'u_curveGreen');
        bindCurve(this.curveTextureBlue, 4, 'u_curveBlue');
        gl.uniform1f(u('u_hasCurves'), p.hasCurves ? 1 : 0);

        if (this.localLumTexture) {
            gl.activeTexture(gl.TEXTURE5);
            gl.bindTexture(gl.TEXTURE_2D, this.localLumTexture);
            gl.uniform1i(u('u_localLum'), 5);
        }
        gl.uniform1f(u('u_hasLocalLum'), this.localLumTexture ? 1 : 0);
        gl.uniform4fv(u('u_localRect'), this._activeLocalRect || [0, 0, 1, 1]);
    }

    render() {
        if (!this.gl || !this.program || !this.texture) return;
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.imageWidth, this.imageHeight);
        gl.useProgram(this.program);
        this.bindCommonUniforms();
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // Render the current adjustments into an offscreen FLOAT framebuffer and
    // read the pixels back - this is the export path. Returns
    // { data: Float32Array RGB [0,1], width, height, float: bool }.
    // With overrideImage {data,width,height} the same adjustments render on
    // that image instead (full-resolution exports); the preview texture and
    // canvas are left untouched. localRect points the draw at its slice of
    // the local-luminance map when the image renders in bands.
    renderToPixels(overrideImage = null, localRect = null) {
        const gl = this.gl;
        this._activeLocalRect = localRect;

        let previewTexture = null;
        const previewW = this.imageWidth, previewH = this.imageHeight;
        if (overrideImage) {
            previewTexture = this.texture;
            this.texture = gl.createTexture();
            this._uploadSourceTexture(this.texture,
                overrideImage.data, overrideImage.width, overrideImage.height);
            this.imageWidth = overrideImage.width;
            this.imageHeight = overrideImage.height;
        }
        const w = this.imageWidth, h = this.imageHeight;

        // Display-only overlays must never leak into the export
        const overlays = {
            showOriginal: this.params.showOriginal,
            clipMode: this.params.clipMode,
        };
        this.params.showOriginal = false;
        this.params.clipMode = 0;

        const fbo = gl.createFramebuffer();
        const target = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, target);

        let floatTarget = false;
        if (this.isWebGL2 && this.colorBufferFloat) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
            floatTarget = true;
        } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);

        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            // Float attachment unsupported after all - fall back to 8-bit
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            floatTarget = false;
        }

        gl.viewport(0, 0, w, h);
        gl.useProgram(this.program);
        this.bindCommonUniforms();
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        const rgb = new Float32Array(w * h * 3);
        if (floatTarget) {
            const rgba = new Float32Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
            this.copyFlippedRGBA(rgba, rgb, w, h, 1);
        } else {
            const rgba = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            this.copyFlippedRGBA(rgba, rgb, w, h, 1 / 255);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(target);
        if (overrideImage) {
            gl.deleteTexture(this.texture);
            this.texture = previewTexture;
            this.imageWidth = previewW;
            this.imageHeight = previewH;
        }
        this._activeLocalRect = null;
        Object.assign(this.params, overlays);
        this.render(); // restore the on-screen preview

        return { data: rgb, width: w, height: h, float: floatTarget };
    }

    // readPixels returns bottom-up; our geometry already flips the image for
    // display, so FBO output matches display orientation top-down... except
    // readPixels itself is bottom-row-first. Flip while converting RGBA->RGB.
    copyFlippedRGBA(rgba, rgb, w, h, scale) {
        for (let y = 0; y < h; y++) {
            const srcRow = (h - 1 - y) * w;
            const dstRow = y * w;
            for (let x = 0; x < w; x++) {
                const s = (srcRow + x) * 4;
                const d = (dstRow + x) * 3;
                rgb[d] = rgba[s] * scale;
                rgb[d + 1] = rgba[s + 1] * scale;
                rgb[d + 2] = rgba[s + 2] * scale;
            }
        }
    }
}
