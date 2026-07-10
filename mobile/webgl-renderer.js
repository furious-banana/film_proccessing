// WebGL renderer for the mobile app.
//
// The fragment shader is IDENTICAL to the desktop app's
// (static/webgl-renderer.js): levels -> exposure -> tone -> contrast ->
// brightness -> temp/tint -> RGB -> saturation -> curves. Export reads the
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

            varying highp vec2 v_texCoord;

            vec3 applyExposure(vec3 color, float exposure) {
                return color * pow(2.0, exposure);
            }

            vec3 applyContrast(vec3 color, float contrast) {
                return (color - 0.5) * (1.0 + contrast) + 0.5;
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

            vec3 applyToneCurve(vec3 color, float highlights, float shadows, float whites, float blacks) {
                float lum = dot(color, vec3(0.299, 0.587, 0.114));

                float shadowMask = 1.0 - smoothstep(0.0, 0.5, lum);
                color += shadows * shadowMask * 0.3;

                float blackMask = 1.0 - smoothstep(0.0, 0.25, lum);
                color += blacks * blackMask * 0.3;

                float highlightMask = smoothstep(0.5, 1.0, lum);
                color += highlights * highlightMask * 0.3;

                float whiteMask = smoothstep(0.75, 1.0, lum);
                color += whites * whiteMask * 0.3;

                return color;
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
                color = applyToneCurve(color, u_highlights, u_shadows, u_whites, u_blacks);
                color = applyContrast(color, u_contrast);
                color += u_brightness;
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

    // Load a prepared source image (Float32Array RGB [0,1])
    setImage(data, width, height) {
        const gl = this.gl;
        this.imageWidth = width;
        this.imageHeight = height;
        this.imageData = data;

        if (!this.texture) this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
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
    renderToPixels() {
        const gl = this.gl;
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
