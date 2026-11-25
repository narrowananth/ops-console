export type SortDirection = 'asc' | 'desc';

/** CSV or TSV text as rows of cells: quotes hold a delimiter, a line break or a doubled quote. Short rows are padded to the first. */
export function parseDelimited(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    // A blank line is no row.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[at + 1] === '"') {
        cell += '"';
        at++;
      } else quoted = false;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at++;
      endRow();
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) endRow();
  const width = rows[0]?.length ?? 0;
  return rows.map((cells) =>
    cells.length < width ? [...cells, ...Array<string>(width - cells.length).fill('')] : cells,
  );
}

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** The rows ordered by one column, numbers as numbers; no direction keeps the file's order. */
export function sortRows(rows: string[][], column: number, direction: SortDirection | null): string[][] {
  if (direction === null) return rows;
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[column] ?? '';
    const right = b[column] ?? '';
    const both = NUMBER.test(left.trim()) && NUMBER.test(right.trim());
    return sign * (both ? Number(left) - Number(right) : left.localeCompare(right, undefined, { numeric: true }));
  });
}
