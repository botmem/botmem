/**
 * Build-time prerender script.
 * Runs after both client and SSR builds to generate static HTML for public pages.
 *
 * Usage: node prerender.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, 'dist');
const ssrPath = path.resolve(__dirname, 'dist-ssr', 'entry-server.js');

// Routes to prerender — static public pages only
const ROUTES = ['/', '/pricing', '/privacy', '/terms', '/data-policy'];

const BASE_URL = 'https://botmem.xyz';

const ROUTE_META = {
  '/': {
    title: 'Botmem — Your Life, Searchable. Personal Memory for AI Agents.',
    description:
      'Open-source personal memory system. Ingest Gmail, Slack, WhatsApp, iMessage, photos, and locations into one AI-powered searchable memory. Self-hosted, local-first, privacy-focused. MCP server for Claude, Cursor, and AI coding agents.',
    canonical: `${BASE_URL}/`,
    ogTitle: 'Botmem — Your Life, Searchable',
    ogDescription:
      'Open-source personal memory. Search Gmail, Slack, WhatsApp, iMessage, photos and locations with AI. Self-hosted or managed.',
    robots: 'index, follow',
  },
  '/pricing': {
    title: 'Botmem Pricing — Free Self-Hosted or Managed Pro',
    description:
      'Botmem pricing: self-host free forever with all features, or get managed Pro hosting for $14.99/month. Open source personal memory with no data lock-in.',
    canonical: `${BASE_URL}/pricing`,
    ogTitle: 'Botmem Pricing',
    ogDescription:
      'Self-host Botmem for free or use managed Pro hosting. Open-source personal memory with no data lock-in.',
    robots: 'index, follow',
  },
  '/privacy': {
    title: 'Botmem Privacy Policy — How Botmem Protects Your Data',
    description:
      'Botmem privacy policy. Learn how your personal memory data is stored, encrypted, and protected with AES-256-GCM encryption at rest and a local-first architecture.',
    canonical: `${BASE_URL}/privacy`,
    ogTitle: 'Botmem Privacy Policy',
    ogDescription:
      'How Botmem stores, encrypts, and protects personal memory data in self-hosted and managed deployments.',
    robots: 'index, follow',
  },
  '/terms': {
    title: 'Botmem Terms of Service',
    description:
      'Botmem terms of service. Read the terms governing your use of the Botmem personal memory platform, managed service, and open-source software.',
    canonical: `${BASE_URL}/terms`,
    ogTitle: 'Botmem Terms of Service',
    ogDescription: 'Terms governing use of Botmem personal memory software and services.',
    robots: 'index, follow',
  },
  '/data-policy': {
    title: 'Botmem Data Policy — Encryption, Storage, Processing, and Your Rights',
    description:
      'Botmem data policy. How your personal memory data is encrypted, stored, processed, exported, and deleted. Local-first architecture with user-controlled data.',
    canonical: `${BASE_URL}/data-policy`,
    ogTitle: 'Botmem Data Policy',
    ogDescription:
      'How Botmem encrypts, stores, processes, exports, and deletes personal memory data.',
    robots: 'index, follow',
  },
};

const SPA_META = {
  title: 'Botmem App',
  description:
    'Botmem app route. Sign in to access your personal memory dashboard, connectors, search, timeline, contacts, and settings.',
  canonical: `${BASE_URL}/`,
  ogTitle: 'Botmem App',
  ogDescription: 'Sign in to access your Botmem personal memory dashboard.',
  robots: 'noindex, nofollow',
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function replaceOrInsert(html, pattern, replacement) {
  if (pattern.test(html)) return html.replace(pattern, replacement);
  return html.replace('</head>', `    ${replacement}\n  </head>`);
}

function applyMeta(html, meta) {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const canonical = escapeHtml(meta.canonical);
  const ogTitle = escapeHtml(meta.ogTitle ?? meta.title);
  const ogDescription = escapeHtml(meta.ogDescription ?? meta.description);
  const robots = escapeHtml(meta.robots ?? 'index, follow');

  let next = html.replace(/<title>.*?<\/title>/s, `<title>${title}</title>`);
  next = replaceOrInsert(
    next,
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="description" content="${description}" />`,
  );
  next = replaceOrInsert(
    next,
    /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i,
    `<link rel="canonical" href="${canonical}" />`,
  );
  next = replaceOrInsert(
    next,
    /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:title" content="${ogTitle}" />`,
  );
  next = replaceOrInsert(
    next,
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:description" content="${ogDescription}" />`,
  );
  next = replaceOrInsert(
    next,
    /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:url" content="${canonical}" />`,
  );
  next = replaceOrInsert(
    next,
    /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="twitter:title" content="${ogTitle}" />`,
  );
  next = replaceOrInsert(
    next,
    /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="twitter:description" content="${ogDescription}" />`,
  );
  next = replaceOrInsert(
    next,
    /<meta\s+name="robots"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="robots" content="${robots}" />`,
  );
  return next;
}

async function prerender() {
  if (!fs.existsSync(ssrPath)) {
    console.error('SSR bundle not found at', ssrPath);
    process.exit(1);
  }

  const template = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');

  // Save a clean copy for the SPA catch-all (no prerendered content).
  // This prevents hydration mismatches when non-prerendered routes (login, dashboard, etc.)
  // are served with the prerendered landing page HTML inside #root.
  fs.writeFileSync(path.join(distPath, '_spa.html'), applyMeta(template, SPA_META));
  console.log('  _spa.html → clean SPA fallback saved');

  const { render } = await import(ssrPath);

  for (const route of ROUTES) {
    const html = await render(route);
    const meta = ROUTE_META[route];
    const fullHtml = applyMeta(
      template.replace('<div id="root"></div>', `<div id="root">${html}</div>`),
      meta,
    );

    if (route === '/') {
      fs.writeFileSync(path.join(distPath, 'index.html'), fullHtml);
    } else {
      const dir = path.join(distPath, route.slice(1));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), fullHtml);
    }

    const size = Buffer.byteLength(fullHtml);
    console.log(`  ${route} → ${(size / 1024).toFixed(1)} kB`);
  }

  console.log(`\nPrerendered ${ROUTES.length} routes`);
}

prerender().catch((err) => {
  console.error('Prerender failed:', err);
  process.exit(1);
});
