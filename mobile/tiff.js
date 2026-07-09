// Minimal 16-bit RGB TIFF encoder (uncompressed, little-endian, single
// strip) - mirrors what the desktop app exports via tifffile.

'use strict';

// pixels: Float32Array RGB [0,1] -> Uint8Array of a complete .tif file
function encodeTiff16(pixels, width, height) {
    const numTags = 8;
    const headerSize = 8;
    const ifdSize = 2 + numTags * 12 + 4;
    const bitsOffset = headerSize + ifdSize;      // BitsPerSample [16,16,16]
    const dataOffset = bitsOffset + 6;
    const dataSize = width * height * 3 * 2;

    const buf = new ArrayBuffer(dataOffset + dataSize);
    const view = new DataView(buf);
    let p = 0;

    // Header: little-endian TIFF, IFD right after
    view.setUint8(p++, 0x49); view.setUint8(p++, 0x49);  // 'II'
    view.setUint16(p, 42, true); p += 2;
    view.setUint32(p, headerSize, true); p += 4;

    // IFD
    view.setUint16(p, numTags, true); p += 2;
    const tag = (id, type, count, value) => {
        view.setUint16(p, id, true); p += 2;
        view.setUint16(p, type, true); p += 2;   // 3=SHORT, 4=LONG
        view.setUint32(p, count, true); p += 4;
        if (type === 3 && count === 1) {
            view.setUint16(p, value, true); p += 4;
        } else {
            view.setUint32(p, value, true); p += 4;
        }
    };
    tag(256, 4, 1, width);        // ImageWidth
    tag(257, 4, 1, height);       // ImageLength
    tag(258, 3, 3, bitsOffset);   // BitsPerSample -> [16,16,16]
    tag(259, 3, 1, 1);            // Compression: none
    tag(262, 3, 1, 2);            // Photometric: RGB
    tag(273, 4, 1, dataOffset);   // StripOffsets
    tag(277, 3, 1, 3);            // SamplesPerPixel
    tag(279, 4, 1, dataSize);     // StripByteCounts
    view.setUint32(p, 0, true); p += 4;  // next IFD: none

    // BitsPerSample values
    view.setUint16(bitsOffset, 16, true);
    view.setUint16(bitsOffset + 2, 16, true);
    view.setUint16(bitsOffset + 4, 16, true);

    // Pixel data: float [0,1] -> uint16, rounded (matches np.rint on desktop)
    const out16 = new Uint16Array(buf, dataOffset, width * height * 3);
    for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        out16[i] = Math.round(Math.min(1, Math.max(0, v)) * 65535);
    }

    return new Uint8Array(buf);
}
