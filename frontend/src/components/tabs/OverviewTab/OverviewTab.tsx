import type { ConfigItem, NginxStatus } from "../../../types";
import "./OverviewTab.scss";
import { Button, CardIconActions, FieldLabel, Panel } from "../../ui";
import { useI18n } from "../../../i18n";

type Props = {
  busy: boolean;
  status: NginxStatus | null;
  configs: ConfigItem[];
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
  status,
  configs,
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
  return (
    <section className="tab-section overview-tab">
      <div className="section-head">
        <h2>{t("overview.title")}</h2>
        <Button iconName="refresh" onClick={onRefresh} disabled={busy}>{t("common.refresh")}</Button>
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
              {(status?.parsed_listeners || []).map((item, idx) => (
                <span key={`${item.ip}-${item.port}-${idx}`} className="chip chip-token chip-token--soft">{item.scheme} {item.ip}:{item.port}</span>
              ))}
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

        <Panel className="panel panel-full">
          <h3>{t("overview.configs")}</h3>
          <div className="cfg-grid">
            {configs.map((cfg) => (
              <div key={cfg.id} className="cfg-card">
                <strong>{cfg.title}</strong>
                <p className="mono">{cfg.path}</p>
                <div className="chips">
                  <span className="chip chip-token chip-token--soft">{cfg.type}</span>
                  <span className="chip chip-token chip-token--soft">{cfg.exists ? t("overview.exists") : t("overview.missing")}</span>
                  <span className="chip chip-token chip-token--soft">{cfg.size} B</span>
                </div>
                <div className="actions-row">
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
