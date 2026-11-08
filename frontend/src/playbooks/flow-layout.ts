/** Where each node of a Playbook's flow sits: one line of nodes that wraps to a new row at the canvas width. */
export const NODE = { w: 180, h: 120, gapX: 44, gapY: 56, pad: 28 };

export type FlowNode =
  | { kind: 'trigger' }
  | { kind: 'empty' }
  | { kind: 'step'; index: number }
  | { kind: 'closing' }
  | { kind: 'end' };

export type Placed = { x: number; y: number; row: number; reversed: boolean };

/** An arrow from one node to the next, and the point in its middle where a step can be added before step `at`. */
export type Edge = { d: string; at: number; x: number; y: number };

/** Rows run left to right, then right to left, so the line never jumps back across the canvas. */
export function layoutFlow(nodes: FlowNode[], width: number, top: number) {
  const { w, h, gapX, gapY, pad } = NODE;
  const columns = Math.max(2, Math.floor((width - pad * 2 + gapX) / (w + gapX)));
  const placed: Placed[] = nodes.map((_, k) => {
    const row = Math.floor(k / columns);
    const at = k % columns;
    const column = row % 2 ? columns - 1 - at : at;
    return { x: pad + column * (w + gapX), y: top + row * (h + gapY), row, reversed: row % 2 === 1 };
  });
  const rows = Math.floor((nodes.length - 1) / columns) + 1;
  const edges: Edge[] = [];
  for (let k = 0; k < nodes.length - 1; k += 1) {
    const a = placed[k];
    const b = placed[k + 1];
    if (!a || !b) continue;
    if (a.row === b.row) {
      const y = a.y + h / 2;
      const x1 = a.reversed ? a.x : a.x + w;
      const x2 = a.reversed ? b.x + w : b.x;
      edges.push({ d: `M${x1},${y} L${x2},${y}`, at: k, x: (x1 + x2) / 2, y });
    } else {
      const x = a.x + w / 2;
      edges.push({ d: `M${x},${a.y + h} L${x},${b.y}`, at: k, x, y: (a.y + h + b.y) / 2 });
    }
  }
  return { placed, edges, height: top + rows * (h + gapY) - gapY + 40 };
}
