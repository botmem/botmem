import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const require = createRequire(import.meta.url);
const appdmg = require('appdmg');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-macos');
const appDir = join(outDir, 'botmem.app');
const dmgAssetsDir = join(outDir, 'dmg-assets');
const contentsDir = join(appDir, 'Contents');
const macosDir = join(contentsDir, 'MacOS');
const resourcesDir = join(contentsDir, 'Resources');
const logoSourceDir = resolve(root, '..', '..', 'apps', 'web', 'public');
const generatedAssetsDir = join(outDir, 'generated-assets');

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd: root, ...options });
}

function writeDmgBackground(target, scale) {
  const width = 920 * scale;
  const height = 560 * scale;
  const logo = readFileSync(join(generatedAssetsDir, 'logo-mark-1024.png')).toString('base64');
  const wordmark = readFileSync(join(generatedAssetsDir, 'logo.png')).toString('base64');
  const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#F5F5F0"/>
  <rect x="${64 * scale}" y="${64 * scale}" width="${796 * scale}" height="${432 * scale}" fill="none" stroke="#C4F53A" stroke-width="${5 * scale}"/>
  <rect x="${52 * scale}" y="${52 * scale}" width="${796 * scale}" height="${432 * scale}" fill="none" stroke="#0D0D0D" stroke-width="${3 * scale}"/>
  <image href="data:image/png;base64,${logo}" x="${82 * scale}" y="${78 * scale}" width="${42 * scale}" height="${42 * scale}"/>
  <image href="data:image/png;base64,${wordmark}" x="${140 * scale}" y="${78 * scale}" width="${190 * scale}" height="${47 * scale}"/>
  <line x1="${405 * scale}" y1="${292 * scale}" x2="${515 * scale}" y2="${292 * scale}" stroke="#C4F53A" stroke-width="${6 * scale}"/>
  <polyline points="${492 * scale},${264 * scale} ${520 * scale},${292 * scale} ${492 * scale},${320 * scale}" fill="none" stroke="#C4F53A" stroke-width="${6 * scale}" stroke-linejoin="miter"/>
</svg>`;
  const png = new Resvg(svg).render().asPng();
  writeFileSync(target, png);
}

function writeAppIcon(target, size) {
  const cell = 205;
  const gap = 31;
  const pad = 124;
  const svg = `
<svg width="${size}" height="${size}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <rect width="1024" height="1024" fill="#0D0D0D"/>
  <rect x="104" y="104" width="816" height="816" fill="#C4F53A"/>
  <rect x="64" y="64" width="816" height="816" fill="#0D0D0D"/>
  <rect x="64" y="64" width="816" height="816" fill="none" stroke="#252540" stroke-width="18"/>
  <rect x="${pad}" y="${pad}" width="${cell}" height="${cell}" fill="#C4F53A"/>
  <rect x="${pad + cell + gap}" y="${pad}" width="${cell}" height="${cell}" fill="#C4F53A"/>
  <rect x="${pad + (cell + gap) * 2}" y="${pad}" width="${cell}" height="${cell}" fill="#252540" stroke="#3A3A60" stroke-width="18"/>
  <rect x="${pad}" y="${pad + cell + gap}" width="${cell}" height="${cell}" fill="#252540" stroke="#3A3A60" stroke-width="18"/>
  <rect x="${pad + cell + gap}" y="${pad + cell + gap}" width="${cell}" height="${cell}" fill="#C4F53A"/>
  <rect x="${pad + (cell + gap) * 2}" y="${pad + cell + gap}" width="${cell}" height="${cell}" fill="#252540" stroke="#3A3A60" stroke-width="18"/>
  <rect x="${pad}" y="${pad + (cell + gap) * 2}" width="${cell}" height="${cell}" fill="#C4F53A"/>
  <rect x="${pad + cell + gap}" y="${pad + (cell + gap) * 2}" width="${cell}" height="${cell}" fill="#252540" stroke="#3A3A60" stroke-width="18"/>
  <rect x="${pad + (cell + gap) * 2}" y="${pad + (cell + gap) * 2}" width="${cell}" height="${cell}" fill="#C4F53A"/>
</svg>`;
  const png = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: size,
    },
  })
    .render()
    .asPng();
  writeFileSync(target, png);
}

function renderSvgToPng(source, target, width) {
  const svg = readFileSync(source);
  const png = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: width,
    },
  })
    .render()
    .asPng();
  writeFileSync(target, png);
}

function buildDmg(source, target, specification) {
  return new Promise((resolveBuild, rejectBuild) => {
    const ee = appdmg({
      target,
      basepath: dirname(source),
      specification,
    });

    ee.on('finish', resolveBuild);
    ee.on('error', rejectBuild);
  });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });
mkdirSync(generatedAssetsDir, { recursive: true });

run('pnpm', ['build']);

const logoMark128 = join(generatedAssetsDir, 'logo-mark-128.png');
const logoMark1024 = join(generatedAssetsDir, 'logo-mark-1024.png');
const logoWordmark = join(generatedAssetsDir, 'logo.png');
renderSvgToPng(join(logoSourceDir, 'logo-mark.svg'), logoMark128, 128);
writeAppIcon(logoMark1024, 1024);
renderSvgToPng(join(logoSourceDir, 'logo.svg'), logoWordmark, 420);

copyFileSync(join(root, 'macos', 'Info.plist'), join(contentsDir, 'Info.plist'));
copyFileSync(logoMark128, join(resourcesDir, 'logo-mark-128.png'));
copyFileSync(logoMark1024, join(resourcesDir, 'logo-mark-1024.png'));
copyFileSync(logoWordmark, join(resourcesDir, 'logo.png'));

const iconsetDir = join(outDir, 'AppIcon.iconset');
mkdirSync(iconsetDir, { recursive: true });
const iconSource = logoMark1024;
const iconSizes = [
  ['16', 'icon_16x16.png'],
  ['32', 'icon_16x16@2x.png'],
  ['32', 'icon_32x32.png'],
  ['64', 'icon_32x32@2x.png'],
  ['128', 'icon_128x128.png'],
  ['256', 'icon_128x128@2x.png'],
  ['256', 'icon_256x256.png'],
  ['512', 'icon_256x256@2x.png'],
  ['512', 'icon_512x512.png'],
  ['1024', 'icon_512x512@2x.png'],
];
for (const [size, name] of iconSizes) {
  run('sips', ['-z', size, size, iconSource, '--out', join(iconsetDir, name)], { stdio: 'ignore' });
}
run('iconutil', ['-c', 'icns', iconsetDir, '-o', join(resourcesDir, 'AppIcon.icns')]);
rmSync(iconsetDir, { recursive: true, force: true });

run('swiftc', [
  join(root, 'macos', 'BotmemAppleBridge.swift'),
  join(root, 'macos', 'AppleBridgeNative.swift'),
  '-framework',
  'AppKit',
  '-framework',
  'Contacts',
  '-framework',
  'CryptoKit',
  '-lsqlite3',
  '-o',
  join(macosDir, 'botmem'),
]);

cpSync(join(root, 'dist'), join(resourcesDir, 'dist'), { recursive: true });
if (existsSync(join(root, 'node_modules'))) {
  cpSync(join(root, 'node_modules'), join(resourcesDir, 'node_modules'), {
    recursive: true,
    dereference: true,
  });
}

const bundledNode = process.env.BOTMEM_NODE_BINARY;
if (bundledNode) {
  copyFileSync(bundledNode, join(resourcesDir, 'node'));
}

writeFileSync(
  join(resourcesDir, 'apple-bridge-runner'),
  `#!/bin/sh
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$DIR/node"
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node || true)"
fi
if [ -z "$NODE" ]; then
  echo "Node.js 20+ is required to run botmem." >&2
  exit 1
fi
export NODE_PATH="$DIR/node_modules"
exec "$NODE" "$DIR/dist/cli.js" "$@"
`,
  { mode: 0o755 },
);

// macOS keys TCC permissions (Full Disk Access, Contacts) to the app's code-signing
// designated requirement. Ad-hoc signing ('-') derives that from the cdhash, which
// changes on every rebuild — so the user must re-grant Full Disk Access each time.
// Signing with a stable identity (Developer ID or Apple Development) keeps the grant
// across rebuilds. Prefer an explicit identity, else auto-detect a stable one.
function resolveCodesignIdentity() {
  if (process.env.BOTMEM_CODESIGN_IDENTITY) return process.env.BOTMEM_CODESIGN_IDENTITY;
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    const lines = out.split('\n');
    const pick = (re) => lines.find((l) => re.test(l))?.match(/"([^"]+)"/)?.[1];
    // Developer ID is distributable + notarizable; Apple Development is stable for local use.
    const found = pick(/Developer ID Application/) || pick(/Apple Development|Mac Developer/);
    if (found) {
      console.log(`Signing botmem with stable identity: ${found}`);
      return found;
    }
  } catch {
    /* `security` unavailable — fall through to ad-hoc */
  }
  console.warn(
    'No stable signing identity found (BOTMEM_CODESIGN_IDENTITY unset); ad-hoc signing botmem.\n' +
      '  Full Disk Access will need re-granting on every rebuild. Install a "Developer ID\n' +
      '  Application" (preferred) or "Apple Development" certificate, or set\n' +
      '  BOTMEM_CODESIGN_IDENTITY, to make the grant persist.',
  );
  return '-';
}
const identity = resolveCodesignIdentity();
run('codesign', [
  '--force',
  '--deep',
  '--options',
  'runtime',
  '--entitlements',
  join(root, 'macos', 'botmem.entitlements'),
  '--sign',
  identity,
  appDir,
]);

const dmgName = process.env.BOTMEM_DMG_NAME || 'botmem.dmg';
const dmgPath = join(outDir, dmgName);
rmSync(dmgAssetsDir, { recursive: true, force: true });
mkdirSync(dmgAssetsDir, { recursive: true });
const backgroundPath = join(dmgAssetsDir, 'background.png');
const background2xPath = join(dmgAssetsDir, 'background@2x.png');
writeDmgBackground(backgroundPath, 1);
writeDmgBackground(background2xPath, 2);
copyFileSync(join(resourcesDir, 'AppIcon.icns'), join(dmgAssetsDir, 'AppIcon.icns'));

await buildDmg(join(dmgAssetsDir, 'dmg.json'), dmgPath, {
  title: 'botmem',
  icon: 'AppIcon.icns',
  background: 'background.png',
  'icon-size': 128,
  window: {
    size: {
      width: 920,
      height: 560,
    },
  },
  format: 'UDZO',
  filesystem: 'HFS+',
  contents: [
    {
      x: 300,
      y: 292,
      type: 'file',
      path: appDir,
      name: 'botmem.app',
    },
    {
      x: 620,
      y: 292,
      type: 'link',
      path: '/Applications',
    },
  ],
});
rmSync(dmgAssetsDir, { recursive: true, force: true });

if (
  process.env.BOTMEM_CODESIGN_IDENTITY &&
  process.env.APPLE_ID &&
  process.env.APPLE_TEAM_ID &&
  process.env.APPLE_APP_SPECIFIC_PASSWORD
) {
  run('xcrun', [
    'notarytool',
    'submit',
    dmgPath,
    '--apple-id',
    process.env.APPLE_ID,
    '--team-id',
    process.env.APPLE_TEAM_ID,
    '--password',
    process.env.APPLE_APP_SPECIFIC_PASSWORD,
    '--wait',
  ]);
  run('xcrun', ['stapler', 'staple', dmgPath]);
}

console.log(`Built ${dmgPath}`);
