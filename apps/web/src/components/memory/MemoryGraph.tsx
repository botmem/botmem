import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import type { GraphData, GraphNode } from '@botmem/shared';
import { CONNECTOR_COLORS, truncate, formatDate } from '@botmem/shared';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { api } from '../../lib/api';
import { IDENTIFIER_COLORS } from '../contacts/constants';

interface MemoryGraphProps {
  data: GraphData;
  onReload?: (params: { memoryLimit: number; linkLimit: number }) => void;
}

const CONTACT_COLOR = '#60A5FA';
const SELF_COLOR = '#C4F53A'; // lime — "me" node
const GROUP_COLOR = '#C084FC';
const FILE_COLOR = '#FB923C';
const DEVICE_COLOR = '#2DD4BF'; // teal
const HIGHLIGHT_COLOR = '#A3E635';
const DIM_OPACITY = 0.15;

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size, y);
  ctx.closePath();
}

function drawHexagon(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const px = x + radius * Math.cos(angle);
    const py = y + radius * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const left = x - w / 2;
  const top = y - h / 2;
  ctx.beginPath();
  ctx.moveTo(left + r, top);
  ctx.lineTo(left + w - r, top);
  ctx.arcTo(left + w, top, left + w, top + r, r);
  ctx.lineTo(left + w, top + h - r);
  ctx.arcTo(left + w, top + h, left + w - r, top + h, r);
  ctx.lineTo(left + r, top + h);
  ctx.arcTo(left, top + h, left, top + h - r, r);
  ctx.lineTo(left, top + r);
  ctx.arcTo(left, top, left + r, top, r);
  ctx.closePath();
}

function edgeTypeColor(type: string): string {
  if (type === 'contradicts') return '#EF4444';
  if (type === 'supports') return '#22C55E';
  if (type === 'involves') return 'rgba(96, 165, 250, 0.6)';
  if (type === 'attachment') return 'rgba(251, 146, 60, 0.6)';
  if (type === 'source') return 'rgba(163, 230, 53, 0.25)';
  return '#666';
}

function LegendToggle({ active, onClick, icon, label }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2 py-1 border-2 font-mono text-[11px] uppercase cursor-pointer transition-all"
      style={{
        borderColor: active ? '#E0E0E0' : '#444',
        opacity: active ? 1 : 0.35,
        backgroundColor: active ? 'rgba(255,255,255,0.05)' : 'transparent',
        color: active ? '#F0F0F0' : '#888',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export function MemoryGraph({ data, onReload }: MemoryGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const nodePositionsRef = useRef<Map<string, { x: number; y: number; vx: number; vy: number }>>(new Map());
  const isInitialRender = useRef(true);
  const [ForceGraph, setForceGraph] = useState<any>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 500 });
  const [minConnections, setMinConnections] = useState(2);
  const [memoryLimit, setMemoryLimit] = useState(500);
  const [linkLimit, setLinkLimit] = useState(2000);
  const [searchTerm, setSearchTerm] = useState('');
  const [hiddenSourceTypes, setHiddenSourceTypes] = useState<Set<string>>(new Set());
  const [hideContacts, setHideContacts] = useState(false);
  const [hideGroups, setHideGroups] = useState(false);
  const [hideFiles, setHideFiles] = useState(false);
  const [hideDevices, setHideDevices] = useState(false);
  const [hiddenEdgeTypes, setHiddenEdgeTypes] = useState<Set<string>>(new Set());

  const [legendOpen, setLegendOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [selfNodeId, setSelfNodeId] = useState<string | null>(null);
  const [contactDetail, setContactDetail] = useState<any>(null);
  const [contactMemories, setContactMemories] = useState<any[]>([]);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [focusExpansion, setFocusExpansion] = useState(1);  // 1 = strongest only, increases with each double-click

  useEffect(() => {
    import('react-force-graph-2d').then((mod) => {
      setForceGraph(() => mod.default);
    });
    api.getMeStatus().then(({ contactId }) => {
      if (contactId) setSelfNodeId(`contact-${contactId}`);
    }).catch(() => {});
  }, []);

  // Auto-reload when nodes/links sliders change (debounced) + periodic refresh
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!onReload) return;
    if (isInitialRender.current) return;
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      onReload({ memoryLimit, linkLimit });
    }, 500);
    return () => { if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current); };
  }, [memoryLimit, linkLimit]);

  // Periodic graph refresh every 15s using current slider values
  useEffect(() => {
    if (!onReload) return;
    const interval = setInterval(() => {
      onReload({ memoryLimit, linkLimit });
    }, 15000);
    return () => clearInterval(interval);
  }, [onReload, memoryLimit, linkLimit]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      if (isFullscreen) {
        // In fullscreen, fill the viewport minus the controls above the canvas
        const rect = el.getBoundingClientRect();
        setDimensions({ width: rect.width, height: window.innerHeight - rect.top });
      } else {
        const rect = el.getBoundingClientRect();
        setDimensions({ width: rect.width, height: Math.max(300, Math.min(rect.width * 0.4, 450)) });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ForceGraph, isFullscreen]);

  // Compute connection counts per node
  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of data.links) {
      const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
      const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
      counts.set(src, (counts.get(src) || 0) + 1);
      counts.set(tgt, (counts.get(tgt) || 0) + 1);
    }
    return counts;
  }, [data.links]);

  // Search matching node IDs
  const searchMatchIds = useMemo(() => {
    if (!searchTerm.trim()) return null;
    const term = searchTerm.toLowerCase();
    // Strip accents for fuzzy matching (amelie matches Amélie)
    const normTerm = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const matched = new Set<string>();
    for (const node of data.nodes) {
      const label = node.label.toLowerCase();
      const normLabel = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (
        label.includes(term) ||
        normLabel.includes(normTerm) ||
        (node.entities || []).some((e) => {
          const el = e.toLowerCase();
          return el.includes(term) || el.normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(normTerm);
        }) ||
        (node.source && node.source.toLowerCase().includes(term))
      ) {
        matched.add(node.id);
      }
    }
    return matched;
  }, [searchTerm, data.nodes]);

  // Detect if search matches a contact/group/device node — if so, show only me + that person + shared connections
  const searchMatchedContactId = useMemo(() => {
    if (!searchMatchIds) return null;
    for (const id of searchMatchIds) {
      const node = data.nodes.find((n) => n.id === id);
      if (node && (node.nodeType === 'contact' || node.nodeType === 'group' || node.nodeType === 'device')) {
        return id;
      }
    }
    return null;
  }, [searchMatchIds, data.nodes]);

  // When search matches a contact, compute the filtered set: me + contact + their shared memories
  const contactFilterIds = useMemo(() => {
    if (!searchMatchedContactId) return null;
    const visible = new Set<string>([searchMatchedContactId]);
    if (selfNodeId) visible.add(selfNodeId);

    // Find memories connected to the matched contact
    const contactMemIds = new Set<string>();
    for (const link of data.links) {
      const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
      const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
      if (src === searchMatchedContactId) contactMemIds.add(tgt);
      if (tgt === searchMatchedContactId) contactMemIds.add(src);
    }

    // If we have a "me" node, find memories also connected to me for shared relationships
    if (selfNodeId) {
      const myMemIds = new Set<string>();
      for (const link of data.links) {
        const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
        const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
        if (src === selfNodeId) myMemIds.add(tgt);
        if (tgt === selfNodeId) myMemIds.add(src);
      }
      // Show all memories connected to the contact (not just shared ones)
      for (const id of contactMemIds) visible.add(id);
    } else {
      // No self node — show all the contact's connections
      for (const id of contactMemIds) visible.add(id);
    }

    return visible;
  }, [searchMatchedContactId, selfNodeId, data.links]);

  // Expand search matches to include their direct neighbors
  const highlightedIds = useMemo(() => {
    if (!searchMatchIds) return null;
    // If a contact is matched, use the contact filter instead
    if (contactFilterIds) return contactFilterIds;
    const expanded = new Set(searchMatchIds);
    for (const link of data.links) {
      const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
      const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
      if (searchMatchIds.has(src)) expanded.add(tgt);
      if (searchMatchIds.has(tgt)) expanded.add(src);
    }
    return expanded;
  }, [searchMatchIds, data.links, contactFilterIds]);

  const SOURCE_TYPE_LABELS: Record<string, string> = {
    email: 'Emails',
    message: 'Messages',
    location: 'Locations',
    file: 'Photos',
    photo: 'Photos',
  };

  // Collect unique source types present in data
  const sourceTypes = useMemo(() => {
    const types = new Set<string>();
    for (const node of data.nodes) {
      if (node.nodeType === 'memory' && node.source) {
        types.add(node.source);
      }
    }
    return Array.from(types).sort();
  }, [data.nodes]);

  // Collect unique edge types present in data
  const edgeTypes = useMemo(() => {
    const types = new Set<string>();
    for (const link of data.links) {
      types.add(link.linkType || 'related');
    }
    return Array.from(types).sort();
  }, [data.links]);

  // Filter graph data by min connections + legend toggles
  // Preserve node positions across data updates to prevent graph from resetting
  const filteredData = useMemo(() => {
    const keepNodes = new Set<string>();
    for (const node of data.nodes) {
      // Legend toggle filters
      if (node.nodeType === 'contact' && hideContacts) continue;
      if (node.nodeType === 'group' && hideGroups) continue;
      if (node.nodeType === 'file' && hideFiles) continue;
      if (node.nodeType === 'device' && hideDevices) continue;
      if (node.nodeType === 'connector') { keepNodes.add(node.id); continue; } // Always show connector hubs
      if (node.nodeType === 'memory' && hiddenSourceTypes.has(node.source)) continue;

      const count = connectionCounts.get(node.id) || 0;
      if (count >= minConnections) {
        keepNodes.add(node.id);
      }
    }

    // Save current node positions before computing new filtered data
    if (graphRef.current) {
      const currentNodes = graphRef.current.graphData?.()?.nodes;
      if (currentNodes) {
        for (const n of currentNodes) {
          if (n.id && n.x !== undefined) {
            nodePositionsRef.current.set(n.id, { x: n.x, y: n.y, vx: n.vx || 0, vy: n.vy || 0 });
          }
        }
      }
    }

    const nodes = data.nodes
      .filter((n) => keepNodes.has(n.id))
      .map((n) => {
        // Restore positions from previous render
        const pos = nodePositionsRef.current.get(n.id);
        if (pos) return { ...n, x: pos.x, y: pos.y, vx: pos.vx, vy: pos.vy };
        return { ...n };
      });
    const links = data.links.filter((l) => {
      const src = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const tgt = typeof l.target === 'object' ? (l.target as any).id : l.target;
      if (!keepNodes.has(src) || !keepNodes.has(tgt)) return false;
      const type = l.linkType || 'related';
      if (hiddenEdgeTypes.has(type)) return false;
      return true;
    });
    return { nodes, links };
  }, [data, connectionCounts, minConnections, hiddenSourceTypes, hideContacts, hideGroups, hideFiles, hideDevices, hiddenEdgeTypes]);

  // Track camera state via onZoom callback — restored after data updates
  const cameraRef = useRef<{ k: number; x: number; y: number } | null>(null);
  const handleZoom = useCallback((transform: { k: number; x: number; y: number }) => {
    if (!isInitialRender.current) {
      cameraRef.current = transform;
    }
  }, []);

  // Restore camera position after data update (prevent auto-recenter)
  useEffect(() => {
    if (!graphRef.current || isInitialRender.current) return;
    if (cameraRef.current) {
      const { k, x, y } = cameraRef.current;
      requestAnimationFrame(() => {
        if (graphRef.current) {
          // Restore zoom + pan via the d3 zoom transform
          graphRef.current.zoom(k, 0);
          graphRef.current.centerAt(
            -x / k + dimensions.width / (2 * k),
            -y / k + dimensions.height / (2 * k),
            0
          );
        }
      });
    }
  }, [filteredData, dimensions]);

  // Focus mode: double-click a node to show only its connections, sorted by strength
  const focusVisibleIds = useMemo(() => {
    if (!focusedNodeId) return null;
    const visible = new Set<string>([focusedNodeId]);
    const connectedLinks = filteredData.links
      .map((link) => {
        const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
        const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
        if (src !== focusedNodeId && tgt !== focusedNodeId) return null;
        const neighbor = src === focusedNodeId ? tgt : src;
        return { neighbor, strength: link.strength ?? 0.5 };
      })
      .filter(Boolean) as Array<{ neighbor: string; strength: number }>;
    connectedLinks.sort((a, b) => b.strength - a.strength);
    const showCount = focusExpansion * 5;
    for (let i = 0; i < Math.min(showCount, connectedLinks.length); i++) {
      visible.add(connectedLinks[i].neighbor);
    }
    return visible;
  }, [focusedNodeId, focusExpansion, filteredData.links]);

  const handleNodeDoubleClick = useCallback((node: any) => {
    if (focusedNodeId === node.id) {
      setFocusExpansion((prev) => prev + 1);
    } else {
      setFocusedNodeId(node.id);
      setFocusExpansion(1);
    }
    setSelectedNode(node);
  }, [focusedNodeId]);

  const nodeCanvasObject = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x || 0;
      const y = node.y || 0;
      const isContact = node.nodeType === 'contact';
      const isGroup = node.nodeType === 'group';
      const isFile = node.nodeType === 'file';
      const isDevice = node.nodeType === 'device';
      const isConnector = node.nodeType === 'connector';

      // Determine if this node should be dimmed (search or focus active but not in results)
      const isSearchActive = searchMatchIds !== null;
      const isFocusActive = focusVisibleIds !== null;
      const isHighlighted = highlightedIds?.has(node.id);
      const isDirectMatch = searchMatchIds?.has(node.id);
      const isFocusVisible = focusVisibleIds?.has(node.id);
      const shouldDim = (isSearchActive && !isHighlighted) || (isFocusActive && !isFocusVisible);

      ctx.globalAlpha = shouldDim ? DIM_OPACITY : 1;

      if (isConnector) {
        const color = CONNECTOR_COLORS[node.source] || '#999';
        const w = 28;
        const h = 20;
        const r = 5;

        // Shadow
        drawRoundedRect(ctx, x + 2, y + 2, w, h, r);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fill();

        // Body
        drawRoundedRect(ctx, x, y, w, h, r);
        ctx.fillStyle = color;
        ctx.fill();

        if (isDirectMatch) {
          ctx.strokeStyle = HIGHLIGHT_COLOR;
          ctx.lineWidth = 3;
        } else {
          ctx.strokeStyle = '#E0E0E0';
          ctx.lineWidth = 2;
        }
        ctx.stroke();

        // Connector label inside
        ctx.font = `bold ${8}px IBM Plex Mono`;
        ctx.fillStyle = '#1A1A2E';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.label.toUpperCase().slice(0, 6), x, y);
        ctx.textBaseline = 'alphabetic';

        // Label below
        if (globalScale > 0.8 || isDirectMatch) {
          ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
          ctx.fillStyle = isDirectMatch ? HIGHLIGHT_COLOR : color;
          ctx.textAlign = 'center';
          ctx.fillText(node.label, x, y + h / 2 + 12 / globalScale);
        }
      } else if (isFile) {
        const size = 7;

        // Shadow
        drawDiamond(ctx, x + 1.5, y + 1.5, size);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fill();

        // Diamond fill
        drawDiamond(ctx, x, y, size);
        ctx.fillStyle = FILE_COLOR;
        ctx.fill();

        if (isDirectMatch) {
          ctx.strokeStyle = HIGHLIGHT_COLOR;
          ctx.lineWidth = 3;
        } else {
          ctx.strokeStyle = '#E0E0E0';
          ctx.lineWidth = 1.5;
        }
        ctx.stroke();

        // File icon (small lines inside)
        ctx.strokeStyle = '#1A1A2E';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - 2, y - 1);
        ctx.lineTo(x + 2, y - 1);
        ctx.moveTo(x - 2, y + 1);
        ctx.lineTo(x + 2, y + 1);
        ctx.stroke();

        if (globalScale > 1.0 || isDirectMatch) {
          ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
          ctx.fillStyle = isDirectMatch ? HIGHLIGHT_COLOR : FILE_COLOR;
          ctx.textAlign = 'center';
          ctx.fillText(truncate(node.label, 20), x, y + size + 12 / globalScale);
        }
      } else if (isGroup) {
        const radius = 10;

        // Shadow
        drawHexagon(ctx, x + 1.5, y + 1.5, radius);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fill();

        // Hexagon fill
        drawHexagon(ctx, x, y, radius);
        ctx.fillStyle = GROUP_COLOR;
        ctx.fill();

        if (isDirectMatch) {
          ctx.strokeStyle = HIGHLIGHT_COLOR;
          ctx.lineWidth = 3;
        } else {
          ctx.strokeStyle = '#E0E0E0';
          ctx.lineWidth = 2;
        }
        ctx.stroke();

        // Group icon (two dots + arc)
        ctx.fillStyle = '#1A1A2E';
        ctx.beginPath();
        ctx.arc(x - 2.5, y - 1, 2, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + 2.5, y - 1, 2, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y + 4, 5, Math.PI, 0);
        ctx.fill();

        if (globalScale > 1.0 || isDirectMatch) {
          ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
          ctx.fillStyle = isDirectMatch ? HIGHLIGHT_COLOR : GROUP_COLOR;
          ctx.textAlign = 'center';
          ctx.fillText(truncate(node.label, 20), x, y + radius + 12 / globalScale);
        }
      } else if (isDevice) {
        const w = 20;
        const h = 14;
        const r = 4;

        // Shadow
        drawRoundedRect(ctx, x + 1.5, y + 1.5, w, h, r);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fill();

        // Body
        drawRoundedRect(ctx, x, y, w, h, r);
        ctx.fillStyle = DEVICE_COLOR;
        ctx.fill();

        if (isDirectMatch) {
          ctx.strokeStyle = HIGHLIGHT_COLOR;
          ctx.lineWidth = 3;
        } else {
          ctx.strokeStyle = '#E0E0E0';
          ctx.lineWidth = 1.5;
        }
        ctx.stroke();

        // Phone icon (small rectangle inside)
        ctx.fillStyle = '#1A1A2E';
        ctx.fillRect(x - 2, y - 3, 4, 6);
        // Screen
        ctx.fillStyle = '#1A1A2E';
        ctx.fillRect(x - 1.5, y - 2.5, 3, 4);

        if (globalScale > 1.0 || isDirectMatch) {
          ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
          ctx.fillStyle = isDirectMatch ? HIGHLIGHT_COLOR : DEVICE_COLOR;
          ctx.textAlign = 'center';
          ctx.fillText(truncate(node.label, 20), x, y + h / 2 + 12 / globalScale);
        }
      } else if (isContact) {
        const isSelf = selfNodeId === node.id;
        const contactColor = isSelf ? SELF_COLOR : CONTACT_COLOR;
        const radius = isSelf ? 10 : 8;

        ctx.beginPath();
        ctx.arc(x + 1.5, y + 1.5, radius, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = contactColor;
        ctx.fill();

        if (isDirectMatch) {
          ctx.strokeStyle = HIGHLIGHT_COLOR;
          ctx.lineWidth = 3;
        } else if (isSelf) {
          ctx.strokeStyle = '#FFF';
          ctx.lineWidth = 3;
        } else {
          ctx.strokeStyle = '#E0E0E0';
          ctx.lineWidth = 2;
        }
        ctx.stroke();

        // Star icon for self, person icon for others
        if (isSelf) {
          ctx.fillStyle = '#1A1A2E';
          ctx.font = `bold 10px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('\u2605', x, y);
          ctx.textBaseline = 'alphabetic';
        } else {
          ctx.fillStyle = '#1A1A2E';
          ctx.beginPath();
          ctx.arc(x, y - 2, 3, 0, 2 * Math.PI);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y + 5, 5, Math.PI, 0);
          ctx.fill();
        }

        // Always show label for self node
        if (globalScale > 1.2 || isDirectMatch || isSelf) {
          ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
          ctx.fillStyle = isDirectMatch ? HIGHLIGHT_COLOR : contactColor;
          ctx.textAlign = 'center';
          ctx.fillText(isSelf ? 'ME' : truncate(node.label, 20), x, y + radius + 12 / globalScale);
        }
      } else {
        const size = 6 + (node.importance || 0.5) * 12;
        const color = CONNECTOR_COLORS[node.source] || '#999';

        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x - size / 2 + 2, y - size / 2 + 2, size, size);

        ctx.fillStyle = color;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);

        if (isDirectMatch) {
          ctx.strokeStyle = HIGHLIGHT_COLOR;
          ctx.lineWidth = 3;
        } else {
          ctx.strokeStyle = '#E0E0E0';
          ctx.lineWidth = 1.5;
        }
        ctx.strokeRect(x - size / 2, y - size / 2, size, size);

        if (globalScale > 1.5 || isDirectMatch) {
          ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
          ctx.fillStyle = isDirectMatch ? HIGHLIGHT_COLOR : '#F0F0F0';
          ctx.textAlign = 'center';
          ctx.fillText(truncate(node.label, 20), x, y + size / 2 + 10 / globalScale);
        }
      }

      ctx.globalAlpha = 1;
    },
    [searchMatchIds, highlightedIds, selfNodeId, focusVisibleIds]
  );

  const nodePointerArea = useCallback(
    (node: any, color: string, ctx: CanvasRenderingContext2D) => {
      const x = node.x || 0;
      const y = node.y || 0;
      ctx.fillStyle = color;
      if (node.nodeType === 'connector') {
        drawRoundedRect(ctx, x, y, 32, 24, 6);
        ctx.fill();
      } else if (node.nodeType === 'file') {
        drawDiamond(ctx, x, y, 9);
        ctx.fill();
      } else if (node.nodeType === 'group') {
        drawHexagon(ctx, x, y, 12);
        ctx.fill();
      } else if (node.nodeType === 'device') {
        drawRoundedRect(ctx, x, y, 24, 18, 5);
        ctx.fill();
      } else if (node.nodeType === 'contact') {
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, 2 * Math.PI);
        ctx.fill();
      } else {
        const size = 6 + (node.importance || 0.5) * 12;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    },
    []
  );

  const linkColor = useCallback((link: any) => {
    const src = typeof link.source === 'object' ? link.source.id : link.source;
    const tgt = typeof link.target === 'object' ? link.target.id : link.target;
    if (searchMatchIds) {
      const srcHighlighted = highlightedIds?.has(src);
      const tgtHighlighted = highlightedIds?.has(tgt);
      if (!srcHighlighted || !tgtHighlighted) return `rgba(102, 102, 102, ${DIM_OPACITY})`;
    }
    if (focusVisibleIds) {
      if (!focusVisibleIds.has(src) || !focusVisibleIds.has(tgt)) return `rgba(102, 102, 102, ${DIM_OPACITY})`;
    }
    if (link.linkType === 'contradicts') return '#EF4444';
    if (link.linkType === 'supports') return '#22C55E';
    if (link.linkType === 'involves') return 'rgba(96, 165, 250, 0.4)';
    if (link.linkType === 'attachment') return 'rgba(251, 146, 60, 0.4)';
    if (link.linkType === 'source') return 'rgba(163, 230, 53, 0.15)';
    return '#666';
  }, [searchMatchIds, highlightedIds, focusVisibleIds]);

  const linkWidth = useCallback((link: any) => {
    if (link.linkType === 'involves') return 1;
    if (link.linkType === 'source') return 0.5;
    return 2;
  }, []);

  // Fetch contact details when a contact/group/device node is selected
  useEffect(() => {
    if (!selectedNode || !['contact', 'group', 'device'].includes(selectedNode.nodeType || '')) {
      setContactDetail(null);
      setContactMemories([]);
      return;
    }
    setContactDetail(null);
    setContactMemories([]);
    // Graph node IDs for contacts are prefixed: "contact-<uuid>"
    const contactId = selectedNode.id.replace(/^contact-/, '');
    api.getContact(contactId).then(setContactDetail).catch(() => setContactDetail(null));
    api.getContactMemories(contactId).then(setContactMemories).catch(() => setContactMemories([]));
  }, [selectedNode?.id, selectedNode?.nodeType]);

  // On entering fullscreen: show hint, auto-select "me" node
  useEffect(() => {
    if (isFullscreen) {
      setShowHint(true);
      const timer = setTimeout(() => setShowHint(false), 4000);

      // Auto-select and center on the "me" node
      if (selfNodeId) {
        const meNode = filteredData.nodes.find((n) => n.id === selfNodeId) as any;
        if (meNode) {
          setSelectedNode(meNode);
          // Wait a tick for the graph to be in fullscreen layout
          setTimeout(() => {
            if (graphRef.current && meNode.x !== undefined) {
              graphRef.current.centerAt(meNode.x, meNode.y, 500);
              graphRef.current.zoom(2.5, 500);
            }
          }, 100);
        }
      }

      return () => clearTimeout(timer);
    }
    setShowHint(false);
  }, [isFullscreen]);

  // Build adjacency list for keyboard navigation
  const adjacency = useMemo(() => {
    const adj = new Map<string, string[]>();
    for (const link of filteredData.links) {
      const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
      const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
      if (!adj.has(src)) adj.set(src, []);
      if (!adj.has(tgt)) adj.set(tgt, []);
      adj.get(src)!.push(tgt);
      adj.get(tgt)!.push(src);
    }
    return adj;
  }, [filteredData.links]);


  // Fullscreen keyboard shortcuts: Escape, arrow keys, Cmd+F, M
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+F — focus search input
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        setSearchFocused(true);
        setTimeout(() => setSearchFocused(false), 600);
        return;
      }

      // Don't capture other shortcuts when typing in an input
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

      if (e.key === 'Escape') {
        if (focusedNodeId) { setFocusedNodeId(null); setFocusExpansion(1); return; }
        setIsFullscreen(false); return;
      }

      // M — jump back to "me" node
      if (e.key === 'm' || e.key === 'M') {
        if (selfNodeId) {
          const meNode = filteredData.nodes.find((n) => n.id === selfNodeId) as any;
          if (meNode) {
            setSelectedNode(meNode);
            if (graphRef.current && meNode.x !== undefined) {
              graphRef.current.centerAt(meNode.x, meNode.y, 400);
              graphRef.current.zoom(2.5, 400);
            }
          }
        }
        return;
      }

      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();

      const nodes = filteredData.nodes;
      if (nodes.length === 0) return;

      if (!selectedNode) {
        // No selection — select first node
        const first = nodes[0];
        setSelectedNode(first);
        const n = first as any;
        if (n.x !== undefined && graphRef.current) {
          graphRef.current.centerAt(n.x, n.y, 300);
          graphRef.current.zoom(2.5, 300);
        }
        return;
      }

      const neighbors = adjacency.get(selectedNode.id) || [];
      if (neighbors.length === 0) return;

      // Get positioned neighbor nodes
      const current = nodes.find((n) => n.id === selectedNode.id) as any;
      const cx = current?.x ?? 0;
      const cy = current?.y ?? 0;

      const neighborNodes = neighbors
        .map((id) => nodes.find((n) => n.id === id) as any)
        .filter((n) => n && n.x !== undefined);

      if (neighborNodes.length === 0) return;

      // Pick the neighbor closest to the arrow direction
      let best: any = null;
      let bestScore = -Infinity;

      for (const n of neighborNodes) {
        const dx = n.x - cx;
        const dy = n.y - cy;
        let score = 0;
        switch (e.key) {
          case 'ArrowRight': score = dx - Math.abs(dy) * 0.5; break;
          case 'ArrowLeft':  score = -dx - Math.abs(dy) * 0.5; break;
          case 'ArrowDown':  score = dy - Math.abs(dx) * 0.5; break;
          case 'ArrowUp':    score = -dy - Math.abs(dx) * 0.5; break;
        }
        if (score > bestScore) { bestScore = score; best = n; }
      }

      if (best) {
        setSelectedNode(best);
        if (graphRef.current) {
          graphRef.current.centerAt(best.x, best.y, 300);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen, selectedNode, filteredData.nodes, adjacency, selfNodeId]);

  // Zoom to fit search results
  useEffect(() => {
    if (!graphRef.current || !searchMatchIds || searchMatchIds.size === 0) return;
    const matchedNodes = filteredData.nodes.filter((n) => searchMatchIds.has(n.id));
    if (matchedNodes.length === 1) {
      const node = matchedNodes[0] as any;
      if (node.x !== undefined) {
        graphRef.current.centerAt(node.x, node.y, 400);
        graphRef.current.zoom(3, 400);
      }
    }
  }, [searchMatchIds, filteredData.nodes]);

  if (!ForceGraph) {
    return (
      <Card className="flex items-center justify-center h-[300px]">
        <p className="font-mono text-sm uppercase text-nb-text">LOADING GRAPH ENGINE...</p>
      </Card>
    );
  }

  const totalNodes = data.nodes.length;
  const visibleNodes = filteredData.nodes.length;
  const matchCount = searchMatchIds?.size || 0;

  return (
    <div className={isFullscreen ? 'fixed inset-0 z-50 bg-nb-bg flex flex-col p-4 overflow-hidden' : ''}>
      {/* Controls — single compact row */}
      <div className="flex items-end gap-3 mb-2">
        <div className="flex-1">
          <input
            ref={searchInputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="SEARCH NODES, ENTITIES..."
            className="w-full border-3 px-3 py-1.5 font-mono text-xs bg-nb-surface text-nb-text focus:outline-none focus:border-nb-lime placeholder:text-nb-muted placeholder:uppercase transition-all duration-300"
            style={{
              borderColor: searchFocused ? '#C4F53A' : undefined,
              boxShadow: searchFocused ? '0 0 8px #C4F53A60' : undefined,
            }}
          />
        </div>
        <div className="w-36">
          <label className="font-mono text-[10px] uppercase text-nb-muted block mb-0.5">
            Min conn: {minConnections}
          </label>
          <input
            type="range"
            min={0}
            max={10}
            value={minConnections}
            onChange={(e) => setMinConnections(Number(e.target.value))}
            className="w-full accent-[#A3E635]"
          />
        </div>
        <div className="w-28">
          <label className="font-mono text-[10px] uppercase text-nb-muted block mb-0.5">
            Nodes: {memoryLimit}
          </label>
          <input
            type="range"
            min={100}
            max={5000}
            step={100}
            value={memoryLimit}
            onChange={(e) => setMemoryLimit(Number(e.target.value))}
            className="w-full accent-[#A3E635]"
          />
        </div>
        <div className="w-28">
          <label className="font-mono text-[10px] uppercase text-nb-muted block mb-0.5">
            Links: {linkLimit}
          </label>
          <input
            type="range"
            min={500}
            max={50000}
            step={500}
            value={linkLimit}
            onChange={(e) => setLinkLimit(Number(e.target.value))}
            className="w-full accent-[#A3E635]"
          />
        </div>
      </div>

      {/* Status bar */}
      <div className="flex gap-4 mb-2 font-mono text-xs text-nb-muted uppercase">
        <span>{visibleNodes} / {totalNodes} nodes</span>
        <span>{filteredData.links.length} edges</span>
        {searchTerm && <span>{matchCount} matches</span>}
      </div>

      <div ref={containerRef} className={`relative border-3 border-nb-border bg-nb-surface overflow-hidden ${isFullscreen ? 'flex-1' : ''}`} style={isFullscreen ? undefined : { maxHeight: dimensions.height }}>
        <ForceGraph
          ref={graphRef}
          graphData={filteredData}
          width={dimensions.width}
          height={dimensions.height}
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={nodePointerArea}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkLineDash={(link: any) => (link.linkType === 'involves' || link.linkType === 'source') ? [4, 2] : []}
          onNodeClick={(node: any) => setSelectedNode(node)}
          onNodeDoubleClick={handleNodeDoubleClick}
          onBackgroundClick={() => { setFocusedNodeId(null); setFocusExpansion(1); }}
          cooldownTicks={isInitialRender.current ? 100 : 0}
          warmupTicks={isInitialRender.current ? 0 : 1}
          onEngineStop={() => { isInitialRender.current = false; }}
          onZoom={handleZoom}
          backgroundColor="#1A1A2E"
        />

        {/* Keyboard shortcuts hint — top left, auto-fades */}
        {isFullscreen && (
          <div
            className="absolute top-3 left-3 z-10 border-2 border-nb-border bg-nb-surface/90 px-3 py-2 font-mono text-[10px] text-nb-muted space-y-0.5 pointer-events-none"
            style={{
              opacity: showHint ? 1 : 0,
              transition: 'opacity 0.6s ease-out',
            }}
          >
            <div className="font-bold uppercase text-nb-text text-[11px] mb-1">Keyboard</div>
            <div><span className="inline-block w-12 text-nb-lime font-bold">Arrows</span> Navigate nodes</div>
            <div><span className="inline-block w-12 text-nb-lime font-bold">{'\u2318'}F</span> Search</div>
            <div><span className="inline-block w-12 text-nb-lime font-bold">M</span> Go to me</div>
            <div><span className="inline-block w-12 text-nb-lime font-bold">Esc</span> Exit fullscreen</div>
          </div>
        )}

      {selectedNode && (
        <div className="absolute top-2 right-2 w-72 z-10">
          <Card className="max-h-[400px] overflow-y-auto" style={selfNodeId === selectedNode.id ? { borderColor: SELF_COLOR, boxShadow: `0 0 12px ${SELF_COLOR}40` } : undefined}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-display text-xs font-bold uppercase" style={selfNodeId === selectedNode.id ? { color: SELF_COLOR } : undefined}>
                {selfNodeId === selectedNode.id ? 'You' : selectedNode.nodeType === 'connector' ? 'Data Type' : selectedNode.nodeType === 'file' ? 'File' : selectedNode.nodeType === 'group' ? 'Group' : selectedNode.nodeType === 'device' ? 'Device' : selectedNode.nodeType === 'contact' ? 'Person' : 'Memory Detail'}
              </span>
              <button
                onClick={() => setSelectedNode(null)}
                className="border-2 border-nb-border w-6 h-6 flex items-center justify-center text-xs font-bold cursor-pointer hover:bg-nb-red hover:text-white text-nb-text"
              >
                X
              </button>
            </div>

            {/* Contact/Group/Device detail — rich view */}
            {['contact', 'group', 'device'].includes(selectedNode.nodeType || '') ? (
              contactDetail ? (
                <div className="flex flex-col gap-3">
                  {/* Display name */}
                  <div className="font-mono text-sm font-bold text-nb-text">{contactDetail.displayName}</div>

                  {/* Avatars */}
                  {contactDetail.avatars && JSON.parse(contactDetail.avatars || '[]').length > 0 && (
                    <div className="flex gap-2 flex-wrap">
                      {JSON.parse(contactDetail.avatars).map((av: any, i: number) => (
                        <img key={i} src={av.url} alt="" className="border-2 border-nb-border w-12 h-12 object-cover" />
                      ))}
                    </div>
                  )}

                  {/* Connector badges */}
                  <div className="flex gap-1 flex-wrap">
                    {(selectedNode.connectors || []).map((c: string) => (
                      <span
                        key={c}
                        className="border-2 border-nb-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase"
                        style={{ backgroundColor: CONNECTOR_COLORS[c] || '#999', color: '#000' }}
                      >
                        {c}
                      </span>
                    ))}
                  </div>

                  {/* Identifiers */}
                  {contactDetail.identifiers?.length > 0 && (
                    <div>
                      <span className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted block mb-1">Identifiers</span>
                      <div className="flex flex-col gap-1">
                        {contactDetail.identifiers.map((ident: any) => (
                          <div key={ident.id} className="flex items-center gap-2">
                            <Badge color={IDENTIFIER_COLORS[ident.identifierType] || IDENTIFIER_COLORS[ident.type]} className="text-[10px] py-0 shrink-0">
                              {ident.identifierType || ident.type}
                            </Badge>
                            <span className="font-mono text-xs text-nb-text truncate flex-1">{ident.identifierValue || ident.value}</span>
                            <button
                              onClick={async () => {
                                const contactId = selectedNode!.id.replace(/^contact-/, '');
                                await api.removeIdentifier(contactId, ident.id);
                                api.getContact(contactId).then(setContactDetail).catch(() => {});
                              }}
                              disabled={contactDetail.identifiers.length <= 1}
                              className="border border-nb-border w-5 h-5 flex items-center justify-center text-[10px] font-bold hover:bg-nb-red hover:text-white cursor-pointer text-nb-muted disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                            >
                              X
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Stats */}
                  <div className="font-mono text-[10px] text-nb-muted">
                    Connections: <span className="text-nb-text font-bold">{connectionCounts.get(selectedNode.id) || 0}</span>
                  </div>

                  {/* Linked memories */}
                  <div>
                    <span className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted block mb-1">
                      Linked Memories ({contactMemories.length})
                    </span>
                    <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                      {contactMemories.length === 0 && (
                        <p className="font-mono text-[10px] text-nb-muted">No linked memories</p>
                      )}
                      {contactMemories.map((m: any) => (
                        <div key={m.id} className="border-2 border-nb-border p-1.5 bg-nb-surface-muted">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="font-mono text-[10px] text-nb-muted">{formatDate(m.eventTime || m.createdAt)}</span>
                            <Badge className="text-[10px] py-0">{m.connectorType}</Badge>
                          </div>
                          <p className="font-mono text-[10px] text-nb-text line-clamp-2">{m.text}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="font-mono text-xs text-nb-muted">Loading...</div>
              )
            ) : (
              <>
                {/* Badges */}
                <div className="flex gap-1 flex-wrap mb-2">
                  {selectedNode.nodeType === 'connector' ? (
                    <span
                      className="border-2 border-nb-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase"
                      style={{ backgroundColor: CONNECTOR_COLORS[selectedNode.source] || '#999', color: '#000' }}
                    >
                      {selectedNode.source}
                    </span>
                  ) : (
                    <>
                      <span
                        className="border-2 border-nb-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase"
                        style={{ backgroundColor: CONNECTOR_COLORS[selectedNode.sourceConnector] || CONNECTOR_COLORS[selectedNode.source] || '#999', color: '#000' }}
                      >
                        {selectedNode.sourceConnector || selectedNode.source}
                      </span>
                      <span className="border-2 border-nb-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-nb-text">
                        {selectedNode.source}
                      </span>
                    </>
                  )}
                </div>

                {/* Photo thumbnail */}
                {selectedNode.nodeType === 'memory' && (selectedNode.source === 'file' || selectedNode.source === 'photo') && !!selectedNode.metadata?.fileUrl && (
                  <div className="border-3 border-nb-border overflow-hidden mb-2">
                    <img
                      src={`/api/memories/${selectedNode.id}/thumbnail`}
                      alt=""
                      className="w-full h-auto max-h-48 object-contain bg-black"
                      loading="lazy"
                    />
                  </div>
                )}

                {/* Text content */}
                {selectedNode.text && (
                  <div className="border-3 border-nb-border p-2 bg-nb-surface-muted mb-2 max-h-32 overflow-y-auto">
                    <p className="font-mono text-xs text-nb-text whitespace-pre-wrap break-words">{selectedNode.text}</p>
                  </div>
                )}

                {/* Event time */}
                {selectedNode.eventTime && (
                  <div className="font-mono text-[10px] text-nb-muted mb-2">
                    EVENT: {new Date(selectedNode.eventTime).toLocaleDateString()} {new Date(selectedNode.eventTime).toLocaleTimeString()}
                  </div>
                )}

                {/* Stats row */}
                <div className="flex gap-3 mb-2 font-mono text-[10px]">
                  <span className="text-nb-muted">Connections: <span className="text-nb-text font-bold">{connectionCounts.get(selectedNode.id) || 0}</span></span>
                  {selectedNode.nodeType === 'memory' && (
                    <span className="text-nb-muted">Importance: <span className="text-nb-text font-bold">{(selectedNode.importance * 100).toFixed(0)}%</span></span>
                  )}
                </div>

                {/* Weight breakdown — only for memories */}
                {selectedNode.nodeType === 'memory' && selectedNode.weights && (
                  <div className="mb-2">
                    <span className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted block mb-1">Weight Breakdown</span>
                    <div className="flex flex-col gap-1">
                      {Object.entries(selectedNode.weights).map(([key, val]) => (
                        <div key={key} className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px] uppercase w-16 text-nb-muted">{key}</span>
                          <div className="flex-1 h-3 border border-nb-border bg-nb-surface-muted">
                            <div
                              className="h-full"
                              style={{
                                width: `${(typeof val === 'number' ? val : 0) * 100}%`,
                                backgroundColor: key === 'final' ? '#C4F53A' : '#A855F7',
                              }}
                            />
                          </div>
                          <span className="font-mono text-[10px] w-8 text-right text-nb-text">{(typeof val === 'number' ? val * 100 : 0).toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Entities */}
                {selectedNode.entities && selectedNode.entities.length > 0 && (
                  <div>
                    <span className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted block mb-1">Entities</span>
                    <div className="flex gap-1 flex-wrap">
                      {selectedNode.entities.map((e: string, i: number) => (
                        <span
                          key={i}
                          className="border border-nb-border px-1.5 py-0.5 font-mono text-[10px] bg-nb-surface text-nb-text"
                        >
                          {e}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      )}

      {/* Graph Controls + Legend */}
      <div className="absolute bottom-2 left-2 flex items-end gap-1 z-10">
        {/* Legend */}
        <div className="relative">
          <button
            onClick={() => setLegendOpen(!legendOpen)}
            className="border-2 border-nb-border h-8 px-3 flex items-center gap-2 font-mono text-xs font-bold uppercase bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
          >
            Legend
            <span className="text-[10px]">{legendOpen ? '\u2212' : '+'}</span>
          </button>

          {legendOpen && (
            <div className="absolute bottom-full left-0 mb-1 w-72 border-3 border-nb-border bg-nb-surface shadow-nb p-3 space-y-3">
              {/* Node Types */}
              <div>
                <div className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted mb-1.5">
                  Nodes
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <LegendToggle
                    active={!hideContacts}
                    onClick={() => setHideContacts(!hideContacts)}
                    icon={
                      <svg width="16" height="16" viewBox="0 0 16 16">
                        <circle cx="8" cy="8" r="7" fill={CONTACT_COLOR} stroke="#E0E0E0" strokeWidth="1" />
                        <circle cx="8" cy="6" r="2.5" fill="#1A1A2E" />
                        <ellipse cx="8" cy="13" rx="4" ry="3" fill="#1A1A2E" />
                      </svg>
                    }
                    label="People"
                  />
                  <LegendToggle
                    active={!hideGroups}
                    onClick={() => setHideGroups(!hideGroups)}
                    icon={
                      <svg width="16" height="16" viewBox="0 0 16 16">
                        <polygon points="8,1 14.5,4.5 14.5,11.5 8,15 1.5,11.5 1.5,4.5" fill={GROUP_COLOR} stroke="#E0E0E0" strokeWidth="1" />
                        <circle cx="5.5" cy="6.5" r="1.5" fill="#1A1A2E" />
                        <circle cx="10.5" cy="6.5" r="1.5" fill="#1A1A2E" />
                        <ellipse cx="8" cy="11.5" rx="4" ry="2.5" fill="#1A1A2E" />
                      </svg>
                    }
                    label="Groups"
                  />
                  <LegendToggle
                    active={!hideFiles}
                    onClick={() => setHideFiles(!hideFiles)}
                    icon={
                      <svg width="16" height="16" viewBox="0 0 16 16">
                        <polygon points="8,1 15,8 8,15 1,8" fill={FILE_COLOR} stroke="#E0E0E0" strokeWidth="1" />
                        <line x1="5" y1="7" x2="11" y2="7" stroke="#1A1A2E" strokeWidth="1.5" />
                        <line x1="5" y1="9.5" x2="11" y2="9.5" stroke="#1A1A2E" strokeWidth="1.5" />
                      </svg>
                    }
                    label="Files"
                  />
                  <LegendToggle
                    active={!hideDevices}
                    onClick={() => setHideDevices(!hideDevices)}
                    icon={
                      <svg width="16" height="16" viewBox="0 0 16 16">
                        <rect x="2" y="2" width="12" height="12" rx="3" fill={DEVICE_COLOR} stroke="#E0E0E0" strokeWidth="1" />
                        <rect x="6" y="4" width="4" height="7" rx="0.5" fill="#1A1A2E" />
                        <circle cx="8" cy="12" r="0.8" fill="#1A1A2E" />
                      </svg>
                    }
                    label="Devices"
                  />
                  {sourceTypes.map((st) => (
                    <LegendToggle
                      key={st}
                      active={!hiddenSourceTypes.has(st)}
                      onClick={() => {
                        setHiddenSourceTypes((prev) => {
                          const next = new Set(prev);
                          next.has(st) ? next.delete(st) : next.add(st);
                          return next;
                        });
                      }}
                      icon={
                        <svg width="14" height="14" viewBox="0 0 14 14">
                          <rect x="1" y="1" width="12" height="12" fill={CONNECTOR_COLORS[st] || '#999'} stroke="#E0E0E0" strokeWidth="1" />
                        </svg>
                      }
                      label={SOURCE_TYPE_LABELS[st] || st}
                    />
                  ))}
                </div>
              </div>

              {/* Edge Types */}
              <div>
                <div className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted mb-1.5">
                  Relationships
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {edgeTypes.map((type) => (
                    <LegendToggle
                      key={type}
                      active={!hiddenEdgeTypes.has(type)}
                      onClick={() => {
                        setHiddenEdgeTypes((prev) => {
                          const next = new Set(prev);
                          next.has(type) ? next.delete(type) : next.add(type);
                          return next;
                        });
                      }}
                      icon={
                        <span className="w-4 flex items-center">
                          <span
                            className="w-full inline-block"
                            style={{
                              height: type === 'involves' ? 1 : 2,
                              backgroundColor: edgeTypeColor(type),
                              borderTop: type === 'involves' ? `1px dashed ${edgeTypeColor(type)}` : 'none',
                            }}
                          />
                        </span>
                      }
                      label={type}
                    />
                  ))}
                </div>
              </div>

              {/* Node Size */}
              <div>
                <div className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted mb-1.5">
                  Size = Importance
                </div>
                <div className="flex items-center gap-2 font-mono text-[10px] text-nb-muted">
                  <span className="w-2 h-2 border border-nb-muted inline-block" /> low
                  <span className="w-3 h-3 border border-nb-muted inline-block" /> med
                  <span className="w-4 h-4 border border-nb-muted inline-block" /> high
                </div>
              </div>
            </div>
          )}
        </div>
        {/* Zoom controls */}
        <div className="flex gap-1">
          <button
            onClick={() => graphRef.current?.zoom(graphRef.current.zoom() * 1.5, 300)}
            className="border-2 border-nb-border w-8 h-8 flex items-center justify-center font-mono text-sm font-bold bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
          >+</button>
          <button
            onClick={() => graphRef.current?.zoom(graphRef.current.zoom() / 1.5, 300)}
            className="border-2 border-nb-border w-8 h-8 flex items-center justify-center font-mono text-sm font-bold bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
          >{'\u2212'}</button>
          <button
            onClick={() => graphRef.current?.zoomToFit(400)}
            className="border-2 border-nb-border w-8 h-8 flex items-center justify-center font-mono text-sm font-bold bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
          >{'\u2299'}</button>
        </div>
      </div>{/* end controls + legend */}

        {/* Fullscreen toggle — bottom right */}
        <button
          onClick={() => setIsFullscreen((f) => !f)}
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          className="absolute bottom-2 right-2 z-10 border-2 border-nb-border w-8 h-8 flex items-center justify-center font-mono text-sm font-bold bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
        >
          {isFullscreen ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9,1 9,5 13,5" />
              <polyline points="5,13 5,9 1,9" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1,5 1,1 5,1" />
              <polyline points="13,9 13,13 9,13" />
            </svg>
          )}
        </button>
      </div>{/* end canvas container */}
    </div>
  );
}
