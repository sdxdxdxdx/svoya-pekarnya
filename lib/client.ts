import type { BakeryRecord, Bootstrap, DataByKind, RecordKind } from './types';
import { getAuth } from './auth';
import { createTransport } from './transport';
export { ApiError } from './transport';

async function api() {
  const { client, config } = await getAuth();
  return createTransport({
    config,
    getToken: async () => (await client.auth.getSession()).data.session?.access_token || null,
    refreshToken: async () => (await client.auth.refreshSession()).data.session?.access_token || null,
  });
}

export const getBootstrap = async () => (await api()).json<Bootstrap>('/bootstrap');
export async function saveRecord(kind: RecordKind, data: DataByKind[RecordKind], existing?: BakeryRecord, id?: string) {
  const transport = await api();
  const result = existing
    ? await transport.json<{ record: BakeryRecord }>(`/records/${encodeURIComponent(existing.id)}`, { method: 'PUT', body: JSON.stringify({ revision: existing.revision, data }) })
    : await transport.json<{ record: BakeryRecord }>('/records', { method: 'POST', body: JSON.stringify({ id: id || crypto.randomUUID(), kind, data }) });
  return result.record;
}
export async function setRecordDeleted(record: BakeryRecord, restore = false) {
  const result = await (await api()).json<{ record: BakeryRecord }>(`/records/${encodeURIComponent(record.id)}`, { method: restore ? 'PATCH' : 'DELETE', body: JSON.stringify({ revision: record.revision, ...(restore ? { restore: true } : {}) }) });
  return result.record;
}
export async function downloadBackup() {
  const response = await (await api()).response('/backup');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `bakery-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
