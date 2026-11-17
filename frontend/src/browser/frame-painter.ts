import type { Size } from './geometry';
import type { PageFrame } from './use-page-stream';

/**
 * Draws the daemon's JPEG frames onto a canvas, newest first: while one decodes, the frames that arrive replace each
 * other, so a slow decode skips ahead instead of falling behind the page.
 */
export function createPainter(canvas: () => HTMLCanvasElement | null, onSize: (size: Size) => void) {
  let busy = false;
  let waiting: PageFrame | null = null;
  const paint = async (frame: PageFrame): Promise<void> => {
    if (busy) {
      waiting = frame;
      return;
    }
    busy = true;
    try {
      // Decoded off the main thread; a frame that is not a picture is skipped.
      const image = await createImageBitmap(new Blob([frame.jpeg], { type: 'image/jpeg' }));
      const target = canvas();
      if (target) {
        if (target.width !== frame.width || target.height !== frame.height) {
          target.width = frame.width;
          target.height = frame.height;
          onSize({ width: frame.width, height: frame.height });
        }
        target.getContext('2d')?.drawImage(image, 0, 0, frame.width, frame.height);
      }
      image.close();
    } catch {
      // The next frame replaces it.
    } finally {
      busy = false;
      const queued = waiting;
      waiting = null;
      if (queued) void paint(queued);
    }
  };
  return (frame: PageFrame): void => void paint(frame);
}
