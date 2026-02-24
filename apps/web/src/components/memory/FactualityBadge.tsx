import type { FactualityLabel } from '@botmem/shared';
import { Badge } from '../ui/Badge';

const factualityColors: Record<FactualityLabel, string> = {
  FACT: '#22C55E',
  UNVERIFIED: '#FFE66D',
  FICTION: '#EF4444',
};

export function FactualityBadge({ label }: { label: FactualityLabel }) {
  return <Badge color={factualityColors[label]}>{label}</Badge>;
}
