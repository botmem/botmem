import { describe, it, expect } from 'vitest';
import { filterReducer, uiReducer } from '../graphReducers';
import type { FilterState, FilterAction, UIState, UIAction } from '../graphReducers';

describe('filterReducer', () => {
  const initial: FilterState = {
    hiddenSourceTypes: new Set(),
    hideContacts: false,
    hideGroups: false,
    hideFiles: false,
    hidePhotos: false,
    hideDevices: false,
    hiddenEdgeTypes: new Set(),
  };

  it('toggles source type on', () => {
    const next = filterReducer(initial, { type: 'toggleSourceType', source: 'email' });
    expect(next.hiddenSourceTypes.has('email')).toBe(true);
  });

  it('toggles source type off', () => {
    const state = { ...initial, hiddenSourceTypes: new Set(['email']) };
    const next = filterReducer(state, { type: 'toggleSourceType', source: 'email' });
    expect(next.hiddenSourceTypes.has('email')).toBe(false);
  });

  it('toggles contacts', () => {
    expect(filterReducer(initial, { type: 'toggleContacts' }).hideContacts).toBe(true);
    expect(filterReducer({ ...initial, hideContacts: true }, { type: 'toggleContacts' }).hideContacts).toBe(false);
  });

  it('toggles groups', () => {
    expect(filterReducer(initial, { type: 'toggleGroups' }).hideGroups).toBe(true);
  });

  it('toggles files', () => {
    expect(filterReducer(initial, { type: 'toggleFiles' }).hideFiles).toBe(true);
  });

  it('toggles photos', () => {
    expect(filterReducer(initial, { type: 'togglePhotos' }).hidePhotos).toBe(true);
  });

  it('toggles devices', () => {
    expect(filterReducer(initial, { type: 'toggleDevices' }).hideDevices).toBe(true);
  });

  it('toggles edge type on/off', () => {
    const on = filterReducer(initial, { type: 'toggleEdgeType', edgeType: 'involves' });
    expect(on.hiddenEdgeTypes.has('involves')).toBe(true);
    const off = filterReducer(on, { type: 'toggleEdgeType', edgeType: 'involves' });
    expect(off.hiddenEdgeTypes.has('involves')).toBe(false);
  });
});

describe('uiReducer', () => {
  const initial: UIState = {
    legendOpen: false,
    isFullscreen: false,
    showHint: false,
    searchFocused: false,
    selectedNode: null,
    focusedNodeId: null,
    focusExpansion: 1,
    contactInfo: null,
  };

  it('toggles legend', () => {
    expect(uiReducer(initial, { type: 'toggleLegend' }).legendOpen).toBe(true);
    expect(uiReducer({ ...initial, legendOpen: true }, { type: 'toggleLegend' }).legendOpen).toBe(false);
  });

  it('enters fullscreen', () => {
    const next = uiReducer(initial, { type: 'enterFullscreen' });
    expect(next.isFullscreen).toBe(true);
    expect(next.showHint).toBe(true);
  });

  it('exits fullscreen', () => {
    const next = uiReducer({ ...initial, isFullscreen: true, showHint: true }, { type: 'exitFullscreen' });
    expect(next.isFullscreen).toBe(false);
    expect(next.showHint).toBe(false);
  });

  it('toggles fullscreen', () => {
    const on = uiReducer(initial, { type: 'toggleFullscreen' });
    expect(on.isFullscreen).toBe(true);
    const off = uiReducer(on, { type: 'toggleFullscreen' });
    expect(off.isFullscreen).toBe(false);
  });

  it('sets showHint', () => {
    expect(uiReducer(initial, { type: 'setShowHint', value: true }).showHint).toBe(true);
  });

  it('sets searchFocused', () => {
    expect(uiReducer(initial, { type: 'setSearchFocused', value: true }).searchFocused).toBe(true);
  });

  it('selects node', () => {
    const node = { id: 'n1', label: 'A' } as any;
    expect(uiReducer(initial, { type: 'selectNode', node }).selectedNode).toBe(node);
    expect(uiReducer(initial, { type: 'selectNode', node: null }).selectedNode).toBeNull();
  });

  it('focuses node', () => {
    const next = uiReducer(initial, { type: 'focusNode', nodeId: 'n1' });
    expect(next.focusedNodeId).toBe('n1');
    expect(next.focusExpansion).toBe(1);
  });

  it('expands focus', () => {
    const focused = { ...initial, focusedNodeId: 'n1', focusExpansion: 1 };
    expect(uiReducer(focused, { type: 'expandFocus' }).focusExpansion).toBe(2);
  });

  it('clears focus', () => {
    const focused = { ...initial, focusedNodeId: 'n1', focusExpansion: 3 };
    const next = uiReducer(focused, { type: 'clearFocus' });
    expect(next.focusedNodeId).toBeNull();
    expect(next.focusExpansion).toBe(1);
  });

  it('sets contact info', () => {
    const info = { detail: { id: 'c1' }, memories: [] };
    expect(uiReducer(initial, { type: 'setContactInfo', info }).contactInfo).toBe(info);
  });

  it('double click on unfocused node focuses it', () => {
    const node = { id: 'n1', label: 'A' } as any;
    const next = uiReducer(initial, { type: 'doubleClickNode', node });
    expect(next.focusedNodeId).toBe('n1');
    expect(next.focusExpansion).toBe(1);
    expect(next.selectedNode).toBe(node);
  });

  it('double click on already focused node expands', () => {
    const node = { id: 'n1', label: 'A' } as any;
    const state = { ...initial, focusedNodeId: 'n1', focusExpansion: 2 };
    const next = uiReducer(state, { type: 'doubleClickNode', node });
    expect(next.focusExpansion).toBe(3);
  });
});
