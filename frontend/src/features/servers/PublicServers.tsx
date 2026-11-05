import { useEffect, useState } from "react";
import { request } from "../../platform/sdk";
import { Icon } from "../../components/ui/Icon";
import { Alert, Field } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import "./public-servers.css";

export type PublicServer = { id: string; name: string; address: string; port: number; user: string; fingerprint: string; socks?: string; email?: string };
export type PublicServerItem = { server: PublicServer; status: { state: string; error?: string; checked_at?: string; connected_at?: string; reconnects: number; domains: { host: string; port: number }[]; metrics?: { host: string; load1: number; cores: number; memory_total: number; memory_used: number; disk_total: number; disk_used: number; uptime: number } } };
const endpoint = "/api/routes/public/";
export async function publicServerRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await request(endpoint + path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await res.json() as T & { ok?: boolean; error?: string };
  if (value.ok === false) throw new Error(value.error || "Не удалось выполнить операцию");
  return value;
}
export const loadPublicServers = () => publicServerRequest<{ items: PublicServerItem[]; error?: string }>("servers");
const fresh = (): PublicServer => ({ id: "", name: "", address: "", port: 22, user: "root", fingerprint: "", socks: "", email: "" });
const stateLabel: Record<string, string> = { waiting: "Ожидание", connecting: "Подключение", configuring: "Настройка HTTPS", online: "На связи", reconnecting: "Переподключение" };
const gb = (n: number) => `${(n / 1073741824).toLocaleString("ru", { maximumFractionDigits: 1 })} ГБ`;

export function PublicServers({ settings = false }: { settings?: boolean }) {
  const [items, setItems] = useState<PublicServerItem[]>([]);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<PublicServer | null>(null);
  const [privateKey, setPrivateKey] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<PublicServer | null>(null);
  const [formError, setFormError] = useState("");
  const [message, setMessage] = useState("");
  const reload = async () => { try { const v = await loadPublicServers(); setItems(v.items); setError(v.error || ""); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } };
  useEffect(() => { void reload(); const timer = window.setInterval(() => void reload(), 10000); return () => window.clearInterval(timer); }, []);
  const open = (s?: PublicServer) => { setDraft(s ? { ...s } : fresh()); setPrivateKey(""); setPassword(""); setFormError(""); setMessage(""); };
  const close = () => { if (!busy) { setDraft(null); setPrivateKey(""); setPassword(""); } };
  const update = (patch: Partial<PublicServer>, connection = false) => setDraft(s => s ? { ...s, ...patch, ...(connection ? { fingerprint: "" } : {}) } : s);
  const act = async (path: string, server: PublicServer) => { setBusy(true); setError(""); try { await publicServerRequest(path, { server }); await reload(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const inspect = async () => { if (!draft) return; setBusy(true); setFormError(""); try { const v = await publicServerRequest<{ fingerprint: string }>("inspect", { server: draft }); update({ fingerprint: v.fingerprint }); } catch (e) { setFormError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const save = async () => { if (!draft) return; setBusy(true); setFormError(""); try { await publicServerRequest("save", { server: draft, private_key: privateKey, password }); setDraft(null); setPrivateKey(""); setPassword(""); setMessage("Сервер подключён. Выберите его в публичных доменах сервиса и примените маршруты."); await reload(); } catch (e) { setFormError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  return <section className="public-servers stack" aria-label="Публичные серверы">
    <div className="section-heading"><div><h2>Публичные серверы</h2><p className="muted">Linux и VPS по SSH · HTTPS и туннели для доменов</p></div><button type="button" className="btn" onClick={() => open()}><Icon name="plus" size={16} />Добавить VPS</button></div>
    {error && <Alert tone="danger">{error}</Alert>}{message && <Alert>{message}</Alert>}
    {!items.length && !error && <div className="card public-server-empty">Подключите VPS, чтобы публиковать домашние сервисы под своими доменами. Существующий доступ через KeenDNS продолжит работать.</div>}
    <div className="public-server-grid">{items.map(({ server: s, status: st }) => { const m = st.metrics, stale = !st.checked_at || Date.now() - Date.parse(st.checked_at) > 60000; return <article className="card public-server-card" key={s.id}>
      <div className="public-server-head"><Icon name="servers" size={22} /><div><h3>{s.name}</h3><span className="mono muted">{s.address}:{s.port}</span></div><span className={`badge ${st.state === "online" && !stale ? "badge-accent" : ""}`}>{stateLabel[st.state] || st.state}</span></div>
      <p className="muted">{s.socks ? `Через mihomo · ${s.socks}` : "Прямое SSH-подключение"} · переподключений: {st.reconnects}</p>
      {m && <dl className="public-server-metrics"><div><dt>Нагрузка / ядра</dt><dd>{m.load1.toFixed(2)} / {m.cores}</dd></div><div><dt>Память</dt><dd>{gb(m.memory_used)} / {gb(m.memory_total)}</dd></div><div><dt>Диск</dt><dd>{gb(m.disk_used)} / {gb(m.disk_total)}</dd></div><div><dt>Работает</dt><dd>{Math.floor(m.uptime / 86400)} д. {Math.floor(m.uptime % 86400 / 3600)} ч.</dd></div></dl>}
      {m && stale && <p className="field-hint">Последние данные устарели. {st.checked_at && new Date(st.checked_at).toLocaleString("ru")}</p>}
      <div className="chip-list">{st.domains.map(d => <a className="chip" href={`https://${d.host}/`} rel="noreferrer" target="_blank" key={d.host}><Icon name="globe" size={13} />{d.host}</a>)}</div>
      {st.error && <Alert tone="danger">{st.error}</Alert>}
      <div className="public-server-actions"><button type="button" className="btn" disabled={busy} onClick={() => open(s)}>Настроить</button><button type="button" className="btn" disabled={busy} onClick={() => void act("reconnect", s)}><Icon name="refresh" size={14} />Переподключить</button>{settings && <button type="button" className="btn" disabled={busy || !!st.domains.length} onClick={() => setRemove(s)}>Отключить</button>}</div>
    </article>; })}</div>
    <Modal open={!!draft} onClose={close} size="lg" title={items.some(i => i.server.id === draft?.id) ? "Настройка VPS" : "Подключить VPS"} description="HomeNet настроит домены по SSH и будет поддерживать обратный туннель." footer={<><button className="btn" disabled={busy} onClick={close}>Отмена</button><button className="btn btn-primary" disabled={busy || !draft?.id || !draft.name || !draft.address || !draft.port} onClick={() => void (draft?.fingerprint ? save() : inspect())}>{busy ? "Подключаю…" : draft?.fingerprint ? "Доверять ключу и подключить" : "Проверить SSH-ключ"}</button></>}>
      {draft && <div className="stack"><div className="form-grid">
        <Field label="Имя сервера"><input value={draft.name} maxLength={80} placeholder="VPS cdn6" onChange={e => update({ name: e.target.value, ...(!items.some(i => i.server.id === draft.id) ? { id: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) } : {}) })} /></Field>
        <Field label="ID"><input value={draft.id} disabled={items.some(i => i.server.id === draft.id)} maxLength={16} onChange={e => update({ id: e.target.value })} /></Field>
        <Field label="Адрес VPS"><input value={draft.address} autoComplete="off" placeholder="213.155.28.79" onChange={e => update({ address: e.target.value.trim() }, true)} /></Field>
        <Field label="SSH-порт"><input type="number" min={1} max={65535} value={draft.port} onChange={e => update({ port: Number(e.target.value) }, true)} /></Field>
        <Field label="SOCKS mihomo" hint="Пусто — напрямую. Для ограниченного интернета укажите SOCKS и направьте адрес VPS через рабочую группу mihomo."><input value={draft.socks || ""} placeholder="127.0.0.1:7891" onChange={e => update({ socks: e.target.value.trim() }, true)} /></Field>
        <Field label="Email для сертификатов"><input type="email" value={draft.email || ""} placeholder="Необязательно" onChange={e => update({ email: e.target.value.trim() })} /></Field>
      </div><Field label="Приватный SSH-ключ для первого входа" hint="Нужен root-доступ. Ключ используется однократно для установки отдельного ключа HomeNet; поле очищается после подключения."><textarea className="mono" rows={4} value={privateKey} autoComplete="off" spellCheck={false} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" onChange={e => setPrivateKey(e.target.value)} /></Field>
        <Field label="Или пароль root для первого входа"><input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></Field>
        {draft.fingerprint && <Alert><b>Ключ SSH сервера</b><p className="mono public-fingerprint">{draft.fingerprint}</p>Сверьте отпечаток с вашим сервером. Подключение закрепит этот ключ; при его изменении HomeNet остановит соединение.</Alert>}
        <p className="field-hint">Автоматическая настройка рассчитана на Debian/Ubuntu с systemd. При публикации HomeNet установит nginx и certbot, выпустит сертификаты и создаст отдельного пользователя туннеля. Существующие домены на VPS проверяются на конфликт.</p>
        {formError && <Alert tone="danger">{formError}</Alert>}</div>}
    </Modal>
    <ConfirmDialog open={!!remove} title={`Отключить «${remove?.name || ""}»?`} confirmLabel="Отключить" onClose={() => setRemove(null)} onConfirm={() => { if (remove) void act("remove", remove); setRemove(null); }}>HomeNet прекратит опрос сервера. Домены сначала нужно удалить из маршрутов и применить изменения.</ConfirmDialog>
  </section>;
}
