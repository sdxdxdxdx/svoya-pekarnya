import { RECORD_KINDS } from './domain/types.ts';
import type { AppUser, BakeryRecord, RecordKind } from './domain/types.ts';
import { ValidationError, validateData } from './domain/validation.ts';

export type AuthIdentity = { id: string; email?: string | null; emailConfirmedAt?: string | null };
export type WriteAction = 'create' | 'update' | 'delete' | 'restore';
export interface BakeryStore {
  list(): Promise<BakeryRecord[]>;
  get(id: string): Promise<BakeryRecord | null>;
  write(action: WriteAction, id: string, kind: RecordKind, data: unknown, revision: number | null, actor: string, now: string): Promise<BakeryRecord>;
}
type Dependencies = {
  authenticate(token: string): Promise<AuthIdentity | null>;
  isMember(email: string): Promise<boolean>;
  store: BakeryStore;
  now?: () => string;
  allowLocalDev?: boolean;
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
const catalogKinds = new Set<RecordKind>(['ingredient', 'product', 'employee']);
const productionOrigin = 'https://sdxdxdxdx.github.io';
const maxBytes = 100 * 1024;
function conflict(): never { throw new ApiError(409, 'Запись уже изменена в другом окне. Обновите данные и повторите действие.', 'CONFLICT'); }
function fields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new ApiError(400, 'Запрос содержит недопустимые поля.');
}
function requireId(value: unknown, existing = false): string {
  if (existing && typeof value === 'string' && /^seed-(ingredient|product|employee)-[a-z0-9-]+$/.test(value)) return value;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(400, 'Некорректный идентификатор записи.');
  return value.toLowerCase();
}
function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ApiError(400, 'Некорректная версия записи.');
  return value;
}
async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) throw new ApiError(413, 'Запись слишком большая (не более 100 КБ).');
  if (!request.body) throw new ApiError(400, 'Отсутствуют данные запроса.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new ApiError(413, 'Запись слишком большая (не более 100 КБ).'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let result: unknown;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'Не удалось прочитать JSON запроса.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ApiError(400, 'Ожидается объект JSON.');
  return result as Record<string, unknown>;
}

export function createBakeryHandler(dependencies: Dependencies) {
  const allowedOrigins = new Set([productionOrigin, ...(dependencies.allowLocalDev ? ['http://localhost:5174', 'http://127.0.0.1:5174'] : [])]);
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const allowedOrigin = origin !== null && allowedOrigins.has(origin);
    const headers: Record<string, string> = {
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin',
      ...(allowedOrigin ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
        'access-control-expose-headers': 'content-disposition',
      } : {}),
    };
    const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(value, { status, headers: { ...headers, ...extra } });
    try {
      if ((origin !== null && !allowedOrigin) || (request.method === 'OPTIONS' && !allowedOrigin)) throw new ApiError(403, 'Откройте приложение по его официальной ссылке.', 'ORIGIN_DENIED');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (!bearer) throw new ApiError(401, 'Войдите в свой аккаунт.', 'UNAUTHENTICATED');
      // Every request is checked with Supabase Auth getUser, not decoded JWT claims.
      const identity = await dependencies.authenticate(bearer);
      if (!identity?.id || !identity.email || !identity.emailConfirmedAt) throw new ApiError(401, 'Войдите в аккаунт и подтвердите адрес почты.', 'UNAUTHENTICATED');
      const email = identity.email.trim().toLowerCase();
      if (!await dependencies.isMember(email)) throw new ApiError(403, 'У этого аккаунта нет доступа к учёту пекарни.', 'FORBIDDEN');
      const user: AppUser = { id: identity.id, email, name: email };
      const store = dependencies.store;
      const now = dependencies.now?.() ?? new Date().toISOString();
      const rawPath = new URL(request.url).pathname;
      const prefix = '/functions/v1/bakery-api';
      const path = (rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath.replace(/^\/bakery-api/, '')).replace(/\/$/, '') || '/';
      if (request.method === 'GET' && path === '/bootstrap') return json({ records: await store.list(), user, serverTime: now });
      if (request.method === 'GET' && path === '/backup') return json({ version: 1, date: now, records: await store.list() }, 200, { 'content-disposition': `attachment; filename="bakery-backup-${now.slice(0, 10)}.json"` });
      const match = path.match(/^\/records\/([^/]+)$/);
      const known = path === '/bootstrap' || path === '/backup' || path === '/records' || match !== null;
      if (!known) throw new ApiError(404, 'Адрес не найден.', 'NOT_FOUND');
      if (!(path === '/records' && request.method === 'POST') && !(match && ['PUT', 'DELETE', 'PATCH'].includes(request.method))) throw new ApiError(405, 'Метод запроса не поддерживается.', 'METHOD_NOT_ALLOWED');
      if (!allowedOrigin) throw new ApiError(403, 'Изменение разрешено только со страницы приложения.', 'ORIGIN_DENIED');
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'Запрос должен содержать JSON.');
      const body = await readJsonObject(request);
      if (request.method === 'POST') {
        fields(body, ['id', 'kind', 'data']);
        const id = requireId(body.id);
        if (typeof body.kind !== 'string' || !RECORD_KINDS.includes(body.kind as RecordKind)) throw new ApiError(400, 'Неизвестный тип записи.');
        const kind = body.kind as RecordKind;
        const data = validateData(kind, body.data, await store.list(), id);
        return json({ record: await store.write('create', id, kind, data, null, user.id, now) });
      }
      const id = requireId(match![1], true);
      fields(body, request.method === 'PUT' ? ['revision', 'data'] : request.method === 'PATCH' ? ['revision', 'restore'] : ['revision']);
      const revision = requireRevision(body.revision);
      const existing = await store.get(id);
      if (!existing) throw new ApiError(404, 'Запись не найдена.', 'NOT_FOUND');
      if (existing.revision !== revision) conflict();
      if (request.method === 'PUT') {
        if (existing.deletedAt) throw new ApiError(409, 'Сначала восстановите удалённую запись.', 'CONFLICT');
        const data = validateData(existing.kind, body.data, await store.list(), id);
        return json({ record: await store.write('update', id, existing.kind, data, revision, user.id, now) });
      }
      if (request.method === 'DELETE') {
        if (catalogKinds.has(existing.kind)) throw new ApiError(400, 'Справочники нельзя удалять: переместите запись в архив, чтобы сохранить историю операций.');
        if (existing.deletedAt) conflict();
        return json({ record: await store.write('delete', id, existing.kind, null, revision, user.id, now) });
      }
      if (body.restore !== true) throw new ApiError(400, 'Для восстановления передайте restore: true.');
      if (!existing.deletedAt) conflict();
      validateData(existing.kind, existing.data, await store.list(), id);
      return json({ record: await store.write('restore', id, existing.kind, null, revision, user.id, now) });
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof ValidationError) return json({ error: error.message, code: 'VALIDATION' }, 400);
      // Avoid logging financial payloads, email addresses or access tokens.
      console.error('Bakery API storage or authentication service unavailable');
      return json({ error: 'Не удалось выполнить запрос к базе данных. Изменения не подтверждены. Повторите попытку.', code: 'STORAGE_UNAVAILABLE' }, 500);
    }
  };
}
