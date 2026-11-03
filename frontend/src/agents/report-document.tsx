import { ReportKind } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { FoldTitle, useFold } from '../components/ui/fold';
import { Markdown } from '../components/ui/markdown';
import { COPY_FAILED, copyLabel, useCopy } from '../lib/clipboard';

/** What a Report's kind means, shown on hover of its chip. */
export const REPORT_KIND_TIP: Record<ReportKind, string> = {
  [ReportKind.Bug]: 'The agent judged this a bug: the code does something wrong.',
  [ReportKind.Improvement]: 'The agent judged this an improvement: the code works, but could handle this case better.',
};

const isKind = (kind: string | null): kind is ReportKind =>
  (Object.values(ReportKind) as string[]).includes(kind ?? '');

export type AgentReport = { title: string; kind: string | null; markdown: string; raw: string };

/** An agent's JSON answer that carries a `markdown` Report, as a Verification asks for; null for any other text. */
export function asReport(text: string): AgentReport | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== 'object' || value === null) return null;
    const fields = value as Record<string, unknown>;
    if (typeof fields.markdown !== 'string' || fields.markdown.trim() === '') return null;
    return {
      title: typeof fields.slug === 'string' && fields.slug !== '' ? fields.slug : 'report',
      kind: typeof fields.kind === 'string' ? fields.kind : null,
      markdown: fields.markdown,
      raw: JSON.stringify(value, null, 2),
    };
  } catch {
    return null;
  }
}

/** A Report drawn as a document: a file bar with Copy, Download and the raw JSON, then the Markdown. */
export function ReportDocument({ report }: { report: AgentReport }) {
  const [raw, setRaw] = useState(false);
  const [copied, copy] = useCopy();
  const [folded, toggle] = useFold('report-document');
  const file = `${report.title}.md`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([report.markdown], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <article aria-label={file} className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
      <header
        className={`flex flex-wrap items-center gap-2 bg-surface px-4 py-2 ${folded ? '' : 'border-b border-line'}`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="flex-none text-neutral-600">
          <path
            d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        <FoldTitle label={file} folded={folded} onToggle={toggle}>
          <strong className="min-w-0 truncate font-mono text-xs">{file}</strong>
        </FoldTitle>
        {report.kind && (
          <span
            title={isKind(report.kind) ? REPORT_KIND_TIP[report.kind] : undefined}
            className="rounded-full bg-neutral-200 px-2 py-px text-[10px] font-bold tracking-[0.06em] text-neutral-700 uppercase"
          >
            {report.kind}
          </span>
        )}
        <span className="ml-auto flex gap-1.5">
          <Button
            className="px-2.5 py-1 text-xs"
            aria-pressed={raw}
            title={raw ? 'Show the Report as a document' : "Show the agent's raw JSON answer"}
            onClick={() => setRaw(!raw)}
          >
            {raw ? 'Document' : 'JSON'}
          </Button>
          <Button
            className="px-2.5 py-1 text-xs"
            title={copied === 'failed' ? COPY_FAILED : "Copy the Report's Markdown"}
            onClick={() => copy(report.markdown)}
          >
            {copyLabel(copied, 'Copy')}
          </Button>
          <Button className="px-2.5 py-1 text-xs" title={`Save the Report as ${file}`} onClick={download}>
            Download .md
          </Button>
        </span>
      </header>
      {folded ? null : raw ? (
        <pre className="m-0 max-h-[60vh] overflow-auto p-4 font-mono text-xs whitespace-pre-wrap">{report.raw}</pre>
      ) : (
        <Markdown source={report.markdown} className="max-w-[80ch] px-6 py-5" />
      )}
    </article>
  );
}
