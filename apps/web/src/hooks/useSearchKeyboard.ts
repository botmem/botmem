import { useEffect } from 'react';
import type { Memory } from '@botmem/shared';

interface UseSearchKeyboardOptions {
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  resultsRef: React.RefObject<HTMLDivElement | null>;
  memories: Memory[];
  selectedMemoryId: string | null;
  onSelectMemory: (id: string | null) => void;
  onToggleSidebar?: () => void;
  onToggleMode?: () => void;
}

export function useSearchKeyboard({
  searchInputRef,
  resultsRef,
  memories,
  selectedMemoryId,
  onSelectMemory,
  onToggleSidebar,
  onToggleMode,
}: UseSearchKeyboardOptions) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // / to focus search (always works unless already in an input)
      if (e.key === '/' && !isInput) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      // Escape: close detail panel, then blur search
      if (e.key === 'Escape') {
        if (selectedMemoryId) {
          onSelectMemory(null);
          return;
        }
        if (document.activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
          return;
        }
      }

      // j/k navigation (only when not in input)
      if (!isInput && (e.key === 'j' || e.key === 'k')) {
        e.preventDefault();
        if (!memories.length) return;
        const currentIdx = selectedMemoryId
          ? memories.findIndex((m) => m.id === selectedMemoryId)
          : -1;
        let nextIdx: number;
        if (e.key === 'j') {
          nextIdx = currentIdx < memories.length - 1 ? currentIdx + 1 : currentIdx;
        } else {
          nextIdx = currentIdx > 0 ? currentIdx - 1 : 0;
        }
        onSelectMemory(memories[nextIdx].id);

        // Scroll the selected card into view
        const card = resultsRef.current?.querySelector(
          `[data-memory-id="${memories[nextIdx].id}"]`,
        );
        card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }

      // Enter: open selected memory detail (when not in input)
      if (e.key === 'Enter' && !isInput && selectedMemoryId) {
        // Already selected — detail panel should be showing
        return;
      }

      // Ctrl+Shift+F: toggle sidebar
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        onToggleSidebar?.();
        return;
      }

      // Ctrl+Shift+A: toggle mode
      if (e.ctrlKey && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        onToggleMode?.();
        return;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    searchInputRef,
    resultsRef,
    memories,
    selectedMemoryId,
    onSelectMemory,
    onToggleSidebar,
    onToggleMode,
  ]);
}
