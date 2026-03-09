import type { RouteApp, RouteHost } from "../../../types";
import { useI18n } from "../../../i18n";
import { CardIconActions, CheckboxChip, FieldLabel, RadioChips } from "../../../components/ui";
import { clone, getInitials, getNdnsEndpoint, getWebEndpoint, updateHost } from "../../../features/servers/lib/utils";

type Props = {
  host: RouteHost;
  idx: number;
  apps: RouteApp[];
  editing: boolean;
  busy: boolean;
  onSetMode: (mode: "view" | "edit") => void;
  onUpdateHost: (updater: (current: RouteHost) => RouteHost) => void;
  onDelete: (title: string) => void;
};

export function HostCard({ host, idx, apps, editing, busy, onSetMode, onUpdateHost, onDelete }: Props) {
  const { t } = useI18n();
  const web = getWebEndpoint(host);
  const ndns = getNdnsEndpoint(host);
  const localDnsOn = (host.dns?.publish || []).includes("local");
  const ndnsOn = !!ndns;
  const title = host.host || `Host ${idx + 1}`;

  return (
    <article className={["card-item", "server-card", editing ? "is-edit" : "is-view"].join(" ")}>
      <header className="server-card-head">
        <div className="server-avatar host-avatar">
          <span>{getInitials(title)}</span>
        </div>
        <div className="server-card-title">
          <strong>{title}</strong>
          <span className="muted">{host.app_id || "-"}</span>
        </div>
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
            <FieldLabel text={t("servers.host")}>
              <input value={host.host || ""} onChange={(e) => onUpdateHost((current) => ({ ...current, host: e.target.value }))} />
            </FieldLabel>

            <div className="row-2">
              <FieldLabel text={t("servers.kind")}>
                <select value={host.kind || "private"} onChange={(e) => onUpdateHost((current) => ({ ...current, kind: e.target.value as "private" | "public" }))}>
                  <option value="private">{t("common.private")}</option>
                  <option value="public">{t("common.public")}</option>
                </select>
              </FieldLabel>
              <FieldLabel text={t("servers.app")}>
                <select value={host.app_id || ""} onChange={(e) => onUpdateHost((current) => ({ ...current, app_id: e.target.value }))}>
                  {apps.map((app) => (
                    <option key={app.id} value={app.id}>{app.name || app.id}</option>
                  ))}
                </select>
              </FieldLabel>
            </div>

            <div className="row-2">
              <FieldLabel text={t("servers.tls_policy")}>
                <select
                  value={host.tls?.cert_policy || "auto_local_ca"}
                  onChange={(e) =>
                    onUpdateHost((current) =>
                      updateHost(
                        {
                          ...current,
                          tls: {
                            ...(current.tls || { cert_ref: "auto", san: [] }),
                            cert_policy: e.target.value as "auto_local_ca" | "auto_acme" | "self_signed" | "off",
                          },
                        },
                        {},
                      ),
                    )
                  }
                >
                  <option value="auto_local_ca">{t("servers.tls_local_ca")}</option>
                  <option value="auto_acme">{t("servers.tls_acme")}</option>
                  <option value="self_signed">{t("servers.tls_self_signed")}</option>
                  <option value="off">{t("servers.tls_off")}</option>
                </select>
              </FieldLabel>
              <FieldLabel text={t("servers.redirect")}>
                <select
                  value={(web?.behavior?.redirect as string) || "https"}
                  onChange={(e) => onUpdateHost((current) => updateHost(current, { redirect: e.target.value as "https" | "http" | "off" }))}
                >
                  <option value="https">{t("common.https")}</option>
                  <option value="http">{t("common.http")}</option>
                  <option value="off">{t("servers.tls_off")}</option>
                </select>
              </FieldLabel>
            </div>

            <FieldLabel text={t("servers.san")}>
              <input
                value={(host.tls?.san || []).join(", ")}
                onChange={(e) =>
                  onUpdateHost((current) => ({
                    ...current,
                    tls: {
                      ...(current.tls || { cert_policy: "auto_local_ca", cert_ref: "auto", san: [] }),
                      san: e.target.value.split(",").map((v) => v.trim()).filter(Boolean),
                    },
                  }))
                }
              />
            </FieldLabel>

            <div className="toggles">
              <CheckboxChip checked={localDnsOn} onChange={(next) => onUpdateHost((current) => ({ ...current, dns: { ...(current.dns || { publish: [] }), publish: next ? ["local"] : [] } }))} label={t("servers.local_dns")} />
              <CheckboxChip checked={ndnsOn} onChange={(next) => onUpdateHost((current) => updateHost(current, { ndnsEnabled: next }))} label={t("servers.ndns")} />
              <CheckboxChip checked={!!host.verify_upstream_ssl} onChange={(next) => onUpdateHost((current) => ({ ...current, verify_upstream_ssl: next }))} label={t("servers.verify_upstream_ssl")} />
            </div>

            {localDnsOn ? (
              <FieldLabel text={t("servers.local_record_ip")}>
                <input value={host.dns?.local_record_ip || "auto"} onChange={(e) => onUpdateHost((current) => ({ ...current, dns: { ...(current.dns || { publish: ["local"] }), local_record_ip: e.target.value } }))} />
              </FieldLabel>
            ) : null}

            {ndnsOn ? (
              <div className="ndns-grid">
                <FieldLabel text={t("servers.name")}>
                  <input
                    value={ndns?.behavior?.ndns_name ? String(ndns.behavior.ndns_name) : ""}
                    onChange={(e) =>
                      onUpdateHost((current) => {
                        const draft = updateHost(current, { ndnsEnabled: true });
                        const endpoint = getNdnsEndpoint(draft);
                        if (endpoint) endpoint.behavior.ndns_name = e.target.value;
                        return clone(draft);
                      })
                    }
                  />
                </FieldLabel>
                <FieldLabel text={t("servers.domain")}>
                  <input
                    value={ndns?.behavior?.ndns_domain ? String(ndns.behavior.ndns_domain) : "ndns"}
                    onChange={(e) =>
                      onUpdateHost((current) => {
                        const draft = updateHost(current, { ndnsEnabled: true });
                        const endpoint = getNdnsEndpoint(draft);
                        if (endpoint) endpoint.behavior.ndns_domain = e.target.value;
                        return clone(draft);
                      })
                    }
                  />
                </FieldLabel>
                <FieldLabel text={t("servers.target")}>
                  <input
                    value={ndns?.behavior?.ndns_target_ip ? String(ndns.behavior.ndns_target_ip) : "auto"}
                    onChange={(e) =>
                      onUpdateHost((current) => {
                        const draft = updateHost(current, { ndnsEnabled: true });
                        const endpoint = getNdnsEndpoint(draft);
                        if (endpoint) endpoint.behavior.ndns_target_ip = e.target.value;
                        return clone(draft);
                      })
                    }
                  />
                </FieldLabel>
                <FieldLabel text={t("servers.port")}>
                  <input
                    value={String(ndns?.listen?.port || "auto_random")}
                    onChange={(e) =>
                      onUpdateHost((current) => {
                        const draft = updateHost(current, { ndnsEnabled: true });
                        const endpoint = getNdnsEndpoint(draft);
                        if (endpoint) endpoint.listen.port = Number(e.target.value) || "auto_random";
                        return clone(draft);
                      })
                    }
                  />
                </FieldLabel>
              </div>
            ) : null}
          </>
        ) : (
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
              <strong>{host.app_id || "-"}</strong>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
