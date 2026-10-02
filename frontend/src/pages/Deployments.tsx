import type { DmsApp } from "../types";
import { useEffect, useState } from "react";
import { Icon } from "../components/ui/Icon";
import { EmptyState } from "../components/ui/controls";
import { dateTime, number } from "../lib/format";
import { PageHeader } from "../navigation";

export function Deployments({
  busy,
  items,
  serviceVersion,
  onRefresh,
}: {
  busy: boolean;
  items: DmsApp[];
  serviceVersion: string;
  onRefresh: () => void;
}) {
  const [url, setUrl] = useState("");
  const [checksum, setChecksum] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [jobs, setJobs] = useState<Array<{id: string; app?: string; status: string; error?: string}>>([]);
  const [connected, setConnected] = useState(false);
  const [plan, setPlan] = useState<{metadata?: {name?: string; version?: string}; app: string; artifacts: Array<{source: string; destination: string; preserve?: boolean}>; healthcheck: {url: string}; nginx: {hosts?: Array<{host: string}>; remove_hosts?: string[]}} | null>(null);
  const refreshJobs = async () => {
    try {
      const res = await fetch("/api/dms/jobs");
      if (!res.ok) { setConnected(false); return; }
      const data = await res.json(); setJobs(data.items || []); setConnected(true);
    } catch { setConnected(false); }
  };
  useEffect(() => {
    void refreshJobs();
    const timer = window.setInterval(() => { void refreshJobs(); }, 3000);
    return () => window.clearInterval(timer);
  }, []);
  const submit = async (dryRun: boolean) => {
    setWorking(true); setMessage(""); setPlan(null);
    try {
      const endpoint = file ? `/api/dms/packages${dryRun ? "?dry_run=true" : ""}` : "/api/dms/install";
      const res = await fetch(endpoint, {method: "POST", headers: {"Content-Type": file ? "application/gzip" : "application/json"}, body: file || JSON.stringify({url, sha256: checksum, dry_run: dryRun})});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (dryRun) setPlan(data.plan);
      setMessage(dryRun ? `Пакет проверен: ${data.plan.metadata?.name || data.plan.app}. Артефактов: ${data.plan.artifacts?.length || 0}.` : `Операция ${data.id} принята. Результат появится в журнале.`);
      await refreshJobs(); onRefresh();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Ошибка установки"); }
    finally { setWorking(false); }
  };
  const restore = async (app: string, release: string) => {
    if (!window.confirm(`Восстановить ${app} из релиза ${release}? Сервис будет перезапущен.`)) return;
    setWorking(true);
    try {
      const res = await fetch("/api/dms/rollback", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({app, release})});
      const data = await res.json(); if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMessage(`Восстановление принято: ${data.id}`); await refreshJobs();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Ошибка восстановления"); }
    finally { setWorking(false); }
  };
  const withMetadata = items.filter((item) => item.metadata).length;
  const releases = items.reduce((sum, item) => sum + item.release_count, 0);
  const hosts = items.reduce((sum, item) => sum + (item.hosts?.length || 0), 0);

  return (
    <div className="stack">
      <PageHeader
        page="dms"
        actions={
          <button type="button" className="btn" onClick={onRefresh} disabled={busy}>
            <Icon name="refresh" />
            Обновить
          </button>
        }
      />
      <section className="card">
        <div className="card-header"><h2>Установить приложение</h2><span className={`badge ${connected ? "badge-success" : "badge-warning"}`}>{connected ? "DMS подключён" : "DMS API недоступен"}</span></div>
        <div className="card-body stack">
          <p className="muted">Готовый пакет с описанием приложения. Перед установкой можно проверить пакет; установка перезапустит его сервис.</p>
          <label className="field"><span className="field-label">URL пакета (HTTPS)</span><input className="input" value={url} disabled={!!file} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/…/app.dms.tar.gz" /></label>
          <label className="field"><span className="field-label">SHA256 из доверенного источника релиза</span><input className="input mono" value={checksum} disabled={!!file} onChange={(e) => setChecksum(e.target.value)} placeholder="64 символа" /></label>
          <label className="field"><span className="field-label">Или архив с компьютера</span><input type="file" accept=".gz,.tgz" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
          <div className="actions"><button className="btn" disabled={!connected || working || (!file && (!url || !checksum))} onClick={() => void submit(true)}>Проверить пакет</button> <button className="btn btn-primary" disabled={!connected || working || (!file && (!url || !checksum))} onClick={() => { if (window.confirm("Установить пакет и перезапустить его сервис?")) void submit(false); }}>Установить</button></div>
          {message && <p role="status">{message}</p>}
          {plan && <div className="stack"><h3>{plan.metadata?.name || plan.app} {plan.metadata?.version || ""}</h3><p>Проверка здоровья: <code>{plan.healthcheck.url || "не задана"}</code></p><p>Домены: {plan.nginx.hosts?.map((host) => host.host).join(", ") || "существующие маршруты сохраняются"}</p>{!!plan.nginx.remove_hosts?.length && <p>Удаляемые домены: {plan.nginx.remove_hosts.join(", ")}</p>}<ul>{plan.artifacts.map((artifact) => <li key={artifact.destination}><code>{artifact.source}</code> → <code>{artifact.destination}</code>{artifact.preserve ? " · сохранить существующий файл" : ""}</li>)}</ul></div>}
        </div>
      </section>
      {jobs.length > 0 && <section className="card"><div className="card-header"><h2>Операции</h2></div><div className="card-body stack">{jobs.slice(0, 10).map((job) => <div key={job.id}><strong>{job.app || "Пакет"}</strong> — {job.status}<div className="muted mono">{job.id}</div>{job.error && <p role="alert">{job.error}</p>}</div>)}</div></section>}
      <div className="stats">
        <article className="card stat">
          <span className="stat-label">
            <Icon name="dms" />
            Сервисы
          </span>
          <strong className="stat-value">{number(items.length)}</strong>
          <span className="stat-meta">С полными метаданными: {number(withMetadata)}</span>
        </article>
        <article className="card stat">
          <span className="stat-label">
            <Icon name="layers" />
            Релизы
          </span>
          <strong className="stat-value">{number(releases)}</strong>
          <span className="stat-meta">Хранятся на роутере</span>
        </article>
        <article className="card stat">
          <span className="stat-label">
            <Icon name="globe" />
            Домены
          </span>
          <strong className="stat-value">{number(hosts)}</strong>
          <span className="stat-meta">Из манифестов DMS</span>
        </article>
        <article className="card stat">
          <span className="stat-label">
            <Icon name="terminal" />
            Сервис DMS
          </span>
          <strong className="stat-value mono dms-version">{serviceVersion || "—"}</strong>
          <span className="stat-meta mono">/opt/bin/dms-service</span>
        </article>
      </div>

      {items.length ? (
        <div className="grid-auto">
          {items.map((item) => (
            <article className="card" key={item.app}>
              <div className="card-header">
                <div className="card-title">
                  <h2 className="break">{item.name || item.app}{item.version ? ` · ${item.version}` : ""}</h2>
                  {item.icon_data?.startsWith("data:image/") && <img src={item.icon_data} alt="" width={32} height={32} />}
                  {item.description && <p>{item.description}</p>}
                  <p>{item.manifest_version ? `Манифест v${item.manifest_version}` : "Старые метаданные"}</p>
                </div>
                <span className={`badge ${item.metadata ? "badge-success" : "badge-warning"}`}>
                  {item.status || "managed"}
                </span>
              </div>
              <div className="card-body stack">
                {!!item.releases?.length && connected && <label className="field"><span className="field-label">Восстановить релиз</span><select className="input" defaultValue="" disabled={working} onChange={(e) => { if (e.target.value) void restore(item.app, e.target.value); e.target.value = ""; }}><option value="">Выберите релиз…</option>{item.releases.filter((id) => id !== item.release_id).map((id) => <option key={id} value={id}>{id}</option>)}</select></label>}
                <div className="release">
                  <span className="field-label">Текущий релиз</span>
                  <strong className="mono break">{item.release_id || "—"}</strong>
                </div>
                <dl className="kv">
                  <div>
                    <dt>Развёрнут</dt>
                    <dd>{item.applied_at ? dateTime(item.applied_at) : "—"}</dd>
                  </div>
                  <div>
                    <dt>Релизов</dt>
                    <dd>{number(item.release_count)}</dd>
                  </div>
                  <div>
                    <dt>Init-сервис</dt>
                    <dd className="mono">{item.service_init_name || "—"}</dd>
                  </div>
                  <div>
                    <dt>Проверка здоровья</dt>
                    <dd className="mono">{item.healthcheck_url || "—"}</dd>
                  </div>
                </dl>
                <div className="field">
                  <span className="field-label">Домены</span>
                  {item.hosts?.length ? (
                    <div className="chip-list">
                      {item.hosts.map((host) => (
                        <span className="chip chip-wrap" key={host}>
                          {host}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">Нет</span>
                  )}
                </div>
                <div className="field">
                  <span className="field-label">Артефакты</span>
                  {item.artifacts?.length ? (
                    <div className="chip-list">
                      {item.artifacts.map((artifact) => (
                        <code className="chip chip-wrap" key={artifact}>
                          {artifact}
                        </code>
                      ))}
                    </div>
                  ) : (
                    <span className="field-hint">Повторное развёртывание через DMS добавит полные метаданные.</span>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="card">
          <EmptyState icon="dms" title="Сервисов под управлением DMS нет">
            Развёртывания появятся после установки приложений через Deploy Management System.
          </EmptyState>
        </section>
      )}
    </div>
  );
}
