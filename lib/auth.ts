import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { assetUrl, parseConfig, type PublicConfig } from './config.ts';

export type AuthContext = { client: SupabaseClient; config: PublicConfig };
let contextPromise: Promise<AuthContext> | null = null;
export function getAuth(): Promise<AuthContext> {
  contextPromise ??= (async () => {
    const response = await fetch(assetUrl(import.meta.env.BASE_URL, 'config.json'), { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('Не удалось загрузить настройки приложения. Обновите страницу.');
    const config = parseConfig(await response.json());
    const client = createClient(config.supabaseUrl, config.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'bakery-auth-session' } });
    return { client, config };
  })().catch(error => { contextPromise = null; throw error; });
  return contextPromise;
}

export function returnUrl(): string { return new URL(import.meta.env.BASE_URL, window.location.origin).href; }
export function authErrorMessage(error: { message: string; code?: string }): string {
  switch (error.code) {
    case 'invalid_credentials': return 'Неверная почта или пароль. Проверьте ввод или восстановите пароль.';
    case 'email_not_confirmed': return 'Подтвердите почту по ссылке из письма, затем войдите.';
    case 'user_already_exists': return 'Такая почта уже зарегистрирована. Переключитесь на вход или восстановите пароль.';
    case 'weak_password': return 'Выберите более надёжный пароль: не менее 8 символов.';
    case 'over_email_send_rate_limit': case 'over_request_rate_limit': return 'Слишком много попыток. Подождите несколько минут и повторите.';
    case 'signup_disabled': return 'Регистрация пока отключена. Обратитесь к владельцу приложения.';
    case 'same_password': return 'Новый пароль должен отличаться от предыдущего.';
    default: return /fetch|network/i.test(error.message) ? 'Нет связи с сервером входа. Проверьте интернет и повторите.' : 'Не удалось выполнить вход. Проверьте данные и повторите. Если ошибка сохраняется, обратитесь к владельцу приложения.';
  }
}
