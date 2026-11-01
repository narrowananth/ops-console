import type { Playbook, PlaybookTrigger } from '@ops-console/shared';
import type { DragEvent } from 'react';
import type { DraftStep } from './drafts';

/** What is being dragged on the page, and from where. */
export type Drag =
  | { kind: 'block'; step: DraftStep }
  | { kind: 'step'; index: number }
  | { kind: 'playbook'; playbook: Playbook }
  | { kind: 'chip'; trigger: PlaybookTrigger };

/** Starts a drag the page's own drop targets read; the text keeps Firefox dragging. */
export function startDrag(event: DragEvent, drag: Drag, setDrag: (drag: Drag) => void) {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', drag.kind);
  setDrag(drag);
}

/** Leaving for a child of the target is not leaving. */
export const leftFor = (event: DragEvent) =>
  !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget));

export function Grip() {
  return (
    <span aria-hidden className="flex-none cursor-grab text-xs tracking-[-2px] text-neutral-500 select-none">
      ⋮⋮
    </span>
  );
}
