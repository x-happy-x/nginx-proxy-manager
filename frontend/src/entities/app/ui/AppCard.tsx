import type { RouteApp } from "../../../types";
import { useI18n } from "../../../i18n";
import { Button, CardIconActions } from "../../../components/ui";
import { getInitials } from "../../../features/servers/lib/utils";

type Props = {
  app: RouteApp;
  idx: number;
  busy: boolean;
  dirty: boolean;
  hostCount: number;
  onEdit: () => void;
  onDelete: (title: string) => void;
};

export function AppCard({ app, idx, busy, dirty, hostCount, onEdit, onDelete }: Props) {
  const { t } = useI18n();
  const title = app.name || app.id || `App ${idx + 1}`;
  const iconUrl = String(app.ui?.icon_data_url || "");
  const upstream = app.upstream.address ? `${app.upstream.scheme}:${app.upstream.address}:${app.upstream.port || 80}` : "-";

  return (
    <article className="card-item server-card is-view">
      <header className="server-card-head">
        <div className="server-avatar">
          {iconUrl ? <img src={iconUrl} alt="" /> : <span>{getInitials(title)}</span>}
        </div>
        <div className="server-card-title">
          <strong>{title}</strong>
          <span className="muted">{app.id || "-"}</span>
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
          {dirty ? <span className="unsaved-badge chip-token chip-token--warning">{t("common.unsaved")}</span> : null}
          <Button className="summary-chip summary-chip--app chip-token chip-token--interactive" variant="ghost" compact onClick={onEdit}>
            <strong className="summary-chip__value">{upstream}</strong>
          </Button>
        </div>
        <div className="compact-summary">
          <div className="summary-item">
            <span className="muted">{t("servers.hosts")}</span>
            <strong>{hostCount}</strong>
          </div>
        </div>
      </div>
    </article>
  );
}
