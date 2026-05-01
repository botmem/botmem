type CountValue = number | string | null | undefined;

function toCountNumber(value: CountValue): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function formatIntegerNumber(value: CountValue): string {
  return toCountNumber(value).toLocaleString();
}

export function formatCompactNumber(value: CountValue): string {
  const safeValue = toCountNumber(value);

  if (safeValue < 10_000) return safeValue.toLocaleString();
  if (safeValue < 1_000_000) {
    return `${(safeValue / 1_000).toFixed(safeValue < 100_000 ? 1 : 0)}k`;
  }
  if (safeValue < 1_000_000_000) {
    return `${(safeValue / 1_000_000).toFixed(safeValue < 100_000_000 ? 1 : 0)}M`;
  }
  return `${(safeValue / 1_000_000_000).toFixed(1)}B`;
}
