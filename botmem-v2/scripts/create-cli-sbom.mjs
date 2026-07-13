import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [artifactPath, metafilePath, outputPath, version] = process.argv.slice(2);
if (!artifactPath || !metafilePath || !outputPath || !version) {
  throw new Error('usage: create-cli-sbom <artifact> <esbuild-metafile> <output> <version>');
}

const artifact = readFileSync(artifactPath);
const metadata = JSON.parse(readFileSync(metafilePath, 'utf8'));
const packages = new Map();
for (const input of Object.keys(metadata.inputs ?? {})) {
  const match = input.match(
    /node_modules\/\.pnpm\/((?:@[^+]+\+)?[^@/]+)@([^/]+)\/node_modules\//u,
  );
  if (!match) continue;
  const encodedName = match[1];
  const version = match[2];
  const name = encodedName.startsWith('@') ? encodedName.replace('+', '/') : encodedName;
  packages.set(`${name}@${version}`, { name, version });
}

const rootRef = `pkg:npm/%40botmem-v2/cli@${version}`;
const components = [...packages.values()]
  .sort((left, right) => `${left.name}@${left.version}`.localeCompare(
    `${right.name}@${right.version}`,
  ))
  .map(({ name, version }) => {
    const purlName = name.startsWith('@') ? `%40${name.slice(1)}` : name;
    const purl = `pkg:npm/${purlName}@${version}`;
    return { type: 'library', 'bom-ref': purl, name, version, purl };
  });
const hash = createHash('sha256').update(artifact).digest('hex').toUpperCase();
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': rootRef,
      group: '@botmem-v2',
      name: 'cli',
      version,
      purl: rootRef,
      hashes: [{ alg: 'SHA-256', content: hash }],
    },
  },
  components,
  dependencies: [
    { ref: rootRef, dependsOn: components.map((component) => component['bom-ref']) },
    ...components.map((component) => ({ ref: component['bom-ref'], dependsOn: [] })),
  ],
};
writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`, { mode: 0o600 });
