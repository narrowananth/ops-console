const ATTACHMENT = /\[📎 [^\]\n]+\]/g;
const FENCE = /```[\s\S]*?(```|$)/g;
const LEAD_IN =
  /^(?:(?:hey|hi|hello|ok(?:ay)?|so|please|kindly)[,\s]+|(?:can|could|would|will) you (?:please )?|i (?:want|need|would like) you to |i (?:want|need) to |let'?s |help me (?:to )?)+/i;

export const MAX_TITLE = 52;

/**
 * A short name for a Session from its first message: the first sentence without attachment chips, code blocks or
 * filler openers, cut at a word. A message of attachments alone is named for them.
 */
export function sessionTitle(text: string): string | null {
  const body = text.replace(FENCE, ' ').replace(ATTACHMENT, ' ');
  const line = body
    .split('\n')
    .map((part) => part.replace(/^[\s>#*\-\d.)]+/, '').trim())
    .find(Boolean);
  if (line === undefined) return /\[📎 [^\]\n]+\]/.test(text) ? 'Attached files' : null;
  const sentence = (line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line).replace(/[.!?:;,\s]+$/, '');
  const plain = sentence.replace(LEAD_IN, '').replace(/\s+/g, ' ').trim() || sentence;
  return shortTitle(plain.charAt(0).toUpperCase() + plain.slice(1));
}

/** A title cut at a word within `MAX_TITLE` characters. */
export function shortTitle(text: string): string {
  const titled = text.replace(/\s+/g, ' ').trim();
  if (titled.length <= MAX_TITLE) return titled;
  const cut = titled.slice(0, MAX_TITLE);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 24)).replace(/[.,;:\s]+$/, '')}…`;
}
