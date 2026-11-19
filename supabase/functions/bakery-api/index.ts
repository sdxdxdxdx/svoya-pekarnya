import { createClient } from 'npm:@supabase/supabase-js@2.119.2';
import { ApiError, createBakeryHandler, type BakeryStore, type WriteAction } from './handler.ts';
import type { BakeryRecord, RecordKind } from './domain/types.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const adminKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(url, adminKey, { auth: { persistSession: false, autoRefreshToken: false } });
type Stored = { id: string; kind: RecordKind; data: unknown; revision: number; created_at: string; updated_at: string; created_by: string; updated_by: string; deleted_at: string | null };
const columns = 'id,kind,data,revision,created_at,updated_at,created_by,updated_by,deleted_at';
function record(row: Stored): BakeryRecord {
  return { id: row.id, kind: row.kind, data: row.data, revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at, createdBy: row.created_by, updatedBy: row.updated_by, deletedAt: row.deleted_at } as BakeryRecord;
}
function storageError(error: { code?: string }): never {
  if (error.code === '23505' || error.code === '40001') throw new ApiError(409, 'Запись или дата уже изменена. Обновите данные и повторите действие.', 'CONFLICT');
  throw new Error('Database operation failed');
}
const store: BakeryStore = {
  async list() {
    const rows: BakeryRecord[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.from('bakery_records').select(columns).order('created_at').order('id').range(offset, offset + 999);
      if (error) storageError(error);
      rows.push(...(data as Stored[]).map(record));
      if (data!.length < 1000) return rows;
    }
  },
  async get(id: string) {
    const { data, error } = await admin.from('bakery_records').select(columns).eq('id', id).maybeSingle();
    if (error) storageError(error);
    return data ? record(data as Stored) : null;
  },
  async write(action: WriteAction, id: string, kind: RecordKind, data: unknown, revision: number | null, actor: string, now: string) {
    const result = await admin.rpc('bakery_write', { p_action: action, p_id: id, p_kind: kind, p_data: data, p_revision: revision, p_actor: actor, p_now: now });
    if (result.error) storageError(result.error);
    if (!result.data) throw new Error('Database returned no confirmed record');
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row) throw new Error('Database returned no confirmed record');
    return record(row as Stored);
  },
};
const handler = createBakeryHandler({
  async authenticate(token: string) {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email, emailConfirmedAt: data.user.email_confirmed_at };
  },
  async isMember(email: string) {
    const { data, error } = await admin.from('bakery_members').select('email').eq('email', email).eq('active', true).maybeSingle();
    if (error) storageError(error);
    return !!data;
  },
  store,
  allowLocalDev: Deno.env.get('BAKERY_ALLOW_LOCAL_DEV') === 'true',
});
Deno.serve(handler);
