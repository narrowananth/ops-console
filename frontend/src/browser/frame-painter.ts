import type { Size } from './geometry';

type Frame = Size & { data: string };

/**
 * Draws the daemon's JPEG frames onto a canvas, newest first: while one decodes, the frames that arrive replace each
 * other, so a slow decode skips ahead instead of falling behind the page.
 */
export function createPainter(canvas: () => HTMLCanvasElement | null, onSize: (size: Size) => void) {
  let busy = false;
  let waiting: Frame | null = null;
  const paint = (frame: Frame): void => {
    if (busy) {
      waiting = frame;
      return;
    }
    busy = true;
    const image = new Image();
    const next = () => {
      busy = false;
      const queued = waiting;
      waiting = null;
      if (queued) paint(queued);
    };
    image.onload = () => {
      const target = canvas();
      if (target) {
        if (target.width !== frame.width || target.height !== frame.height) {
          target.width = frame.width;
          target.height = frame.height;
          onSize({ width: frame.width, height: frame.height });
        }
        target.getContext('2d')?.drawImage(image, 0, 0, frame.width, frame.height);
      }
      next();
    };
    image.onerror = next;
    image.src = `data:image/jpeg;base64,${frame.data}`;
  };
  return paint;
}
