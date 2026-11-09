import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../components/ui/Icon";
import { Empty, Pill, Section, Stat } from "../features/pve/parts";
import { ModuleBoundary, usePage } from "./module-base";
import type { Host } from "./sdk";
import "../features/pve/pve.css";
import "../features/hostings/hostings.css";

type Account = { id: string; name: string; provider: string; token_set: boolean; checked_at: number; last_ok: number; error?: string; servers: number };
type Server = { id: string; account: string; name: string; ip: string; country: string; country_code: string; cpu: string; ram: string; disk: string; os: string; status: string; state: string };
type Overview = { accounts: Account[]; servers: Server[]; error?: string; providers: { id: string; name: string }[] };
const ago = (time: number) => !time ? "Ещё не обновлялось" : `Обновлено ${new Date(time * 1000).toLocaleString("ru-RU")}`;
const statusName = (value: string) => ({ running: "Работает", stopped: "Остановлен", suspended: "Приостановлен", pending: "Подготавливается", expired: "Истёк срок" }[value] || value || "Нет данных");

function Hostings({ host }: { host: Host }) {
  const page = usePage();
  const settings = page === "hostings-settings";
  const [data, setData] = useState<Overview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("is*hosting");
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState("");
  const call = async (path: string, body?: object) => {
    const response = await host.api(`/api/hostings/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const value = await response.json();
    if (!response.ok || value.ok === false) throw new Error(value.error || "Не удалось выполнить запрос");
    return value;
  };
  const load = async () => {
    try { setData(await call("overview")); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30000); return () => window.clearInterval(timer); }, []);
  const refresh = async () => {
    setBusy(true); setNotice("");
    try { setData(await call("refresh", {})); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const edit = (account?: Account) => { setEditing(account?.id || "new"); setName(account?.name || "is*hosting"); setToken(""); setNotice(""); };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await call("accounts", { id: editing === "new" ? "" : editing, name: name.trim(), provider: "ishosting", token: token.trim() });
      setToken(""); setEditing(undefined); setNotice("Подключение сохранено"); setData(await call("refresh", {}));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try { await call("accounts/remove", { id }); await load(); setNotice("Подключение отключено. Серверы у хостинга сохранены."); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const servers = (data?.servers || []).filter(s => (!accountFilter || s.account === accountFilter) && `${s.name} ${s.ip} ${s.country} ${s.id}`.toLowerCase().includes(query.toLowerCase()));
  const accounts = data?.accounts || [];
  return <div className="pve-module"><div className="pve-page hosting-page">
    {!host.shellNav && <nav className="section-tabs"><a href="#/hostings">Серверы</a><a href="#/hostings-settings">Подключения</a></nav>}
    <header className="hosting-heading"><div><h1>{settings ? "Подключения хостингов" : "Хостинги"}</h1><p className="pve-muted">{settings ? "Аккаунты провайдеров и доступ к API" : `${data?.servers.length || 0} VPS · подключений: ${accounts.length}`}</p></div>
      <div className="hosting-actions"><button className="pve-btn" disabled={busy} onClick={() => void refresh()}>{busy ? "Обновление…" : "Обновить"}</button><button className="pve-btn primary" disabled={busy} onClick={() => { host.navigate("hostings-settings"); edit(); }}>Добавить хостинг</button></div>
    </header>
    {error || data?.error ? <div className="pve-health bad" role="alert">{error || data?.error}</div> : null}
    {notice && <div className="pve-health" role="status">{notice}</div>}
    {!data && !error ? <div className="pve-skeleton tall" aria-label="Загрузка хостингов" /> : null}
    {!settings && data && <>
      <div className="hosting-stats"><Stat label="Серверов" value={data.servers.length} /><Stat label="Работают" value={data.servers.filter(s => s.status === "running").length} /><Stat label="Подключений" value={accounts.length} /><Stat label="Требуют внимания" value={accounts.filter(a => !!a.error).length} tone={accounts.some(a => a.error) ? "warn" : "ok"} /></div>
      {accounts.filter(a => a.error).map(a => <div key={a.id} className="pve-health bad" role="status"><span>{a.name}: {a.error}. {a.last_ok ? `Показаны последние данные. ${ago(a.last_ok)}.` : ""}</span><button className="pve-btn" onClick={() => { host.navigate("hostings-settings"); edit(a); }}>Проверить ключ</button></div>)}
      <Section title="VPS" hint="Параметры и состояние из панели хостинга · обновление раз в 5 минут" actions={<div className="hosting-actions"><input aria-label="Поиск сервера" placeholder="Имя, IP или страна" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Подключение" value={accountFilter} onChange={e => setAccountFilter(e.target.value)}><option value="">Все подключения</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>}>
        {!accounts.length ? <Empty title="Хостинги не подключены">Добавьте аккаунт is*hosting, чтобы видеть его серверы и состояние.</Empty> : !servers.length ? <Empty title={query || accountFilter ? "Серверы не найдены" : "VPS пока нет"}>{query || accountFilter ? "Измените поиск или выберите другое подключение." : "Обновите данные или проверьте состояние подключения."}</Empty> : <div className="hosting-grid">{servers.map(s => {
          const account = accounts.find(a => a.id === s.account);
          return <article className="hosting-server" key={`${s.account}/${s.id}`}><header><span className="hosting-server-icon"><Icon name="servers" size={21} /></span><div><h3>{s.name}</h3><span className="pve-muted">{account?.name} · #{s.id}</span></div><Pill tone={s.status === "running" ? "ok" : "warn"}>{statusName(s.status)}</Pill></header>
            <div className="hosting-address"><code>{s.ip || "IP не указан"}</code><span>{s.country} {s.country_code && <small>· {s.country_code}</small>}</span></div>
            <dl><div><dt>Процессор</dt><dd>{s.cpu || "—"}</dd></div><div><dt>Память</dt><dd>{s.ram || "—"}</dd></div><div><dt>Диск</dt><dd>{s.disk || "—"}</dd></div><div><dt>ОС по панели</dt><dd>{s.os || "—"}</dd></div></dl>
            <footer>{account?.error ? "Последние доступные данные" : ago(account?.checked_at || 0)}<a href="https://my.ishosting.com/" target="_blank" rel="noopener noreferrer">Панель хостинга</a></footer>
          </article>;
        })}</div>}
      </Section>
    </>}
    {settings && <>
      <Section title="Подключённые аккаунты" hint="Ключи используются на сервере HomeNet и не возвращаются в интерфейс.">
        {!accounts.length ? <Empty title="Нет подключений">Добавьте is*hosting с API-ключом из личного кабинета.</Empty> : <div className="hosting-accounts">{accounts.map(a => <div className="hosting-account" key={a.id}><Icon name="servers" size={20} /><div><strong>{a.name}</strong><span className="pve-muted">is*hosting · {a.servers} VPS · {a.token_set ? "Ключ сохранён" : "Ключ не указан"}</span><small className={a.error ? "hosting-error" : "pve-muted"}>{a.error || ago(a.checked_at)}</small></div><Pill tone={a.error ? "bad" : a.last_ok ? "ok" : "idle"}>{a.error ? "Нет связи" : a.last_ok ? "На связи" : "Ожидает проверки"}</Pill><button className="pve-btn" disabled={busy} onClick={() => edit(a)}>Изменить</button><button className="pve-btn" disabled={busy} onClick={() => void remove(a.id)}>Отключить</button></div>)}</div>}
      </Section>
      {editing && <Section title={editing === "new" ? "Добавить хостинг" : "Изменить подключение"}><form className="hosting-form" onSubmit={save}>
        <label>Провайдер<select value="ishosting" disabled><option value="ishosting">is*hosting</option></select></label>
        <label>Название<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="Например, основной аккаунт" /></label>
        <label className="hosting-token">API-ключ<input type="password" autoComplete="new-password" required={editing === "new"} value={token} onChange={e => setToken(e.target.value)} placeholder={editing === "new" ? "Ключ из панели is*hosting" : "Оставьте пустым, чтобы сохранить текущий"} /><small className="pve-muted">Пустое поле при редактировании сохраняет прежний ключ.</small></label>
        <div className="hosting-actions"><button className="pve-btn primary" disabled={busy} type="submit">{busy ? "Проверка…" : "Сохранить и обновить"}</button><button className="pve-btn" type="button" disabled={busy} onClick={() => { setEditing(undefined); setToken(""); }}>Отмена</button></div>
      </form></Section>}
    </>}
  </div></div>;
}
export function mount(element: HTMLElement, host: Host) {
  if (host.protocol !== 1) throw new Error("Несовместимая версия HomeNet");
  const root = host.createRoot(element); root.render(<ModuleBoundary><Hostings host={host} /></ModuleBoundary>); return () => root.unmount();
}
