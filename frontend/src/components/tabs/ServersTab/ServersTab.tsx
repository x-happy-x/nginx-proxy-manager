import { useState } from "react";
import type { RouteApp, RouteHost, RoutesDocument } from "../../../types";
import { useDraftState } from "../../../hooks/useDraftState";
import "./ServersTab.scss";
import { FieldLabel, IconButton, ModalShell, RadioChips } from "../../ui";
import { useI18n } from "../../../i18n";
import { AppCard } from "../../../entities/app/ui/AppCard";
import { HostCard } from "../../../entities/host/ui/HostCard";
import { StubSettingsPanel } from "../../../features/stub-settings/ui/StubSettingsPanel";
import { DeleteConfirmModal } from "../../../features/delete-confirm/ui/DeleteConfirmModal";

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

  const [appModes, setAppModes] = useState<Record<number, "view" | "edit">>({});
  const [hostModes, setHostModes] = useState<Record<number, "view" | "edit">>({});

  const [appModalOpen, setAppModalOpen] = useState(false);
  const [hostModalOpen, setHostModalOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "app" | "host"; idx: number; title: string } | null>(null);

  const newAppDraft = useDraftState<RouteApp>({ id: "", name: "", upstream: { address: "", port: 80, scheme: "http" } });
  const newHostDraft = useDraftState<{ host: string; kind: "private" | "public"; app_id: string }>({
    host: "",
    kind: "private",
    app_id: doc.apps[0]?.id || "",
  });
  const newApp = newAppDraft.value;
  const newHost = newHostDraft.value;

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

  const addApp = () => {
    const idx = doc.apps.length + 1;
    const id = newApp.id.trim() || `app-${idx}`;
    const name = newApp.name.trim() || `App ${idx}`;
    const item: RouteApp = {
      id,
      name,
      upstream: {
        address: newApp.upstream.address || "",
        port: Number(newApp.upstream.port) || 80,
        scheme: newApp.upstream.scheme || "http",
      },
    };
    setApps([...doc.apps, item]);
    setAppModes((prev) => ({ ...prev, [doc.apps.length]: "edit" }));
    setAppModalOpen(false);
    newAppDraft.reset({ id: "", name: "", upstream: { address: "", port: 80, scheme: "http" } });
  };

  const addHost = () => {
    const appId = newHost.app_id || doc.apps[0]?.id || "";
    setHosts([
      ...doc.hosts,
      {
        host: newHost.host,
        kind: newHost.kind,
        app_id: appId,
        verify_upstream_ssl: false,
        ws_proxy: { enabled: false, path: "/connections", rewrite_to_wss: false, rewrite_from: "" },
        dns: { publish: ["local"], local_record_ip: "auto" },
        tls: { cert_policy: "auto_local_ca", cert_ref: "auto", san: [] },
        endpoints: [{ name: "web", listen: { protocol: "https", port: doc.globals.ports.https || 443 }, behavior: { redirect: "https" } }],
      },
    ]);
    setHostModes((prev) => ({ ...prev, [doc.hosts.length]: "edit" }));
    setHostModalOpen(false);
    newHostDraft.reset({ host: "", kind: "private", app_id: doc.apps[0]?.id || "" });
  };

  const confirmDelete = () => {
    if (!deleteConfirm) return;
    if (deleteConfirm.type === "app") {
      const idx = deleteConfirm.idx;
      setApps(doc.apps.filter((_, i) => i !== idx));
      setAppModes((prev) => {
        const next: Record<number, "view" | "edit"> = {};
        Object.entries(prev).forEach(([k, v]) => {
          const n = Number(k);
          if (n < idx) next[n] = v;
          if (n > idx) next[n - 1] = v;
        });
        return next;
      });
    } else {
      setHosts(doc.hosts.filter((_, i) => i !== deleteConfirm.idx));
    }
    setDeleteConfirm(null);
  };

  return (
    <section className="tab-section servers-tab">
      <div className="section-head">
        <h2>{t("servers.apps")}</h2>
        <IconButton iconName="plus" iconOnly tooltip={t("servers.add_app")} onClick={() => setAppModalOpen(true)} disabled={busy} />
      </div>
      <div className="grid-cards compact-grid">
        {doc.apps.map((app, idx) => {
          const mode = appModes[idx] || "view";
          const editing = mode === "edit";
          const title = app.name || app.id || `App ${idx + 1}`;
          return (
            <AppCard
              key={`${app.id}-${idx}`}
              app={app}
              idx={idx}
              editing={editing}
              busy={busy}
              dirty={dirty}
              onSetMode={(next) => setAppModes((prev) => ({ ...prev, [idx]: next }))}
              onUpdateApp={(updater) => updateAppAt(idx, updater)}
              onDelete={(nextTitle) => setDeleteConfirm({ type: "app", idx, title: nextTitle })}
            />
          );
        })}
      </div>

      <div className="section-head">
        <h2>{t("servers.hosts")}</h2>
        <IconButton iconName="plus" iconOnly tooltip={t("servers.add_host")} onClick={() => setHostModalOpen(true)} disabled={busy} />
      </div>
      <div className="grid-cards compact-grid">
        {doc.hosts.map((host, idx) => {
          const editing = (hostModes[idx] || "view") === "edit";
          const title = host.host || `Host ${idx + 1}`;
          return (
            <HostCard
              key={`${host.host}-${idx}`}
              host={host}
              idx={idx}
              apps={doc.apps}
              editing={editing}
              busy={busy}
              onSetMode={(next) => setHostModes((prev) => ({ ...prev, [idx]: next }))}
              onUpdateHost={(updater) => updateHostAt(idx, updater)}
              onDelete={(nextTitle) => setDeleteConfirm({ type: "host", idx, title: nextTitle })}
            />
          );
        })}
      </div>

      <StubSettingsPanel doc={doc} busy={busy} onApplyStub={onApplyStub} onRestartUi={onRestartUi} onUploadStub={onUploadStub} onSetGlobal={setGlobal} />

      <ModalShell open={appModalOpen} onClose={() => setAppModalOpen(false)}>
        <header>
          <h3>{t("servers.add_app")}</h3>
          <IconButton iconName="close" iconOnly tooltip={t("common.close")} onClick={() => setAppModalOpen(false)} />
        </header>
        <div className="row-2">
          <FieldLabel text={t("servers.id")}>
            <input value={newApp.id} onChange={(e) => newAppDraft.setField("id", e.target.value)} />
          </FieldLabel>
          <FieldLabel text={t("servers.name")}>
            <input value={newApp.name} onChange={(e) => newAppDraft.setField("name", e.target.value)} />
          </FieldLabel>
        </div>
        <FieldLabel text={t("servers.upstream_address")}>
          <input value={newApp.upstream.address} onChange={(e) => newAppDraft.setValue((prev) => ({ ...prev, upstream: { ...prev.upstream, address: e.target.value } }))} />
        </FieldLabel>
        <div className="row-2">
          <FieldLabel text={t("servers.port")}>
            <input type="number" value={newApp.upstream.port} onChange={(e) => newAppDraft.setValue((prev) => ({ ...prev, upstream: { ...prev.upstream, port: Number(e.target.value) || 80 } }))} />
          </FieldLabel>
          <FieldLabel text={t("servers.scheme")}>
            <RadioChips
              value={newApp.upstream.scheme}
              onChange={(next) => newAppDraft.setValue((prev) => ({ ...prev, upstream: { ...prev.upstream, scheme: next } }))}
              options={[
                { value: "http", label: t("common.http") },
                { value: "https", label: t("common.https") },
              ]}
            />
          </FieldLabel>
        </div>
        <footer className="servers-modal-actions">
          <IconButton iconName="plus" iconOnly tooltip={t("common.add")} variant="accent" onClick={addApp} disabled={busy} />
        </footer>
      </ModalShell>

      <ModalShell open={hostModalOpen} onClose={() => setHostModalOpen(false)}>
        <header>
          <h3>{t("servers.add_host")}</h3>
          <IconButton iconName="close" iconOnly tooltip={t("common.close")} onClick={() => setHostModalOpen(false)} />
        </header>
        <FieldLabel text={t("servers.host")}>
          <input value={newHost.host} onChange={(e) => newHostDraft.setField("host", e.target.value)} />
        </FieldLabel>
        <div className="row-2">
          <FieldLabel text={t("servers.kind")}>
            <select value={newHost.kind} onChange={(e) => newHostDraft.setField("kind", e.target.value as "private" | "public")}>
              <option value="private">{t("common.private")}</option>
              <option value="public">{t("common.public")}</option>
            </select>
          </FieldLabel>
          <FieldLabel text={t("servers.app")}>
            <select value={newHost.app_id} onChange={(e) => newHostDraft.setField("app_id", e.target.value)}>
              {doc.apps.map((app) => (
                <option key={app.id} value={app.id}>{app.name || app.id}</option>
              ))}
            </select>
          </FieldLabel>
        </div>
        <footer className="servers-modal-actions">
          <IconButton iconName="plus" iconOnly tooltip={t("common.add")} variant="accent" onClick={addHost} disabled={busy || !newHost.host.trim()} />
        </footer>
      </ModalShell>

      <DeleteConfirmModal open={!!deleteConfirm} title={deleteConfirm?.title || ""} onClose={() => setDeleteConfirm(null)} onConfirm={confirmDelete} />
    </section>
  );
}
