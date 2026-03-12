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
const ROUTES = ['/', '/landing', '/pricing', '/privacy', '/terms', '/data-policy'];

async function prerender() {
  if (!fs.existsSync(ssrPath)) {
    console.error('SSR bundle not found at', ssrPath);
    process.exit(1);
  }

  const template = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');
  const { render } = await import(ssrPath);

  for (const route of ROUTES) {
    const html = await render(route);
    const fullHtml = template.replace(
      '<div id="root"></div>',
      `<div id="root">${html}</div>`,
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
