import type { CertItem, ConfigItem, DnsHostItem, NginxStatus, RoutesDocument } from "../../../types";
import "./OverviewTab.scss";
import { Button, CardIconActions, FieldLabel, Panel } from "../../ui";
import { useI18n } from "../../../i18n";

type Props = {
  busy: boolean;
  doc: RoutesDocument;
  status: NginxStatus | null;
  configs: ConfigItem[];
  certs: CertItem[];
  dnsItems: DnsHostItem[];
  ndnsText: string;
  routeFiles: string[];
  activeRouteFile: string;
  selectedRouteFile: string;
  onSelectedRouteFileChange: (value: string) => void;
  onRefresh: () => void;
  onUseRouteFile: () => void;
  onBackupRouteFile: () => void;
  onOpenConfig: (id: string, editable: boolean) => void;
};

export function OverviewTab({
  busy,
  doc,
  status,
  configs,
  certs,
  dnsItems,
  ndnsText,
  routeFiles,
  activeRouteFile,
  selectedRouteFile,
  onSelectedRouteFileChange,
  onRefresh,
  onUseRouteFile,
  onBackupRouteFile,
  onOpenConfig,
}: Props) {
  const { t } = useI18n();
  const privateHosts = doc.hosts.filter((host) => host.kind === "private").length;
  const publicHosts = doc.hosts.filter((host) => host.kind === "public").length;
  const httpEndpoints = doc.hosts.flatMap((host) => host.endpoints || []).filter((endpoint) => endpoint.listen.protocol === "http").length;
  const httpsEndpoints = doc.hosts.flatMap((host) => host.endpoints || []).filter((endpoint) => endpoint.listen.protocol === "https").length;
  const existingConfigs = configs.filter((cfg) => cfg.exists).length;
  const missingConfigs = configs.filter((cfg) => !cfg.exists).length;
  const uniqueListeners = Array.from(
    new Map(
      (status?.parsed_listeners || []).map((item) => [
        `${item.scheme}:${item.ip}:${item.port}`,
        item,
      ]),
    ).values(),
  );

  return (
    <section className="tab-section overview-tab">
      <div className="section-head">
        <h2>{t("overview.title")}</h2>
        <Button iconName="refresh" onClick={onRefresh} disabled={busy}>{t("common.refresh")}</Button>
      </div>

      <div className="summary-grid">
        <Panel className="panel summary-card">
          <span className="summary-card__label">{t("overview.routes_total")}</span>
          <strong>{doc.hosts.length}</strong>
          <small>{doc.apps.length} {t("overview.apps_count")}</small>
        </Panel>
        <Panel className="panel summary-card">
          <span className="summary-card__label">{t("overview.private_public")}</span>
          <strong>{privateHosts} / {publicHosts}</strong>
          <small>{t("common.private")} / {t("common.public")}</small>
        </Panel>
        <Panel className="panel summary-card">
          <span className="summary-card__label">{t("overview.cert_coverage")}</span>
          <strong>{certs.length}</strong>
          <small>{doc.globals.ssl_mode}</small>
        </Panel>
        <Panel className="panel summary-card">
          <span className="summary-card__label">{t("overview.config_health")}</span>
          <strong>{existingConfigs}/{configs.length}</strong>
          <small>{missingConfigs} {t("overview.missing")}</small>
        </Panel>
      </div>

      <div className="panel-grid">
        <Panel className="panel">
          <h3>{t("overview.nginx_runtime")}</h3>
          {status ? (
            <div className="kv">
              <span>{t("overview.running")}</span>
              <b>{status.running ? t("overview.yes") : t("overview.no")}</b>
              <span>{t("overview.version")}</span>
              <b>{status.version || "-"}</b>
              <span>{t("overview.pids")}</span>
              <b>{status.pids.join(", ") || "-"}</b>
              <span>{t("overview.rss")}</span>
              <b>{status.rss_kb ? `${status.rss_kb} KB` : "-"}</b>
            </div>
          ) : (
            <p className="muted">{t("overview.no_data")}</p>
          )}
        </Panel>

        <Panel className="panel">
          <h3>{t("overview.listen_endpoints")}</h3>
          <div className="chips">
            {uniqueListeners.map((item) => (
              <span key={`${item.scheme}-${item.ip}-${item.port}`} className="chip chip-token chip-token--soft">{item.scheme} {item.ip}:{item.port}</span>
            ))}
          </div>
          <div className="inline-stats">
            <span>{t("common.http")}: <b>{httpEndpoints}</b></span>
            <span>{t("common.https")}: <b>{httpsEndpoints}</b></span>
          </div>
        </Panel>

        <Panel className="panel">
          <h3>{t("overview.routes_file")}</h3>
          <FieldLabel text={t("overview.active_routes_file")}>
            <select value={selectedRouteFile} onChange={(e) => onSelectedRouteFileChange(e.target.value)}>
              {routeFiles.map((path) => (
                <option key={path} value={path}>{path}</option>
              ))}
            </select>
          </FieldLabel>
          <div className="actions-row">
            <Button iconName="overview" onClick={onUseRouteFile} disabled={busy}>{t("overview.use_selected")}</Button>
            <Button iconName="save" onClick={onBackupRouteFile} disabled={busy}>{t("common.backup")}</Button>
          </div>
          <p className="mono">{t("overview.active")}: {activeRouteFile || "-"}</p>
        </Panel>

        <Panel className="panel">
          <h3>{t("overview.bind_and_ssl")}</h3>
          <div className="kv">
            <span>{t("overview.ui_bind")}</span>
            <b>{doc.globals.ui.host}:{doc.globals.ui.port}</b>
            <span>{t("overview.ssl_mode")}</span>
            <b>{doc.globals.ssl_mode}</b>
            <span>{t("overview.acme_email")}</span>
            <b>{doc.globals.acme.email || "-"}</b>
            <span>{t("overview.listen_ips")}</span>
            <b>{doc.globals.listen_ips.join(", ") || "-"}</b>
          </div>
        </Panel>

        <Panel className="panel">
          <h3>{t("overview.network_snapshot")}</h3>
          <div className="kv">
            <span>DNS</span>
            <b>{dnsItems.length}</b>
            <span>NDNS</span>
            <b>{ndnsText}</b>
            <span>{t("overview.stub_enabled")}</span>
            <b>{doc.globals.stub.enabled ? t("overview.yes") : t("overview.no")}</b>
          </div>
        </Panel>

        <Panel className="panel">
          <h3>{t("overview.route_topology")}</h3>
          <div className="kv">
            <span>{t("overview.apps_count")}</span>
            <b>{doc.apps.length}</b>
            <span>{t("overview.hosts_count")}</span>
            <b>{doc.hosts.length}</b>
            <span>{t("overview.http_ports")}</span>
            <b>{[doc.globals.ports.http, ...doc.globals.ports.http_extra].join(", ") || "-"}</b>
            <span>{t("overview.https_ports")}</span>
            <b>{[doc.globals.ports.https, ...doc.globals.ports.https_extra].join(", ") || "-"}</b>
          </div>
        </Panel>

        <Panel className="panel panel-full">
          <h3>{t("overview.configs")}</h3>
          <div className="cfg-list">
            <div className="cfg-list__head">
              <span>Name</span>
              <span>Path</span>
              <span>Meta</span>
              <span>Actions</span>
            </div>
            {configs.map((cfg) => (
              <div key={cfg.id} className="cfg-row">
                <strong>{cfg.title}</strong>
                <p className="mono">{cfg.path}</p>
                <div className="chips cfg-row__meta">
                  <span className="chip chip-token chip-token--soft">{cfg.type}</span>
                  <span className="chip chip-token chip-token--soft">{cfg.exists ? t("overview.exists") : t("overview.missing")}</span>
                  <span className="chip chip-token chip-token--soft">{cfg.size} B</span>
                </div>
                <div className="cfg-row__actions">
                  <CardIconActions
                    actions={[
                      { iconName: "file", tooltip: t("common.open"), onClick: () => onOpenConfig(cfg.id, false) },
                      { iconName: "edit", tooltip: t("common.edit"), onClick: () => onOpenConfig(cfg.id, true), disabled: !cfg.editable },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </section>
  );
}
