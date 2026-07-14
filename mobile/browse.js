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
        this.entries = [];       // [{ name, handle, size? }]
        this.cells = [];         // grid cells, parallel to entries
        this.generation = 0;     // cancels stale thumbnail work
        this.previewGen = 0;     // cancels stale preview loads
        this.previewIndex = -1;
        this.previewUrl = null;
        this.selectMode = false; // long-press a cell to enter
        this.selected = new Set(); // entry names
        this.batch = new BatchProcessor(app);
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

        // Batch bar (select mode)
        document.getElementById('batchDoneBtn').addEventListener('click', () => this.exitSelect());
        document.getElementById('batchAllBtn').addEventListener('click', () => this.selectAllToggle());
        document.getElementById('batchPresetBtn').addEventListener('click', () => this.showPresetDialog());
        document.getElementById('presetDialogCancel').addEventListener('click', () => {
            document.getElementById('presetDialog').style.display = 'none';
        });
        document.getElementById('batchCropBtn').addEventListener('click', () => this.autoCropSelected());
        document.getElementById('batchExportBtn').addEventListener('click', () => this.showExportDialog());
        document.getElementById('batchStopBtn').addEventListener('click', () => {
            this.batch.cancelled = true;
        });
        document.getElementById('batchDialogCancel').addEventListener('click', () => {
            document.getElementById('batchDialog').style.display = 'none';
        });
        document.getElementById('batchDialogGo').addEventListener('click', () => this.runExport());

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
        this.exitSelect();
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
        this.exitSelect();
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
            const dots = document.createElement('span');
            dots.className = 'browse-dots';
            const label = document.createElement('span');
            label.className = 'browse-name';
            label.textContent = entry.name;
            cell.appendChild(ph);
            cell.appendChild(dots);
            cell.appendChild(label);
            this.wireCell(cell, i);
            grid.appendChild(cell);
            return cell;
        });
        this.cells = cells;

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
                this.updateBadge(i); // thumbUrl learned the file size
            } catch (e) {
                cells[i].firstChild.textContent = '⚠';
                console.warn('Thumbnail failed for ' + this.entries[i].name, e);
            }
        }
    }

    // --- Multi-select (long-press a cell) + batch actions ---

    // Tap = preview (or toggle in select mode); a long, still press
    // enters select mode. The context menu Android shows on long-press
    // is suppressed.
    wireCell(cell, i) {
        let timer = null, start = null, fired = false;
        const cancel = () => { clearTimeout(timer); timer = null; };
        cell.addEventListener('pointerdown', (e) => {
            start = { x: e.clientX, y: e.clientY };
            fired = false;
            clearTimeout(timer);
            timer = setTimeout(() => {
                fired = true;
                this.enterSelect(i);
            }, 450);
        });
        cell.addEventListener('pointermove', (e) => {
            // A drag (scrolling the grid) is never a long-press
            if (timer && start
                && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) cancel();
        });
        cell.addEventListener('pointerup', cancel);
        cell.addEventListener('pointercancel', cancel);
        cell.addEventListener('contextmenu', (e) => e.preventDefault());
        cell.addEventListener('click', () => {
            if (fired) { fired = false; return; } // the long-press ate this tap
            if (this.selectMode) this.toggleSelect(i);
            else this.openPreview(i);
        });
    }

    enterSelect(i) {
        this.selectMode = true;
        if (i !== undefined) this.selected.add(this.entries[i].name);
        document.getElementById('batchBar').style.display = '';
        this.updateSelectionUI();
    }

    exitSelect() {
        this.selectMode = false;
        this.selected.clear();
        document.getElementById('batchBar').style.display = 'none';
        this.updateSelectionUI();
    }

    toggleSelect(i) {
        const name = this.entries[i].name;
        if (!this.selected.delete(name)) this.selected.add(name);
        // Deselecting the last frame leaves select mode - a natural way
        // out in addition to the ✕ Done button
        if (!this.selected.size) { this.exitSelect(); return; }
        this.updateSelectionUI();
    }

    selectAllToggle() {
        if (this.selected.size === this.entries.length) this.selected.clear();
        else this.entries.forEach(e => this.selected.add(e.name));
        this.updateSelectionUI();
    }

    updateSelectionUI() {
        document.getElementById('batchCount').textContent =
            this.selected.size + ' selected';
        this.cells.forEach((cell, i) => {
            cell.classList.toggle('selected',
                this.selectMode && this.selected.has(this.entries[i].name));
        });
    }

    selectedEntries() {
        return this.entries.filter(e => this.selected.has(e.name));
    }

    // Corner dots: green = has saved settings, blue = exported
    updateBadge(i) {
        const entry = this.entries[i];
        const cell = this.cells[i];
        if (!cell || entry.size === undefined) return;
        const dots = cell.querySelector('.browse-dots');
        if (!dots) return;
        const dot = (cls, title) =>
            `<span class="dot ${cls}" title="${title}"></span>`;
        dots.innerHTML =
            (localStorage.getItem(filmSettingsKey(entry.name, entry.size))
                ? dot('edited', 'has settings') : '')
            + (localStorage.getItem(filmExportedKey(entry.name, entry.size))
                ? dot('exported', 'exported') : '');
    }

    updateBadges() {
        for (let i = 0; i < this.entries.length; i++) this.updateBadge(i);
    }

    toast(msg) {
        const el = document.getElementById('browseToast');
        el.textContent = msg;
        el.style.display = '';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
    }

    showProgress(on) {
        document.getElementById('batchBar').style.display = on ? 'none' : '';
        document.getElementById('batchProgress').style.display = on ? '' : 'none';
    }

    progressText(msg) {
        document.getElementById('batchProgressText').textContent = msg;
    }

    showPresetDialog() {
        if (!this.selectedEntries().length) { this.toast('Select frames first'); return; }
        const names = Object.keys(this.app.loadPresets()).sort();
        if (!names.length) {
            this.toast('No presets yet — save one in the editor first');
            return;
        }
        const list = document.getElementById('presetDialogList');
        list.innerHTML = '';
        for (const name of names) {
            const btn = document.createElement('button');
            btn.className = 'tb-btn';
            btn.textContent = name;
            btn.addEventListener('click', () => this.applyPresetToSelected(name));
            list.appendChild(btn);
        }
        document.getElementById('presetDialog').style.display = '';
    }

    async applyPresetToSelected(name) {
        document.getElementById('presetDialog').style.display = 'none';
        const preset = this.app.loadPresets()[name];
        const sel = this.selectedEntries();
        if (!preset || !sel.length) return;
        // Presets are saved without geometry or eyedropper points, but old
        // ones (or desktop-made ones) might carry straighten - strip it so
        // a preset never moves a frame's crop
        const look = stripGeometry(preset);
        for (const entry of sel) {
            const file = await entry.handle.getFile();
            entry.size = file.size;
            const merged = { ...(loadSavedSettings(file.name, file.size) || {}), ...look };
            saveSavedSettings(file.name, file.size, merged);
        }
        this.updateBadges();
        this.toast(`"${name}" applied to ${sel.length} frame${sel.length > 1 ? 's' : ''}`);
    }

    async autoCropSelected() {
        const sel = this.selectedEntries();
        if (!sel.length) { this.toast('Select frames first'); return; }
        this.showProgress(true);
        const res = await this.batch.autoCropAll(sel, (i, n, name) =>
            this.progressText(`Auto-cropping ${i + 1}/${n} — ${name}`));
        this.showProgress(false);
        this.updateBadges();
        this.toast(`Auto-cropped ${res.done}/${sel.length}`
            + (res.failed.length ? ` — no frame found in ${res.failed.length}` : ''));
    }

    showExportDialog() {
        if (!this.selectedEntries().length) { this.toast('Select frames first'); return; }
        document.getElementById('batchDialog').style.display = '';
    }

    async runExport() {
        document.getElementById('batchDialog').style.display = 'none';
        const sel = this.selectedEntries();
        if (!sel.length) return;
        const format = document.querySelector('input[name="batchFormat"]:checked').value;
        const autoCrop = document.getElementById('batchAutoCrop').checked;
        let dir = window.__batchOutDir || null; // test hook
        if (!dir) {
            if (!window.showDirectoryPicker) {
                this.toast('This browser cannot save to a folder');
                return;
            }
            try {
                // Called inside the Export tap: the picker needs a gesture
                dir = await window.showDirectoryPicker({
                    mode: 'readwrite', id: 'batch-export',
                });
            } catch (e) {
                if (e.name !== 'AbortError') this.toast('Could not open folder: ' + e.message);
                return;
            }
        }
        this.showProgress(true);
        const res = await this.batch.exportAll(sel, { format, autoCrop, dir },
            (i, n, name) => this.progressText(`Exporting ${i + 1}/${n} — ${name}`));
        this.showProgress(false);
        this.updateBadges();
        this.toast(`Exported ${res.done}/${sel.length}`
            + (res.failed.length ? ` — ${res.failed.length} failed` : ''));
    }

    async thumbUrl(entry) {
        const file = await entry.handle.getFile();
        entry.size = file.size; // needed for the settings/exported badges
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
