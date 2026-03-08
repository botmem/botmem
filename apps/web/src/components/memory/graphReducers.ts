import type { GraphNode } from '@botmem/shared';

export type FilterState = {
  hiddenSourceTypes: Set<string>;
  hideContacts: boolean;
  hideGroups: boolean;
  hideFiles: boolean;
  hideDevices: boolean;
  hiddenEdgeTypes: Set<string>;
};

export type FilterAction =
  | { type: 'toggleSourceType'; source: string }
  | { type: 'toggleContacts' }
  | { type: 'toggleGroups' }
  | { type: 'toggleFiles' }
  | { type: 'toggleDevices' }
  | { type: 'toggleEdgeType'; edgeType: string };

export function filterReducer(state: FilterState, action: FilterAction): FilterState {
  switch (action.type) {
    case 'toggleSourceType': {
      const next = new Set(state.hiddenSourceTypes);
      next.has(action.source) ? next.delete(action.source) : next.add(action.source);
      return { ...state, hiddenSourceTypes: next };
    }
    case 'toggleContacts': return { ...state, hideContacts: !state.hideContacts };
    case 'toggleGroups': return { ...state, hideGroups: !state.hideGroups };
    case 'toggleFiles': return { ...state, hideFiles: !state.hideFiles };
    case 'toggleDevices': return { ...state, hideDevices: !state.hideDevices };
    case 'toggleEdgeType': {
      const next = new Set(state.hiddenEdgeTypes);
      next.has(action.edgeType) ? next.delete(action.edgeType) : next.add(action.edgeType);
      return { ...state, hiddenEdgeTypes: next };
    }
  }
}

export type SearchState = {
  term: string;
  pending: boolean;
  results: {
    memoryIds: Set<string>;
    contactNodeIds: string[];
    scoreMap: Map<string, number>;
    resolvedEntities?: { contacts: { id: string; displayName: string }[]; topicWords: string[]; topicMatchCount: number };
  } | null;
};

export type SearchAction =
  | { type: 'setTerm'; term: string }
  | { type: 'startSearch' }
  | { type: 'searchComplete'; results: SearchState['results'] }
  | { type: 'clearSearch' };

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case 'setTerm': return { ...state, term: action.term };
    case 'startSearch': return { ...state, pending: true };
    case 'searchComplete': return { ...state, pending: false, results: action.results };
    case 'clearSearch': return { ...state, pending: false, results: null };
  }
}

export type UIState = {
  legendOpen: boolean;
  isFullscreen: boolean;
  showHint: boolean;
  searchFocused: boolean;
  selectedNode: GraphNode | null;
  focusedNodeId: string | null;
  focusExpansion: number;
  contactInfo: { detail: any; memories: any[] } | null;
};

export type UIAction =
  | { type: 'toggleLegend' }
  | { type: 'enterFullscreen' }
  | { type: 'exitFullscreen' }
  | { type: 'toggleFullscreen' }
  | { type: 'setShowHint'; value: boolean }
  | { type: 'setSearchFocused'; value: boolean }
  | { type: 'selectNode'; node: GraphNode | null }
  | { type: 'focusNode'; nodeId: string }
  | { type: 'expandFocus' }
  | { type: 'clearFocus' }
  | { type: 'setContactInfo'; info: { detail: any; memories: any[] } | null }
  | { type: 'doubleClickNode'; node: GraphNode };

export function uiReducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case 'toggleLegend': return { ...state, legendOpen: !state.legendOpen };
    case 'enterFullscreen': return { ...state, isFullscreen: true, showHint: true };
    case 'exitFullscreen': return { ...state, isFullscreen: false, showHint: false };
    case 'toggleFullscreen': return state.isFullscreen
      ? { ...state, isFullscreen: false, showHint: false }
      : { ...state, isFullscreen: true, showHint: true };
    case 'setShowHint': return { ...state, showHint: action.value };
    case 'setSearchFocused': return { ...state, searchFocused: action.value };
    case 'selectNode': return { ...state, selectedNode: action.node };
    case 'focusNode': return { ...state, focusedNodeId: action.nodeId, focusExpansion: 1 };
    case 'expandFocus': return { ...state, focusExpansion: state.focusExpansion + 1 };
    case 'clearFocus': return { ...state, focusedNodeId: null, focusExpansion: 1 };
    case 'setContactInfo': return { ...state, contactInfo: action.info };
    case 'doubleClickNode': return state.focusedNodeId === action.node.id
      ? { ...state, focusExpansion: state.focusExpansion + 1, selectedNode: action.node }
      : { ...state, focusedNodeId: action.node.id, focusExpansion: 1, selectedNode: action.node };
  }
}
