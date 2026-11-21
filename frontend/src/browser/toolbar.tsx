import { FILL_VIEWPORT, type Tab, TabAction, VIEWPORT_PRESETS, type Viewport } from '@ops-console/shared';
import { useState } from 'react';
import { z } from 'zod';
import { useStored } from '../lib/remember';
import { clampSide, customViewport, isFill, presetViewport, rotateViewport, viewportLabel } from './geometry';
import { isLoopbackUrl } from './loopback';
import { MenuButton, MenuHeading, MenuItem, MenuRule } from './menu-button';
import { isBlank } from './tabs';

/** Where a link in the conversation opens. Kept per browser. */
export const LINK_TARGETS = ['app', 'system'] as const;
export type LinkTarget = (typeof LINK_TARGETS)[number];
export const LINK_TARGET_KEY = 'browser.link-target';

export function useLinkTarget() {
  return useStored<LinkTarget>(LINK_TARGET_KEY, z.enum(LINK_TARGETS), 'app');
}

const ROUND =
  'flex size-7 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-sm text-neutral-700 hover:bg-neutral-200 hover:text-text disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';

/**
 * Back, forward and reload (stop while loading), the address field, the device menu, the window button, External and
 * the menu with the link setting. With no tab, only the address field works: an address makes the first tab. A tab's own
 * window passes neither `onWindow` nor `onClear`: it has no window button, and the menu (link setting, cookies) stays
 * the panel's.
 */
export function Toolbar({
  tab,
  chromeMissing,
  error,
  onAction,
  onAddress,
  onViewport,
  onWindow,
  onExternal,
  onClear,
}: {
  tab: Tab | undefined;
  chromeMissing: boolean;
  /** Why the last address was refused, from the daemon. */
  error: string | null;
  onAction: (action: TabAction) => void;
  onAddress: (text: string) => void;
  onViewport: (viewport: Viewport) => void;
  onWindow?: () => void;
  onExternal: () => void;
  onClear?: () => void;
}) {
  const [linkTarget, setLinkTarget] = useLinkTarget();
  const [custom, setCustom] = useState(false);
  const viewport = tab?.viewport;
  const blank = tab === undefined || isBlank(tab);
  return (
    <div className="@container border-b border-line">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          disabled={!tab?.can_back}
          onClick={() => onAction(TabAction.Back)}
          className={ROUND}
        >
          ←
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          disabled={!tab?.can_forward}
          onClick={() => onAction(TabAction.Forward)}
          className={ROUND}
        >
          →
        </button>
        {tab?.loading ? (
          <button
            type="button"
            aria-label="Stop"
            title="Stop loading"
            onClick={() => onAction(TabAction.Stop)}
            className={ROUND}
          >
            ×
          </button>
        ) : (
          <button
            type="button"
            aria-label="Reload"
            title="Reload"
            disabled={blank}
            onClick={() => onAction(TabAction.Reload)}
            className={ROUND}
          >
            ↻
          </button>
        )}
        <AddressField
          // A tab's own draft: another tab starts from its address.
          key={tab?.id ?? 'none'}
          address={tab?.url ?? ''}
          disabled={chromeMissing}
          placeholder={chromeMissing ? 'Google Chrome is needed' : 'Type an address or pick a server'}
          invalid={error !== null}
          focus={blank}
          onSubmit={onAddress}
        />
        <MenuButton
          label="Device"
          title="Page size: the panel's own, or a phone, tablet or desktop"
          disabled={tab === undefined}
          width="w-60"
          menuChildren={(close) => (
            <DeviceMenu
              viewport={viewport}
              custom={custom}
              setCustom={setCustom}
              onPick={(next) => {
                close();
                setCustom(false);
                onViewport(next);
              }}
            />
          )}
        >
          <span aria-hidden className="text-neutral-600">
            ▭
          </span>
          <span className="max-w-28 truncate">{viewport ? viewportLabel(viewport) : 'Fill'}</span>
          <span aria-hidden className="text-neutral-600">
            ▾
          </span>
        </MenuButton>
        {onWindow && (
          <button
            type="button"
            aria-label="Open in a window"
            title="Open this tab in a window of its own"
            disabled={tab === undefined}
            onClick={onWindow}
            className={ROUND}
          >
            ⛶
          </button>
        )}
        <button
          type="button"
          title={blank ? 'Nothing is loaded yet' : 'Open this address in your own browser'}
          disabled={blank}
          onClick={onExternal}
          className="flex flex-none cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-xs font-semibold text-text hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span aria-hidden>↗</span>
          <span className="hidden @md:inline">External</span>
        </button>
        {onClear && (
          <MenuButton
            label="Browser menu"
            width="w-64"
            className="[&>button]:border-transparent [&>button]:bg-transparent"
            menuChildren={(close) => (
              <>
                <MenuHeading>Open links</MenuHeading>
                <MenuItem
                  selected={linkTarget === 'app'}
                  onClick={() => {
                    close();
                    setLinkTarget('app');
                  }}
                >
                  In the console
                </MenuItem>
                <MenuItem
                  selected={linkTarget === 'system'}
                  onClick={() => {
                    close();
                    setLinkTarget('system');
                  }}
                >
                  In the external browser
                </MenuItem>
                <MenuRule />
                <MenuItem
                  title="Signs this Session out of every site it logged in to"
                  onClick={() => {
                    close();
                    onClear();
                  }}
                >
                  Clear this Session's cookies
                </MenuItem>
              </>
            )}
          >
            <span aria-hidden>⋯</span>
          </MenuButton>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="m-0 px-3.5 pb-1.5 text-xs text-accent-700">
          {error}
        </p>
      )}
      {tab?.loading && <div aria-hidden className="h-0.5 animate-pulse bg-accent" />}
    </div>
  );
}

function AddressField({
  address,
  placeholder,
  disabled,
  invalid,
  focus,
  onSubmit,
}: {
  address: string;
  placeholder: string;
  disabled: boolean;
  invalid: boolean;
  focus: boolean;
  onSubmit: (text: string) => void;
}) {
  // What the operator is typing; null while the field shows the page's own address.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <form
      className="relative min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        const text = (draft ?? address).trim();
        if (text === '') return;
        setDraft(null);
        onSubmit(text);
      }}
    >
      {!disabled && (
        <span
          aria-hidden
          className={`absolute top-1/2 left-3 size-2 -translate-y-1/2 rounded-full ${isLoopbackUrl(address) ? 'bg-ok' : 'bg-neutral-400'}`}
        />
      )}
      <input
        type="text"
        aria-label="Address"
        aria-invalid={invalid}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={draft ?? address}
        // biome-ignore lint/a11y/noAutofocus: a blank tab opens to be typed in
        autoFocus={focus}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => setDraft(null)}
        className={`w-full min-w-0 rounded-full border bg-surface py-1 pr-3 font-mono text-xs text-text outline-none focus:border-accent-400 disabled:opacity-60 ${disabled ? 'pl-3' : 'pl-7'} ${invalid ? 'border-accent-400' : 'border-line'}`}
      />
    </form>
  );
}

function DeviceMenu({
  viewport,
  custom,
  setCustom,
  onPick,
}: {
  viewport: Viewport | undefined;
  custom: boolean;
  setCustom: (custom: boolean) => void;
  onPick: (viewport: Viewport) => void;
}) {
  const fill = viewport === undefined || isFill(viewport);
  const [width, setWidth] = useState(String(viewport?.width ?? 390));
  const [height, setHeight] = useState(String(viewport?.height ?? 844));
  const isCustom = !fill && viewport?.preset === null;
  return (
    <>
      <MenuHeading>Device</MenuHeading>
      <MenuItem selected={fill} onClick={() => onPick(FILL_VIEWPORT)}>
        Fill
      </MenuItem>
      {VIEWPORT_PRESETS.map((preset) => (
        <MenuItem
          key={preset.id}
          selected={viewport?.preset === preset.id}
          hint={`${preset.width}×${preset.height}`}
          onClick={() => onPick(presetViewport(preset.id))}
        >
          {preset.label}
        </MenuItem>
      ))}
      <MenuItem selected={isCustom} onClick={() => setCustom(!custom)}>
        Custom size…
      </MenuItem>
      {custom && (
        <form
          className="flex items-center gap-1.5 px-2.5 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const w = Number(width);
            const h = Number(height);
            if (Number.isFinite(w) && Number.isFinite(h)) onPick(customViewport(clampSide(w), clampSide(h)));
          }}
        >
          <SizeField label="Width" value={width} onChange={setWidth} />
          <span aria-hidden className="text-neutral-600">
            ×
          </span>
          <SizeField label="Height" value={height} onChange={setHeight} />
          <button
            type="submit"
            className="ml-auto cursor-pointer rounded-md border border-divider bg-card px-2.5 py-1 text-xs font-semibold shadow-sm hover:bg-neutral-200"
          >
            Set
          </button>
        </form>
      )}
      <MenuItem
        selected={!fill && viewport?.rotated === true}
        disabled={fill}
        title={fill ? 'Pick a device first' : 'Turn the device on its side'}
        onClick={() => viewport && onPick(rotateViewport(viewport))}
      >
        Rotate
      </MenuItem>
    </>
  );
}

function SizeField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="number"
      aria-label={label}
      min={240}
      max={3840}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-16 rounded-md border border-divider bg-bg px-2 py-1 font-mono text-xs text-text outline-none focus:border-accent-400"
    />
  );
}
