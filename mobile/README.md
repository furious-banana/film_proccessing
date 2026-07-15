# Film Processor — Mobile

A standalone, fully client-side version of the film processor that runs
entirely on your phone. No PC, no server — decoding, editing and 16-bit
TIFF export all happen in the browser.

It is completely separate from the desktop app; nothing here touches the
code in `src/`, `static/` or `templates/`.

## How it works

- **Same pipeline as the desktop app.** The WebGL fragment shader is
  identical (levels → exposure → tone → contrast → color → curves), and
  export reads the shader's own output back from a float framebuffer, so
  what you see is what you export.
- 16-bit TIFF decode via [UTIF.js](https://github.com/photopea/UTIF.js)
  (vendored, MIT); Adobe RGB scans are converted to sRGB on load, like
  the desktop app.
- Export writes an uncompressed 16-bit RGB TIFF (or a JPEG for quick
  sharing) and hands it to the system share sheet.
- **Working resolution is capped at 4096 px** on the long side — phones
  can't hold a 22-megapixel float pipeline in browser memory. Use the
  desktop app when you need full-resolution output.

## Features

Negative/Photo modes, film base correction, tone + RGB sliders,
black/gray/white eyedroppers with a magnifying loupe, RGB + per-channel
curves, crop with degree-level straightening, 90° rotation, undo,
presets (same format as the desktop app), press-and-hold before/after.
Folder browser with batch tools: long-press thumbnails to multi-select,
then apply a preset, auto-crop, or export the whole selection.

**Settings sync with the PC**: browsing is read-only; the first time an
edit saves, the app asks for write access to the folder, and from then on
every edit saves a `<image>_settings.json` sidecar next to the scan —
the same file the desktop app auto-loads and saves.

**Roll metadata**: the 🎞️ button in the browser records the roll's film
stock, camera, ISO, date and notes as a `roll.json` in the scans folder,
so the info travels with the roll. It shows under the folder name and is
stamped into exported TIFFs as their description tag (JPEG exports carry
no metadata). Whichever device
saved last wins, and crops made on the phone survive a PC round-trip
(the desktop app doesn't touch them).

## Putting it on your phone

The app is static files — it needs any HTTPS host. The easiest free way:

### GitHub Pages

1. Push this repo to GitHub.
2. Repo → Settings → Pages → deploy from branch, folder `/ (root)`.
3. On your phone, open `https://<you>.github.io/<repo>/mobile/`.
4. **iPhone:** Share → *Add to Home Screen*.
   **Android:** Chrome menu → *Install app*.

After the first visit the service worker caches everything, so the app
works with no connection at all.

> If the repo is private, use any static host instead (Netlify /
> Cloudflare Pages free tiers work the same way).

### Quick try without hosting (online-only)

From the repo root on your PC: `npx serve .` then open
`http://<pc-ip>:3000/mobile/` on your phone. Editing works, but
"Add to Home Screen"/offline requires HTTPS, so use Pages for the real
install.

## Development

Automated test: `node tests/mobile_drive.mjs` drives the app in an
Electron window, exercises every control, and cross-checks an exported
TIFF pixel-for-pixel against the desktop Python pipeline.
