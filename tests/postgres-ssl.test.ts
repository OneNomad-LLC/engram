/**
 * postgres-ssl — R-005 regression tests.
 *
 * Verifies that resolvePostgresSsl() produces the correct ssl option
 * for the pg Pool constructor:
 *
 *   - localhost / 127.0.0.1 / [::1] → ssl: false
 *   - cloud / remote hosts           → ssl: { rejectUnauthorized: true }
 *   - ENGRAM_PG_SSL=off              → ssl: false  (explicit opt-out)
 *   - ENGRAM_PG_SSL=on               → ssl: { rejectUnauthorized: true } (explicit opt-in)
 *
 * Run: `npm test` or `node --import tsx --test tests/postgres-ssl.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePostgresSsl } from '../src/storage-postgres.js';

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe('resolvePostgresSsl — R-005', () => {
  // ── Localhost variants → ssl: false ──────────────────────────────

  it('localhost URL returns ssl: false', () => {
    withEnv('ENGRAM_PG_SSL', undefined, () => {
      assert.equal(resolvePostgresSsl('postgres://localhost/mydb'), false);
    });
  });

  it('127.0.0.1 URL returns ssl: false', () => {
    withEnv('ENGRAM_PG_SSL', undefined, () => {
      assert.equal(resolvePostgresSsl('postgres://127.0.0.1:5432/mydb'), false);
    });
  });

  it('[::1] IPv6 loopback URL returns ssl: false', () => {
    withEnv('ENGRAM_PG_SSL', undefined, () => {
      assert.equal(resolvePostgresSsl('postgres://[::1]:5432/mydb'), false);
    });
  });

  // ── Cloud / remote hosts → ssl: { rejectUnauthorized: true } ─────

  it('remote host returns ssl: { rejectUnauthorized: true }', () => {
    withEnv('ENGRAM_PG_SSL', undefined, () => {
      const result = resolvePostgresSsl('postgres://db.example.com:5432/mydb');
      assert.deepEqual(result, { rejectUnauthorized: true });
    });
  });

  it('Supabase URL returns ssl: { rejectUnauthorized: true }', () => {
    withEnv('ENGRAM_PG_SSL', undefined, () => {
      const result = resolvePostgresSsl('postgres://user:pass@db.supabase.co:5432/postgres');
      assert.deepEqual(result, { rejectUnauthorized: true });
    });
  });

  it('Neon URL returns ssl: { rejectUnauthorized: true }', () => {
    withEnv('ENGRAM_PG_SSL', undefined, () => {
      const result = resolvePostgresSsl('postgres://user:pass@project.neon.tech:5432/neondb');
      assert.deepEqual(result, { rejectUnauthorized: true });
    });
  });

  // ── ENGRAM_PG_SSL opt-out ─────────────────────────────────────────

  it('ENGRAM_PG_SSL=off forces ssl: false even for remote hosts', () => {
    for (const val of ['off', 'false', '0']) {
      withEnv('ENGRAM_PG_SSL', val, () => {
        assert.equal(
          resolvePostgresSsl('postgres://db.example.com/mydb'),
          false,
          `ENGRAM_PG_SSL=${val} should disable SSL`,
        );
      });
    }
  });

  it('ENGRAM_PG_SSL=on forces ssl: { rejectUnauthorized: true } even for localhost', () => {
    for (const val of ['on', 'true', '1']) {
      withEnv('ENGRAM_PG_SSL', val, () => {
        const result = resolvePostgresSsl('postgres://localhost/mydb');
        assert.deepEqual(
          result,
          { rejectUnauthorized: true },
          `ENGRAM_PG_SSL=${val} should force SSL`,
        );
      });
    }
  });
});
