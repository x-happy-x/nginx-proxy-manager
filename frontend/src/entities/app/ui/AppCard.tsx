import type { RouteApp } from "../../../types";
import { useI18n } from "../../../i18n";
import { Button, CardIconActions, FieldLabel, IconButton, RadioChips } from "../../../components/ui";
import { getInitials, readFileAsDataUrl } from "../../../features/servers/lib/utils";

type Props = {
  app: RouteApp;
  idx: number;
  editing: boolean;
  busy: boolean;
  dirty: boolean;
  onSetMode: (mode: "view" | "edit") => void;
  onUpdateApp: (updater: (current: RouteApp) => RouteApp) => void;
  onDelete: (title: string) => void;
};

export function AppCard({ app, idx, editing, busy, dirty, onSetMode, onUpdateApp, onDelete }: Props) {
  const { t } = useI18n();
  const iconId = `app-icon-${idx}`;
  const title = app.name || app.id || `App ${idx + 1}`;
  const iconUrl = String(app.ui?.icon_data_url || "");

  return (
    <article className={["card-item", "server-card", editing ? "is-edit" : "is-view"].join(" ")}>
      <header className="server-card-head">
        <div className={["server-avatar", editing ? "editable" : ""].join(" ")}>
          {iconUrl ? <img src={iconUrl} alt="" /> : <span>{getInitials(title)}</span>}
          {editing ? (
            <div className="avatar-overlay">
              <IconButton iconName="upload" iconOnly tooltip={t("common.upload")} onClick={() => document.getElementById(iconId)?.click()} disabled={busy} />
              <IconButton
                iconName="trash"
                iconOnly
                tooltip={t("common.delete")}
                disabled={busy || !iconUrl}
                onClick={() => onUpdateApp((current) => ({ ...current, ui: { ...(current.ui || {}), icon_data_url: "" } }))}
              />
            </div>
          ) : null}
          <input
            id={iconId}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const dataUrl = await readFileAsDataUrl(file);
              onUpdateApp((current) => ({ ...current, ui: { ...(current.ui || {}), icon_data_url: dataUrl } }));
              e.currentTarget.value = "";
            }}
          />
        </div>
        {editing ? (
          <div className="server-card-edit-head">
            <input value={app.name || ""} onChange={(e) => onUpdateApp((current) => ({ ...current, name: e.target.value }))} placeholder={t("servers.name")} />
            <input value={app.id || ""} onChange={(e) => onUpdateApp((current) => ({ ...current, id: e.target.value }))} placeholder={t("servers.id")} />
          </div>
        ) : (
          <div className="server-card-title">
            <strong>{title}</strong>
            <span className="muted">{app.id || "-"}</span>
          </div>
        )}
        <div className="actions-row no-wrap">
          <CardIconActions
            actions={[
              {
                iconName: editing ? "close" : "edit",
                tooltip: editing ? t("common.cancel") : t("common.edit"),
                onClick: () => onSetMode(editing ? "view" : "edit"),
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

      <div className={["mode-pane", editing ? "mode-pane--edit" : "mode-pane--view"].join(" ")}>
        {editing ? (
          <>
            <FieldLabel text={t("servers.upstream_address")}>
              <input value={app.upstream.address || ""} onChange={(e) => onUpdateApp((current) => ({ ...current, upstream: { ...current.upstream, address: e.target.value } }))} />
            </FieldLabel>
            <div className="row-2">
              <FieldLabel text={t("servers.port")}>
                <input
                  type="number"
                  value={app.upstream.port || 80}
                  onChange={(e) => onUpdateApp((current) => ({ ...current, upstream: { ...current.upstream, port: Number(e.target.value) || 80 } }))}
                />
              </FieldLabel>
              <FieldLabel text={t("servers.scheme")}>
                <RadioChips
                  value={app.upstream.scheme || "http"}
                  onChange={(next) => onUpdateApp((current) => ({ ...current, upstream: { ...current.upstream, scheme: next } }))}
                  options={[
                    { value: "http", label: t("common.http") },
                    { value: "https", label: t("common.https") },
                  ]}
                />
              </FieldLabel>
            </div>
          </>
        ) : (
          <div className="summary-row">
            {dirty ? <span className="unsaved-badge chip-token chip-token--warning">{t("common.unsaved")}</span> : null}
            <Button className="summary-chip summary-chip--app chip-token chip-token--interactive" variant="ghost" compact onClick={() => onSetMode("edit")}>
              <strong className="summary-chip__value">
                {app.upstream.address ? `${app.upstream.scheme}:${app.upstream.address}:${app.upstream.port || 80}` : "-"}
              </strong>
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
