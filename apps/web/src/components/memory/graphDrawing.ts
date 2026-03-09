import { CONNECTOR_COLORS, truncate } from '@botmem/shared';

const CONTACT_COLOR = '#60A5FA';
const SELF_COLOR = '#C4F53A';
const GROUP_COLOR = '#C084FC';
const FILE_COLOR = '#FB923C';
const DEVICE_COLOR = '#2DD4BF';
const HIGHLIGHT_COLOR = '#A3E635';
const DIM_OPACITY = 0.15;

export {
  CONTACT_COLOR,
  SELF_COLOR,
  GROUP_COLOR,
  FILE_COLOR,
  DEVICE_COLOR,
  HIGHLIGHT_COLOR,
  DIM_OPACITY,
};

export function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size, y);
  ctx.closePath();
}

export function drawHexagon(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
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

export function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
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

export interface NodeRenderCtx {
  searchMatchIds: Set<string> | null;
  highlightedIds: Set<string> | null;
  focusVisibleIds: Set<string> | null;
  selfNodeId: string | null;
  scoreMap: Map<string, number> | null;
}

export function renderNode(
  node: any,
  ctx: CanvasRenderingContext2D,
  globalScale: number,
  rc: NodeRenderCtx,
) {
  const x = node.x || 0;
  const y = node.y || 0;
  const isContact = node.nodeType === 'contact';
  const isGroup = node.nodeType === 'group';
  const isFile = node.nodeType === 'file';
  const isDevice = node.nodeType === 'device';
  const isConnector = node.nodeType === 'connector';

  const isSearchActive = rc.searchMatchIds !== null;
  const isFocusActive = rc.focusVisibleIds !== null;
  const isHighlighted = rc.highlightedIds?.has(node.id);
  const isDirectMatch = rc.searchMatchIds?.has(node.id);
  const isFocusVisible = rc.focusVisibleIds?.has(node.id);
  const shouldDim = (isSearchActive && !isHighlighted) || (isFocusActive && !isFocusVisible);

  const rankScore = isDirectMatch ? (rc.scoreMap?.get(node.id) ?? 0.5) : -1;
  const isTopResult = rankScore >= 0.8;

  ctx.globalAlpha = shouldDim
    ? DIM_OPACITY
    : isSearchActive && isDirectMatch && !isTopResult
      ? 0.4 + rankScore * 0.6
      : 1;

  if (isConnector) {
    const color = CONNECTOR_COLORS[node.source] || '#999';
    const w = 28;
    const h = 20;
    const r = 5;
    drawRoundedRect(ctx, x + 2, y + 2, w, h, r);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fill();
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
    ctx.font = `bold ${8}px IBM Plex Mono`;
    ctx.fillStyle = '#1A1A2E';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.label.toUpperCase().slice(0, 6), x, y);
    ctx.textBaseline = 'alphabetic';
    if (globalScale > 0.8 || isDirectMatch) {
      ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
      ctx.fillStyle = isDirectMatch ? HIGHLIGHT_COLOR : color;
      ctx.textAlign = 'center';
      ctx.fillText(node.label, x, y + h / 2 + 12 / globalScale);
    }
  } else if (isFile) {
    const size = 7;
    drawDiamond(ctx, x + 1.5, y + 1.5, size);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
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
    drawHexagon(ctx, x + 1.5, y + 1.5, radius);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
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
    drawRoundedRect(ctx, x + 1.5, y + 1.5, w, h, r);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
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
    ctx.fillStyle = '#1A1A2E';
    ctx.fillRect(x - 2, y - 3, 4, 6);
    ctx.fillRect(x - 1.5, y - 2.5, 3, 4);
    if (globalScale > 1.0 || isDirectMatch) {
      ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
      ctx.fillStyle = isDirectMatch ? HIGHLIGHT_COLOR : DEVICE_COLOR;
      ctx.textAlign = 'center';
      ctx.fillText(truncate(node.label, 20), x, y + h / 2 + 12 / globalScale);
    }
  } else if (isContact) {
    const isSelf = rc.selfNodeId === node.id;
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
    if (globalScale > 1.2 || isDirectMatch || isSelf) {
      ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
      ctx.fillStyle = isDirectMatch ? HIGHLIGHT_COLOR : contactColor;
      ctx.textAlign = 'center';
      ctx.fillText(isSelf ? 'ME' : truncate(node.label, 20), x, y + radius + 12 / globalScale);
    }
  } else {
    const baseSize = 6 + (node.importance || 0.5) * 12;
    const size = isTopResult ? baseSize * (1.2 + rankScore * 0.5) : baseSize;
    const color = CONNECTOR_COLORS[node.source] || '#999';
    if (isTopResult) {
      ctx.shadowColor = HIGHLIGHT_COLOR;
      ctx.shadowBlur = 8 + rankScore * 12;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x - size / 2 + 2, y - size / 2 + 2, size, size);
    ctx.fillStyle = color;
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
    if (isTopResult) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
    if (isDirectMatch) {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = isTopResult ? 4 : 3;
    } else {
      ctx.strokeStyle = '#E0E0E0';
      ctx.lineWidth = 1.5;
    }
    ctx.strokeRect(x - size / 2, y - size / 2, size, size);
    if (globalScale > 1.5 || isDirectMatch) {
      ctx.font = `bold ${(isTopResult ? 12 : 10) / globalScale}px IBM Plex Mono`;
      ctx.fillStyle = isDirectMatch ? HIGHLIGHT_COLOR : '#F0F0F0';
      ctx.textAlign = 'center';
      ctx.fillText(truncate(node.label, 20), x, y + size / 2 + 10 / globalScale);
    }
  }

  ctx.globalAlpha = 1;
}

export function renderNodePointerArea(node: any, color: string, ctx: CanvasRenderingContext2D) {
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
    ctx.arc(x, y, 14, 0, 2 * Math.PI);
    ctx.fill();
  } else {
    const size = 6 + (node.importance || 0.5) * 12;
    const hitSize = Math.max(size + 6, 24);
    ctx.fillRect(x - hitSize / 2, y - hitSize / 2, hitSize, hitSize);
  }
}
