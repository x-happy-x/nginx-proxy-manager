import { useState } from "react";
import type { RouteApp, RouteHost, RoutesDocument } from "../../../types";
import "./ServersTab.scss";
import { Button, CheckboxChip, FieldLabel, IconButton, ModalShell, RadioChips } from "../../ui";
import { useI18n } from "../../../i18n";
import { AppCard } from "../../../entities/app/ui/AppCard";
import { HostCard } from "../../../entities/host/ui/HostCard";
import { StubSettingsPanel } from "../../../features/stub-settings/ui/StubSettingsPanel";
import { DeleteConfirmModal } from "../../../features/delete-confirm/ui/DeleteConfirmModal";
import { clone, getNdnsEndpoint, getWebEndpoint, readFileAsDataUrl, updateHost } from "../../../features/servers/lib/utils";

type Props = {
  doc: RoutesDocument;
  busy: boolean;
  dirty: boolean;
  onChange: (next: RoutesDocument) => void;
  onApplyStub: () => void;
  onUploadStub: (content: string) => void;
  onRestartUi: () => void;
};

export function ServersTab({ doc, busy, dirty, onChange, onApplyStub, onUploadStub, onRestartUi }: Props) {
  const { t } = useI18n();
  const [activeEditor, setActiveEditor] = useState<{ type: "app" | "host"; idx: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "app" | "host"; idx: number; title: string } | null>(null);

  const setApps = (apps: RouteApp[]) => onChange({ ...doc, apps });
  const setHosts = (hosts: RouteHost[]) => onChange({ ...doc, hosts });

  const updateAppAt = (idx: number, updater: (current: RouteApp) => RouteApp) => {
    setApps(doc.apps.map((app, i) => (i === idx ? updater(app) : app)));
  };

  const updateHostAt = (idx: number, updater: (current: RouteHost) => RouteHost) => {
    setHosts(doc.hosts.map((host, i) => (i === idx ? updater(host) : host)));
  };

  const setGlobal = (patch: Partial<RoutesDocument["globals"]>) => {
    onChange({ ...doc, globals: { ...doc.globals, ...patch } });
  };

  const makeApp = (): RouteApp => {
    const idx = doc.apps.length + 1;
    return {
      id: `app-${idx}`,
      name: `App ${idx}`,
      upstream: { address: "", port: 80, scheme: "http" },
    };
  };

  const makeHost = (appId?: string): RouteHost => ({
    host: "",
    kind: "private",
    app_id: appId || doc.apps[0]?.id || "",
    verify_upstream_ssl: false,
    ws_proxy: { enabled: false, path: "/connections", rewrite_to_wss: false, rewrite_from: "" },
    dns: { publish: ["local"], local_record_ip: "auto" },
    tls: { cert_policy: "auto_local_ca", cert_ref: "auto", san: [] },
    endpoints: [{ name: "web", listen: { protocol: "https", port: doc.globals.ports.https || 443 }, behavior: { redirect: "https" } }],
  });

  const openAppEditor = (idx: number) => setActiveEditor({ type: "app", idx });
  const openHostEditor = (idx: number) => setActiveEditor({ type: "host", idx });

  const addApp = () => {
    const idx = doc.apps.length;
    setApps([...doc.apps, makeApp()]);
    openAppEditor(idx);
  };

  const addHost = (appId?: string) => {
    const idx = doc.hosts.length;
    setHosts([...doc.hosts, makeHost(appId)]);
    openHostEditor(idx);
  };

  const updateAppIdAt = (idx: number, nextId: string) => {
    const prevId = doc.apps[idx]?.id || "";
    onChange({ ...doc,
      apps: doc.apps.map((app,i) => i === idx ? {...app,id:nextId} : app),
      hosts: doc.hosts.map(host => host.app_id === prevId ? {...host,app_id:nextId} : host),
    });
  };

  const shiftActiveEditorAfterDelete = (type: "app" | "host", idx: number) => {
    setActiveEditor((current) => {
      if (!current || current.type !== type) return current;
      if (current.idx === idx) return null;
      if (current.idx > idx) return { ...current, idx: current.idx - 1 };
      return current;
    });
  };

  const confirmDelete = () => {
    if (!deleteConfirm) return;
    if (deleteConfirm.type === "app") {
      const idx = deleteConfirm.idx;
      onChange({...doc,apps:doc.apps.filter((_,i)=>i!==idx),hosts:doc.hosts.filter(host=>host.app_id!==doc.apps[idx].id)});
      shiftActiveEditorAfterDelete("app", idx);
    } else {
      setHosts(doc.hosts.filter((_, i) => i !== deleteConfirm.idx));
      shiftActiveEditorAfterDelete("host", deleteConfirm.idx);
    }
    setDeleteConfirm(null);
  };

  const activeApp = activeEditor?.type === "app" ? doc.apps[activeEditor.idx] : null;
  const activeHost = activeEditor?.type === "host" ? doc.hosts[activeEditor.idx] : null;
  const activeAppHosts = activeApp ? doc.hosts.map((host, idx) => ({ host, idx })).filter(({ host }) => host.app_id === activeApp.id) : [];
  const activeHostApp = activeHost ? doc.apps.find((app) => app.id === activeHost.app_id) || null : null;
  const appIconId = activeEditor?.type === "app" ? `app-icon-${activeEditor.idx}` : "app-icon";

  return (
    <section className="tab-section servers-tab">
      <div className="section-head">
        <h2>{t("servers.apps")}</h2>
        <IconButton iconName="plus" iconOnly tooltip={t("servers.add_app")} onClick={addApp} disabled={busy} />
      </div>
      <div className="grid-cards compact-grid">
        {doc.apps.map((app, idx) => {
          const title = app.name || app.id || `App ${idx + 1}`;
          return (
            <AppCard
              key={`${app.id}-${idx}`}
              app={app}
              idx={idx}
              busy={busy}
              dirty={dirty}
              hostCount={doc.hosts.filter((host) => host.app_id === app.id).length}
              onEdit={() => openAppEditor(idx)}
              onDelete={(nextTitle) => setDeleteConfirm({ type: "app", idx, title: nextTitle })}
            />
          );
        })}
      </div>

      <div className="section-head">
        <h2>{t("servers.hosts")}</h2>
        <IconButton iconName="plus" iconOnly tooltip={t("servers.add_host")} onClick={() => addHost()} disabled={busy} />
      </div>
      <div className="grid-cards compact-grid">
        {doc.hosts.map((host, idx) => {
          const title = host.host || `Host ${idx + 1}`;
          return (
            <HostCard
              key={`${host.host}-${idx}`}
              host={host}
              idx={idx}
              apps={doc.apps}
              busy={busy}
              onEdit={() => openHostEditor(idx)}
              onDelete={(nextTitle) => setDeleteConfirm({ type: "host", idx, title: nextTitle })}
            />
          );
        })}
      </div>

      <StubSettingsPanel doc={doc} busy={busy} onApplyStub={onApplyStub} onRestartUi={onRestartUi} onUploadStub={onUploadStub} onSetGlobal={setGlobal} />

      <ModalShell open={!!activeApp} onClose={() => setActiveEditor(null)} size="big">
        {activeApp ? (
          <div className="servers-editor-modal">
            <header className="servers-editor-modal__head">
              <div>
                <h3>{activeApp.name || activeApp.id || t("servers.add_app")}</h3>
                <p className="muted">{t("servers.apps")}</p>
              </div>
              <div className="servers-editor-modal__actions">
                <IconButton iconName="trash" iconOnly tooltip={t("common.remove")} onClick={() => setDeleteConfirm({ type: "app", idx: activeEditor!.idx, title: activeApp.name || activeApp.id || "" })} disabled={busy} />
                <IconButton iconName="close" iconOnly tooltip={t("common.close")} onClick={() => setActiveEditor(null)} />
              </div>
            </header>

            <section className="servers-editor-section">
              <div className="servers-editor-grid">
                <div className="server-avatar server-avatar--editor editable">
                  {activeApp.ui?.icon_data_url ? <img src={String(activeApp.ui.icon_data_url)} alt="" /> : <span>{(activeApp.name || activeApp.id || "AP").slice(0, 2).toUpperCase()}</span>}
                  <div className="avatar-overlay">
                    <IconButton iconName="upload" iconOnly tooltip={t("common.upload")} onClick={() => document.getElementById(appIconId)?.click()} disabled={busy} />
                    <IconButton
                      iconName="trash"
                      iconOnly
                      tooltip={t("common.delete")}
                      disabled={busy || !activeApp.ui?.icon_data_url}
                      onClick={() => updateAppAt(activeEditor!.idx, (current) => ({ ...current, ui: { ...(current.ui || {}), icon_data_url: "" } }))}
                    />
                  </div>
                  <input
                    id={appIconId}
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    hidden
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const dataUrl = await readFileAsDataUrl(file);
                      updateAppAt(activeEditor!.idx, (current) => ({ ...current, ui: { ...(current.ui || {}), icon_data_url: dataUrl } }));
                      e.currentTarget.value = "";
                    }}
                  />
                </div>
                <div className="row-2">
                  <FieldLabel text={t("servers.id")}>
                    <input value={activeApp.id || ""} onChange={(e) => updateAppIdAt(activeEditor!.idx, e.target.value)} />
                  </FieldLabel>
                  <FieldLabel text={t("servers.name")}>
                    <input value={activeApp.name || ""} onChange={(e) => updateAppAt(activeEditor!.idx, (current) => ({ ...current, name: e.target.value }))} />
                  </FieldLabel>
                </div>
              </div>

              <FieldLabel text={t("servers.upstream_address")}>
                <input value={activeApp.upstream.address || ""} onChange={(e) => updateAppAt(activeEditor!.idx, (current) => ({ ...current, upstream: { ...current.upstream, address: e.target.value } }))} />
              </FieldLabel>
              <div className="row-2">
                <FieldLabel text={t("servers.port")}>
                  <input type="number" value={activeApp.upstream.port || 80} onChange={(e) => updateAppAt(activeEditor!.idx, (current) => ({ ...current, upstream: { ...current.upstream, port: Number(e.target.value) || 80 } }))} />
                </FieldLabel>
                <FieldLabel text={t("servers.scheme")}>
                  <RadioChips
                    value={activeApp.upstream.scheme || "http"}
                    onChange={(next) => updateAppAt(activeEditor!.idx, (current) => ({ ...current, upstream: { ...current.upstream, scheme: next } }))}
                    options={[
                      { value: "http", label: t("common.http") },
                      { value: "https", label: t("common.https") },
                    ]}
                  />
                </FieldLabel>
              </div>
            </section>

            <section className="servers-editor-section">
              <div className="servers-editor-section__head">
                <div>
                  <strong>{t("servers.hosts")}</strong>
                  <span className="muted">{activeAppHosts.length}</span>
                </div>
                <Button variant="ghost" compact iconName="plus" onClick={() => addHost(activeApp.id)} disabled={busy}>
                  {t("servers.add_host")}
                </Button>
              </div>
              {activeAppHosts.length ? (
                <div className="servers-linked-list">
                  {activeAppHosts.map(({ host, idx }) => (
                    <button key={`${host.host}-${idx}`} type="button" className="servers-linked-item" onClick={() => openHostEditor(idx)}>
                      <span className="servers-linked-item__title">{host.host || `${t("servers.host")} ${idx + 1}`}</span>
                      <span className="servers-linked-item__meta">{host.kind || "-"}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="servers-empty muted">{t("common.none")}</p>
              )}
            </section>
          </div>
        ) : null}
      </ModalShell>

      <ModalShell open={!!activeHost} onClose={() => setActiveEditor(null)} size="big">
        {activeHost ? (
          <div className="servers-editor-modal">
            <header className="servers-editor-modal__head">
              <div>
                <h3>{activeHost.host || t("servers.add_host")}</h3>
                <p className="muted">{t("servers.hosts")}</p>
              </div>
              <div className="servers-editor-modal__actions">
                <IconButton iconName="trash" iconOnly tooltip={t("common.remove")} onClick={() => setDeleteConfirm({ type: "host", idx: activeEditor!.idx, title: activeHost.host || "" })} disabled={busy} />
                <IconButton iconName="close" iconOnly tooltip={t("common.close")} onClick={() => setActiveEditor(null)} />
              </div>
            </header>

            <section className="servers-editor-section">
              <FieldLabel text={t("servers.host")}>
                <input value={activeHost.host || ""} onChange={(e) => updateHostAt(activeEditor!.idx, (current) => ({ ...current, host: e.target.value }))} />
              </FieldLabel>

              <div className="row-2">
                <FieldLabel text={t("servers.kind")}>
                  <select value={activeHost.kind || "private"} onChange={(e) => updateHostAt(activeEditor!.idx, (current) => ({ ...current, kind: e.target.value as "private" | "public" }))}>
                    <option value="private">{t("common.private")}</option>
                    <option value="public">{t("common.public")}</option>
                  </select>
                </FieldLabel>
                <FieldLabel text={t("servers.app")}>
                  <select value={activeHost.app_id || ""} onChange={(e) => updateHostAt(activeEditor!.idx, (current) => ({ ...current, app_id: e.target.value }))}>
                    {doc.apps.map((app) => (
                      <option key={app.id} value={app.id}>{app.name || app.id}</option>
                    ))}
                  </select>
                </FieldLabel>
              </div>
            </section>

            <section className="servers-editor-section">
              <div className="servers-editor-section__head">
                <strong>{t("servers.app")}</strong>
                {activeHostApp ? (
                  <Button variant="ghost" compact onClick={() => openAppEditor(doc.apps.findIndex((app) => app.id === activeHostApp.id))}>
                    {t("common.open")}
                  </Button>
                ) : null}
              </div>
              <div className="summary-item">
                <span className="muted">{t("servers.app")}</span>
                <strong>{activeHostApp?.name || activeHost.app_id || t("common.none")}</strong>
              </div>
            </section>

            <section className="servers-editor-section">
              <div className="row-2">
                <FieldLabel text={t("servers.tls_policy")}>
                  <select
                    value={activeHost.tls?.cert_policy || "auto_local_ca"}
                    onChange={(e) =>
                      updateHostAt(activeEditor!.idx, (current) =>
                        updateHost(
                          {
                            ...current,
                            tls: {
                              ...(current.tls || { cert_ref: "auto", san: [] }),
                              cert_policy: e.target.value as "auto_local_ca" | "auto_acme" | "self_signed" | "keenetic" | "off",
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
                    <option value="keenetic">Keenetic / KeenDNS</option>
                    <option value="off">{t("servers.tls_off")}</option>
                  </select>
                </FieldLabel>
                <FieldLabel text={t("servers.redirect")}>
                  <select
                    value={(getWebEndpoint(activeHost)?.behavior?.redirect as string) || "https"}
                    onChange={(e) => updateHostAt(activeEditor!.idx, (current) => updateHost(current, { redirect: e.target.value as "https" | "http" | "off" }))}
                  >
                    <option value="https">{t("common.https")}</option>
                    <option value="http">{t("common.http")}</option>
                    <option value="off">{t("servers.tls_off")}</option>
                  </select>
                </FieldLabel>
              </div>

              <FieldLabel text={t("servers.san")}>
                <input
                  value={(activeHost.tls?.san || []).join(", ")}
                  onChange={(e) =>
                    updateHostAt(activeEditor!.idx, (current) => ({
                      ...current,
                      tls: {
                        ...(current.tls || { cert_policy: "auto_local_ca", cert_ref: "auto", san: [] }),
                        san: e.target.value.split(",").map((value) => value.trim()).filter(Boolean),
                      },
                    }))
                  }
                />
              </FieldLabel>

              <div className="toggles">
                <CheckboxChip checked={(activeHost.dns?.publish || []).includes("local")} onChange={(next) => updateHostAt(activeEditor!.idx, (current) => ({ ...current, dns: { ...(current.dns || { publish: [] }), publish: next ? ["local"] : [] } }))} label={t("servers.local_dns")} />
                <CheckboxChip checked={!!getNdnsEndpoint(activeHost)} onChange={(next) => updateHostAt(activeEditor!.idx, (current) => updateHost(current, { ndnsEnabled: next }))} label={t("servers.ndns")} />
                <CheckboxChip checked={!!activeHost.verify_upstream_ssl} onChange={(next) => updateHostAt(activeEditor!.idx, (current) => ({ ...current, verify_upstream_ssl: next }))} label={t("servers.verify_upstream_ssl")} />
              </div>

              {(activeHost.dns?.publish || []).includes("local") ? (
                <FieldLabel text={t("servers.local_record_ip")}>
                  <input value={activeHost.dns?.local_record_ip || "auto"} onChange={(e) => updateHostAt(activeEditor!.idx, (current) => ({ ...current, dns: { ...(current.dns || { publish: ["local"] }), local_record_ip: e.target.value } }))} />
                </FieldLabel>
              ) : null}

              {getNdnsEndpoint(activeHost) ? (
                <div className="ndns-grid">
                  <FieldLabel text={t("servers.name")}>
                    <input
                      value={getNdnsEndpoint(activeHost)?.behavior?.ndns_name ? String(getNdnsEndpoint(activeHost)?.behavior?.ndns_name) : ""}
                      onChange={(e) =>
                        updateHostAt(activeEditor!.idx, (current) => {
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
                      value={getNdnsEndpoint(activeHost)?.behavior?.ndns_domain ? String(getNdnsEndpoint(activeHost)?.behavior?.ndns_domain) : "ndns"}
                      onChange={(e) =>
                        updateHostAt(activeEditor!.idx, (current) => {
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
                      value={getNdnsEndpoint(activeHost)?.behavior?.ndns_target_ip ? String(getNdnsEndpoint(activeHost)?.behavior?.ndns_target_ip) : "auto"}
                      onChange={(e) =>
                        updateHostAt(activeEditor!.idx, (current) => {
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
                      value={String(getNdnsEndpoint(activeHost)?.listen?.port || "auto_random")}
                      onChange={(e) =>
                        updateHostAt(activeEditor!.idx, (current) => {
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
            </section>
          </div>
        ) : null}
      </ModalShell>

      <DeleteConfirmModal open={!!deleteConfirm} title={deleteConfirm?.title || ""} onClose={() => setDeleteConfirm(null)} onConfirm={confirmDelete} />
    </section>
  );
}
