import type { ElementCapture } from '@ops-console/shared';
import type { CDPSession } from 'playwright-core';
import type { WebSocket } from 'ws';
import { captureElement, elementAt, scrolled, within } from './element-capture';

const CROP_QUALITY = 70;
const HIGHLIGHT = {
  contentColor: { r: 111, g: 168, b: 220, a: 0.35 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.3 },
  borderColor: { r: 255, g: 120, b: 40, a: 0.9 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.25 },
  showInfo: true,
};

export type PickHost = {
  cdp: CDPSession;
  /** The page's CSS size and device scale now. */
  size(): { width: number; height: number; scale: number };
  /** Runs `work` in turn with the size changes, so a crop and the size it is read at cannot disagree. */
  turn<T>(work: () => Promise<T>): Promise<T>;
};

/**
 * Pick mode for one tab: a viewer in pick mode has the element under its pointer highlighted by Chrome's own overlay,
 * which the screencast carries to every viewer, and a click takes that element as an `ElementCapture`. The click goes to
 * this, never to the page.
 */
export class ElementPicker {
  private readonly viewers = new Set<WebSocket>();
  private shown: number | null = null;
  private next: { x: number; y: number } | null = null;
  private moving: Promise<void> | null = null;

  constructor(private readonly host: PickHost) {}

  has(viewer: WebSocket): boolean {
    return this.viewers.has(viewer);
  }

  async start(viewer: WebSocket): Promise<void> {
    if (this.viewers.has(viewer)) return;
    const first = this.viewers.size === 0;
    this.viewers.add(viewer);
    if (!first) return;
    await this.host.cdp.send('DOM.enable');
    await this.host.cdp.send('Overlay.enable');
  }

  /** Leaves pick mode for a viewer; the overlay goes when the last one leaves. */
  async end(viewer: WebSocket): Promise<void> {
    if (!this.viewers.delete(viewer) || this.viewers.size > 0) return;
    this.next = null;
    await this.moving?.catch(() => {});
    await this.hide();
    await this.host.cdp.send('Overlay.disable').catch(() => {});
    await this.host.cdp.send('DOM.disable').catch(() => {});
  }

  /** Highlights what is at the point. Moves that arrive while one is in flight replace each other. */
  hover(x: number, y: number): void {
    this.next = { x, y };
    if (this.moving) return;
    this.moving = this.follow().finally(() => {
      this.moving = null;
    });
  }

  private async follow(): Promise<void> {
    for (let point = this.next; point; point = this.next) {
      this.next = null;
      const node = await elementAt(this.host.cdp, point.x, point.y);
      if (node === this.shown) continue;
      this.shown = node;
      if (node === null) await this.hide();
      else
        await this.host.cdp
          .send('Overlay.highlightNode', { backendNodeId: node, highlightConfig: HIGHLIGHT })
          .catch(() => {});
    }
  }

  private async hide(): Promise<void> {
    this.shown = null;
    await this.host.cdp.send('Overlay.hideHighlight').catch(() => {});
  }

  /** Takes the element at the point; pick mode stays on. Null when the point is on the page itself. */
  async click(x: number, y: number): Promise<ElementCapture | null> {
    this.next = null;
    await this.moving?.catch(() => {});
    const node = await elementAt(this.host.cdp, x, y);
    if (node === null) return null;
    // The outline is part of the page's pixels, so it goes before the crop is taken; the next hover draws it again.
    await this.hide();
    return captureElement(this.host.cdp, node, (clip, scale) => this.crop(clip, scale), this.host.size());
  }

  private crop(clip: { x: number; y: number; width: number; height: number }, scale: number): Promise<string> {
    return this.host.turn(async () => {
      // The page is drawn at its device scale; the crop is read at one pixel per CSS pixel, or fewer for a large element.
      const at = await scrolled(this.host.cdp);
      const { data } = await within(
        this.host.cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: CROP_QUALITY,
          clip: { ...clip, x: clip.x + at.x, y: clip.y + at.y, scale: scale / this.host.size().scale },
        }),
      );
      return data;
    });
  }
}
