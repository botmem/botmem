import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { calculateFlywayChecksum, discoverMigrations } from './migrations.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'botmem-migrator-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('discoverMigrations', () => {
  it('sorts numeric versions and produces immutable SHA-256 metadata', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'V2__second.sql'), 'SELECT 2;\n');
    await writeFile(join(directory, 'V1__first.sql'), 'SELECT 1;\n');

    const migrations = await discoverMigrations(directory);

    expect(migrations.map(({ version, script }) => ({ version, script }))).toEqual([
      { version: 1, script: 'V1__first.sql' },
      { version: 2, script: 'V2__second.sql' },
    ]);
    expect(migrations[0]?.checksumSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ['V2__gap.sql', 'migration_order_invalid'],
    ['V1__Bad.sql', 'migration_name_invalid'],
    ['V1__first.sql.bak', 'migration_name_invalid'],
  ])('rejects an invalid ordered set containing %s', async (script, code) => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, script), 'SELECT 1;');
    await expect(discoverMigrations(directory)).rejects.toMatchObject({ code });
  });

  it('rejects symlinked migration files and directories', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'target.sql');
    await writeFile(target, 'SELECT 1;');
    await symlink(target, join(directory, 'V1__linked.sql'));
    await expect(discoverMigrations(directory)).rejects.toMatchObject({
      code: 'migration_name_invalid',
    });

    const parent = await temporaryDirectory();
    const real = join(parent, 'real');
    const linked = join(parent, 'linked');
    await mkdir(real);
    await symlink(real, linked);
    await expect(discoverMigrations(linked)).rejects.toMatchObject({
      code: 'migration_directory_invalid',
    });
  });
});

describe('calculateFlywayChecksum', () => {
  it('matches CRC32, ignores line endings, and strips only the initial BOM', () => {
    expect(calculateFlywayChecksum('abc')).toBe(891_568_578);
    expect(calculateFlywayChecksum('\uFEFFa\r\nb')).toBe(calculateFlywayChecksum('a\nb'));
    expect(calculateFlywayChecksum('a\nb')).toBe(calculateFlywayChecksum('ab'));
  });
});
