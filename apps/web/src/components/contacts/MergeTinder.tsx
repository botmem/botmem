import { useState, useEffect, useCallback, useRef } from 'react';
import { ContactCard } from './ContactCard';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

interface MergeContact {
  id: string;
  displayName: string;
  avatars: Array<{ url: string; source: string }>;
  identifiers: Array<{ type: string; value: string }>;
  connectorSources: string[];
}

interface MergeSuggestion {
  contact1: MergeContact;
  contact2: MergeContact;
  reason: string;
}

interface UndoEntry {
  type: 'skip';
  suggestion: MergeSuggestion;
}

interface MergeTinderProps {
  suggestions: MergeSuggestion[];
  onMerge: (targetId: string, sourceId: string) => void;
  onDismiss: (id1: string, id2: string) => void;
  onUndismiss?: (id1: string, id2: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onReinsertSuggestion?: (suggestion: any) => void;
}

type SwipeDir = 'left' | 'right' | 'up' | null;

export function MergeTinder({
  suggestions,
  onMerge,
  onDismiss,
  onUndismiss,
  onReinsertSuggestion,
}: MergeTinderProps) {
  const [index, setIndex] = useState(0);
  const [swipeDir, setSwipeDir] = useState<SwipeDir>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const undoStackRef = useRef(undoStack);
  undoStackRef.current = undoStack;

  // Keep index in bounds when suggestions change
  useEffect(() => {
    if (index >= suggestions.length) {
      setIndex(Math.max(0, suggestions.length - 1));
    }
  }, [suggestions.length, index]);

  const current = suggestions[index] || null;

  const doMerge = useCallback(() => {
    if (!current) return;
    setSwipeDir('right');
    setTimeout(() => {
      const c1Count = current.contact1.identifiers?.length || 0;
      const c2Count = current.contact2.identifiers?.length || 0;
      if (c1Count >= c2Count) {
        onMerge(current.contact1.id, current.contact2.id);
      } else {
        onMerge(current.contact2.id, current.contact1.id);
      }
      // Don't reset swipeDir here — let the suggestion removal trigger re-render with new card
      requestAnimationFrame(() => setSwipeDir(null));
    }, 200);
  }, [current, onMerge]);

  const doSkip = useCallback(() => {
    if (!current) return;
    setSwipeDir('left');
    setTimeout(() => {
      setUndoStack((prev) => [...prev, { type: 'skip', suggestion: current }]);
      onDismiss(current.contact1.id, current.contact2.id);
      requestAnimationFrame(() => setSwipeDir(null));
    }, 200);
  }, [current, onDismiss]);

  const doUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const last = stack[stack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setSwipeDir('up');
    if (last.type === 'skip' && onUndismiss) {
      onUndismiss(last.suggestion.contact1.id, last.suggestion.contact2.id);
      // Reinsert at position 0 and reset index to show it
      onReinsertSuggestion?.(last.suggestion);
      setIndex(0);
    }
    setTimeout(() => setSwipeDir(null), 100);
  }, [onUndismiss, onReinsertSuggestion]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          doMerge();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          doSkip();
          break;
        case 'ArrowUp':
          e.preventDefault();
          doUndo();
          break;
        case 'Escape':
          setIsOpen(false);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, doMerge, doSkip, doUndo]);

  const hasAutoOpened = useRef(false);
  useEffect(() => {
    if (suggestions.length > 0 && !hasAutoOpened.current) {
      hasAutoOpened.current = true;
      setIsOpen(true);
    }
  }, [suggestions.length]);

  if (suggestions.length === 0) {
    return (
      <div className="w-full mb-4 border-3 border-nb-border bg-nb-surface shadow-nb px-4 py-3 flex items-center gap-3 opacity-60">
        <span className="font-display text-sm font-bold uppercase tracking-wider text-nb-muted">
          No merge suggestions
        </span>
      </div>
    );
  }

  // Collapsed bar
  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="w-full mb-4 border-3 border-nb-border bg-nb-surface shadow-nb px-4 py-3 flex items-center gap-3 cursor-pointer hover:border-nb-lime transition-colors"
      >
        <Badge color="#FFE66D" className="text-sm px-2 py-0.5">
          {suggestions.length}
        </Badge>
        <span className="font-display text-sm font-bold uppercase tracking-wider text-nb-text">
          Merge Suggestions
        </span>
        <span className="font-mono text-xs text-nb-muted ml-auto">Click to review</span>
      </button>
    );
  }

  // No more suggestions after processing
  if (!current) {
    return (
      <Card className="mb-4">
        <div className="text-center py-6">
          <p className="font-display text-lg font-bold uppercase text-nb-text mb-1">All Done</p>
          <p className="font-mono text-xs text-nb-muted">No more merge suggestions</p>
          <button
            onClick={() => setIsOpen(false)}
            className="mt-3 border-2 border-nb-border px-4 py-1.5 font-mono text-xs font-bold uppercase bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
          >
            Close
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-4 p-0 overflow-hidden">
      {/* Header */}
      <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span>Merge Review</span>
          <Badge color="#FFE66D" className="text-[10px] py-0">
            {suggestions.length}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-nb-muted">
            {index + 1} / {suggestions.length}
          </span>
          <button
            onClick={() => setIsOpen(false)}
            className="border border-nb-border size-6 flex items-center justify-center text-xs font-bold hover:bg-nb-red hover:text-white cursor-pointer"
          >
            X
          </button>
        </div>
      </div>

      {/* Card stack area */}
      <div className="relative px-4 py-4">
        {/* Swipe indicators */}
        <div
          className="absolute inset-y-0 left-0 w-16 flex items-center justify-center pointer-events-none transition-opacity duration-100"
          style={{ opacity: swipeDir === 'left' ? 1 : 0 }}
        >
          <div className="bg-nb-red/20 border-2 border-nb-red rounded-full size-12 flex items-center justify-center">
            <span className="font-display text-lg font-bold text-nb-red">X</span>
          </div>
        </div>
        <div
          className="absolute inset-y-0 right-0 w-16 flex items-center justify-center pointer-events-none transition-opacity duration-100"
          style={{ opacity: swipeDir === 'right' ? 1 : 0 }}
        >
          <div
            className="border-2 border-nb-lime rounded-full size-12 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(196, 245, 58, 0.2)' }}
          >
            <span className="font-display text-lg font-bold text-nb-lime">{'\u2713'}</span>
          </div>
        </div>

        {/* Current suggestion card */}
        <div
          className="transition-all duration-100"
          style={{
            transform:
              swipeDir === 'right'
                ? 'translateX(60px) rotate(3deg)'
                : swipeDir === 'left'
                  ? 'translateX(-60px) rotate(-3deg)'
                  : swipeDir === 'up'
                    ? 'translateY(-30px)'
                    : 'translateX(0)',
            opacity: swipeDir ? 0.5 : 1,
          }}
        >
          {/* The two contacts side by side */}
          <div className="flex items-stretch gap-3">
            <div className="flex-1">
              <ContactCard contact={current.contact1} compact />
            </div>
            <div className="flex items-center shrink-0">
              <span className="font-display text-lg font-bold text-nb-muted">{'\u2194'}</span>
            </div>
            <div className="flex-1">
              <ContactCard contact={current.contact2} compact />
            </div>
          </div>

          {/* Reason */}
          <p className="font-mono text-xs text-nb-muted mt-2 text-center">{current.reason}</p>
        </div>
      </div>

      {/* Up next preview */}
      {suggestions.length > index + 1 && (
        <div className="px-4 pb-3 flex flex-col gap-1.5">
          <span className="font-mono text-[10px] text-nb-muted uppercase">Up next</span>
          {suggestions.slice(index + 1, index + 3).map((s, i) => (
            <div
              key={`${s.contact1.id}::${s.contact2.id}`}
              className="flex items-center gap-2 px-2 py-1.5 border border-nb-border bg-nb-surface-muted"
              style={{ opacity: 1 - i * 0.3 }}
            >
              <span className="font-mono text-xs text-nb-text truncate flex-1">
                {s.contact1.displayName}
              </span>
              <span className="font-mono text-[10px] text-nb-muted shrink-0">{'\u2194'}</span>
              <span className="font-mono text-xs text-nb-text truncate flex-1 text-right">
                {s.contact2.displayName}
              </span>
              <span className="font-mono text-[9px] text-nb-muted shrink-0 max-w-32 truncate">
                {s.reason.split(':')[0]}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Action bar */}
      <div className="border-t-2 border-nb-border px-4 py-3 flex items-center justify-between bg-nb-surface">
        {/* Skip button */}
        <button
          onClick={doSkip}
          className="flex items-center gap-2 border-2 border-nb-red px-4 py-2 font-mono text-xs font-bold uppercase text-nb-red hover:bg-nb-red hover:text-white cursor-pointer transition-colors"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="2" y1="2" x2="12" y2="12" />
            <line x1="12" y1="2" x2="2" y2="12" />
          </svg>
          Skip
          <kbd className="ml-1 border border-current px-1 py-0 text-[9px] opacity-60">
            {'\u2190'}
          </kbd>
        </button>

        {/* Undo */}
        <button
          onClick={doUndo}
          disabled={undoStack.length === 0}
          className="flex items-center gap-1.5 border-2 border-nb-border px-3 py-2 font-mono text-xs font-bold uppercase text-nb-text hover:bg-nb-surface-hover cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Undo last skip"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="4,7 1,4 4,1" />
            <path d="M1,4 H9 A4,4 0 0 1 9,12 H5" />
          </svg>
          Undo
          <kbd className="ml-0.5 border border-nb-border px-1 py-0 text-[9px] opacity-60">
            {'\u2191'}
          </kbd>
        </button>

        {/* Merge button */}
        <button
          onClick={doMerge}
          className="flex items-center gap-2 border-2 border-nb-lime px-4 py-2 font-mono text-xs font-bold uppercase text-black bg-nb-lime hover:brightness-110 cursor-pointer transition-colors"
        >
          Merge
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="2,7 6,11 12,3" />
          </svg>
          <kbd className="ml-1 border border-black/30 px-1 py-0 text-[9px] opacity-60">
            {'\u2192'}
          </kbd>
        </button>
      </div>

      {/* Keyboard hint */}
      <div className="border-t border-nb-border px-4 py-1.5 bg-nb-surface-muted flex items-center justify-center gap-4 font-mono text-[10px] text-nb-muted">
        <span>
          <kbd className="border border-nb-border px-1 py-0 text-[9px]">{'\u2190'}</kbd> Skip
        </span>
        <span>
          <kbd className="border border-nb-border px-1 py-0 text-[9px]">{'\u2192'}</kbd> Merge
        </span>
        <span>
          <kbd className="border border-nb-border px-1 py-0 text-[9px]">{'\u2191'}</kbd> Undo
        </span>
        <span>
          <kbd className="border border-nb-border px-1 py-0 text-[9px]">Esc</kbd> Close
        </span>
      </div>
    </Card>
  );
}
