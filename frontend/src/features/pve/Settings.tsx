import { useEffect, useMemo, useState } from "react";
import type { Host } from "../../platform/sdk";
import type { PveConfig, PveConfigHost, PveTest } from "./model";
import { Dot, Empty, Section } from "./parts";

// NPM-75: servers of the «Сервера» section, edited here and stored by the worker in hosts.json.

type Row = PveConfigHost & { key: string; test?: PveTest & { busy?: boolean } };
let seq = 0;
const row = (h: Partial<PveConfigHost> = {}): Row => ({ id: "", name: "", address: "", port: 22, user: "root", ...h, key: `r${++seq}` });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

function ServerRow({ r, onChange, onRemove, onTest }: { r: Row; onChange: (r: Row) => void; onRemove: () => void; onTest: (trust: boolean) => void }) {
  const set = (patch: Partial<Row>) => onChange({ ...r, ...patch, test: undefined });
  const t = r.test;
  const tone = t?.busy ? "idle" : t ? (t.ok ? "ok" : "bad") : r.pinned ? "ok" : "warn";
  return (
    <div className="pve-cfg-row">
      <div className="pve-cfg-fields">
        <label><span>Имя</span><input value={r.name} placeholder="s1" maxLength={40}
          onChange={(e) => set({ name: e.target.value, id: r.id && r.id !== slug(r.name) ? r.id : slug(e.target.value) })} /></label>
        <label><span>Адрес</span><input value={r.address} placeholder="192.168.99.10" className="pve-mono" onChange={(e) => set({ address: e.target.value.trim(), pinned: false })} /></label>
        <label className="narrow"><span>Порт</span><input value={r.port} inputMode="numeric" onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
        <label className="narrow"><span>Пользователь</span><input value={r.user} onChange={(e) => set({ user: e.target.value.trim() })} /></label>
        <label className="narrow"><span>ID</span><input value={r.id} className="pve-mono" title="Внутренний идентификатор: латиница, цифры, дефис" onChange={(e) => set({ id: slug(e.target.value) })} /></label>
      </div>
      <div className="pve-cfg-status">
        <Dot tone={tone} />
        <span className="pve-cfg-note">
          {t?.busy ? "Проверяю…"
            : t ? (t.ok ? `Агент ${t.agent} на «${t.host}» · ${t.latency_ms} мс` : t.error)
            : r.pinned ? "Ключ сервера закреплён" : "Ключ сервера не закреплён"}
          {t?.fingerprint ? <small className="pve-mono"> · закреплён {t.fingerprint}</small> : null}
        </span>
        <div className="pve-cfg-actions">
          {r.pinned || t?.pinned ? (
            <button type="button" className="pve-btn" onClick={() => onTest(false)} disabled={t?.busy || !r.address}>Проверить</button>
          ) : (
            <button type="button" className="pve-btn" onClick={() => onTest(true)} disabled={t?.busy || !r.address} title="Подключиться и закрепить ключ этого сервера">Проверить и доверять</button>
          )}
          <button type="button" className="pve-btn ghost danger" onClick={onRemove} aria-label={`Удалить ${r.name || "сервер"}`}>Удалить</button>
        </div>
      </div>
    </div>
  );
}

export function Settings({ host }: { host: Host }) {
  const [cfg, setCfg] = useState<PveConfig | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const load = async () => {
    try {
      const c = (await (await host.api("/api/pve/config")).json()) as PveConfig;
      setCfg(c);
      setRows(c.hosts.map((h) => row(h)));
      setSaved(JSON.stringify(c.hosts.map(({ id, name, address, port, user }) => ({ id, name, address, port, user }))));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); }, []);
  const plain = rows.map(({ id, name, address, port, user }) => ({ id, name, address, port, user }));
  const dirty = cfg != null && JSON.stringify(plain) !== saved;
  const update = (key: string, next: Row) => setRows((rs) => rs.map((r) => (r.key === key ? next : r)));
  const test = async (r: Row, trust: boolean) => {
    update(r.key, { ...r, test: { ok: false, busy: true } });
    try {
      const res = (await (await host.api("/api/pve/config/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: r.address, port: r.port, user: r.user, trust }) })).json()) as PveTest;
      setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, pinned: res.pinned ?? x.pinned, test: res } : x)));
    } catch (e) {
      setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, test: { ok: false, error: e instanceof Error ? e.message : String(e) } } : x)));
    }
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      await host.api("/api/pve/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hosts: plain }) });
      host.notify("Список серверов сохранён — опрос начнётся через несколько секунд");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); window.setTimeout(() => setCopied(""), 1600); } catch { /* clipboard is optional */ }
  };
  const install = useMemo(() => cfg?.public_key
    ? `scp -r pve-agent root@<адрес>:/tmp/ && ssh root@<адрес> "sh /tmp/pve-agent/install.sh '${cfg.public_key}'"`
    : "", [cfg]);

  if (!cfg) return error ? <Empty title="Настройки недоступны">{error}</Empty> : <div className="pve-skeleton" />;
  return (
    <div className="pve-page">
      <Section title="Сервера" hint="Proxmox-хосты, которые опрашивает HomeNet. Изменения применяются без перезапуска."
        actions={<>
          <button type="button" className="pve-btn" onClick={() => setRows((rs) => [...rs, row()])}>Добавить сервер</button>
          <button type="button" className="pve-btn primary" onClick={save} disabled={!dirty || busy}>{busy ? "Сохраняю…" : "Сохранить"}</button>
        </>}>
        {error ? <div className="pve-health bad" role="alert"><span className="pve-health-dot" aria-hidden="true" />{error}</div> : null}
        <div className="card pve-cfg">
          {rows.length ? rows.map((r) => (
            <ServerRow key={r.key} r={r} onChange={(n) => update(r.key, n)} onRemove={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} onTest={(trust) => void test(r, trust)} />
          )) : <Empty title="Серверов нет">Нажмите «Добавить сервер».</Empty>}
        </div>
        {dirty ? <p className="pve-muted pve-small">Есть несохранённые изменения.</p> : null}
      </Section>

      <Section title="Подключение нового сервера" hint="HomeNet читает только данные агента: ключ роутера на сервере разрешён лишь для команды агента.">
        <div className="card pve-howto">
          <ol>
            <li>
              <b>Ключ роутера.</b> Установщик добавит его в <span className="pve-mono">authorized_keys</span> с ограничением на команду агента.
              <div className="pve-code">
                <code>{cfg.public_key || cfg.key_error || "—"}</code>
                {cfg.public_key ? <button type="button" className="pve-btn ghost" onClick={() => void copy(cfg.public_key, "key")}>{copied === "key" ? "Скопировано" : "Копировать"}</button> : null}
              </div>
            </li>
            <li>
              <b>Агент.</b> Из папки репозитория HomeNet выполните на своём ПК (замените <span className="pve-mono">&lt;адрес&gt;</span>):
              <div className="pve-code">
                <code>{install || "—"}</code>
                {install ? <button type="button" className="pve-btn ghost" onClick={() => void copy(install, "cmd")}>{copied === "cmd" ? "Скопировано" : "Копировать"}</button> : null}
              </div>
            </li>
            <li><b>Сервер в списке.</b> Добавьте его выше, нажмите «Проверить и доверять», затем «Сохранить».</li>
          </ol>
          <p className="pve-muted pve-small">Агент собирает данные каждые 10 с и хранит сутки истории на самом сервере. В кластере ставьте его на каждый узел.</p>
        </div>
      </Section>
    </div>
  );
}

