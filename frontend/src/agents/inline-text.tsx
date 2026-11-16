import type { ReactNode } from 'react';
import { useBrowserPanel } from '../browser/browser-links';
import { isLoopbackUrl, isWebUrl } from '../browser/loopback';

const PIECES = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>`]+)/;
const MARKDOWN_LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;
/** Punctuation that ends a sentence, not a bare address. */
const TRAILING = /[.,;:!?)\]'"]+$/;

/**
 * A link in agent text. A loopback page opens in the Session's Browser panel when the Session has one and the operator
 * keeps links "In the console"; any other link, and a click with Cmd, Ctrl, Shift or Alt, opens a new tab of the
 * operator's own browser.
 */
function TextLink({ href, children }: { href: string; children: ReactNode }) {
  const panel = useBrowserPanel();
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-info underline break-all"
      onClick={(event) => {
        if (!panel || !isLoopbackUrl(href)) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        panel.open(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Agent text with its inline Markdown drawn: `**bold**`, `` `code` `` and links, `[text](url)` or a bare `http(s)://`
 * address. Anything else shows as written.
 */
export function InlineText({ text, codeClassName = '' }: { text: string; codeClassName?: string }) {
  return text.split(PIECES).map((piece, index) => {
    if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces sit by position and never reorder
      return <strong key={index}>{piece.slice(2, -2)}</strong>;
    }
    if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: pieces sit by position and never reorder
        <code key={index} className={`font-mono ${codeClassName}`}>
          {piece.slice(1, -1)}
        </code>
      );
    }
    const link = MARKDOWN_LINK.exec(piece);
    if (link?.[1] && link[2] && isWebUrl(link[2])) {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: pieces sit by position and never reorder
        <TextLink key={index} href={link[2]}>
          {link[1]}
        </TextLink>
      );
    }
    if (/^https?:\/\//.test(piece)) {
      const address = piece.replace(TRAILING, '');
      if (isWebUrl(address)) {
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces sit by position and never reorder
          <span key={index}>
            <TextLink href={address}>{address}</TextLink>
            {piece.slice(address.length)}
          </span>
        );
      }
    }
    return piece;
  });
}
