import { describe, expect, it } from 'vitest';
import { jpegSize } from '../src/browser/jpeg-size';

// A JPEG head: SOI, an APP0 segment, then SOF0 for a 790 x 1400 image (height first, then width).
const head = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x05, 0x78, 0x03, 0x16, 0x01, 0x01,
  0x11, 0x00,
]);

describe('jpegSize', () => {
  it('reads the size from the start-of-frame marker after other segments', () => {
    expect(jpegSize(head.toString('base64'))).toEqual({ width: 790, height: 1400 });
  });

  it('answers null for data that is not a JPEG head', () => {
    expect(jpegSize(Buffer.from('not a jpeg at all, just text').toString('base64'))).toBeNull();
    expect(jpegSize('')).toBeNull();
  });
});
