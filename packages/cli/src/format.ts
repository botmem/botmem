/**
 * ANSI formatting helpers and human-readable output formatters.
 * No external dependencies — uses ANSI escape codes directly.
 */

const isColor = process.stdout.isTTY !== false && !process.env['NO_COLOR'];

import { encode } from '@toon-format/toon';

/**
 * Convert data to TOON format for LLM-optimized output (--toon mode).
 * Uses @toon-format/toon for 40-60% token savings.
 * Pre-parses JSON-encoded strings so they're included as real objects.
 */
export function toonify(data: unknown): string {
  const cleaned = parseJsonStringsDeep(data);
  return encode(cleaned);
}

function parseJsonStringsDeep(val: unknown): unknown {
  if (val == null) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null) return parseJsonStringsDeep(parsed);
    } catch {
      /* not JSON */
    }
    return val;
  }
  if (Array.isArray(val)) return val.map(parseJsonStringsDeep);
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v != null) out[k] = parseJsonStringsDeep(v);
    }
    return out;
  }
  return val;
}

const esc = (code: string) => (s: string) => (isColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = esc('2');
export const bold = esc('1');
export const green = esc('32');
export const red = esc('31');
export const yellow = esc('33');
export const cyan = esc('36');
export const magenta = esc('35');
export const white = esc('37');

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '\u2026';
}

function statusDot(status: string): string {
  switch (status) {
    case 'done':
    case 'completed':
    case 'active':
      return green('\u25cf');
    case 'running':
      return yellow('\u25cf');
    case 'failed':
      return red('\u25cf');
    case 'queued':
    case 'waiting':
      return dim('\u25cb');
    default:
      return dim('\u25cb');
  }
}

function progressBar(progress: number | null, total: number | null, width = 20): string {
  if (progress == null || total == null || total === 0) return '';
  const pct = Math.min(progress / total, 1);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return (
    dim('[') +
    green('\u2588'.repeat(filled)) +
    dim('\u2591'.repeat(empty)) +
    dim(']') +
    ` ${Math.round(pct * 100)}%`
  );
}

function commaNum(n: number): string {
  return n.toLocaleString('en-US');
}

// --- Public formatters ---

export function formatSearchResults(
  results: Array<{
    id: string;
    text: string;
    sourceType: string;
    connectorType: string;
    eventTime: string;
    score?: number;
    weights?: { final: number };
  }>,
): string {
  if (!results.length) return dim('No results found.');
  return results
    .map((r, i) => {
      const score = r.weights?.final ?? r.score ?? 0;
      const header = `${bold(`#${i + 1}`)} ${dim(`(${score.toFixed(4)})`)} ${dim(`[${r.sourceType}/${r.connectorType}]`)} ${dim(timeAgo(r.eventTime))}`;
      const body = `  ${truncate(r.text, 120)}`;
      const id = `  ${dim(r.id)}`;
      return `${header}\n${body}\n${id}`;
    })
    .join('\n\n');
}

export function formatMemory(m: {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  eventTime: string;
  importance: number | null;
  factuality: string | null;
  embeddingStatus: string;
  entities: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`${bold('Memory')} ${dim(m.id)}`);
  lines.push(`${dim('Source:')}  ${m.sourceType}/${m.connectorType}`);
  lines.push(`${dim('Time:')}    ${m.eventTime} ${dim(`(${timeAgo(m.eventTime)})`)}`);
  if (m.importance != null) lines.push(`${dim('Import:')}  ${m.importance}`);
  if (m.factuality) lines.push(`${dim('Factual:')} ${m.factuality}`);
  lines.push(`${dim('Embed:')}   ${m.embeddingStatus}`);
  if (m.entities) {
    try {
      const ents = JSON.parse(m.entities);
      if (Array.isArray(ents) && ents.length) {
        lines.push(
          `${dim('Entities:')} ${ents.map((e: Record<string, unknown>) => e.value || e.name || e.id || String(e)).join(', ')}`,
        );
      }
    } catch {
      /* non-JSON entities, skip */
    }
  }
  lines.push('');
  lines.push(m.text);
  return lines.join('\n');
}

export function formatMemoryList(
  items: Array<{
    id: string;
    text: string;
    sourceType: string;
    connectorType: string;
    eventTime: string;
  }>,
  total: number,
): string {
  if (!items.length) return dim('No memories found.');
  const lines = items.map((m) => {
    return `${dim(timeAgo(m.eventTime).padEnd(8))} ${dim(`[${m.sourceType}/${m.connectorType}]`.padEnd(20))} ${truncate(m.text, 80)}  ${dim(m.id)}`;
  });
  lines.push('');
  lines.push(dim(`Showing ${items.length} of ${commaNum(total)}`));
  return lines.join('\n');
}

export function formatContact(c: {
  id: string;
  displayName: string;
  identifiers: Array<{ identifierType: string; identifierValue: string }>;
  memoryCount?: number;
}): string {
  const lines: string[] = [];
  lines.push(`${bold(c.displayName)} ${dim(c.id)}`);
  for (const ident of c.identifiers) {
    lines.push(`  ${dim(ident.identifierType.padEnd(10))} ${ident.identifierValue}`);
  }
  if (c.memoryCount != null) lines.push(`  ${dim('memories')}   ${c.memoryCount}`);
  return lines.join('\n');
}

export function formatContactList(
  items: Array<{
    id: string;
    displayName: string;
    identifiers: Array<{ identifierType: string; identifierValue: string }>;
  }>,
  total: number,
): string {
  if (!items.length) return dim('No contacts found.');
  const lines = items.map((c) => {
    const idents = c.identifiers
      .slice(0, 3)
      .map((i) => i.identifierValue)
      .join(', ');
    return `${bold(c.displayName.padEnd(25))} ${dim(idents)}  ${dim(c.id)}`;
  });
  lines.push('');
  lines.push(dim(`Showing ${items.length} of ${commaNum(total)}`));
  return lines.join('\n');
}

export function formatJob(j: {
  id: string;
  connector: string;
  accountIdentifier: string | null;
  status: string;
  progress: number | null;
  total: number | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}): string {
  const parts = [
    statusDot(j.status),
    j.status.padEnd(8),
    j.connector.padEnd(12),
    (j.accountIdentifier || '').padEnd(25),
  ];
  if (j.status === 'running') {
    parts.push(progressBar(j.progress, j.total));
  } else if (j.completedAt) {
    parts.push(dim(timeAgo(j.completedAt)));
  } else if (j.startedAt) {
    parts.push(dim(timeAgo(j.startedAt)));
  }
  if (j.error) {
    parts.push(red(truncate(j.error, 40)));
  }
  return parts.join(' ');
}

export function formatJobList(
  jobs: Array<{
    id: string;
    connector: string;
    accountIdentifier: string | null;
    status: string;
    progress: number | null;
    total: number | null;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
  }>,
): string {
  if (!jobs.length) return dim('No jobs found.');
  return jobs.map(formatJob).join('\n');
}

export function formatStats(stats: {
  total: number;
  bySource: Record<string, number>;
  byConnector: Record<string, number>;
  byFactuality: Record<string, number>;
}): string {
  const lines: string[] = [];
  lines.push(`${bold('Total:')} ${commaNum(stats.total)}`);
  lines.push('');
  lines.push(bold('By Source:'));
  for (const [k, v] of Object.entries(stats.bySource)) {
    lines.push(`  ${k.padEnd(15)} ${commaNum(v)}`);
  }
  lines.push('');
  lines.push(bold('By Connector:'));
  for (const [k, v] of Object.entries(stats.byConnector)) {
    lines.push(`  ${k.padEnd(15)} ${commaNum(v)}`);
  }
  lines.push('');
  lines.push(bold('By Factuality:'));
  for (const [k, v] of Object.entries(stats.byFactuality)) {
    lines.push(`  ${k.padEnd(15)} ${commaNum(v)}`);
  }
  return lines.join('\n');
}

export function formatAccounts(
  accounts: Array<{
    id: string;
    type: string;
    identifier: string;
    status: string;
    lastSync: string | null;
    memoriesIngested: number | null;
  }>,
): string {
  if (!accounts.length) return dim('No connected accounts.');
  return accounts
    .map((a) => {
      return `${statusDot(a.status)} ${a.type.padEnd(12)} ${a.identifier.padEnd(30)} ${dim('synced ' + timeAgo(a.lastSync))}  ${commaNum(a.memoriesIngested ?? 0)} memories  ${dim(a.id)}`;
    })
    .join('\n');
}

export function formatVersion(v: { buildTime: string; gitHash: string; uptime: number }): string {
  const secs = v.uptime;
  const days = Math.floor(secs / 86400);
  const hrs = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hrs) parts.push(`${hrs}h`);
  parts.push(`${mins}m`);
  const uptimeStr = parts.join(' ');

  const lines: string[] = [];
  lines.push(`${bold('Botmem API')}`);
  lines.push(`${dim('Build:')}   ${v.buildTime}`);
  lines.push(`${dim('Hash:')}    ${v.gitHash}`);
  lines.push(`${dim('Uptime:')}  ${uptimeStr}`);
  return lines.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatAgentAnswer(data: any): string {
  const lines: string[] = [];

  // Show temporal fallback notice
  if (data.parsed?.temporalFallback && data.parsed?.temporal) {
    const from = new Date(data.parsed.temporal.from).toLocaleString();
    const to = new Date(data.parsed.temporal.to).toLocaleString();
    lines.push(dim(`No memories found between ${from} and ${to}.`));
    lines.push(dim('Showing general results instead:'));
    lines.push('');
  }

  if (data.answer) {
    lines.push(bold('Answer'));
    lines.push(data.answer);
    lines.push('');
  }
  if (data.summary) {
    lines.push(bold('Summary'));
    lines.push(data.summary);
    lines.push('');
  }
  const results = data.results || data.memories || [];
  if (results.length) {
    lines.push(dim(`Sources (${results.length}):`));
    for (const r of results.slice(0, 10)) {
      lines.push(
        `  ${dim(`[${r.sourceType}/${r.connectorType}]`)} ${truncate(r.text, 100)}  ${dim(timeAgo(r.eventTime))}`,
      );
    }
  }
  if (!lines.length) return dim('No results.');
  return lines.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatAgentContext(data: any): string {
  const lines: string[] = [];
  if (data.contact) {
    lines.push(bold(data.contact.displayName || 'Unknown'));
    if (data.contact.identifiers?.length) {
      for (const id of data.contact.identifiers) {
        lines.push(`  ${dim(id.identifierType.padEnd(10))} ${id.identifierValue}`);
      }
    }
  }
  if (data.stats) {
    lines.push('');
    lines.push(dim('Stats:'));
    for (const [k, v] of Object.entries(data.stats)) {
      lines.push(`  ${dim(k.padEnd(15))} ${v}`);
    }
  }
  if (data.recentMemories?.length) {
    lines.push('');
    lines.push(dim(`Recent memories (${data.recentMemories.length}):`));
    for (const m of data.recentMemories.slice(0, 10)) {
      lines.push(`  ${dim(timeAgo(m.eventTime).padEnd(8))} ${truncate(m.text, 90)}`);
    }
  }
  if (!lines.length) return dim('No context found.');
  return lines.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatMemoryBanks(banks: any[]): string {
  if (!banks.length) return dim('No memory banks.');
  const lines = banks.map((b: any) => {
    return `${bold(String(b.name).padEnd(25))} ${dim(String(b.memoryCount ?? 0).padStart(5) + ' memories')}  ${dim(b.id)}`;
  });
  lines.push('');
  lines.push(dim(`${banks.length} bank(s)`));
  return lines.join('\n');
}

export function formatStatus(
  stats: { total: number; bySource: Record<string, number> },
  queues: Record<string, { waiting: number; active: number; failed: number }>,
  accounts: Array<{
    id: string;
    type: string;
    identifier: string;
    status: string;
    lastSync: string | null;
    memoriesIngested: number | null;
  }>,
): string {
  const lines: string[] = [];
  lines.push(bold('BOTMEM STATUS'));
  lines.push(dim('\u2500'.repeat(40)));

  const srcBreakdown = Object.entries(stats.bySource)
    .map(([k, v]) => `${k}: ${commaNum(v)}`)
    .join(', ');
  lines.push(`${dim('Memories:')}  ${commaNum(stats.total)}  ${dim(`(${srcBreakdown})`)}`);

  let totalActive = 0,
    totalWaiting = 0,
    totalFailed = 0;
  for (const q of Object.values(queues)) {
    totalActive += q.active;
    totalWaiting += q.waiting;
    totalFailed += q.failed;
  }
  lines.push(
    `${dim('Pending:')}   ${totalActive + totalWaiting}  ${dim(`(${totalActive} active, ${totalWaiting} waiting)`)}`,
  );
  lines.push(`${dim('Failed:')}    ${totalFailed}`);

  if (accounts.length) {
    lines.push('');
    lines.push(dim('Connectors:'));
    for (const a of accounts) {
      lines.push(
        `  ${statusDot(a.status)} ${a.type.padEnd(12)} ${a.identifier.padEnd(25)} ${dim('synced ' + timeAgo(a.lastSync))}  ${commaNum(a.memoriesIngested ?? 0)} memories`,
      );
    }
  }

  return lines.join('\n');
}
