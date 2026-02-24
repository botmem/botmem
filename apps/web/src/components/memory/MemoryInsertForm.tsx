import { useState } from 'react';
import { cn } from '@botmem/shared';
import type { SourceType, Memory } from '@botmem/shared';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

const sourceTypes: Array<{ value: SourceType; label: string; icon: string }> = [
  { value: 'email', label: 'EMAIL', icon: '✉' },
  { value: 'message', label: 'MESSAGE', icon: '💬' },
  { value: 'photo', label: 'PHOTO', icon: '📷' },
  { value: 'location', label: 'LOCATION', icon: '📍' },
];

interface MemoryInsertFormProps {
  onInsert: (m: Memory) => void;
}

export function MemoryInsertForm({ onInsert }: MemoryInsertFormProps) {
  const [source, setSource] = useState<SourceType>('message');
  const [text, setText] = useState('');
  const [time, setTime] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // The store's insertMemory sends {text, sourceType, connectorType} to the API
    // and converts the response back to a Memory object
    onInsert({
      id: '',
      source,
      sourceConnector: 'manual',
      text,
      time: time || new Date().toISOString(),
      ingestTime: new Date().toISOString(),
      factuality: { label: 'UNVERIFIED', confidence: 0.5, rationale: 'Manually inserted' },
      weights: { semantic: 0, rerank: 0, recency: 1, importance: 0.5, trust: 0.5, final: 0.5 },
      entities: [],
      claims: [],
      metadata: {},
    } as Memory);
    setText('');
    setTime('');
    setSubmitted(true);
    setTimeout(() => setSubmitted(false), 2000);
  };

  return (
    <Card>
      <h3 className="font-display text-lg font-bold uppercase mb-4 text-nb-text">Insert Memory</h3>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="font-display text-xs font-bold uppercase tracking-wider block mb-2 text-nb-text">
            Source Type
          </label>
          <div className="grid grid-cols-4 gap-2">
            {sourceTypes.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setSource(s.value)}
                className={cn(
                  'border-3 border-nb-border p-3 text-center cursor-pointer transition-all',
                  source === s.value
                    ? 'bg-nb-lime text-black shadow-nb-sm translate-x-[2px] translate-y-[2px]'
                    : 'bg-nb-surface text-nb-text shadow-nb hover:translate-x-[1px] hover:translate-y-[1px]'
                )}
              >
                <span className="text-xl block">{s.icon}</span>
                <span className="font-mono text-xs font-bold">{s.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="font-display text-xs font-bold uppercase tracking-wider block mb-2 text-nb-text">
            Memory Text
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full border-3 border-nb-border p-4 font-mono text-sm bg-nb-surface text-nb-text focus:outline-none focus:shadow-nb-sm min-h-[120px] resize-y placeholder:text-nb-muted placeholder:uppercase"
            placeholder="ENTER THE MEMORY CONTENT..."
            required
          />
        </div>

        <Input
          label="Event Time"
          type="datetime-local"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />

        <Button type="submit" size="lg">
          {submitted ? '✓ INSERTED' : 'INSERT MEMORY'}
        </Button>
      </form>
    </Card>
  );
}
