// Folder browser: pick a scans folder once, get a thumbnail grid of the
// images in it (Adobe Bridge-style), tap one for a full-screen preview,
// swipe between frames, and open one in the editor.
//
// Thumbnails of uncompressed TIFFs are built WITHOUT reading the whole
// file: the IFD is parsed from a small header slice, then only every Nth
// row is fetched with byte-range reads - a 140MB scan costs a few MB.
// Thumbnails are cached in IndexedDB so a folder is instant on revisits.

'use strict';

// ------------------------------------------------------------------
// IndexedDB: one store for the folder handle, one for thumbnails
// ------------------------------------------------------------------

function browseDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('filmBrowser', 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore('handles');
            req.result.createObjectStore('thumbs');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbGet(store, key) {
    const db = await browseDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction(store).objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbSet(store, key, value) {
    const db = await browseDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ------------------------------------------------------------------
// Fast subsampled TIFF reader (uncompressed, contiguous, strip-based).
// Returns a canvas at most targetLongEdge on its long side, or null if
// the file's layout needs the full decoder.
// ------------------------------------------------------------------

async function readTiffSubsampled(file, targetLongEdge) {
    const HEAD = 64 * 1024;
    const head = new DataView(await file.slice(0, Math.min(HEAD, file.size)).arrayBuffer());
    if (head.byteLength < 8) return null;
    const b0 = head.getUint16(0, false);
    if (b0 !== 0x4949 && b0 !== 0x4D4D) return null;
    const le = b0 === 0x4949;
    if (head.getUint16(2, le) !== 42) return null;

    const ifdOffset = head.getUint32(4, le);
    if (ifdOffset + 2 > head.byteLength) return null; // IFD past our slice: rare, fall back
    const numTags = head.getUint16(ifdOffset, le);
    if (ifdOffset + 2 + numTags * 12 > head.byteLength) return null;

    const TYPE_SIZE = { 1: 1, 3: 2, 4: 4, 5: 8 };
    const tags = {};
    for (let i = 0; i < numTags; i++) {
        const p = ifdOffset + 2 + i * 12;
        const id = head.getUint16(p, le);
        const type = head.getUint16(p + 2, le);
        const count = head.getUint32(p + 4, le);
        tags[id] = { type, count, p: p + 8 };
    }

    // Reads a tag's values (inline, from the head slice, or from disk)
    const readValues = async (tag) => {
        const size = (TYPE_SIZE[tag.type] || 0) * tag.count;
        if (!size) return null;
        let view;
        if (size <= 4) {
            view = new DataView(head.buffer, tag.p, 4);
        } else {
            const off = head.getUint32(tag.p, le);
            if (off + size <= head.byteLength) {
                view = new DataView(head.buffer, off, size);
            } else {
                view = new DataView(await file.slice(off, off + size).arrayBuffer());
            }
        }
        const out = new Array(tag.count);
        for (let i = 0; i < tag.count; i++) {
            out[i] = tag.type === 3 ? view.getUint16(i * 2, le)
                : tag.type === 1 ? view.getUint8(i)
                : view.getUint32(i * 4, le); // LONG (RATIONAL unused here)
        }
        return out;
    };
    const one = async (id, dflt) => tags[id] ? (await readValues(tags[id]))[0] : dflt;

    if (tags[322] || tags[323]) return null;                 // tiled
    const compression = await one(259, 1);
    if (compression !== 1) return null;                      // compressed
    if (await one(284, 1) !== 1) return null;                // planar
    const photometric = await one(262, 2);
    if (photometric !== 2 && photometric !== 1 && photometric !== 0) return null;

    const width = await one(256, 0);
    const height = await one(257, 0);
    if (!width || !height || !tags[273]) return null;
    const spp = await one(277, photometric === 2 ? 3 : 1);
    const bits = tags[258] ? (await readValues(tags[258]))[0] : 8;
    if (bits !== 8 && bits !== 16) return null;
    const rowsPerStrip = await one(278, height);
    const stripOffsets = await readValues(tags[273]);

    const bytesPerSample = bits / 8;
    const rowBytes = width * spp * bytesPerSample;

    const scale = Math.min(1, targetLongEdge / Math.max(width, height));
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));

    // Fetch only the rows the output needs
    const rowFor = (outY) => Math.min(height - 1, Math.floor(outY * height / outH));
    const fetchRow = async (srcY) => {
        const s = Math.floor(srcY / rowsPerStrip);
        const offset = stripOffsets[s] + (srcY - s * rowsPerStrip) * rowBytes;
        return new DataView(await file.slice(offset, offset + rowBytes).arrayBuffer());
    };

    const rgba = new Uint8ClampedArray(outW * outH * 4);
    const BATCH = 16;
    for (let y0 = 0; y0 < outH; y0 += BATCH) {
        const n = Math.min(BATCH, outH - y0);
        const rows = await Promise.all(
            Array.from({ length: n }, (_, i) => fetchRow(rowFor(y0 + i))));
        for (let i = 0; i < n; i++) {
            const row = rows[i];
            const base = (y0 + i) * outW * 4;
            for (let outX = 0; outX < outW; outX++) {
                const srcX = Math.floor(outX * width / outW);
                const sp = srcX * spp * bytesPerSample;
                let r, g, b;
                if (bits === 16) {
                    r = row.getUint16(sp, le) >> 8;
                    g = spp >= 3 ? row.getUint16(sp + 2, le) >> 8 : r;
                    b = spp >= 3 ? row.getUint16(sp + 4, le) >> 8 : r;
                } else {
                    r = row.getUint8(sp);
                    g = spp >= 3 ? row.getUint8(sp + 1) : r;
                    b = spp >= 3 ? row.getUint8(sp + 2) : r;
                }
                // MinIsBlack==0 means inverted grayscale
                if (photometric === 0) { r = 255 - r; g = 255 - g; b = 255 - b; }
                const o = base + outX * 4;
                rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
            }
        }
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext('2d').putImageData(new ImageData(rgba, outW, outH), 0, 0);
    return canvas;
}

// Any image file -> canvas capped at targetLongEdge on its long side
async function imageThumbCanvas(file, targetLongEdge) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.tif') || name.endsWith('.tiff')) {
        const fast = await readTiffSubsampled(file, targetLongEdge);
        if (fast) return fast;
        // Unusual layout (compressed/tiled): full decode, then shrink
        const img = await decodeImageFile(file, targetLongEdge);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const rgba = new Uint8ClampedArray(img.width * img.height * 4);
        for (let i = 0; i < img.width * img.height; i++) {
            rgba[i * 4] = img.data[i * 3] * 255;
            rgba[i * 4 + 1] = img.data[i * 3 + 1] * 255;
            rgba[i * 4 + 2] = img.data[i * 3 + 2] * 255;
            rgba[i * 4 + 3] = 255;
        }
        canvas.getContext('2d').putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
        return canvas;
    }
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, targetLongEdge / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas;
}

// ------------------------------------------------------------------
// The browser UI
// ------------------------------------------------------------------

const IMAGE_EXT = /\.(tiff?|jpe?g|png)$/i;
const THUMB_SIZE = 320;
const PREVIEW_SIZE = 1600;

class FolderBrowser {
    constructor(app) {
        this.app = app;
        this.dirHandle = null;
        this.entries = [];       // [{ name, handle }]
        this.generation = 0;     // cancels stale thumbnail work
        this.previewGen = 0;     // cancels stale preview loads
        this.previewIndex = -1;
        this.previewUrl = null;
        this.wire();
    }

    wire() {
        document.getElementById('browseBtn').addEventListener('click', () => this.open());
        document.getElementById('browseCloseBtn').addEventListener('click', () => this.close());
        document.getElementById('browseFolderBtn').addEventListener('click', () => this.pickFolder());
        document.getElementById('browsePickBtn').addEventListener('click', () => this.pickFolder());
        document.getElementById('previewCloseBtn').addEventListener('click', () => this.closePreview());
        document.getElementById('previewEditBtn').addEventListener('click', () => this.editCurrent());
        document.getElementById('previewPrevBtn').addEventListener('click', () => this.movePreview(-1));
        document.getElementById('previewNextBtn').addEventListener('click', () => this.movePreview(1));

        // Swipe between frames in the preview
        const pv = document.getElementById('browsePreview');
        let downX = null;
        pv.addEventListener('pointerdown', (e) => { downX = e.clientX; });
        pv.addEventListener('pointerup', (e) => {
            if (downX === null) return;
            const dx = e.clientX - downX;
            downX = null;
            if (Math.abs(dx) > 60) this.movePreview(dx < 0 ? 1 : -1);
        });
    }

    async open() {
        document.getElementById('browsePanel').style.display = '';
        if (this.entries.length) return; // keep the grid from last time
        if (!this.dirHandle) {
            try {
                this.dirHandle = await dbGet('handles', 'dir') || null;
            } catch { /* first run */ }
        }
        if (!this.dirHandle) {
            this.showEmpty('Pick the folder your scans live in.');
            return;
        }
        // The Browse tap is a user gesture, so a permission re-prompt is
        // allowed right here (Android forgets grants between sessions)
        if (this.dirHandle.queryPermission) {
            let perm = await this.dirHandle.queryPermission({ mode: 'read' });
            if (perm === 'prompt') {
                try {
                    perm = await this.dirHandle.requestPermission({ mode: 'read' });
                } catch { perm = 'denied'; }
            }
            if (perm !== 'granted') {
                this.showEmpty('Access to the folder was not granted — pick it again.');
                return;
            }
        }
        await this.list();
    }

    // Test hook: browse a fake directory handle without any picker
    async openWithHandle(handle) {
        this.dirHandle = handle;
        this.entries = [];
        document.getElementById('browsePanel').style.display = '';
        await this.list();
    }

    close() {
        this.generation++;
        document.getElementById('browsePanel').style.display = 'none';
        this.closePreview();
    }

    showEmpty(msg) {
        document.getElementById('browseGrid').innerHTML = '';
        const empty = document.getElementById('browseEmpty');
        empty.style.display = '';
        document.getElementById('browseEmptyMsg').textContent = msg;
    }

    async pickFolder() {
        if (!window.showDirectoryPicker) {
            alert('This browser cannot open folders — use Load instead.');
            return;
        }
        try {
            const handle = await window.showDirectoryPicker({ mode: 'read' });
            this.dirHandle = handle;
            dbSet('handles', 'dir', handle).catch(() => {});
            this.entries = [];
            await this.list();
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('Folder pick failed', e);
        }
    }

    async list() {
        const gen = ++this.generation;
        document.getElementById('browseEmpty').style.display = 'none';
        document.getElementById('browseTitle').textContent = this.dirHandle.name || 'Browse';
        const grid = document.getElementById('browseGrid');
        grid.innerHTML = '';

        this.entries = [];
        try {
            for await (const entry of this.dirHandle.values()) {
                if (entry.kind === 'file' && IMAGE_EXT.test(entry.name)) {
                    this.entries.push({ name: entry.name, handle: entry });
                }
            }
        } catch (e) {
            this.showEmpty('Could not read the folder — pick it again. (' + e.message + ')');
            return;
        }
        this.entries.sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true }));

        if (!this.entries.length) {
            this.showEmpty('No images in this folder (TIFF, JPEG or PNG).');
            return;
        }

        const cells = this.entries.map((entry, i) => {
            const cell = document.createElement('div');
            cell.className = 'browse-cell';
            const ph = document.createElement('div');
            ph.className = 'browse-thumb';
            const label = document.createElement('span');
            label.className = 'browse-name';
            label.textContent = entry.name;
            cell.appendChild(ph);
            cell.appendChild(label);
            cell.addEventListener('click', () => this.openPreview(i));
            grid.appendChild(cell);
            return cell;
        });

        // Thumbnails fill in one by one; cached ones are instant
        for (let i = 0; i < this.entries.length; i++) {
            if (gen !== this.generation) return;
            try {
                const url = await this.thumbUrl(this.entries[i]);
                if (gen !== this.generation) { URL.revokeObjectURL(url); return; }
                const img = document.createElement('img');
                img.src = url;
                img.onload = () => URL.revokeObjectURL(url);
                cells[i].replaceChild(img, cells[i].firstChild);
                img.className = 'browse-thumb';
            } catch (e) {
                cells[i].firstChild.textContent = '⚠';
                console.warn('Thumbnail failed for ' + this.entries[i].name, e);
            }
        }
    }

    async thumbUrl(entry) {
        const file = await entry.handle.getFile();
        const key = `${file.name}|${file.size}|${file.lastModified}`;
        try {
            const cached = await dbGet('thumbs', key);
            if (cached) return URL.createObjectURL(cached);
        } catch { /* cache unavailable */ }
        const canvas = await imageThumbCanvas(file, THUMB_SIZE);
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
        dbSet('thumbs', key, blob).catch(() => {});
        return URL.createObjectURL(blob);
    }

    // --- Full-screen preview ---

    async openPreview(index) {
        this.previewIndex = index;
        const entry = this.entries[index];
        document.getElementById('browsePreview').style.display = '';
        document.getElementById('previewName').textContent =
            `${entry.name} (${index + 1}/${this.entries.length})`;
        const img = document.getElementById('browsePreviewImg');
        img.style.opacity = 0.4; // stale while the sharp version loads

        const my = ++this.previewGen;
        try {
            const file = await entry.handle.getFile();
            const canvas = await imageThumbCanvas(file, PREVIEW_SIZE);
            if (my !== this.previewGen || this.previewIndex !== index) return;
            const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
            if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
            this.previewUrl = URL.createObjectURL(blob);
            img.src = this.previewUrl;
            img.style.opacity = 1;
        } catch (e) {
            if (my === this.previewGen) {
                document.getElementById('previewName').textContent =
                    entry.name + ' — could not preview (' + e.message + ')';
            }
        }
    }

    movePreview(step) {
        if (this.previewIndex < 0) return;
        const next = this.previewIndex + step;
        if (next < 0 || next >= this.entries.length) return;
        this.openPreview(next);
    }

    closePreview() {
        this.previewGen++;
        this.previewIndex = -1;
        document.getElementById('browsePreview').style.display = 'none';
        const img = document.getElementById('browsePreviewImg');
        img.removeAttribute('src');
        if (this.previewUrl) { URL.revokeObjectURL(this.previewUrl); this.previewUrl = null; }
    }

    async editCurrent() {
        if (this.previewIndex < 0) return;
        const entry = this.entries[this.previewIndex];
        this.closePreview();
        this.close();
        const file = await entry.handle.getFile();
        await this.app.loadFile(file);
    }
}
