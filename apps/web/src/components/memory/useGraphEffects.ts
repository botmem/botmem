import { useEffect, useCallback } from 'react';
import type { GraphNode } from '@botmem/shared';
import type { UIAction, SearchState } from './graphReducers';
import type { ForceGraphInstance, SimulationNode } from './graphTypes';
import { api } from '../../lib/api';

interface UseGraphEffectsArgs {
  selectedNode: GraphNode | null;
  isFullscreen: boolean;
  selfNodeId: string | null;
  search: SearchState;
  filteredNodes: GraphNode[];
  graphRef: React.RefObject<ForceGraphInstance | null>;
  dispatchUI: React.Dispatch<UIAction>;
}

export function useGraphEffects({
  selectedNode,
  isFullscreen,
  selfNodeId,
  search,
  filteredNodes,
  graphRef,
  dispatchUI,
}: UseGraphEffectsArgs) {
  // Fetch contact details when a contact/group/device node is selected
  useEffect(() => {
    if (!selectedNode || !['contact', 'group', 'device'].includes(selectedNode.nodeType || '')) {
      dispatchUI({ type: 'setContactInfo', info: null });
      return;
    }
    const contactId = selectedNode.id.replace(/^contact-/, '');
    Promise.all([
      api.getContact(contactId).catch(() => null),
      api.getContactMemories(contactId).catch(() => []),
    ]).then(([detail, memories]) =>
      dispatchUI({ type: 'setContactInfo', info: { detail, memories } }),
    );
  }, [selectedNode?.id, selectedNode?.nodeType]);

  // On entering fullscreen: show hint, auto-select "me" node
  useEffect(() => {
    if (isFullscreen) {
      const timer = setTimeout(() => dispatchUI({ type: 'setShowHint', value: false }), 4000);
      if (selfNodeId) {
        const meNode = filteredNodes.find((n) => n.id === selfNodeId) as SimulationNode | undefined;
        if (meNode) {
          dispatchUI({ type: 'selectNode', node: meNode });
          setTimeout(() => {
            if (graphRef.current && meNode.x !== undefined) {
              graphRef.current.centerAt(meNode.x, meNode.y || 0, 500);
              graphRef.current.zoom(2.5, 500);
            }
          }, 100);
        }
      }
      return () => clearTimeout(timer);
    }
  }, [isFullscreen]);

  // Auto-select top search result (highest score)
  useEffect(() => {
    if (!search.results || !search.results.scoreMap) return;
    let topId: string | null = null;
    let topScore = -1;
    for (const [id, score] of search.results.scoreMap) {
      if (score > topScore) {
        topScore = score;
        topId = id;
      }
    }
    if (topId) {
      const node = filteredNodes.find((n) => n.id === topId) as SimulationNode | undefined;
      if (node) {
        dispatchUI({ type: 'selectNode', node });
        if (graphRef.current && node.x !== undefined) {
          graphRef.current.centerAt(node.x, node.y || 0, 400);
        }
      }
    }
  }, [search.results, filteredNodes]);

  const handleRemoveIdentifier = useCallback(async (contactId: string, identId: string) => {
    await api.removeIdentifier(contactId, identId);
    const [detail, memories] = await Promise.all([
      api.getContact(contactId).catch(() => null),
      api.getContactMemories(contactId).catch(() => []),
    ]);
    dispatchUI({ type: 'setContactInfo', info: detail ? { detail, memories } : null });
  }, []);

  return { handleRemoveIdentifier };
}
