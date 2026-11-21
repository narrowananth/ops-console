import type { Size } from './geometry';
import type { PageFrame } from './use-page-stream';

/**
 * Draws the daemon's JPEG frames onto a canvas, newest first: while one decodes, the frames that arrive replace each
 * other, so a slow decode skips ahead instead of falling behind the page. The canvas holds the frame's own pixels, so a
 * sharp frame stays sharp, and it is never cleared between frames: a frame of another size replaces the last in one
 * step. `onPage` gets the page's CSS size each time it changes, which is not the canvas's size.
 */
export function createPainter(canvas: () => HTMLCanvasElement | null, onPage: (page: Size) => void) {
  let busy = false;
  let page: Size | null = null;
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
        if (target.width !== image.width || target.height !== image.height) {
          target.width = image.width;
          target.height = image.height;
        }
        // An opaque canvas that may present ahead of the compositor: the least between a frame arriving and showing.
        target.getContext('2d', { alpha: false, desynchronized: true })?.drawImage(image, 0, 0);
        if (page?.width !== frame.width || page.height !== frame.height) {
          page = { width: frame.width, height: frame.height };
          onPage(page);
        }
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

const LAST_FRAMES = 12;
const lastFrames = new Map<string, PageFrame>();

/** The newest frame of each recently watched tab, so a tab switch or a reopened panel draws at once while a fresh frame comes. */
export const frameCache = {
  remember(tabId: string, frame: PageFrame): void {
    lastFrames.delete(tabId);
    lastFrames.set(tabId, frame);
    const oldest = lastFrames.keys().next().value;
    if (lastFrames.size > LAST_FRAMES && oldest !== undefined) lastFrames.delete(oldest);
  },
  recall: (tabId: string): PageFrame | undefined => lastFrames.get(tabId),
};
