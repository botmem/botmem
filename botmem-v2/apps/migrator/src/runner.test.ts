import { describe, expect, it } from 'vitest';

import type { Migration } from './migrations.js';
import { validateAppliedHistory, validateLegacyHistory } from './runner.js';

function migration(version: number): Migration {
  return {
    version,
    script: `V${version}__migration_${version}.sql`,
    description: `migration ${version}`,
    checksumSha256: String(version).repeat(64),
    flywayChecksum: version * 100,
    sql: `SELECT ${version};`,
  };
}

const migrations = [migration(1), migration(2)];

describe('validateAppliedHistory', () => {
  it('accepts an exact applied prefix', () => {
    expect(() =>
      validateAppliedHistory(
        [
          {
            version: '1',
            script: migrations[0]!.script,
            checksum_sha256: migrations[0]!.checksumSha256,
          },
        ],
        migrations,
      ),
    ).not.toThrow();
  });

  it('rejects checksum drift and gaps', () => {
    expect(() =>
      validateAppliedHistory(
        [{ version: '1', script: migrations[0]!.script, checksum_sha256: 'f'.repeat(64) }],
        migrations,
      ),
    ).toThrow('migration_checksum_drift');
    expect(() =>
      validateAppliedHistory(
        [
          {
            version: '2',
            script: migrations[1]!.script,
            checksum_sha256: migrations[1]!.checksumSha256,
          },
        ],
        migrations,
      ),
    ).toThrow('migration_order_rejected');
  });
});

describe('validateLegacyHistory', () => {
  it('accepts only an exact successful Flyway prefix', () => {
    expect(
      validateLegacyHistory(
        [
          {
            installed_rank: 1,
            version: '1',
            description: migrations[0]!.description,
            type: 'SQL',
            script: migrations[0]!.script,
            checksum: migrations[0]!.flywayChecksum,
            success: true,
          },
        ],
        migrations,
      ),
    ).toEqual([migrations[0]]);
  });

  it('rejects failed, drifted, and out-of-order legacy rows', () => {
    const valid = {
      installed_rank: 1,
      version: '1',
      description: migrations[0]!.description,
      type: 'SQL',
      script: migrations[0]!.script,
      checksum: migrations[0]!.flywayChecksum,
      success: true,
    };
    expect(() => validateLegacyHistory([{ ...valid, success: false }], migrations)).toThrow(
      'legacy_failed_migration_rejected',
    );
    expect(() => validateLegacyHistory([{ ...valid, checksum: 999 }], migrations)).toThrow(
      'legacy_history_rejected',
    );
    expect(() => validateLegacyHistory([{ ...valid, installed_rank: 2 }], migrations)).toThrow(
      'legacy_history_rejected',
    );
  });
});
