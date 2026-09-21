import type { DmsApp } from "../../../types";
import { Button, Panel } from "../../ui";
import { useI18n } from "../../../i18n";
import "./DmsTab.scss";

type Props = {
  busy: boolean;
  items: DmsApp[];
  serviceVersion: string;
  onRefresh: () => void;
};

function formatDate(value: string | undefined, locale: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale === "ru" ? "ru-RU" : "en-US");
}

export function DmsTab({ busy, items, serviceVersion, onRefresh }: Props) {
  const { locale, t } = useI18n();
  const richMetadata = items.filter((item) => item.metadata).length;
  const releases = items.reduce((sum, item) => sum + item.release_count, 0);
  const hosts = items.reduce((sum, item) => sum + (item.hosts?.length || 0), 0);

  return (
    <section className="tab-section dms-tab">
      <div className="section-head">
        <div>
          <h2>{t("dms.title")}</h2>
          <p className="muted">{t("dms.subtitle")}</p>
        </div>
        <Button iconName="refresh" onClick={onRefresh} disabled={busy}>{t("common.refresh")}</Button>
      </div>

      <div className="dms-summary">
        <Panel className="panel dms-summary__card">
          <span>{t("dms.managed_apps")}</span>
          <strong>{items.length}</strong>
          <small>{richMetadata} {t("dms.with_metadata")}</small>
        </Panel>
        <Panel className="panel dms-summary__card">
          <span>{t("dms.releases")}</span>
          <strong>{releases}</strong>
          <small>{t("dms.on_router")}</small>
        </Panel>
        <Panel className="panel dms-summary__card">
          <span>{t("dms.published_hosts")}</span>
          <strong>{hosts}</strong>
          <small>{t("dms.from_manifests")}</small>
        </Panel>
        <Panel className="panel dms-summary__card">
          <span>{t("dms.service_version")}</span>
          <strong className="dms-summary__version">{serviceVersion || "-"}</strong>
          <small>/opt/bin/dms-service</small>
        </Panel>
      </div>

      <div className="dms-grid">
        {items.map((item) => (
          <Panel className="panel dms-card" key={item.app}>
            <div className="dms-card__head">
              <div>
                <span className="dms-card__eyebrow">DMS / {item.manifest_version ? `manifest v${item.manifest_version}` : t("dms.legacy_metadata")}</span>
                <h3>{item.app}</h3>
              </div>
              <span className={`chip-token ${item.metadata ? "chip-token--soft" : "chip-token--warning"}`}>
                {item.status || "managed"}
              </span>
            </div>

            <div className="dms-card__release">
              <span>{t("dms.current_release")}</span>
              <strong>{item.release_id || "-"}</strong>
            </div>

            <div className="kv">
              <span>{t("dms.applied_at")}</span>
              <b>{formatDate(item.applied_at, locale)}</b>
              <span>{t("dms.releases")}</span>
              <b>{item.release_count}</b>
              <span>{t("dms.init_service")}</span>
              <b>{item.service_init_name || "-"}</b>
              <span>{t("dms.healthcheck")}</span>
              <b className="mono">{item.healthcheck_url || "-"}</b>
            </div>

            <div className="dms-card__section">
              <span>{t("dms.hosts")}</span>
              <div className="chips">
                {(item.hosts || []).map((host) => <span className="chip chip-token chip-token--soft" key={host}>{host}</span>)}
                {!item.hosts?.length ? <small className="muted">{t("common.none")}</small> : null}
              </div>
            </div>

            <div className="dms-card__section">
              <span>{t("dms.artifacts")}</span>
              <div className="dms-card__artifacts">
                {(item.artifacts || []).map((artifact) => <code key={artifact}>{artifact}</code>)}
                {!item.artifacts?.length ? <small className="muted">{t("dms.deploy_again_hint")}</small> : null}
              </div>
            </div>
          </Panel>
        ))}
      </div>

      {!items.length ? <Panel className="panel dms-empty">{t("dms.empty")}</Panel> : null}
    </section>
  );
}
