import { FILL_VIEWPORT, VIEWPORT_PRESETS, type Viewport } from '@ops-console/shared';

export type Size = { width: number; height: number };
export type Box = { left: number; top: number; width: number; height: number };

const MIN_SIDE = 240;
const MAX_SIDE = 3840;

/** A side the daemon accepts, whole pixels. */
export const clampSide = (value: number): number => Math.round(Math.min(MAX_SIDE, Math.max(MIN_SIDE, value)));

/** A pixel ratio the daemon accepts: a zoomed-out page can report under 1, a zoomed-in one over 3. */
export const clampRatio = (value: number): number => Math.min(3, Math.max(1, value));

export const isFill = (viewport: Viewport): boolean => viewport.width === null || viewport.height === null;

/** How much to shrink `page` to fit `box`: never above 1, so a small page is not blown up. */
export function fitScale(page: Size, box: Size): number {
  if (page.width <= 0 || page.height <= 0 || box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / page.width, box.height / page.height);
}

/** A point on the drawn page (client pixels) as a point on the page itself (CSS pixels). */
export function toPagePoint(client: { x: number; y: number }, drawn: Box, page: Size): { x: number; y: number } {
  if (drawn.width <= 0 || drawn.height <= 0) return { x: 0, y: 0 };
  return {
    x: ((client.x - drawn.left) * page.width) / drawn.width,
    y: ((client.y - drawn.top) * page.height) / drawn.height,
  };
}

export function presetViewport(id: string): Viewport {
  const preset = VIEWPORT_PRESETS.find((one) => one.id === id);
  if (!preset) return FILL_VIEWPORT;
  return { preset: preset.id, width: preset.width, height: preset.height, scale: preset.scale, rotated: false };
}

export const customViewport = (width: number, height: number): Viewport => ({
  preset: null,
  width: clampSide(width),
  height: clampSide(height),
  scale: 1,
  rotated: false,
});

/** The same device on its side, or upright again. Fill has no sides. */
export const rotateViewport = (viewport: Viewport): Viewport =>
  isFill(viewport) ? viewport : { ...viewport, rotated: !viewport.rotated };

/** What the device button says: Fill, the preset's name, or `390×844`. */
export function viewportLabel(viewport: Viewport): string {
  if (viewport.width === null || viewport.height === null) return 'Fill';
  const preset = VIEWPORT_PRESETS.find((one) => one.id === viewport.preset);
  return preset ? preset.label : `${viewport.width}×${viewport.height}`;
}

/** The size the panel asks Chrome for in Fill: its own, whole pixels, within what the daemon accepts. */
export function fillSize(box: Size): Size | null {
  const width = Math.round(box.width);
  const height = Math.round(box.height);
  if (width < 100 || height < 100) return null;
  return { width: Math.min(3840, width), height: Math.min(3840, height) };
}
