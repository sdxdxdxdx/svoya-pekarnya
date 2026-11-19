import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig, assetUrl } from '../lib/config.ts';
import { createTransport, ApiError } from '../lib/transport.ts';

const config = { supabaseUrl: 'https://example.supabase.co', publishableKey: 'sb_publishable_example' };
test('runtime config accepts only public publishable credentials and normalizes URL', () => {
  assert.deepEqual(parseConfig({ ...config, supabaseUrl: config.supabaseUrl + '/' }), config);
  for (const value of [null, {}, { ...config, publishableKey: 'service_role_secret' }, { ...config, supabaseUrl: 'http://example.supabase.co' }, { ...config, supabaseUrl: 'https://evil.test/path' }]) assert.throws(() => parseConfig(value));
  assert.equal(assetUrl('/bakery/', 'config.json'), '/bakery/config.json');
  assert.equal(assetUrl('/', 'config.json'), '/config.json');
});

test('transport addresses Edge function and sends user token, never cookies', async () => {
  let seenUrl = ''; let seenInit: RequestInit | undefined;
  const api = createTransport({ config, getToken: async () => 'user-token', refreshToken: async () => null, fetcher: async (url, init) => { seenUrl = String(url); seenInit = init; return Response.json({ ok: true }); } });
  assert.deepEqual(await api.json('/records', { method: 'POST', body: '{"test":true}' }), { ok: true });
  assert.equal(seenUrl, 'https://example.supabase.co/functions/v1/bakery-api/records');
  assert.equal(new Headers(seenInit?.headers).get('authorization'), 'Bearer user-token');
  assert.equal(new Headers(seenInit?.headers).get('apikey'), config.publishableKey);
  assert.equal(seenInit?.credentials, 'omit');
  assert.equal(seenInit?.cache, 'no-store');
  assert.equal(seenInit?.body, '{"test":true}');
});

test('unauthenticated request does not reach financial API', async () => {
  let calls = 0;
  const api = createTransport({ config, getToken: async () => null, refreshToken: async () => null, fetcher: async () => { calls++; return Response.json({}); } });
  await assert.rejects(api.json('/bootstrap'), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(calls, 0);
});

test('expired token refreshes once and retries the exact mutation body', async () => {
  const tokens: string[] = []; const bodies: unknown[] = []; let refreshed = 0;
  const api = createTransport({ config, getToken: async () => 'old', refreshToken: async () => { refreshed++; return 'new'; }, fetcher: async (_url, init) => { tokens.push(new Headers(init?.headers).get('authorization')!); bodies.push(init?.body); return tokens.length === 1 ? Response.json({ error: 'expired' }, { status: 401 }) : Response.json({ record: 'saved' }); } });
  assert.deepEqual(await api.json('/records/id', { method: 'PUT', body: 'same-payload' }), { record: 'saved' });
  assert.deepEqual(tokens, ['Bearer old', 'Bearer new']);
  assert.deepEqual(bodies, ['same-payload', 'same-payload']);
  assert.equal(refreshed, 1);
});

test('revision conflict and membership errors remain actionable', async () => {
  for (const [status, code] of [[409, 'CONFLICT'], [403, 'FORBIDDEN']] as const) {
    const api = createTransport({ config, getToken: async () => 'user', refreshToken: async () => null, fetcher: async () => Response.json({ error: status === 403 ? 'Доступ к пекарне не выдан.' : 'stale', code }, { status }) });
    await assert.rejects(api.json('/records/id'), (error: unknown) => error instanceof ApiError && error.status === status && error.code === code && (status !== 409 || error.message.includes('Ваш ввод сохранён')));
  }
});

test('network failures and final 401 report errors without retry loops', async () => {
  let calls = 0;
  const api = createTransport({ config, getToken: async () => 'bad', refreshToken: async () => 'still-bad', fetcher: async () => { calls++; return Response.json({}, { status: 401 }); } });
  await assert.rejects(api.json('/bootstrap'), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(calls, 2);
  const offline = createTransport({ config, getToken: async () => 'token', refreshToken: async () => null, fetcher: async () => { throw new TypeError('offline'); } });
  await assert.rejects(offline.json('/bootstrap'), (error: unknown) => error instanceof ApiError && error.status === 0);
});
