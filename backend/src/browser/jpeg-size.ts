/**
 * The pixel size a base64 JPEG says it has, from its first start-of-frame marker, or `null` when the head holds none.
 * Reads only the start of the data: the marker sits within the first few hundred bytes.
 */
export function jpegSize(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64.slice(0, 8192), 'base64');
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}
