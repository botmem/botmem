import { cn } from '@botmem/shared';
import type { SyncSchedule } from '@botmem/shared';

interface SyncSchedulePickerProps {
  value: SyncSchedule;
  onChange: (s: SyncSchedule) => void;
}

const options: Array<{ value: SyncSchedule; label: string; desc: string }> = [
  { value: 'hourly', label: 'HOURLY', desc: 'Near real-time' },
  { value: 'every-6h', label: 'EVERY 6H', desc: 'Balanced' },
  { value: 'daily', label: 'DAILY', desc: 'Low bandwidth' },
  { value: 'manual', label: 'MANUAL', desc: 'On demand only' },
];

export function SyncSchedulePicker({ value, onChange }: SyncSchedulePickerProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'border-3 border-nb-border p-4 text-left cursor-pointer transition-all',
            value === opt.value
              ? 'bg-nb-lime text-black shadow-nb-sm translate-x-[2px] translate-y-[2px]'
              : 'bg-nb-surface text-nb-text shadow-nb hover:translate-x-[1px] hover:translate-y-[1px]'
          )}
        >
          <div className="font-display text-sm font-bold">{opt.label}</div>
          <div className={cn('font-mono text-xs mt-1', value === opt.value ? 'text-black/60' : 'text-nb-muted')}>{opt.desc}</div>
        </button>
      ))}
    </div>
  );
}
