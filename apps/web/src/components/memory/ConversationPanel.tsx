import { useState, useRef, useEffect } from 'react';
import type { ApiMemoryItem } from '../../lib/api';
import { ConversationMessage } from './ConversationMessage';

interface ConversationPanelProps {
  conversation: {
    id: string | null;
    messages: Array<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      citations?: ApiMemoryItem[];
      timestamp: number;
    }>;
    loading: boolean;
  };
  onSendMessage: (query: string) => void;
  onClear: () => void;
}

export function ConversationPanel({
  conversation,
  onSendMessage,
  onClear,
}: ConversationPanelProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation.messages, conversation.loading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q) return;
    setInput('');
    onSendMessage(q);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      {conversation.messages.length > 0 && (
        <div className="flex items-center justify-between border-b border-nb-border/30 px-4 py-2">
          <span className="font-mono text-[11px] uppercase text-nb-muted">
            CONVERSATION{conversation.id ? ` #${conversation.id.slice(0, 8)}` : ''}
          </span>
          <button
            type="button"
            onClick={onClear}
            className="cursor-pointer font-mono text-[11px] uppercase text-nb-muted hover:text-nb-red"
          >
            CLEAR
          </button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {conversation.messages.length === 0 && !conversation.loading && (
          <div className="flex h-full items-center justify-center">
            <p className="font-mono text-sm text-nb-muted">ASK A QUESTION ABOUT YOUR MEMORIES</p>
          </div>
        )}
        {conversation.messages.map((msg) => (
          <ConversationMessage key={msg.id} message={msg} />
        ))}
        {conversation.loading && (
          <div className="flex gap-1 py-4">
            <span className="h-2 w-2 animate-pulse bg-nb-lime" style={{ animationDelay: '0ms' }} />
            <span
              className="h-2 w-2 animate-pulse bg-nb-lime"
              style={{ animationDelay: '150ms' }}
            />
            <span
              className="h-2 w-2 animate-pulse bg-nb-lime"
              style={{ animationDelay: '300ms' }}
            />
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t-2 border-nb-border p-3">
        <input
          type="text"
          id="conversation-input"
          name="conversation-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="ASK A FOLLOW-UP..."
          aria-label="Ask a question"
          disabled={conversation.loading}
          className="w-full border-2 border-nb-border bg-nb-bg px-3 py-2 font-mono text-sm text-nb-text placeholder:text-nb-muted/50 focus:border-nb-lime focus:outline-none disabled:opacity-50"
        />
      </form>
    </div>
  );
}
