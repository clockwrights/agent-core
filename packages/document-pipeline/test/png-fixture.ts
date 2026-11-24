// ---------------------------------------------------------------------------
// Minimal valid PNG header for MIME-sniffing tests.
//
// file-type (22+) checks PNG structure, not just the 8-byte signature: it
// needs an IHDR chunk. This builds the signature plus a well-formed IHDR
// chunk (1×1, 8-bit RGB, correct CRC), followed by padding.
// ---------------------------------------------------------------------------

import { crc32 } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngBuffer(paddingBytes = 50): Buffer {
  const type = Buffer.from("IHDR", "ascii");
  const data = Buffer.from([
    0, 0, 0, 1, // width 1
    0, 0, 0, 1, // height 1
    8, // bit depth
    2, // colour type: RGB
    0, // compression
    0, // filter
    0, // interlace
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([PNG_SIGNATURE, length, type, data, crc, Buffer.alloc(paddingBytes)]);
}
