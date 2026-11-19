export type PublicConfig = { supabaseUrl: string; publishableKey: string };

export function assetUrl(base: string, file: string): string {
  return `${base.endsWith('/') ? base : `${base}/`}${file.replace(/^\/+/, '')}`;
}

export function parseConfig(value: unknown): PublicConfig {
  const input = value as Partial<PublicConfig> | null;
  if (!input || typeof input.supabaseUrl !== 'string' || typeof input.publishableKey !== 'string' || !input.publishableKey.startsWith('sb_publishable_')) throw new Error('Не найдены публичные настройки подключения. Обновите страницу или обратитесь к владельцу приложения.');
  let url: URL;
  try { url = new URL(input.supabaseUrl); } catch { throw new Error('Некорректный адрес базы приложения.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co') || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) throw new Error('Некорректный адрес базы приложения.');
  return { supabaseUrl: url.origin, publishableKey: input.publishableKey };
}
