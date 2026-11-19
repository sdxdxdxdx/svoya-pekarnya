import { useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ArrowRight, LockKeyhole, Wheat } from 'lucide-react';
import BakeryApp from './BakeryApp';
import { authErrorMessage, getAuth, returnUrl, type AuthContext } from '@/lib/auth';

type Mode = 'signin' | 'signup' | 'reset' | 'password';
export default function AuthApp() {
  const [context, setContext] = useState<AuthContext | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordAgain, setPasswordAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true; let unsubscribe: (() => void) | undefined;
    setLoading(true); setError('');
    void getAuth().then(async auth => {
      if (!active) return;
      setContext(auth);
      const { data } = auth.client.auth.onAuthStateChange((event, next) => {
        if (!active) return;
        setSession(next); setLoading(false);
        if (event === 'PASSWORD_RECOVERY') setMode('password');
      });
      unsubscribe = () => data.subscription.unsubscribe();
      const result = await auth.client.auth.getSession();
      if (active) { if (result.error) setError(authErrorMessage(result.error)); setSession(result.data.session); setLoading(false); }
    }).catch(cause => { if (active) { setError(cause instanceof Error ? cause.message : 'Не удалось подключиться к приложению.'); setLoading(false); } });
    return () => { active = false; unsubscribe?.(); };
  }, [reload]);

  function changeMode(next: Mode) { setMode(next); setError(''); setNotice(''); setPassword(''); setPasswordAgain(''); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !context) return;
    setError(''); setNotice('');
    if ((mode === 'signup' || mode === 'password') && password !== passwordAgain) { setError('Пароли не совпадают. Повторите ввод.'); return; }
    setBusy(true);
    try {
      if (mode === 'signin') {
        const result = await context.client.auth.signInWithPassword({ email: email.trim(), password });
        if (result.error) throw result.error;
        setPassword(''); setSession(result.data.session);
      } else if (mode === 'signup') {
        const result = await context.client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: returnUrl() } });
        if (result.error) throw result.error;
        setPassword(''); setPasswordAgain('');
        if (result.data.session) setSession(result.data.session);
        else { setMode('signin'); setNotice('Проверьте почту и папку «Спам». Подтвердите адрес по ссылке из письма, затем войдите с выбранным паролем. Доступ к данным выдаётся отдельно.'); }
      } else if (mode === 'reset') {
        const result = await context.client.auth.resetPasswordForEmail(email.trim(), { redirectTo: returnUrl() });
        if (result.error) throw result.error;
        setNotice('Если этот адрес зарегистрирован, придёт письмо со ссылкой для смены пароля. Проверьте также папку «Спам».');
      } else {
        const result = await context.client.auth.updateUser({ password });
        if (result.error) throw result.error;
        setPassword(''); setPasswordAgain(''); setMode('signin'); setNotice('Пароль обновлён.');
      }
    } catch (cause) { setError(cause && typeof cause === 'object' && 'message' in cause ? authErrorMessage(cause as { message: string; code?: string }) : 'Не удалось выполнить действие. Повторите попытку.'); }
    finally { setBusy(false); }
  }
  async function signOut() {
    if (!context) return;
    const result = await context.client.auth.signOut({ scope: 'local' });
    if (result.error) throw new Error(authErrorMessage(result.error));
    setSession(null); setMode('signin'); setPassword(''); setPasswordAgain(''); setNotice('Вы вышли из учёта на этом устройстве.');
  }
  if (loading) return <main className="loading-screen"><Wheat size={36} /><h1>Своя пекарня</h1><p>Проверяем вход…</p></main>;
  if (session && mode !== 'password') return <BakeryApp key={session.user.id} onSignOut={signOut} />;
  const headings: Record<Mode, string> = { signin: 'Войти в пекарню', signup: 'Создать свой вход', reset: 'Восстановить пароль', password: 'Новый пароль' };
  return <main className="auth-page"><section className="auth-story"><a className="brand" href={import.meta.env.BASE_URL}><Wheat size={34} /><div>Своя пекарня<small>Ежедневный учёт</small></div></a><div><span className="auth-eyebrow">Всё под рукой</span><h1>Понятно,<br /> как идут дела.</h1><p>Закупки, продажи, рецептуры и расходы — в одном общем учёте, с телефона и компьютера.</p></div><small><LockKeyhole size={15} /> Данные открыты только владельцам с доступом.</small></section><section className="auth-panel"><div className="auth-card"><h2>{headings[mode]}</h2><p className="auth-intro">{mode === 'signup' ? 'Зарегистрируйтесь с почтой, для которой выдан доступ к пекарне. Придумайте отдельный пароль.' : mode === 'reset' ? 'Укажите почту своего входа. Пришлём ссылку для смены пароля.' : mode === 'password' ? 'Придумайте новый пароль для входа в учёт.' : 'Используйте почту и пароль своего входа в учёт.'}</p>{error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="auth-notice" role="status">{notice}</div>}{context ? <form onSubmit={event => void submit(event)}>{mode !== 'password' && <label className="field"><span>Почта</span><input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required disabled={busy} placeholder="you@example.com" /></label>}{mode !== 'reset' && <label className="field"><span>Пароль</span><input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} required minLength={mode === 'signin' ? undefined : 8} disabled={busy} /></label>}{(mode === 'signup' || mode === 'password') && <label className="field"><span>Повторите пароль</span><input type="password" autoComplete="new-password" value={passwordAgain} onChange={event => setPasswordAgain(event.target.value)} required minLength={8} disabled={busy} /><small>Не менее 8 символов. Пароль вводите только здесь.</small></label>}<button className="button primary auth-submit" type="submit" disabled={busy}>{busy ? 'Подождите…' : mode === 'signin' ? 'Войти' : mode === 'signup' ? 'Зарегистрироваться' : mode === 'reset' ? 'Отправить ссылку' : 'Сохранить пароль'}<ArrowRight size={18} /></button></form> : <button className="button primary" type="button" onClick={() => setReload(value => value + 1)}>Повторить подключение</button>}<div className="auth-links">{mode === 'signin' ? <><button className="text-button" type="button" disabled={busy} onClick={() => changeMode('signup')}>Первый вход? Создать аккаунт</button><button className="text-button" type="button" disabled={busy} onClick={() => changeMode('reset')}>Забыли пароль?</button></> : mode !== 'password' && <button className="text-button" type="button" disabled={busy} onClick={() => changeMode('signin')}>Вернуться ко входу</button>}</div><p className="auth-footnote">Регистрация сама по себе не открывает данные. Совладельцу нужно отдельно выдать доступ по его почте.</p></div></section></main>;
}
