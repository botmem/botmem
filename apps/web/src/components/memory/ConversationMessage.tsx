import type { ApiMemoryItem } from '../../lib/api';
import { CitationCard } from './CitationCard';

interface ConversationMessageProps {
  message: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    citations?: ApiMemoryItem[];
    timestamp: number;
  };
  onCitationClick?: (id: string) => void;
}

export function ConversationMessage({ message, onCitationClick }: ConversationMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`mb-6 ${isUser ? 'text-right' : 'text-left'}`}>
      <div
        className={`inline-block max-w-[85%] text-left ${isUser ? 'font-display text-nb-lime' : 'font-body text-nb-text'}`}
      >
        <p className="text-sm whitespace-pre-wrap">{message.content}</p>
      </div>

      {!isUser && message.citations && message.citations.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 max-w-[85%]">
          <span className="font-mono text-[11px] uppercase text-nb-muted">SOURCES</span>
          {message.citations.slice(0, 5).map((c, i) => (
            <CitationCard
              key={c.id}
              citation={c}
              index={i}
              onClick={() => onCitationClick?.(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
