/** Agent text with its inline Markdown drawn: `**bold**` and `` `code` ``. Anything else shows as written. */
export function InlineText({ text, codeClassName = '' }: { text: string; codeClassName?: string }) {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).map((piece, index) => {
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
    return piece;
  });
}
