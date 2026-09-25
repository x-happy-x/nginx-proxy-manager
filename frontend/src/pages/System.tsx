import type { CertItem, ConfigItem, NginxStatus, RoutesDocument } from "../types";
import { Icon } from "../components/ui/Icon";
import { EmptyState, Field } from "../components/ui/controls";
import { bytes, count, dateTime, nginxVersion, number } from "../lib/format";
import { PageHeader } from "../navigation";
import { StatusBadge } from "./Dashboard";

type Props = {
  busy: boolean;
  doc: RoutesDocument;
  status: NginxStatus | null;
  configs: ConfigItem[];
  certs: CertItem[];
  dnsCount: number;
  ndnsCount: number;
  routeFiles: string[];
  activeRouteFile: string;
  selectedRouteFile: string;
  onSelectedRouteFileChange: (value: string) => void;
  onRefresh: () => void;
  onUseRouteFile: () => void;
  onBackupRouteFile: () => void;
  onOpenConfig: (id: string, editable: boolean) => void;
};

const SSL_LABELS: Record<string, string> = {
  acme: "ACME (Let's Encrypt)",
  "local-ca": "Локальный CA",
  "self-signed": "Самоподписанные",
  off: "Только HTTP",
};

export function System({
  busy,
  doc,
  status,
  configs,
  certs,
  dnsCount,
  ndnsCount,
  routeFiles,
  activeRouteFile,
  selectedRouteFile,
  onSelectedRouteFileChange,
  onRefresh,
  onUseRouteFile,
  onBackupRouteFile,
  onOpenConfig,
}: Props) {
  const privateHosts = doc.hosts.filter((host) => host.kind === "private").length;
  const publicHosts = doc.hosts.length - privateHosts;
  const missing = configs.filter((cfg) => !cfg.exists).length;
  const listeners = Array.from(
    new Map(
      (status?.parsed_listeners || []).map((item) => [`${item.scheme}:${item.ip}:${item.port}`, item]),
    ).values(),
  ).sort((a, b) => a.port - b.port || a.ip.localeCompare(b.ip));

  return (
    <div className="stack">
      <PageHeader
        page="system"
        actions={
          <button type="button" className="btn" onClick={onRefresh} disabled={busy}>
            <Icon name="refresh" />
            Обновить
          </button>
        }
      />

      <div className="stats">
        <article className="card stat">
          <span className="stat-label">
            <Icon name="route" />
            Маршруты
          </span>
          <strong className="stat-value">{number(doc.hosts.length)}</strong>
          <span className="stat-meta">{count(doc.apps.length, ["приложение", "приложения", "приложений"])}</span>
        </article>
        <article className="card stat">
          <span className="stat-label">
            <Icon name="globe" />
            Локальные / публичные
          </span>
          <strong className="stat-value">
            {privateHosts}
            <small>/ {publicHosts}</small>
          </strong>
          <span className="stat-meta">
            DNS-записей {number(dnsCount)}, входов KeenDNS {number(ndnsCount)}
          </span>
        </article>
        <article className="card stat">
          <span className="stat-label">
            <Icon name="certs" />
            Сертификаты
          </span>
          <strong className="stat-value">{number(certs.length)}</strong>
          <span className="stat-meta">{SSL_LABELS[doc.globals.ssl_mode] || doc.globals.ssl_mode}</span>
        </article>
        <article className="card stat">
          <span className="stat-label">
            <Icon name="file" />
            Конфигурационные файлы
          </span>
          <strong className={`stat-value${missing ? " text-warning" : ""}`}>
            {configs.length - missing}
            <small>/ {configs.length}</small>
          </strong>
          <span className="stat-meta">{missing ? `Отсутствует: ${missing}` : "Все на месте"}</span>
        </article>
      </div>

      <div className="grid-2 align-start">
        <section className="card">
          <div className="card-header">
            <div className="card-title">
              <h2>Процесс nginx</h2>
              <p>Выделенный master-процесс HomeNet</p>
            </div>
            <StatusBadge status={status} />
          </div>
          <div className="card-body">
            {status ? (
              <dl className="kv">
                <div>
                  <dt>Версия</dt>
                  <dd className="mono">{nginxVersion(status.version) || "—"}</dd>
                </div>
                <div>
                  <dt>PID</dt>
                  <dd className="mono">{status.pids.join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt>Память (RSS)</dt>
                  <dd>{status.rss_kb ? bytes(status.rss_kb * 1024) : "—"}</dd>
                </div>
                <div>
                  <dt>Прослушивание</dt>
                  <dd>
                    {listeners.length ? (
                      <div className="chip-list">
                        {listeners.map((item) => (
                          <span key={`${item.scheme}-${item.ip}-${item.port}`} className="chip">
                            {item.scheme} {item.ip}:{item.port}
                          </span>
                        ))}
                      </div>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="muted">Нет данных о процессе.</p>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div className="card-title">
              <h2>Параметры</h2>
              <p>Глобальные настройки из файла маршрутов</p>
            </div>
          </div>
          <div className="card-body">
            <dl className="kv">
              <div>
                <dt>Интерфейс менеджера</dt>
                <dd className="mono">
                  {doc.globals.ui.host}:{doc.globals.ui.port}
                </dd>
              </div>
              <div>
                <dt>IP прослушивания</dt>
                <dd className="mono">{doc.globals.listen_ips.join(", ") || "—"}</dd>
              </div>
              <div>
                <dt>Порты HTTP</dt>
                <dd className="mono">{[doc.globals.ports.http, ...doc.globals.ports.http_extra].join(", ")}</dd>
              </div>
              <div>
                <dt>Порты HTTPS</dt>
                <dd className="mono">{[doc.globals.ports.https, ...doc.globals.ports.https_extra].join(", ")}</dd>
              </div>
              <div>
                <dt>Политика TLS</dt>
                <dd>{SSL_LABELS[doc.globals.ssl_mode] || doc.globals.ssl_mode}</dd>
              </div>
              <div>
                <dt>Email ACME</dt>
                <dd>{doc.globals.acme.email || "—"}</dd>
              </div>
              <div>
                <dt>Сервер-заглушка</dt>
                <dd>{doc.globals.stub.enabled ? "Включён" : "Выключен"}</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-header">
          <div className="card-title">
            <h2>Файл маршрутов</h2>
            <p className="mono break">{activeRouteFile || "—"}</p>
          </div>
        </div>
        <div className="card-body route-file">
          <Field label="Файл для загрузки">
            <select value={selectedRouteFile} onChange={(e) => onSelectedRouteFileChange(e.target.value)}>
              {routeFiles.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </Field>
          <div className="button-row">
            <button
              type="button"
              className="btn"
              onClick={onUseRouteFile}
              disabled={busy || !selectedRouteFile || selectedRouteFile === activeRouteFile}
            >
              Использовать выбранный
            </button>
            <button type="button" className="btn btn-ghost" onClick={onBackupRouteFile} disabled={busy}>
              <Icon name="save" />
              Резервная копия
            </button>
          </div>
        </div>
      </section>

      <section className="card card-flush">
        <div className="card-header">
          <div className="card-title">
            <h2>
              Конфигурационные файлы<span className="count">{configs.length}</span>
            </h2>
            <p>Секретные ключи и карты сертификатов через редактор не выдаются</p>
          </div>
        </div>
        {configs.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Файл</th>
                  <th className="col-shrink">Тип</th>
                  <th className="col-num">Размер</th>
                  <th className="col-shrink">Изменён</th>
                  <th className="col-actions">
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {configs.map((cfg) => (
                  <tr key={cfg.id}>
                    <td className="cell-primary" data-label="">
                      <strong className="break">{cfg.title}</strong>
                      <span className="cell-sub mono break">{cfg.path}</span>
                    </td>
                    <td className="cell-aside col-shrink">
                      {cfg.exists ? <span className="badge">{cfg.type}</span> : <span className="badge badge-warning">нет файла</span>}
                    </td>
                    <td className="col-num" data-label="Размер">
                      {cfg.exists ? bytes(cfg.size) : "—"}
                    </td>
                    <td className="col-shrink secondary" data-label="Изменён">
                      {cfg.mtime ? dateTime(cfg.mtime * 1000) : "—"}
                    </td>
                    <td className="col-actions">
                      <div className="row-actions">
                        <button type="button" className="btn btn-sm" onClick={() => onOpenConfig(cfg.id, false)} disabled={!cfg.exists}>
                          <Icon name="file" size={14} />
                          Открыть
                        </button>
                        {cfg.editable ? (
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpenConfig(cfg.id, true)} disabled={!cfg.exists}>
                            <Icon name="edit" size={14} />
                            Изменить
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon="file" title="Файлы не найдены" />
        )}
      </section>
    </div>
  );
}
