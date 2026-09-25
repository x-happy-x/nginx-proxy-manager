import type { DmsApp } from "../types";
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
                  <h2 className="break">{item.app}</h2>
                  <p>{item.manifest_version ? `Манифест v${item.manifest_version}` : "Старые метаданные"}</p>
                </div>
                <span className={`badge ${item.metadata ? "badge-success" : "badge-warning"}`}>
                  {item.status || "managed"}
                </span>
              </div>
              <div className="card-body stack">
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
