import { useEffect, useState } from "react";
import { Segmented, Switch } from "../../components/ui/controls";
import { Icon } from "../../components/ui/Icon";
import type { Host } from "../../platform/sdk";
import { Dot, Empty, Section } from "../pve/parts";
import type { Config, ConfigHost, Test } from "./model";

type Row = ConfigHost & { key: number; test?: Test & { busy?: boolean } };
let sequence = 0;
const createRow = (h?: ConfigHost): Row => ({ id: "", name: "", address: "", port: 22, user: "", ...h, key: ++sequence });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
const plain = (rows: Row[]) => rows.map(({ id, name, address, port, user }) => ({ id, name, address, port, user }));

export function Settings({ host, onSaved }: { host: Host; onSaved: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [os, setOs] = useState("windows");
  const [docker, setDocker] = useState(false);
  const [wsl, setWsl] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [copied, setCopied] = useState("");
  const load = async () => {
    try {
      const next = await (await host.api("/api/pc/config")).json() as Config;
      setConfig(next); setRows(next.hosts.map(createRow)); setSaved(JSON.stringify(next.hosts.map(({ id, name, address, port, user }) => ({ id, name, address, port, user })))); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); }, [host]);
  const update = (row: Row, patch: Partial<Row>) => setRows((rs) => rs.map((r) => r.key === row.key ? { ...r, ...patch, test: undefined } : r));
  const test = async (r: Row) => {
    setRows((rs) => rs.map((x) => x.key === r.key ? { ...x, test: { ok: false, busy: true } } : x));
    try {
      const reply = await (await host.api("/api/pc/config/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: r.address, port: r.port, user: r.user, trust: !r.pinned }) })).json() as Test;
      setRows((rs) => rs.map((x) => x.key === r.key ? { ...x, pinned: reply.pinned ?? x.pinned, test: reply } : x));
    } catch (e) { setRows((rs) => rs.map((x) => x.key === r.key ? { ...x, test: { ok: false, error: e instanceof Error ? e.message : String(e) } } : x)); }
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      await host.api("/api/pc/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hosts: plain(rows) }) });
      await load(); onSaved(); host.notify("Компьютеры сохранены. Данные появятся после опроса агентов.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const copy = async (value: string, id: string) => { try { await navigator.clipboard.writeText(value); setCopied(id); window.setTimeout(() => setCopied(""), 2000); } catch { setError("Не удалось скопировать. Выделите команду вручную."); } };
  const key = config?.public_key || "";
  const command = !key ? "" : os === "windows"
    ? `powershell -NoProfile -File .\\install.ps1 -PublicKey '${key.replace(/'/g, "''")}'${docker ? " -AllowDockerActions" : ""}${wsl ? " -AllowWSLActions" : ""}${admin ? " -AdministratorKeyFile" : ""}`
    : `sh ./install.sh '${key.replace(/'/g, "'\\''")}'${docker ? " --allow-docker-actions" : ""}`;
  const dirty = !!config && JSON.stringify(plain(rows)) !== saved;
  const valid = rows.every((r) => r.id && r.name && r.address && r.user && r.port > 0 && r.port <= 65535) && new Set(rows.map((r) => r.id)).size === rows.length;
  if (!config) return error ? <Empty title="Настройки недоступны">{error}</Empty> : <div className="pve-skeleton" />;
  return <div className="pc-page"><Section title="Подключённые компьютеры" hint="HomeNet подключается по SSH под указанным пользователем и запускает ограниченную команду агента."
    actions={<><button type="button" className="pve-btn" onClick={() => setRows((old) => [...old, createRow()])}><Icon name="plus" size={14} />Добавить компьютер</button><button type="button" className="pve-btn primary" disabled={!dirty || !valid || busy} onClick={() => void save()}>{busy ? "Сохраняю…" : "Сохранить"}</button></>}>
    {error ? <div className="pc-error" role="alert">{error}</div> : null}
    <div className="card pve-cfg">{rows.length ? rows.map((r) => <div className="pve-cfg-row" key={r.key}><div className="pve-cfg-fields">
      <label><span>Имя</span><input value={r.name} maxLength={40} placeholder="Домашний ПК" onChange={(e) => update(r, { name: e.target.value, id: !r.id || r.id === slug(r.name) ? slug(e.target.value) : r.id })} /></label>
      <label><span>Адрес</span><input value={r.address} placeholder="192.168.1.100" onChange={(e) => update(r, { address: e.target.value.trim(), pinned: false })} /></label>
      <label><span>SSH-порт</span><input value={r.port} inputMode="numeric" onChange={(e) => update(r, { port: Number(e.target.value.replace(/\D/g, "")), pinned: false })} /></label>
      <label><span>Пользователь</span><input value={r.user} placeholder="Имя в системе" autoComplete="off" onChange={(e) => update(r, { user: e.target.value.trim() })} /></label>
      <label><span>ID</span><input value={r.id} placeholder="home-pc" onChange={(e) => update(r, { id: slug(e.target.value) })} /></label>
    </div><div className="pve-cfg-status"><Dot tone={r.test?.busy ? "idle" : r.test ? r.test.ok ? "ok" : "bad" : r.pinned ? "ok" : "warn"} /><span className="pve-cfg-note">{r.test?.busy ? "Проверяю…" : r.test ? r.test.ok ? `${r.test.host || r.name} · агент ${r.test.agent || "подключён"}${r.test.os ? ` · ${r.test.os}` : ""} · ${r.test.latency_ms ?? "—"} мс` : r.test.error : r.pinned ? "Ключ компьютера закреплён" : "Первое подключение: проверьте адрес компьютера"}{r.test?.fingerprint ? <small className="pve-mono"> · {r.test.fingerprint}</small> : null}</span>
      <div className="pve-cfg-actions"><button type="button" className="pve-btn" onClick={() => void test(r)} disabled={!r.address || !r.user || !r.port || r.test?.busy}>{r.pinned ? "Проверить" : "Проверить и доверять"}</button><button type="button" className="pve-btn ghost danger" onClick={() => setRows((old) => old.filter((x) => x.key !== r.key))}>Удалить</button></div></div></div>) : <Empty title="Компьютеров нет">Установите агент по инструкции ниже и добавьте адрес компьютера.</Empty>}</div>
    {dirty ? <p className="pve-muted pve-small">Есть несохранённые изменения.{!valid ? " Заполните все поля и задайте уникальные ID латиницей." : ""}</p> : null}
  </Section>
  <Section title="Установка агента" hint="Установите агент под тем же пользователем, который указан в подключении SSH.">
    <div className="pc-setup card"><Segmented label="Операционная система" value={os} onChange={setOs} options={[{ value: "windows", label: "Windows" }, { value: "linux", label: "Linux" }]} />
      <ol><li><b>Подготовьте SSH.</b> {os === "windows" ? "Включите OpenSSH Server в дополнительных компонентах Windows и запустите службу sshd. Для WSL используйте пользователя, которому принадлежат дистрибутивы." : "Установите и запустите OpenSSH Server. Для Docker у пользователя должен быть доступ к Docker CLI и сокету демона."}</li>
        <li><b>Скопируйте агент.</b> Соберите его в репозитории HomeNet командой <code className="pve-mono">powershell -NoProfile -File pc-agent/build.ps1</code>. Скопируйте папку <code className="pve-mono">pc-agent/dist/{os}-amd64</code> на подключаемый компьютер; для ARM используйте папку <code className="pve-mono">{os}-arm64</code>.</li>
        <li><b>Выберите разрешения.</b> Без них агент только читает состояние.<div className="pc-permissions"><Switch checked={docker} onChange={setDocker} label="Управлять контейнерами Docker" hint="Запуск, остановка и перезапуск" />{os === "windows" ? <><Switch checked={wsl} onChange={setWsl} label="Управлять дистрибутивами WSL" hint="Запуск и завершение всех процессов дистрибутива" /><Switch checked={admin} onChange={setAdmin} label="Пользователь состоит в группе администраторов" hint="Использовать общий файл ключей OpenSSH; установщик нужно запустить с повышенными правами" /></> : null}</div></li>
        <li><b>Запустите установщик</b> {os === "windows" ? "в PowerShell " : ""}из скопированной папки на подключаемом компьютере.<div className="pve-code"><code>{command || config.key_error || "Ключ пока недоступен"}</code>{command ? <button type="button" className="pve-btn ghost" onClick={() => void copy(command, "command")}>{copied === "command" ? "Скопировано" : "Копировать"}</button> : null}</div></li>
        <li><b>Добавьте компьютер</b> в список выше, проверьте подключение и сохраните настройки.</li>
      </ol>
      <details><summary>Публичный ключ HomeNet</summary><div className="pve-code"><code>{key || config.key_error || "—"}</code>{key ? <button type="button" className="pve-btn ghost" onClick={() => void copy(key, "key")}>{copied === "key" ? "Скопировано" : "Копировать"}</button> : null}</div></details>
      <p className="pve-muted pve-small">Агент не создаёт постоянную службу. Он запускается по запросу HomeNet через SSH, а ключ разрешает только команды агента. Для изменения разрешений повторите установку с нужными переключателями.</p>
    </div>
  </Section></div>;
}
