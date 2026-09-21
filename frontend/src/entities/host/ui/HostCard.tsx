import type { RouteApp, RouteHost } from "../../../types";
import { useI18n } from "../../../i18n";
import { Button, CardIconActions } from "../../../components/ui";
import { getNdnsEndpoint, getWebEndpoint } from "../../../features/servers/lib/utils";

type Props = {
  host: RouteHost;
  idx: number;
  apps: RouteApp[];
  busy: boolean;
  onEdit: () => void;
  onDelete: (title: string) => void;
};

export function HostCard({ host, idx, apps, busy, onEdit, onDelete }: Props) {
  const { t } = useI18n();
  const web = getWebEndpoint(host);
  const ndns = getNdnsEndpoint(host);
  const title = host.host || `Host ${idx + 1}`;
  const app = apps.find((item) => item.id === host.app_id);

  return (
    <article className="card-item server-card server-card--host is-view">
      <header className="server-card-head">
        <div className="server-card-title">
          <strong>{title}</strong>
          <span className="muted">{app?.name || host.app_id || "-"}</span>
        </div>
        <div className="actions-row no-wrap">
          <CardIconActions
            actions={[
              {
                iconName: "edit",
                tooltip: t("common.edit"),
                onClick: onEdit,
                disabled: busy,
              },
              {
                iconName: "trash",
                tooltip: t("common.remove"),
                onClick: () => onDelete(title),
                disabled: busy,
              },
            ]}
          />
        </div>
      </header>

      <div className="mode-pane mode-pane--view">
        <div className="summary-row">
          <Button className="summary-chip chip-token chip-token--interactive" variant="ghost" compact onClick={onEdit}>
            <strong className="summary-chip__value">{web?.listen?.protocol || "https"}:{String(web?.listen?.port || 443)}</strong>
          </Button>
          {ndns ? (
            <span className="summary-chip chip-token">
              <strong className="summary-chip__value">ndns:{String(ndns.listen?.port || "auto_random")}</strong>
            </span>
          ) : null}
        </div>
        <div className="compact-summary">
          <div className="summary-item">
            <span className="muted">{t("servers.kind")}</span>
            <strong>{host.kind || "-"}</strong>
          </div>
          <div className="summary-item">
            <span className="muted">{t("servers.tls_policy")}</span>
            <strong>{host.tls?.cert_policy || "-"}</strong>
          </div>
          <div className="summary-item">
            <span className="muted">{t("servers.app")}</span>
            <strong>{app?.name || host.app_id || "-"}</strong>
          </div>
        </div>
      </div>
    </article>
  );
}
