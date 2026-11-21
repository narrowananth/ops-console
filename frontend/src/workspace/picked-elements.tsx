import { type ElementCapture, elementCaptureSchema, type PickedElement } from '@ops-console/shared';
import { z } from 'zod';
import { useStored } from '../lib/remember';
import type { useAttachments } from './attachments';

const pickedSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** The name of the crop among the message's attached files; null when the pick has no image. */
  crop: z.string().nullable(),
  capture: elementCaptureSchema.omit({ crop: true }),
});
export type Picked = z.infer<typeof pickedSchema>;

const LABEL_CHARS = 60;

/** `button#sign-in: Sign in`: the tag, its id or first class, and what it says. */
export function pickLabel(capture: Omit<ElementCapture, 'crop'>): string {
  const mark = capture.id ? `#${capture.id}` : capture.classes[0] ? `.${capture.classes[0]}` : '';
  const said = capture.text || capture.name;
  const label = `${capture.tag}${mark}${said ? `: ${said}` : ''}`.replace(/[\r\n/\\\]]+/g, ' ');
  return label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label;
}

function cropFile(base64: string, name: string): File {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new File([bytes], `${name}.jpg`, { type: 'image/jpeg' });
}

/**
 * The elements picked in the Browser panel for the message being written. Each crop is attached as an image, and the
 * pick's text goes into the message when it is sent. Kept with the Session through a reload until removed or sent.
 */
export function useElementPicks(sessionId: string, attachments: ReturnType<typeof useAttachments>) {
  const [picks, setPicks] = useStored(`workspace.element-picks.${sessionId}`, z.array(pickedSchema), []);
  return {
    picks,
    /** The picks as a message carries them. */
    forMessage: (): PickedElement[] => picks.map(({ crop, capture }) => ({ crop, capture })),
    add: (captures: ElementCapture[]) => {
      const taken = new Set(picks.map((pick) => pick.label));
      const fresh = captures.map((full) => {
        const { crop, ...capture } = full;
        const base = pickLabel(capture);
        let label = base;
        for (let n = 2; taken.has(label); n++) label = `${base} (${n})`;
        taken.add(label);
        return { id: crypto.randomUUID(), label, crop, capture };
      });
      // Files go under the names the attachments settle on, which can differ from the label.
      const names = attachments.add(fresh.flatMap((pick) => (pick.crop ? [cropFile(pick.crop, pick.label)] : [])));
      let next = 0;
      setPicks((now) => [
        ...now,
        ...fresh.map(({ id, label, crop, capture }) => ({
          id,
          label,
          capture,
          crop: crop ? (names[next++] ?? null) : null,
        })),
      ]);
    },
    remove: (id: string) => {
      const pick = picks.find((candidate) => candidate.id === id);
      if (pick?.crop) attachments.remove([pick.crop]);
      setPicks((now) => now.filter((candidate) => candidate.id !== id));
    },
    /** Takes the sent picks out; one picked while the message was going stays. */
    drop: (ids: string[]) => setPicks((now) => now.filter((pick) => !ids.includes(pick.id))),
  };
}

/** One chip per picked element: its crop, its label and a way to take it out. A chip opens its crop. */
export function PickedChips({
  picks,
  thumb,
  onOpen,
  onRemove,
}: {
  picks: Picked[];
  thumb: (name: string) => string | null;
  onOpen: (name: string) => void;
  onRemove: (id: string) => void;
}) {
  if (picks.length === 0) return null;
  return (
    <ul aria-label="Picked elements" className="m-0 flex list-none flex-wrap gap-1.5 px-3.5 pt-3 pb-0">
      {picks.map((pick) => {
        const src = pick.crop ? thumb(pick.crop) : null;
        return (
          <li
            key={pick.id}
            className="flex max-w-72 items-center gap-1.5 rounded-md border border-line bg-bg py-0.5 pr-0.5 pl-1 font-mono text-xs leading-5"
          >
            <button
              type="button"
              title={`${pick.capture.selector} on ${pick.capture.page_url}`}
              disabled={pick.crop === null}
              onClick={() => pick.crop && onOpen(pick.crop)}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left font-mono text-xs text-text disabled:cursor-default"
            >
              {src && <img src={src} alt="" className="size-5 flex-none rounded-sm object-cover" />}
              <span className="min-w-0 truncate">{pick.label}</span>
            </button>
            <button
              type="button"
              aria-label={`Remove ${pick.label}`}
              title={`Remove ${pick.label}`}
              onClick={() => onRemove(pick.id)}
              className="flex size-4.5 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-neutral-700 hover:bg-neutral-200 hover:text-text"
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}
