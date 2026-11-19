import assert from 'node:assert/strict';
import test from 'node:test';
import { createBakeryHandler, type AuthIdentity, type BakeryStore } from '../supabase/functions/bakery-api/handler.ts';
import type { BakeryRecord } from '../lib/types.ts';

const origin = 'https://sdxdxdxdx.github.io';
const id = '25f0572a-44e7-41c5-aee2-a546526b3d38';
const actor = 'b76886ab-9a4b-4e48-b0d9-84e9b4672660';
const now = '2026-11-19T10:00:00.000Z';
const expense = { date: '2026-11-19', category: 'Газ', amountKopecks: 100000 };
const authenticated: AuthIdentity = { id: actor, email: 'Owner@Example.test', emailConfirmedAt: now };

function request(path = '/bootstrap', method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://project.supabase.co/functions/v1/bakery-api${path}`, {
    method, headers: { origin, authorization: 'Bearer valid-access-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function setup(identity: AuthIdentity | null = authenticated, membership = true) {
  const records = new Map<string, BakeryRecord>();
  const writes: unknown[][] = [];
  const store: BakeryStore = {
    async list() { return [...records.values()]; },
    async get(key) { return records.get(key) || null; },
    async write(action, key, kind, data, revision, userId, timestamp) {
      writes.push([action, key, kind, data, revision, userId]);
      const existing = records.get(key);
      if (action === 'create') {
        const record = { id: key, kind, data, revision: 1, createdAt: timestamp, updatedAt: timestamp, createdBy: userId, updatedBy: userId, deletedAt: null } as BakeryRecord;
        records.set(key, record); return record;
      }
      const record = { ...existing!, data: data ?? existing!.data, revision: existing!.revision + 1, updatedAt: timestamp, updatedBy: userId, deletedAt: action === 'delete' ? timestamp : null } as BakeryRecord;
      records.set(key, record); return record;
    },
  };
  const tokens: string[] = [];
  const handler = createBakeryHandler({
    async authenticate(token) { tokens.push(token); return identity; },
    async isMember(email) { assert.equal(email, 'owner@example.test'); return membership; },
    store, now: () => now,
  });
  return { handler, records, writes, tokens };
}

test('requires a verified bearer identity and active email membership before returning records', async () => {
  for (const identity of [null, { ...authenticated, emailConfirmedAt: null }]) {
    const s = setup(identity);
    assert.equal((await s.handler(request())).status, 401);
  }
  assert.equal((await setup(authenticated, false).handler(request())).status, 403);
  const s = setup();
  const response = await s.handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(s.tokens, ['valid-access-token']);
  assert.deepEqual(await response.json(), { records: [], user: { id: actor, email: 'owner@example.test', name: 'owner@example.test' }, serverTime: now });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('denies missing bearer and unapproved origins without calling storage', async () => {
  const s = setup();
  assert.equal((await s.handler(request('/bootstrap', 'GET', undefined, { authorization: '' }))).status, 401);
  assert.equal((await s.handler(request('/bootstrap', 'GET', undefined, { origin: 'https://evil.test' }))).status, 403);
  assert.equal(s.writes.length, 0);
});

test('preflight allows the Pages origin only and does not authenticate OPTIONS', async () => {
  const s = setup(null);
  const response = await s.handler(request('/records', 'OPTIONS'));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.match(response.headers.get('access-control-allow-headers')!, /authorization/);
  assert.equal(s.tokens.length, 0);
  assert.equal((await s.handler(request('/records', 'OPTIONS', undefined, { origin: 'http://localhost:5174' }))).status, 403);
});

test('validates writes on server and records stable authenticated UUID audit', async () => {
  const s = setup();
  assert.equal((await s.handler(request('/records', 'POST', { id, kind: 'expense', data: { ...expense, amountKopecks: -1 } }))).status, 400);
  assert.equal(s.writes.length, 0);
  const response = await s.handler(request('/records', 'POST', { id, kind: 'expense', data: expense }));
  assert.equal(response.status, 200);
  const { record } = await response.json();
  assert.equal(record.createdBy, actor);
  assert.equal(record.revision, 1);
  assert.deepEqual(s.writes[0], ['create', id, 'expense', expense, null, actor]);
  assert.equal((await s.handler(request('/records', 'POST', { id, kind: 'expense', data: expense, createdBy: 'forged' }))).status, 400);
});

test('rejects non-JSON, missing origin, malformed and oversized bodies', async () => {
  const s = setup();
  assert.equal((await s.handler(request('/records', 'POST', { id }, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await s.handler(request('/records', 'POST', { id }, { origin: '' }))).status, 403);
  assert.equal((await s.handler(request('/records', 'POST', { id }, { 'content-length': '102401' }))).status, 413);
  const malformed = new Request('https://project.supabase.co/functions/v1/bakery-api/records', { method: 'POST', headers: { origin, authorization: 'Bearer valid', 'content-type': 'application/json' }, body: '{' });
  assert.equal((await s.handler(malformed)).status, 400);
  assert.equal((await s.handler(request('/records', 'POST', { id, extra: 'x'.repeat(102401) }))).status, 413);
  assert.equal(s.writes.length, 0);
});

test('optimistic revisions reject stale update and deletion before storage', async () => {
  const s = setup();
  await s.handler(request('/records', 'POST', { id, kind: 'expense', data: expense }));
  assert.equal((await s.handler(request(`/records/${id}`, 'PUT', { revision: 2, data: expense }))).status, 409);
  assert.equal((await s.handler(request(`/records/${id}`, 'PUT', { revision: 1, data: { ...expense, amountKopecks: 200000 } }))).status, 200);
  assert.equal((await s.handler(request(`/records/${id}`, 'DELETE', { revision: 1 }))).status, 409);
  assert.equal((await s.handler(request(`/records/${id}`, 'DELETE', { revision: 2 }))).status, 200);
  assert.equal((await s.handler(request(`/records/${id}`, 'PUT', { revision: 3, data: expense }))).status, 409);
  assert.equal((await s.handler(request(`/records/${id}`, 'PATCH', { revision: 3, restore: true }))).status, 200);
  assert.equal(s.records.get(id)!.deletedAt, null);
});

test('catalogs archive instead of delete and backups include soft-deleted records', async () => {
  const s = setup();
  await s.handler(request('/records', 'POST', { id, kind: 'product', data: { name: 'Test', salePriceKopecks: 100 } }));
  assert.equal((await s.handler(request(`/records/${id}`, 'DELETE', { revision: 1 }))).status, 400);
  const backup = await s.handler(request('/backup'));
  assert.equal(backup.status, 200);
  assert.equal((await backup.json()).records.length, 1);
  assert.match(backup.headers.get('content-disposition')!, /attachment/);
});

test('seed IDs can be updated only when present; unknown routes/methods are explicit', async () => {
  const s = setup();
  assert.equal((await s.handler(request('/records/seed-product-missing', 'PUT', { revision: 1, data: {} }))).status, 404);
  assert.equal((await s.handler(request('/records/not-a-record', 'PUT', { revision: 1, data: {} }))).status, 400);
  assert.equal((await s.handler(request('/missing'))).status, 404);
  assert.equal((await s.handler(request('/records', 'GET'))).status, 405);
});
