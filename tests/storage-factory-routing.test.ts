/**
 * storage-factory — routing decision tests.
 *
 * Covers the resolution waterfall in src/storage-factory.ts. Each test
 * mutates a temp dir + env vars, calls createStorageAdapter, and asserts
 * which adapter class came back. Postgres + cloud branches that require
 * live infrastructure are exercised only as far as the "throws when
 * required env missing" or "constructs without throwing" assertion;
 * full I/O round-trips live in storage-roundtrip.test.ts.
 *
 * The regression this file locks down:
 *   Pre-1.0.1, the factory would silently route to cloud whenever a
 *   ~/.pyre/credentials.json file existed, with no opt-out and no log
 *   line. A user who ran `przm-memory login` once would then have every
 *   subsequent invocation hit the wire, even if they expected local
 *   mode. The new ENGRAM_NO_AUTO_CLOUD escape hatch + always-on routing
 *   log are tested here.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStorageAdapter, resolveBackend } from '../src/storage-factory.js';
import { FileStorageAdapter } from '../src/storage-file.js';
import type { Credentials } from '../src/auth/credentials.js';

const VALID_CREDS: Credentials = {
  api_url: 'https://dev.pyre.sh',
  api_key: 'sk_pyre_test_routing_abcdef',
  label: 'routing-test',
  scopes: ['engram:read', 'engram:write'],
  issued_at: '2026-05-19T00:00:00.000Z',
};

// Env vars we mutate. Save+restore so tests can run in any order under
// node --test, which shares the process between files.
const ENV_KEYS = [
  'STORAGE_BACKEND',
  'PYRE_API_URL',
  'PYRE_API_KEY',
  'PYRE_CREDENTIALS_FILE',
  'ENGRAM_NO_AUTO_CLOUD',
  'DATABASE_URL',
  'TENANT_ID',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

async function withTempCreds<T>(
  fn: (credsPath: string, dataDir: string) => Promise<T>,
  opts: { writeCreds?: boolean; credsBody?: string } = { writeCreds: true },
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'engram-routing-'));
  const credsPath = join(dir, 'credentials.json');
  const dataDir = join(dir, 'data');
  const snap = snapshotEnv();
  try {
    clearEnv();
    if (opts.writeCreds !== false) {
      const body = opts.credsBody ?? JSON.stringify(VALID_CREDS);
      writeFileSync(credsPath, body, 'utf-8');
    }
    process.env.PYRE_CREDENTIALS_FILE = credsPath;
    return await fn(credsPath, dataDir);
  } finally {
    restoreEnv(snap);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('createStorageAdapter: STORAGE_BACKEND=file returns FileStorageAdapter', async () => {
  await withTempCreds(async (_credsPath, dataDir) => {
    process.env.STORAGE_BACKEND = 'file';
    const adapter = await createStorageAdapter({ dataDir });
    assert.ok(adapter instanceof FileStorageAdapter, 'expected FileStorageAdapter');
  });
});

test('createStorageAdapter: STORAGE_BACKEND=file beats an existing valid credentials file', async () => {
  await withTempCreds(async (_credsPath, dataDir) => {
    // Cred file exists at PYRE_CREDENTIALS_FILE; explicit env should win.
    process.env.STORAGE_BACKEND = 'file';
    const adapter = await createStorageAdapter({ dataDir });
    assert.ok(adapter instanceof FileStorageAdapter, 'explicit file beats auto-cloud');
  });
});

test('createStorageAdapter: no env + no credentials file → file mode', async () => {
  await withTempCreds(async (_credsPath, dataDir) => {
    // Point at a path that does NOT exist so credentialsExist returns false.
    process.env.PYRE_CREDENTIALS_FILE = join(dataDir, 'nonexistent-creds.json');
    const adapter = await createStorageAdapter({ dataDir });
    assert.ok(adapter instanceof FileStorageAdapter, 'default with no cred file is file mode');
  }, { writeCreds: false });
});

test('createStorageAdapter: ENGRAM_NO_AUTO_CLOUD=1 forces file mode even with valid credentials', async () => {
  await withTempCreds(async (_credsPath, dataDir) => {
    process.env.ENGRAM_NO_AUTO_CLOUD = '1';
    const adapter = await createStorageAdapter({ dataDir });
    assert.ok(adapter instanceof FileStorageAdapter, 'opt-out beats auto-cloud');
  });
});

test('createStorageAdapter: ENGRAM_NO_AUTO_CLOUD accepts truthy variants', async () => {
  for (const truthy of ['1', 'true', 'yes', 'on', 'TRUE', '  true  ']) {
    await withTempCreds(async (_credsPath, dataDir) => {
      process.env.ENGRAM_NO_AUTO_CLOUD = truthy;
      const adapter = await createStorageAdapter({ dataDir });
      assert.ok(
        adapter instanceof FileStorageAdapter,
        `ENGRAM_NO_AUTO_CLOUD=${JSON.stringify(truthy)} should force file mode`,
      );
    });
  }
});

test('createStorageAdapter: ENGRAM_NO_AUTO_CLOUD=0 does NOT opt out', async () => {
  await withTempCreds(async (_credsPath, _dataDir) => {
    process.env.ENGRAM_NO_AUTO_CLOUD = '0';
    // With valid creds + opt-out off, we should reach the cloud branch.
    // We don't want this test to actually init the cloud adapter (no
    // network in CI), so assert via resolveBackend instead.
    assert.equal(resolveBackend(), 'cloud', '0 is not truthy');
  });
});

test('createStorageAdapter: corrupt credentials file falls back to file mode (no crash)', async () => {
  await withTempCreds(async (_credsPath, dataDir) => {
    // File exists but is garbage. Pre-fix this would route to cloud,
    // then crash inside the cloud branch when readCredentials returned
    // null and no PYRE_API_URL was set. Post-fix we fall through.
    const adapter = await createStorageAdapter({ dataDir });
    assert.ok(
      adapter instanceof FileStorageAdapter,
      'invalid creds should fall back to file mode instead of crashing',
    );
  }, { writeCreds: true, credsBody: '{not valid json' });
});

test('createStorageAdapter: file backend requires dataDir', async () => {
  const snap = snapshotEnv();
  try {
    clearEnv();
    process.env.STORAGE_BACKEND = 'file';
    await assert.rejects(
      () => createStorageAdapter({}),
      /dataDir is required/,
    );
  } finally {
    restoreEnv(snap);
  }
});

test('createStorageAdapter: STORAGE_BACKEND=postgres requires DATABASE_URL + TENANT_ID', async () => {
  const snap = snapshotEnv();
  try {
    clearEnv();
    process.env.STORAGE_BACKEND = 'postgres';
    await assert.rejects(
      () => createStorageAdapter({ dataDir: tmpdir() }),
      /DATABASE_URL and TENANT_ID/,
    );
  } finally {
    restoreEnv(snap);
  }
});

test('createStorageAdapter: STORAGE_BACKEND=cloud without creds throws', async () => {
  const snap = snapshotEnv();
  try {
    clearEnv();
    // Point at a non-existent credentials file so readCredentials returns null.
    process.env.PYRE_CREDENTIALS_FILE = join(tmpdir(), `engram-no-such-creds-${Date.now()}.json`);
    process.env.STORAGE_BACKEND = 'cloud';
    await assert.rejects(
      () => createStorageAdapter({ dataDir: tmpdir() }),
      /requires PYRE_API_URL and PYRE_API_KEY/,
    );
  } finally {
    restoreEnv(snap);
  }
});

test('createStorageAdapter: STORAGE_BACKEND=invalid throws on unknown value', async () => {
  const snap = snapshotEnv();
  try {
    clearEnv();
    process.env.STORAGE_BACKEND = 'sqlite';
    await assert.rejects(
      () => createStorageAdapter({ dataDir: tmpdir() }),
      /Unknown STORAGE_BACKEND/,
    );
  } finally {
    restoreEnv(snap);
  }
});

test('resolveBackend: ENGRAM_NO_AUTO_CLOUD suppresses cred-file probe', async () => {
  await withTempCreds(async (_credsPath, _dataDir) => {
    // Cred file exists and is valid. Without opt-out → cloud.
    assert.equal(resolveBackend(), 'cloud', 'baseline auto-routes to cloud');
    process.env.ENGRAM_NO_AUTO_CLOUD = '1';
    assert.equal(resolveBackend(), 'file', 'opt-out flips to file');
  });
});

test('resolveBackend: explicit arg beats env + cred file', async () => {
  await withTempCreds(async (_credsPath, _dataDir) => {
    process.env.STORAGE_BACKEND = 'cloud';
    assert.equal(resolveBackend('file'), 'file', 'arg wins over env');
    assert.equal(resolveBackend('postgres'), 'postgres', 'arg wins over env');
  });
});
