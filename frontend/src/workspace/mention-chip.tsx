import { CHIP_CLASS, CUBE_PATH, describeMention } from './mentions';

/** A `$skill` or `@file` mention drawn as a chip: the skill's name, or the file's name with its path in the tip. */
export function MentionChip({ raw }: { raw: string }) {
  const { kind, label, title, badge } = describeMention(raw);
  return (
    <span
      data-mention={raw}
      role="img"
      aria-label={`${kind === 'skill' ? 'Skill' : 'File'} ${label}`}
      title={title}
      className={CHIP_CLASS[kind]}
    >
      {kind === 'skill' ? (
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          aria-hidden
          className="flex-none"
        >
          <path d={CUBE_PATH} />
        </svg>
      ) : (
        <span aria-hidden data-badge={badge || 'FILE'} className={CHIP_CLASS.badge} />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
