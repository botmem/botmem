import { CONNECTOR_COLORS, formatTime } from '@botmem/shared';
import type { Memory } from '@botmem/shared';
import { MemoryScoreBadge } from './memoryScores';

const FACTUALITY_COLORS: Record<string, string> = {
  FACT: 'var(--color-nb-green)',
  UNVERIFIED: 'var(--color-nb-yellow)',
  FICTION: 'var(--color-nb-red)',
};

interface TimelineMemoryItemProps {
  memory: Memory;
  selected: boolean;
  onClick: () => void;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstAttachment(metadata: Record<string, unknown>): Record<string, unknown> {
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  const attachment = attachments.find((item) => item && typeof item === 'object');
  return (attachment as Record<string, unknown> | undefined) ?? {};
}

function section(text: string, label: string): string {
  const start = text.indexOf(label);
  if (start < 0) return '';
  return text
    .slice(start + label.length)
    .split(/\n\s*\n/)
    .at(0)
    ?.trim() ?? '';
}

function cleanFileSnippet(memory: Memory): { title: string; snippet: string } | null {
  if (memory.source !== 'file') return null;

  const metadata = memory.metadata ?? {};
  const attachment = firstAttachment(metadata);
  const title =
    firstText(metadata.fileName, metadata.filename, attachment.fileName, attachment.filename) ||
    'File result';
  const linkedDocs = Array.isArray(metadata.linkedDocuments) ? metadata.linkedDocuments : [];
  const linkedSummary = firstText(
    ...(linkedDocs as Record<string, unknown>[]).map((doc) => doc.searchSummary),
  );
  const raw = memory.text || '';
  const candidate =
    linkedSummary ||
    section(raw, 'Document summary:') ||
    section(raw, 'Extracted document text:') ||
    section(raw, 'Message context:') ||
    raw;
  const snippet = candidate
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^(File from|Connector:|Original source type:|Media type:|MIME type:|Filename:|Linked file \d+|Extraction warnings:)/i.test(
          line,
        ) &&
        !line.startsWith('{'),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  // ponytail: display-only cleanup; move to API if more result card types need it.
  return { title, snippet: snippet || 'No extracted preview available' };
}

export function TimelineMemoryItem({ memory, selected, onClick }: TimelineMemoryItemProps) {
  const connColor = CONNECTOR_COLORS[memory.sourceConnector] || '#888';
  const fileDisplay = cleanFileSnippet(memory);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left p-3 border-b-2 border-nb-border font-mono text-xs cursor-pointer transition-colors ${
        selected
          ? 'bg-nb-surface-hover border-l-4 border-l-nb-lime'
          : 'bg-nb-surface hover:bg-nb-surface-hover border-l-4 border-l-transparent'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="size-2.5 shrink-0" style={{ backgroundColor: connColor }} />
        <span className="font-bold uppercase text-[11px] text-nb-muted">
          {memory.sourceConnector}
        </span>
        <span className="text-nb-muted text-[11px] ml-auto">{formatTime(memory.time)}</span>
        <MemoryScoreBadge weights={memory.weights} />
      </div>
      {fileDisplay && (
        <div className="font-display text-xs font-bold uppercase text-nb-text mb-1 truncate">
          {fileDisplay.title}
        </div>
      )}
      <p className="text-nb-text line-clamp-2 text-[11px] mb-1">
        {fileDisplay?.snippet ?? memory.text}
      </p>
      <div className="flex gap-1 flex-wrap">
        {memory.people?.slice(0, 3).map((p) => (
          <span key={p.personId} className="border border-nb-border px-1 text-[9px] text-nb-muted">
            {p.displayName}
          </span>
        ))}
        {memory.factuality?.label && memory.factuality.label !== 'UNVERIFIED' && (
          <span
            className="text-[9px] font-bold px-1"
            style={{ color: FACTUALITY_COLORS[memory.factuality.label] }}
          >
            {memory.factuality.label}
          </span>
        )}
      </div>
    </button>
  );
}
