import type { PublicConfig } from './config.ts';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}

type TransportOptions = { config: PublicConfig; getToken: () => Promise<string | null>; refreshToken: () => Promise<string | null>; fetcher?: typeof fetch };
export function createTransport({ config, getToken, refreshToken, fetcher = fetch }: TransportOptions) {
  async function response(path: string, init?: RequestInit): Promise<Response> {
    let token = await getToken();
    if (!token) throw new ApiError('Войдите по почте и паролю, чтобы открыть общий учёт.', 401, 'UNAUTHENTICATED');
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(init?.headers);
      headers.set('Content-Type', 'application/json');
      headers.set('apikey', config.publishableKey);
      headers.set('Authorization', `Bearer ${token}`);
      let result: Response;
      try { result = await fetcher(`${config.supabaseUrl}/functions/v1/bakery-api${path}`, { ...init, credentials: 'omit', cache: 'no-store', headers }); }
      catch { throw new ApiError('Нет связи с сервером. Проверьте подключение и повторите сохранение.', 0, 'NETWORK'); }
      if (result.status === 401 && attempt === 0) {
        const renewed = await refreshToken().catch(() => null);
        if (renewed) { token = renewed; continue; }
      }
      if (!result.ok) {
        const body = await result.json().catch(() => null) as { error?: string; code?: string } | null;
        if (result.status === 409) throw new ApiError('Запись уже изменил другой совладелец. Ваш ввод сохранён в форме. Обновите данные и откройте актуальную запись, затем повторите нужные изменения.', 409, body?.code);
        const fallback = result.status === 401 ? 'Срок входа истёк. Войдите по почте и паролю снова.' : result.status === 403 ? 'Для этой почты не выдан доступ к пекарне. Обратитесь к владельцу приложения.' : 'Не удалось выполнить действие. Повторите попытку.';
        throw new ApiError(body?.error || fallback, result.status, body?.code);
      }
      return result;
    }
    throw new ApiError('Срок входа истёк. Войдите снова.', 401, 'UNAUTHENTICATED');
  }
  return {
    response,
    async json<T>(path: string, init?: RequestInit): Promise<T> {
      const result = await response(path, init);
      try { return await result.json() as T; } catch { throw new ApiError('Сервер вернул неполный ответ. Обновите данные перед повторным сохранением.', 502, 'INVALID_RESPONSE'); }
    },
  };
}
