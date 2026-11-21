import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A static page for measuring the streamed page. A green background (never white, so a white canvas is a blank one), a
 * hover block whose CSS `:hover` turns it black, an input that writes its text length into a barcode, and a page tall
 * enough to scroll that writes its scroll position into the same barcode. The barcode is 16 cells of 3vw along the top:
 * a frame at any scale decodes to the same number.
 */
export const LAB_PAGE = `<!doctype html><title>Lab</title><style>
html, body { margin: 0; height: 100%; background: #2e7d32; font: 16px system-ui }
#bar { position: fixed; left: 0; top: 0; width: 100vw; height: 6vh }
#bar i { position: absolute; top: 0; width: 3vw; height: 6vh; background: #fff }
#bar i.on { background: #000 }
#hov { position: fixed; left: 40vw; top: 40vh; width: 20vw; height: 20vh; background: #fff; border: 0; font-size: 20px }
#hov:hover { background: #000; color: #fff }
#f { position: fixed; left: 40vw; top: 70vh; width: 20vw; font-size: 20px }
#tall { height: 30000px }
</style><div id="bar"></div><button id="hov">Hover</button><input id="f" aria-label="Field"><div id="tall"></div>
<script>
const bar = document.getElementById('bar');
for (let i = 0; i < 16; i += 1) { const cell = document.createElement('i'); cell.style.left = i * 3 + 'vw'; bar.append(cell); }
const show = (value) => [...bar.children].forEach((cell, i) => cell.classList.toggle('on', Boolean((value >> i) & 1)));
document.getElementById('f').addEventListener('input', (event) => show(event.target.value.length));
addEventListener('scroll', () => show(Math.round(scrollY / 4)), { passive: true });
</script>`;

export class LabServer {
  private readonly server: Server = createServer((req, res) => {
    const title = new URL(req.url ?? '/', 'http://x').searchParams.get('title') ?? 'Lab';
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(LAB_PAGE.replace('<title>Lab</title>', `<title>${title}</title>`));
  });
  origin = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

export type Draw = {
  t: number;
  canvas: number;
  cw: number;
  ch: number;
  /** The stage's CSS size at the time, in device pixels. */
  stageW: number;
  stageH: number;
  code: number;
  /** The pixel at the middle of the canvas: [r, g, b, a]. */
  mid: [number, number, number, number];
  /** Luma at the middle of the canvas, where the hover block is. */
  hover: number;
  /** Whether the frame's pixels are the stage's size, within Chrome's rounding. */
  fits: boolean;
};
export type Stamp = { t: number; type: string; n: number };
export type FrameIn = { t: number; w: number; h: number; bytes: number };
export type Sent = { t: number; type: string; width?: number; height?: number };

export type ProbeData = {
  draws: Draw[];
  events: Stamp[];
  frames: FrameIn[];
  sent: Sent[];
  /** rAF ticks, with whether the stage had a canvas, whether it had drawn, and whether its last frame fitted. */
  ticks: { t: number; has: boolean; drawn: boolean; fits: boolean; blank: boolean; stretch: number }[];
  origin: number;
};

/** Runs in every page of the console, before its own code: records what the canvas shows, and when. */
export function installProbe(): void {
  const probe: ProbeData & { sampling: boolean } = {
    draws: [],
    events: [],
    frames: [],
    sent: [],
    ticks: [],
    origin: performance.timeOrigin,
    sampling: false,
  };
  Object.assign(window, { __probe: probe });
  const ids = new WeakMap<HTMLCanvasElement, number>();
  const lastDraw = new Map<number, Draw>();
  let counter = 0;
  const near = (got: number, want: number) => Math.abs(got - want) <= Math.max(3, want * 0.02);
  const fitsStage = (canvas: HTMLCanvasElement) => {
    const stage = canvas.parentElement;
    if (!stage) return false;
    const dpr = window.devicePixelRatio;
    return near(canvas.width, stage.clientWidth * dpr) && near(canvas.height, stage.clientHeight * dpr);
  };
  const draw = CanvasRenderingContext2D.prototype.drawImage as (...args: unknown[]) => void;
  CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    draw.apply(this, args);
    const canvas = this.canvas;
    if (!(canvas instanceof HTMLCanvasElement) || canvas.getAttribute('aria-label') === null) return;
    if (!ids.has(canvas)) ids.set(canvas, ++counter);
    let code = 0;
    let mid: [number, number, number, number] = [0, 0, 0, 0];
    let hover = -1;
    try {
      const row = this.getImageData(0, Math.floor(canvas.height * 0.03), canvas.width, 1).data;
      for (let i = 0; i < 16; i += 1) {
        const x = Math.min(canvas.width - 1, Math.floor((canvas.width * (i * 3 + 1.5)) / 100));
        const luma = (row[x * 4] ?? 0) * 0.3 + (row[x * 4 + 1] ?? 0) * 0.59 + (row[x * 4 + 2] ?? 0) * 0.11;
        if (luma < 128) code |= 1 << i;
      }
      const m = this.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height * 0.9), 1, 1).data;
      mid = [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] ?? 0];
      const h = this.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      hover = (h[0] ?? 0) * 0.3 + (h[1] ?? 0) * 0.59 + (h[2] ?? 0) * 0.11;
    } catch {
      // A canvas that cannot be read is recorded without a code.
    }
    const stage = canvas.parentElement;
    const dpr = window.devicePixelRatio;
    const entry: Draw = {
      t: performance.now(),
      canvas: ids.get(canvas) ?? 0,
      cw: canvas.width,
      ch: canvas.height,
      stageW: (stage?.clientWidth ?? 0) * dpr,
      stageH: (stage?.clientHeight ?? 0) * dpr,
      code,
      mid,
      hover,
      fits: fitsStage(canvas),
    };
    probe.draws.push(entry);
    lastDraw.set(entry.canvas, entry);
  } as typeof CanvasRenderingContext2D.prototype.drawImage;

  for (const type of ['mousemove', 'keydown', 'wheel', 'click', 'mouseup']) {
    let n = 0;
    window.addEventListener(type, () => probe.events.push({ t: performance.now(), type, n: ++n }), { capture: true });
  }

  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
    if (this.url.includes('/browser/') && typeof data === 'string' && data.startsWith('{"type":"resize"')) {
      const message = JSON.parse(data) as { width: number; height: number };
      probe.sent.push({ t: performance.now(), type: 'resize', width: message.width, height: message.height });
    }
    send.call(this, data);
  };
  const Native = window.WebSocket;
  class Watched extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (String(url).includes('/browser/')) {
        this.addEventListener('message', (event) => {
          if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 8) return;
          const view = new DataView(event.data);
          probe.frames.push({
            t: performance.now(),
            w: view.getUint32(0),
            h: view.getUint32(4),
            bytes: event.data.byteLength,
          });
        });
      }
    }
  }
  window.WebSocket = Watched;

  // Every animation frame says whether the stage has something drawn that fits it.
  let ticking = false;
  const tick = () => {
    ticking = true;
    requestAnimationFrame(tick);
    const canvas = document.querySelector('canvas[aria-label]');
    const has = canvas instanceof HTMLCanvasElement;
    let drawn = false;
    let fits = false;
    let blank = false;
    let stretch = 0;
    if (has) {
      const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
      const held = canvas.width / Math.max(1, canvas.height);
      stretch = Math.abs(aspect / held - 1);
      const last = lastDraw.get(ids.get(canvas) ?? -1);
      drawn = last !== undefined;
      fits = drawn && fitsStage(canvas);
      // Blank is what the operator sees: a canvas on screen that holds no page yet, or a white page where there is none.
      const onScreen = canvas.clientWidth > 0 && getComputedStyle(canvas).visibility === 'visible';
      blank =
        onScreen &&
        (!drawn ||
          last?.mid[3] === 0 ||
          ((last?.mid[0] ?? 0) > 245 && (last?.mid[1] ?? 0) > 245 && (last?.mid[2] ?? 0) > 245));
    }
    probe.ticks.push({ t: performance.now(), has, drawn, fits, blank, stretch });
  };
  // A window the console opens may not run an animation frame requested before its document is ready.
  requestAnimationFrame(tick);
  document.addEventListener('DOMContentLoaded', () => {
    if (!ticking) requestAnimationFrame(tick);
  });
  setTimeout(() => {
    if (!ticking) requestAnimationFrame(tick);
  }, 1000);
}

export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
};

export const summary = (values: number[]) => ({
  n: values.length,
  p50: Math.round(percentile(values, 50)),
  p90: Math.round(percentile(values, 90)),
  max: Math.round(Math.max(...values)),
});
