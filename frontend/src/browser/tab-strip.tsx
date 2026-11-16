import { type Tab, TabOpener } from '@ops-console/shared';
import { useState } from 'react';
import { isBlank } from './tabs';

/** One tab's face: its favicon, or a grey square while there is none. */
function Favicon({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  if (src === null || broken) return <span aria-hidden className="size-3.5 flex-none rounded-sm bg-neutral-400" />;
  return (
    <img
      src={src}
      alt=""
      width={14}
      height={14}
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="size-3.5 flex-none rounded-sm"
    />
  );
}

/**
 * The panel's tabs: each page's favicon and title, a tag on one the agent opened, a close, and a plus for a new one.
 * With no tab yet the strip shows a blank "New tab" that is not a tab until an address is typed.
 */
export function TabStrip({
  tabs,
  activeId,
  onPick,
  onClose,
  onNew,
}: {
  tabs: Tab[];
  activeId: string | undefined;
  onPick: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div role="tablist" aria-label="Browser tabs" className="flex items-end gap-1 overflow-x-auto bg-surface px-2 pt-2">
      {tabs.length === 0 && (
        <span className="flex max-w-48 items-center gap-2 rounded-t-lg border border-b-0 border-line bg-bg px-3 py-1.5 text-xs font-semibold">
          <Favicon src={null} />
          New tab
        </span>
      )}
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={`flex max-w-52 min-w-0 flex-none items-center gap-2 rounded-t-lg border border-b-0 py-1.5 pr-1.5 pl-3 text-xs ${
              selected ? 'border-line bg-bg font-semibold' : 'border-transparent text-neutral-700 hover:bg-neutral-200'
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              title={tab.url || undefined}
              onClick={() => onPick(tab.id)}
              className="flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-inherit"
            >
              <Favicon src={tab.favicon} />
              <span className="min-w-0 truncate">{tab.title || (isBlank(tab) ? 'New tab' : tab.url)}</span>
              {tab.opened_by === TabOpener.Agent && (
                <span
                  title="The agent opened this tab"
                  className="flex-none rounded-full bg-accent-200 px-1.5 text-[10px] font-semibold text-accent-800"
                >
                  agent
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title || 'tab'}`}
              title="Close the tab"
              onClick={() => onClose(tab.id)}
              className="flex size-4 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-neutral-600 hover:bg-neutral-300 hover:text-text"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New tab"
        title="New tab"
        onClick={onNew}
        className="mb-1 flex size-6 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-neutral-700 hover:bg-neutral-200 hover:text-text"
      >
        +
      </button>
    </div>
  );
}
