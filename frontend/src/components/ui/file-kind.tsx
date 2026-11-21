export type FileKind = 'image' | 'video' | 'audio' | 'document' | 'text' | 'archive' | 'file';

const BY_EXTENSION: [FileKind, RegExp][] = [
  ['image', /\.(avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)$/i],
  ['video', /\.(avi|m4v|mkv|mov|mp4|mpe?g|webm)$/i],
  ['audio', /\.(aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav)$/i],
  ['document', /\.(docx?|key|numbers|odp|ods|odt|pages|pdf|pptx?|rtf|xlsx?)$/i],
  ['archive', /\.(7z|bz2|gz|rar|tar|tgz|xz|zip)$/i],
  [
    'text',
    /\.(c|conf|cpp|css|csv|diff|go|h|html?|ini|java|jsonl?|jsx?|kt|log|md|mjs|patch|py|rb|rs|scss|sh|sql|swift|toml|tsv|tsx?|txt|xml|ya?ml)$/i,
  ],
];

/** What a file is, from its name: the browser's own type is often empty for anything but a picture. */
export function kindOf(name: string): FileKind {
  return BY_EXTENSION.find(([, pattern]) => pattern.test(name))?.[0] ?? 'file';
}

const PATHS: Record<FileKind, string> = {
  image: 'M4 5h16v14H4zM4 16l4.5-4.5L13 16l3-3 4 4M15.5 9.5h.01',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  audio: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  document: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  text: 'M6 4h12v16H6zM9 9h6M9 13h6M9 17h3',
  archive: 'M4 7h16v13H4zM3 4h18v3H3zM10 11h4',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
};

/** A small line icon for a kind of file. */
export function FileKindIcon({ kind, size = 18 }: { kind: FileKind; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="flex-none"
    >
      <path d={PATHS[kind]} />
    </svg>
  );
}
