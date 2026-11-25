import { useState } from 'react';
import { AttachmentViewer } from './attachment-viewer';
import { CodeBlock } from './code-block';
import { blockFile } from './viewer/kinds';

/** A fenced block of the agent's text. A language the Viewer draws gets an Expand button that opens the block there. */
export function FencedBlock({ lang, text, className }: { lang: string; text: string; className: string }) {
  const [open, setOpen] = useState(false);
  const name = blockFile(lang);
  return (
    <>
      <CodeBlock text={text} className={className} onExpand={name === null ? undefined : () => setOpen(true)} />
      {open && name !== null && <AttachmentViewer viewed={{ name, text }} onClose={() => setOpen(false)} />}
    </>
  );
}
