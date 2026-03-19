import { CONNECTOR_COLORS, truncate } from '@botmem/shared';
import type { SimulationNode } from './graphTypes';

// Image cache — loaded once per URL, reused across frames
const imageCache = new Map<string, HTMLImageElement | 'loading' | 'failed'>();

/** Load image via plain GET (for public URLs and data: URIs) */
function getAvatarImage(url: string): HTMLImageElement | null {
  const cached = imageCache.get(url);
  if (cached === 'loading' || cached === 'failed') return null;
  if (cached) return cached;
  imageCache.set(url, 'loading');
  const img = new Image();
  img.onload = () => {
    imageCache.set(url, img);
  };
  img.onerror = () => {
    imageCache.set(url, 'failed');
  };
  img.src = url;
  return null;
}

/** Load image via fetch with auth headers (for protected endpoints like thumbnails) */
function getAuthedImage(url: string, token: string | null): HTMLImageElement | null {
  const cached = imageCache.get(url);
  if (cached === 'loading' || cached === 'failed') return null;
  if (cached) return cached;
  imageCache.set(url, 'loading');
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  fetch(url, { headers, credentials: 'include' })
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status}`);
      return res.blob();
    })
    .then((blob) => {
      const img = new Image();
      img.onload = () => {
        imageCache.set(url, img);
      };
      img.onerror = () => {
        imageCache.set(url, 'failed');
      };
      img.src = URL.createObjectURL(blob);
    })
    .catch(() => {
      imageCache.set(url, 'failed');
    });
  return null;
}

const CONTACT_COLOR = '#60A5FA';
const SELF_COLOR = '#C4F53A';
const GROUP_COLOR = '#C084FC';
const FILE_COLOR = '#FB923C';
const PHOTO_COLOR = '#F9A8D4';
const DEVICE_COLOR = '#2DD4BF';
const HIGHLIGHT_COLOR = '#A3E635';
const DIM_OPACITY = 0.15;

/** Read live CSS custom-property values so the graph matches the active theme. */
function getThemeColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    bg: v('--color-nb-bg') || '#0D0D0D',
    surface: v('--color-nb-surface') || '#1A1A1A',
    border: v('--color-nb-border') || '#333',
    text: v('--color-nb-text') || '#E0E0E0',
    muted: v('--color-nb-muted') || '#A0A0A0',
    accent: v('--color-nb-lime') || '#C4F53A',
  };
}

/** Cached theme — refreshed once per animation frame via refreshThemeCache(). */
let _tc = getThemeColors();
export function refreshThemeCache() {
  _tc = getThemeColors();
}

export const ENTITY_COLORS: Record<string, string> = {
  person: '#C4F53A',
  organization: '#0088CC',
  location: '#5856D6',
  date: '#E67E00',
  amount: '#EA4335',
};

export {
  CONTACT_COLOR,
  SELF_COLOR,
  GROUP_COLOR,
  FILE_COLOR,
  PHOTO_COLOR,
  DEVICE_COLOR,
  HIGHLIGHT_COLOR,
  DIM_OPACITY,
};

// ── Source-type glyph cache ─────────────────────────────────
// Pre-renders glyphs to offscreen canvases keyed by "source:size".
// drawImage() per frame is much faster than re-pathing every node.

const glyphCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

function getGlyphCanvas(
  source: string,
  size: number,
  color: string,
): OffscreenCanvas | HTMLCanvasElement | null {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const key = `${source}:${Math.round(size)}:${dpr}`;
  const cached = glyphCache.get(key);
  if (cached) return cached;

  const s = Math.round(size);
  if (s < 4) return null;
  const ps = Math.round(s * dpr); // physical pixel size
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(ps, ps)
      : (() => {
          const c = document.createElement('canvas');
          c.width = ps;
          c.height = ps;
          return c;
        })();
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D;
  if (!ctx) return null;

  // Scale so drawing coordinates match logical size
  ctx.scale(dpr, dpr);

  const cx = s / 2;
  const cy = s / 2;
  const bg = 'transparent';

  if (source === 'email') {
    const ew = s * 0.55;
    const eh = s * 0.38;
    ctx.fillStyle = bg;
    ctx.fillRect(cx - ew / 2, cy - eh / 2, ew, eh);
    ctx.beginPath();
    ctx.moveTo(cx - ew / 2, cy - eh / 2);
    ctx.lineTo(cx, cy + eh * 0.1);
    ctx.lineTo(cx + ew / 2, cy - eh / 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, s * 0.07);
    ctx.stroke();
  } else if (source === 'message') {
    const bw = s * 0.55;
    const bh = s * 0.38;
    const br = s * 0.08;
    // Bubble body
    const left = cx - bw / 2;
    const top = cy - s * 0.05 - bh / 2;
    ctx.beginPath();
    ctx.moveTo(left + br, top);
    ctx.lineTo(left + bw - br, top);
    ctx.arcTo(left + bw, top, left + bw, top + br, br);
    ctx.lineTo(left + bw, top + bh - br);
    ctx.arcTo(left + bw, top + bh, left + bw - br, top + bh, br);
    ctx.lineTo(left + br, top + bh);
    ctx.arcTo(left, top + bh, left, top + bh - br, br);
    ctx.lineTo(left, top + br);
    ctx.arcTo(left, top, left + br, top, br);
    ctx.closePath();
    ctx.fillStyle = bg;
    ctx.fill();
    // Tail
    ctx.beginPath();
    ctx.moveTo(cx - bw * 0.25, top + bh);
    ctx.lineTo(cx - bw * 0.35, top + bh + s * 0.12);
    ctx.lineTo(cx - bw * 0.05, top + bh);
    ctx.fillStyle = bg;
    ctx.fill();
    // Dots
    const dotR = Math.max(0.8, s * 0.05);
    ctx.fillStyle = color;
    for (const dx of [-s * 0.1, 0, s * 0.1]) {
      ctx.beginPath();
      ctx.arc(cx + dx, cy - s * 0.05, dotR, 0, 2 * Math.PI);
      ctx.fill();
    }
  } else if (source === 'location') {
    const pr = s * 0.2;
    ctx.beginPath();
    ctx.arc(cx, cy - s * 0.05, pr, Math.PI, 0);
    ctx.lineTo(cx, cy + s * 0.25);
    ctx.closePath();
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy - s * 0.05, pr * 0.4, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    return null; // No glyph for this source type
  }

  glyphCache.set(key, canvas);
  return canvas;
}

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
  authToken: string | null;
  selectedNodeId: string | null;
}

export function renderNode(
  node: SimulationNode,
  ctx: CanvasRenderingContext2D,
  globalScale: number,
  rc: NodeRenderCtx,
) {
  const x = node.x || 0;
  const y = node.y || 0;
  const isContact = node.nodeType === 'contact';
  const isGroup = node.nodeType === 'group';
  const isFile = node.nodeType === 'file';
  const isPhoto = node.nodeType === 'memory' && node.source === 'photo';
  const isDevice = node.nodeType === 'device';
  const isConnector = node.nodeType === 'connector';

  const isDirectMatch = rc.searchMatchIds?.has(node.id);
  const isFocusActive = rc.focusVisibleIds !== null;
  const isFocusVisible = rc.focusVisibleIds?.has(node.id);

  const rankScore = isDirectMatch ? (rc.scoreMap?.get(node.id) ?? 0.5) : -1;
  const isTopResult = rankScore === 1;

  const focusDimmed = isFocusActive && !isFocusVisible;
  ctx.globalAlpha = focusDimmed ? DIM_OPACITY : 1;

  if (isConnector) {
    const color = CONNECTOR_COLORS[node.source] || '#999';
    const w = 28;
    const h = 20;
    const r = 5;
    drawRoundedRect(ctx, x + 2, y + 2, w, h, r);
    ctx.fillStyle = _tc.border + '30';
    ctx.fill();
    drawRoundedRect(ctx, x, y, w, h, r);
    ctx.fillStyle = color;
    ctx.fill();
    if (isTopResult) {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = 3;
    } else {
      ctx.strokeStyle = _tc.border;
      ctx.lineWidth = 2;
    }
    ctx.stroke();
    ctx.font = `bold ${8}px IBM Plex Mono`;
    ctx.fillStyle = _tc.surface;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.label.toUpperCase().slice(0, 6), x, y);
    ctx.textBaseline = 'alphabetic';
    if (globalScale > 0.8 || isDirectMatch) {
      ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
      ctx.fillStyle = isTopResult ? HIGHLIGHT_COLOR : color;
      ctx.textAlign = 'center';
      ctx.fillText(node.label, x, y + h / 2 + 12 / globalScale);
    }
  } else if (isFile) {
    const size = 7;
    drawDiamond(ctx, x + 1.5, y + 1.5, size);
    ctx.fillStyle = _tc.border + '30';
    ctx.fill();
    drawDiamond(ctx, x, y, size);
    ctx.fillStyle = FILE_COLOR;
    ctx.fill();
    if (isTopResult) {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = 3;
    } else {
      ctx.strokeStyle = _tc.border;
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
      ctx.fillStyle = isTopResult ? HIGHLIGHT_COLOR : FILE_COLOR;
      ctx.textAlign = 'center';
      ctx.fillText(truncate(node.label, 20), x, y + size + 12 / globalScale);
    }
  } else if (isGroup) {
    const radius = 10;
    drawHexagon(ctx, x + 1.5, y + 1.5, radius);
    ctx.fillStyle = _tc.border + '30';
    ctx.fill();
    drawHexagon(ctx, x, y, radius);
    ctx.fillStyle = GROUP_COLOR;
    ctx.fill();
    if (isTopResult) {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = 3;
    } else {
      ctx.strokeStyle = _tc.border;
      ctx.lineWidth = 2;
    }
    ctx.stroke();
    ctx.fillStyle = _tc.surface;
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
      ctx.fillStyle = isTopResult ? HIGHLIGHT_COLOR : GROUP_COLOR;
      ctx.textAlign = 'center';
      ctx.fillText(truncate(node.label, 20), x, y + radius + 12 / globalScale);
    }
  } else if (isDevice) {
    const w = 20;
    const h = 14;
    const r = 4;
    drawRoundedRect(ctx, x + 1.5, y + 1.5, w, h, r);
    ctx.fillStyle = _tc.border + '30';
    ctx.fill();
    drawRoundedRect(ctx, x, y, w, h, r);
    ctx.fillStyle = DEVICE_COLOR;
    ctx.fill();
    if (isTopResult) {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = 3;
    } else {
      ctx.strokeStyle = _tc.border;
      ctx.lineWidth = 1.5;
    }
    ctx.stroke();
    ctx.fillStyle = _tc.surface;
    ctx.fillRect(x - 2, y - 3, 4, 6);
    ctx.fillRect(x - 1.5, y - 2.5, 3, 4);
    if (globalScale > 1.0 || isDirectMatch) {
      ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
      ctx.fillStyle = isTopResult ? HIGHLIGHT_COLOR : DEVICE_COLOR;
      ctx.textAlign = 'center';
      ctx.fillText(truncate(node.label, 20), x, y + h / 2 + 12 / globalScale);
    }
  } else if (isContact) {
    const isSelf = rc.selfNodeId === node.id;
    const contactColor = isSelf ? SELF_COLOR : CONTACT_COLOR;
    const radius = isSelf ? 10 : 8;
    // Use data URI from node directly, fall back to proxy for legacy URLs
    const avatarImg = node.avatarUrl?.startsWith('data:')
      ? getAvatarImage(node.avatarUrl)
      : node.avatarUrl && node.id
        ? getAuthedImage(`/api/people/${node.id.replace('contact-', '')}/avatar`, rc.authToken)
        : null;

    // Shadow
    ctx.beginPath();
    ctx.arc(x + 1.5, y + 1.5, radius, 0, 2 * Math.PI);
    ctx.fillStyle = _tc.border + '30';
    ctx.fill();

    if (avatarImg) {
      // Draw avatar clipped to circle
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.clip();
      ctx.drawImage(avatarImg, x - radius, y - radius, radius * 2, radius * 2);
      ctx.restore();
    } else {
      // Fallback: solid circle with person glyph
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = contactColor;
      ctx.fill();
    }

    // Border
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    if (isTopResult) {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = 3;
    } else if (isSelf) {
      ctx.strokeStyle = '#FFF';
      ctx.lineWidth = 3;
    } else {
      ctx.strokeStyle = avatarImg ? _tc.muted : _tc.border;
      ctx.lineWidth = 2;
    }
    ctx.stroke();

    // Inner icon (only when no avatar)
    if (!avatarImg) {
      if (isSelf) {
        ctx.fillStyle = _tc.surface;
        ctx.font = `bold 10px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u2605', x, y);
        ctx.textBaseline = 'alphabetic';
      } else {
        ctx.fillStyle = _tc.surface;
        ctx.beginPath();
        ctx.arc(x, y - 2, 3, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y + 5, 5, Math.PI, 0);
        ctx.fill();
      }
    }

    if (globalScale > 1.2 || isDirectMatch || isSelf) {
      ctx.font = `bold ${10 / globalScale}px IBM Plex Mono`;
      ctx.fillStyle = isTopResult ? HIGHLIGHT_COLOR : contactColor;
      ctx.textAlign = 'center';
      ctx.fillText(isSelf ? 'ME' : truncate(node.label, 20), x, y + radius + 12 / globalScale);
    }
  } else if (isPhoto) {
    const baseSize = 8 + (node.importance || 0.5) * 10;
    const size = rankScore >= 0 ? baseSize * (0.5 + rankScore * 0.8) : baseSize;
    const r = 3;
    // Prefer inline data URL (no HTTP request), fall back to authed thumbnail endpoint
    const thumbImg = node.thumbnailDataUrl
      ? getAvatarImage(node.thumbnailDataUrl)
      : getAuthedImage(`/api/memories/${node.id}/thumbnail`, rc.authToken);

    if (isTopResult) {
      ctx.shadowColor = HIGHLIGHT_COLOR;
      ctx.shadowBlur = 8 + rankScore * 12;
    }
    // Shadow
    drawRoundedRect(ctx, x + 1.5, y + 1.5, size, size, r);
    ctx.fillStyle = _tc.border + '30';
    ctx.fill();

    if (thumbImg) {
      // Draw thumbnail clipped to rounded rect, cover-cropped to maintain aspect ratio
      ctx.save();
      drawRoundedRect(ctx, x, y, size, size, r);
      ctx.clip();
      const iw = thumbImg.naturalWidth || thumbImg.width;
      const ih = thumbImg.naturalHeight || thumbImg.height;
      const scale = Math.max(size / iw, size / ih);
      const sw = iw * scale;
      const sh = ih * scale;
      ctx.drawImage(thumbImg, x - sw / 2, y - sh / 2, sw, sh);
      ctx.restore();
    } else {
      // Fallback: pink rect with mountain/sun glyph
      drawRoundedRect(ctx, x, y, size, size, r);
      ctx.fillStyle = PHOTO_COLOR;
      ctx.fill();
      ctx.fillStyle = _tc.surface;
      const s = size * 0.22;
      ctx.beginPath();
      ctx.arc(x + s, y - s, s * 0.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - size * 0.3, y + size * 0.25);
      ctx.lineTo(x, y - size * 0.1);
      ctx.lineTo(x + size * 0.3, y + size * 0.25);
      ctx.closePath();
      ctx.fill();
    }
    if (isTopResult) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
    // Border
    drawRoundedRect(ctx, x, y, size, size, r);
    if (isTopResult) {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = 4;
    } else {
      ctx.strokeStyle = thumbImg ? _tc.muted : _tc.border;
      ctx.lineWidth = 1.5;
    }
    ctx.stroke();
    if (globalScale > 1.5 || isDirectMatch) {
      ctx.font = `bold ${(isTopResult ? 12 : 10) / globalScale}px IBM Plex Mono`;
      ctx.fillStyle = isTopResult ? HIGHLIGHT_COLOR : PHOTO_COLOR;
      ctx.textAlign = 'center';
      ctx.fillText(truncate(node.label, 20), x, y + size / 2 + 10 / globalScale);
    }
  } else {
    const baseSize = 6 + (node.importance || 0.5) * 12;
    const radius = (rankScore >= 0 ? baseSize * (0.5 + rankScore * 0.8) : baseSize) / 2;
    const color = CONNECTOR_COLORS[node.source] || '#999';

    if (isTopResult) {
      ctx.shadowColor = HIGHLIGHT_COLOR;
      ctx.shadowBlur = 8 + rankScore * 12;
    }
    // Shadow
    ctx.beginPath();
    ctx.arc(x + 1.5, y + 1.5, radius, 0, 2 * Math.PI);
    ctx.fillStyle = _tc.border + '30';
    ctx.fill();
    // Fill circle
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    if (isTopResult) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
    // Selected node glow
    if (rc.selectedNodeId === node.id) {
      ctx.shadowColor = HIGHLIGHT_COLOR;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else if (isTopResult) {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.stroke();
    } else {
      ctx.strokeStyle = _tc.border;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.stroke();
    }
    // Inner glyph
    const glyph = getGlyphCanvas(node.source, radius * 2, color);
    if (glyph) {
      ctx.drawImage(glyph as CanvasImageSource, x - radius, y - radius, radius * 2, radius * 2);
    }
    // Label
    if (globalScale > 1.5 || isDirectMatch) {
      ctx.font = `bold ${(isTopResult ? 12 : 10) / globalScale}px IBM Plex Mono`;
      ctx.fillStyle = isTopResult ? HIGHLIGHT_COLOR : _tc.text;
      ctx.textAlign = 'center';
      ctx.fillText(truncate(node.label, 20), x, y + radius + 10 / globalScale);
    }
  }

  ctx.globalAlpha = 1;
}

export function renderNodePointerArea(
  node: SimulationNode,
  color: string,
  ctx: CanvasRenderingContext2D,
) {
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
  } else if (node.nodeType === 'memory' && node.source === 'photo') {
    const size = 8 + (node.importance || 0.5) * 10;
    const hitSize = Math.max(size + 6, 24);
    drawRoundedRect(ctx, x, y, hitSize, hitSize, 3);
    ctx.fill();
  } else {
    const size = 6 + (node.importance || 0.5) * 12;
    const radius = Math.max(size / 2 + 3, 12);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fill();
  }
}
