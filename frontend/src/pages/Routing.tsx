import { useEffect, useRef, useState } from "react";
import type { HostEndpoint, RouteApp, RouteHost, RoutesDocument } from "../types";
import { Icon } from "../components/ui/Icon";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { EmptyState, Field, SearchInput, Segmented, Switch } from "../components/ui/controls";
import { count } from "../lib/format";
import { PageHeader } from "../navigation";
import { AppAvatar } from "./Services";
import {
  clone,
  getNdnsEndpoint,
  getWebEndpoint,
  readFileAsDataUrl,
  updateHost,
} from "../features/servers/lib/utils";

type CertPolicy = NonNullable<RouteHost["tls"]>["cert_policy"];

const TLS_LABELS: Record<CertPolicy, string> = {
  auto_local_ca: "Локальный CA",
  auto_acme: "ACME (Let's Encrypt)",
  self_signed: "Самоподписанный",
  keenetic: "Keenetic / KeenDNS",
  off: "Без TLS",
};

const REDIRECT_LABELS = {
  https: "На HTTPS",
  http: "На HTTP",
  off: "Без перенаправления",
} as const;

type Props = {
  doc: RoutesDocument;
  busy: boolean;
  onChange: (next: RoutesDocument) => void;
  onApplyStub: () => void;
  onUploadStub: (content: string) => void;
  onRestartUi: () => void;
};

type Editor = { type: "app" | "host"; idx: number } | null;

/** Comma-separated list field that keeps raw text while typing and commits on blur. */
function ListInput({
  value,
  onCommit,
  placeholder,
  numeric,
}: {
  value: string[];
  onCommit: (next: string[]) => void;
  placeholder?: string;
  numeric?: boolean;
}) {
  const joined = value.join(", ");
  const [text, setText] = useState(joined);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(joined);
  }, [joined]);
  const commit = () => {
    focused.current = false;
    const next = text
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => !numeric || (/^\d+$/.test(item) && +item > 0 && +item <= 65535));
    onCommit(next);
    setText(next.join(", "));
  };
  return (
    <input
      className="mono"
      value={text}
      placeholder={placeholder}
      inputMode={numeric ? "numeric" : undefined}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

const TLS_SHORT: Record<CertPolicy, string> = {
  auto_local_ca: "Локальный CA",
  auto_acme: "ACME",
  self_signed: "Самоподписанный",
  keenetic: "Keenetic",
  off: "Без TLS",
};

function endpointLabel(ep: HostEndpoint): string {
  const port = ep.listen.port === "auto_random" ? "авто" : ep.listen.port;
  return ep.behavior?.ndns_profile ? `KeenDNS ${port}` : `${ep.listen.protocol.toUpperCase()} ${port}`;
}

export function Routing({ doc, busy, onChange, onApplyStub, onUploadStub, onRestartUi }: Props) {
  const [tab, setTab] = useState<"apps" | "hosts" | "listen">("apps");
  const [editor, setEditor] = useState<Editor>(null);
  const [remove, setRemove] = useState<{ type: "app" | "host"; idx: number; title: string } | null>(null);
  const [query, setQuery] = useState("");

  const setGlobal = (patch: Partial<RoutesDocument["globals"]>) =>
    onChange({ ...doc, globals: { ...doc.globals, ...patch } });
  const updateAppAt = (idx: number, updater: (current: RouteApp) => RouteApp) =>
    onChange({ ...doc, apps: doc.apps.map((app, i) => (i === idx ? updater(app) : app)) });
  const updateHostAt = (idx: number, updater: (current: RouteHost) => RouteHost) =>
    onChange({ ...doc, hosts: doc.hosts.map((host, i) => (i === idx ? updater(host) : host)) });
  const updateAppIdAt = (idx: number, nextId: string) => {
    const prevId = doc.apps[idx]?.id || "";
    onChange({
      ...doc,
      apps: doc.apps.map((app, i) => (i === idx ? { ...app, id: nextId } : app)),
      hosts: doc.hosts.map((host) => (host.app_id === prevId ? { ...host, app_id: nextId } : host)),
    });
  };

  const addApp = () => {
    const n = doc.apps.length + 1;
    onChange({
      ...doc,
      apps: [...doc.apps, { id: `app-${n}`, name: `Приложение ${n}`, upstream: { address: "", port: 80, scheme: "http" } }],
    });
    setTab("apps");
    setEditor({ type: "app", idx: doc.apps.length });
  };

  const addHost = (appId?: string) => {
    const host: RouteHost = {
      host: "",
      kind: "private",
      app_id: appId || doc.apps[0]?.id || "",
      verify_upstream_ssl: false,
      ws_proxy: { enabled: false, path: "/connections", rewrite_to_wss: false, rewrite_from: "" },
      dns: { publish: ["local"], local_record_ip: "auto" },
      tls: { cert_policy: "auto_local_ca", cert_ref: "auto", san: [] },
      endpoints: [{ name: "web", listen: { protocol: "https", port: doc.globals.ports.https || 443 }, behavior: { redirect: "https" } }],
    };
    onChange({ ...doc, hosts: [...doc.hosts, host] });
    setEditor({ type: "host", idx: doc.hosts.length });
  };

  const confirmDelete = () => {
    if (!remove) return;
    if (remove.type === "app") {
      const id = doc.apps[remove.idx]?.id;
      onChange({
        ...doc,
        apps: doc.apps.filter((_, i) => i !== remove.idx),
        hosts: doc.hosts.filter((host) => host.app_id !== id),
      });
    } else {
      onChange({ ...doc, hosts: doc.hosts.filter((_, i) => i !== remove.idx) });
    }
    setEditor(null);
    setRemove(null);
  };

  const needle = query.trim().toLowerCase();
  const appRows = doc.apps
    .map((app, idx) => ({ app, idx }))
    .filter(({ app }) => !needle || `${app.name} ${app.id} ${app.upstream.address}`.toLowerCase().includes(needle));
  const hostRows = doc.hosts
    .map((host, idx) => ({ host, idx }))
    .filter(({ host }) => !needle || `${host.host} ${host.app_id}`.toLowerCase().includes(needle));

  const activeApp = editor?.type === "app" ? doc.apps[editor.idx] : null;
  const activeHost = editor?.type === "host" ? doc.hosts[editor.idx] : null;

  return (
    <div className="stack">
      <PageHeader
        page="advanced"
        actions={
          tab === "listen" ? null : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => (tab === "apps" ? addApp() : addHost())}
              disabled={busy}
            >
              <Icon name="plus" />
              {tab === "apps" ? "Добавить приложение" : "Добавить хост"}
            </button>
          )
        }
      >
        Точные параметры приложений, хостов, портов и сервера-заглушки. Изменения сразу
        попадают в черновик.
      </PageHeader>

      <div className="tabs" role="tablist" aria-label="Раздел маршрутизации">
        <button type="button" role="tab" aria-selected={tab === "apps"} onClick={() => setTab("apps")}>
          Приложения <span className="badge-count">{doc.apps.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "hosts"} onClick={() => setTab("hosts")}>
          Хосты <span className="badge-count">{doc.hosts.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "listen"} onClick={() => setTab("listen")}>
          Слушатели и заглушка
        </button>
      </div>

      {tab !== "listen" ? (
        <div className="toolbar">
          <SearchInput
            label="Поиск"
            placeholder={tab === "apps" ? "Название, ID или адрес" : "Домен или ID приложения"}
            value={query}
            onChange={setQuery}
          />
        </div>
      ) : null}

      {tab === "apps" ? (
        <section className="card card-flush">
          {appRows.length ? (
            <div className="table-wrap">
              <table className="table responsive">
                <thead>
                  <tr>
                    <th>Приложение</th>
                    <th>Адрес</th>
                    <th className="col-shrink">Хосты</th>
                    <th className="col-actions">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {appRows.map(({ app, idx }) => {
                    const hosts = doc.hosts.filter((host) => host.app_id === app.id).length;
                    return (
                      <tr key={`${app.id}-${idx}`}>
                        <td className="cell-primary" data-label="">
                          <div className="cell-title">
                            <AppAvatar app={app} />
                            <div>
                              <strong className="break">{app.name || app.id || `Приложение ${idx + 1}`}</strong>
                              <span className="cell-sub mono">{app.id || "—"}</span>
                            </div>
                          </div>
                        </td>
                        <td data-label="Адрес" className="mono">
                          {app.upstream.address ? `${app.upstream.scheme}://${app.upstream.address}:${app.upstream.port || 80}` : <span className="text-warning">не задан</span>}
                        </td>
                        <td className="cell-aside col-shrink">
                          <span className="badge">{count(hosts, ["хост", "хоста", "хостов"])}</span>
                        </td>
                        <td className="col-actions">
                          <div className="row-actions">
                            <button type="button" className="btn btn-sm" aria-label={`Изменить ${app.name || app.id}`} title="Изменить" onClick={() => setEditor({ type: "app", idx })} disabled={busy}>
                              <Icon name="edit" size={14} />
                              <span className="btn-label">Изменить</span>
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-icon btn-danger-ghost"
                              aria-label={`Удалить ${app.name || app.id}`}
                              title="Удалить"
                              onClick={() => setRemove({ type: "app", idx, title: app.name || app.id })}
                              disabled={busy}
                            >
                              <Icon name="trash" size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="servers" title={needle ? "Ничего не найдено" : "Приложений нет"} />
          )}
        </section>
      ) : null}

      {tab === "hosts" ? (
        <section className="card card-flush">
          {hostRows.length ? (
            <div className="table-wrap">
              <table className="table responsive">
                <thead>
                  <tr>
                    <th>Хост и приложение</th>
                    <th>TLS</th>
                    <th>Входы</th>
                    <th className="col-actions">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {hostRows.map(({ host, idx }) => {
                    const app = doc.apps.find((item) => item.id === host.app_id);
                    return (
                      <tr key={`${host.host}-${idx}`}>
                        <td className="cell-primary" data-label="">
                          <div className="cell-title">
                            <Icon name={host.kind === "public" ? "globe" : "home"} className="muted" />
                            <div>
                              <strong className="mono domain">{host.host || <span className="text-warning">домен не задан</span>}</strong>
                              <span className="cell-sub">
                                {app ? app.name || app.id : <span className="text-danger">приложение {host.app_id || "не выбрано"}</span>}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="cell-aside">
                          <span className={`badge${host.tls?.cert_policy === "off" ? "" : " badge-success"}`}>
                            {host.tls?.cert_policy === "off" ? null : <Icon name="lock" />}
                            {TLS_SHORT[host.tls?.cert_policy || "auto_local_ca"]}
                          </span>
                        </td>
                        <td data-label="Входы">
                          <div className="chip-list">
                            {(host.endpoints || []).map((ep) => (
                              <span key={ep.name} className="chip">
                                {endpointLabel(ep)}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="col-actions">
                          <div className="row-actions">
                            <button type="button" className="btn btn-sm" aria-label={`Изменить ${host.host || "хост"}`} title="Изменить" onClick={() => setEditor({ type: "host", idx })} disabled={busy}>
                              <Icon name="edit" size={14} />
                              <span className="btn-label">Изменить</span>
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-icon btn-danger-ghost"
                              aria-label={`Удалить ${host.host}`}
                              title="Удалить"
                              onClick={() => setRemove({ type: "host", idx, title: host.host || `хост ${idx + 1}` })}
                              disabled={busy}
                            >
                              <Icon name="trash" size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="dns" title={needle ? "Ничего не найдено" : "Хостов нет"} />
          )}
        </section>
      ) : null}

      {tab === "listen" ? (
        <ListenSettings
          doc={doc}
          busy={busy}
          setGlobal={setGlobal}
          onApplyStub={onApplyStub}
          onUploadStub={onUploadStub}
          onRestartUi={onRestartUi}
        />
      ) : null}

      <Modal
        open={!!activeApp}
        onClose={() => setEditor(null)}
        size="lg"
        title={activeApp?.name || activeApp?.id || "Приложение"}
        description="Изменения сразу попадают в черновик маршрутов."
        footer={
          <>
            <button
              type="button"
              className="btn btn-danger-ghost"
              style={{ marginRight: "auto" }}
              onClick={() => activeApp && setRemove({ type: "app", idx: editor!.idx, title: activeApp.name || activeApp.id })}
              disabled={busy}
            >
              <Icon name="trash" />
              Удалить
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setEditor(null)}>
              Готово
            </button>
          </>
        }
      >
        {activeApp ? (
          <AppEditor
            app={activeApp}
            idx={editor!.idx}
            doc={doc}
            busy={busy}
            updateApp={(updater) => updateAppAt(editor!.idx, updater)}
            updateId={(id) => updateAppIdAt(editor!.idx, id)}
            onOpenHost={(idx) => setEditor({ type: "host", idx })}
            onAddHost={() => addHost(activeApp.id)}
          />
        ) : null}
      </Modal>

      <Modal
        open={!!activeHost}
        onClose={() => setEditor(null)}
        size="lg"
        title={activeHost?.host || "Новый хост"}
        description="Изменения сразу попадают в черновик маршрутов."
        footer={
          <>
            <button
              type="button"
              className="btn btn-danger-ghost"
              style={{ marginRight: "auto" }}
              onClick={() => activeHost && setRemove({ type: "host", idx: editor!.idx, title: activeHost.host })}
              disabled={busy}
            >
              <Icon name="trash" />
              Удалить
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setEditor(null)}>
              Готово
            </button>
          </>
        }
      >
        {activeHost ? (
          <HostEditor
            host={activeHost}
            doc={doc}
            update={(updater) => updateHostAt(editor!.idx, updater)}
            onOpenApp={(idx) => setEditor({ type: "app", idx })}
          />
        ) : null}
      </Modal>

      <ConfirmDialog
        open={!!remove}
        title={remove?.type === "app" ? "Удалить приложение?" : "Удалить хост?"}
        confirmLabel="Удалить из черновика"
        onClose={() => setRemove(null)}
        onConfirm={confirmDelete}
      >
        <strong>{remove?.title || "Без названия"}</strong>
        {remove?.type === "app"
          ? " и все его хосты будут удалены из черновика."
          : " будет удалён из черновика."}
      </ConfirmDialog>
    </div>
  );
}

function AppEditor({
  app,
  idx,
  doc,
  busy,
  updateApp,
  updateId,
  onOpenHost,
  onAddHost,
}: {
  app: RouteApp;
  idx: number;
  doc: RoutesDocument;
  busy: boolean;
  updateApp: (updater: (current: RouteApp) => RouteApp) => void;
  updateId: (id: string) => void;
  onOpenHost: (idx: number) => void;
  onAddHost: () => void;
}) {
  const fileId = `app-icon-${idx}`;
  const hosts = doc.hosts.map((host, i) => ({ host, i })).filter(({ host }) => host.app_id === app.id);
  return (
    <>
      <section className="form-section">
        <div className="app-identity">
          <AppAvatar app={app} large />
          <div className="button-row">
            <button type="button" className="btn btn-sm" onClick={() => document.getElementById(fileId)?.click()} disabled={busy}>
              <Icon name="upload" size={14} />
              Загрузить иконку
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy || !app.ui?.icon_data_url}
              onClick={() => updateApp((current) => ({ ...current, ui: { ...(current.ui || {}), icon_data_url: "" } }))}
            >
              Убрать
            </button>
            <input
              id={fileId}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                const input = e.currentTarget;
                if (!file) return;
                const dataUrl = await readFileAsDataUrl(file);
                updateApp((current) => ({ ...current, ui: { ...(current.ui || {}), icon_data_url: dataUrl } }));
                input.value = "";
              }}
            />
          </div>
        </div>
        <div className="form-grid">
          <Field label="Название">
            <input value={app.name || ""} onChange={(e) => updateApp((c) => ({ ...c, name: e.target.value }))} />
          </Field>
          <Field label="ID" hint="Используется в хостах; при изменении ссылки обновятся.">
            <input className="mono" value={app.id || ""} onChange={(e) => updateId(e.target.value)} />
          </Field>
        </div>
      </section>
      <section className="form-section">
        <div className="form-section-head">
          <h3>Адрес приложения</h3>
        </div>
        <div className="form-grid cols-upstream">
          <Field label="IP-адрес или имя хоста">
            <input
              className="mono"
              value={app.upstream.address || ""}
              onChange={(e) => updateApp((c) => ({ ...c, upstream: { ...c.upstream, address: e.target.value } }))}
            />
          </Field>
          <Field label="Порт">
            <input
              type="number"
              inputMode="numeric"
              value={app.upstream.port || 80}
              onChange={(e) => updateApp((c) => ({ ...c, upstream: { ...c.upstream, port: Number(e.target.value) || 80 } }))}
            />
          </Field>
          <Field label="Протокол">
            <select
              value={app.upstream.scheme || "http"}
              onChange={(e) => updateApp((c) => ({ ...c, upstream: { ...c.upstream, scheme: e.target.value as "http" | "https" } }))}
            >
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
            </select>
          </Field>
        </div>
      </section>
      <section className="form-section">
        <div className="form-section-head">
          <h3>
            Хосты<span className="inline-count">{hosts.length}</span>
          </h3>
          <button type="button" className="btn btn-sm" onClick={onAddHost} disabled={busy}>
            <Icon name="plus" size={14} />
            Добавить хост
          </button>
        </div>
        {hosts.length ? (
          <div className="link-list">
            {hosts.map(({ host, i }) => (
              <button key={`${host.host}-${i}`} type="button" onClick={() => onOpenHost(i)}>
                <Icon name={host.kind === "public" ? "globe" : "home"} className="muted" />
                <span className="mono truncate">{host.host || `Хост ${i + 1}`}</span>
                <span className="badge">{host.kind === "public" ? "Публичный" : "Локальный"}</span>
                <Icon name="chevronRight" className="muted" />
              </button>
            ))}
          </div>
        ) : (
          <p className="field-hint">У приложения пока нет хостов.</p>
        )}
      </section>
    </>
  );
}

function HostEditor({
  host,
  doc,
  update,
  onOpenApp,
}: {
  host: RouteHost;
  doc: RoutesDocument;
  update: (updater: (current: RouteHost) => RouteHost) => void;
  onOpenApp: (idx: number) => void;
}) {
  const ndns = getNdnsEndpoint(host);
  const localDns = (host.dns?.publish || []).includes("local");
  const appIdx = doc.apps.findIndex((app) => app.id === host.app_id);
  const setNdns = (patch: (endpoint: HostEndpoint) => void) =>
    update((current) => {
      const draft = updateHost(current, { ndnsEnabled: true });
      const endpoint = getNdnsEndpoint(draft);
      if (endpoint) patch(endpoint);
      return clone(draft);
    });
  return (
    <>
      <section className="form-section">
        <div className="form-grid">
          <Field label="Домен" className="span-2">
            <input
              className="mono"
              value={host.host || ""}
              placeholder="service.home.arpa"
              autoCapitalize="none"
              onChange={(e) => update((c) => ({ ...c, host: e.target.value }))}
            />
          </Field>
          <Field label="Тип" group>
            <Segmented
              label="Тип хоста"
              value={host.kind || "private"}
              onChange={(kind) => update((c) => ({ ...c, kind }))}
              options={[
                { value: "private", label: "Локальный" },
                { value: "public", label: "Публичный" },
              ]}
            />
          </Field>
          <Field
            label="Приложение"
            hint={
              appIdx >= 0 ? (
                <button type="button" className="link-button" onClick={() => onOpenApp(appIdx)}>
                  Открыть приложение
                </button>
              ) : undefined
            }
          >
            <select value={host.app_id || ""} onChange={(e) => update((c) => ({ ...c, app_id: e.target.value }))}>
              {appIdx < 0 ? <option value={host.app_id}>{host.app_id || "Не выбрано"}</option> : null}
              {doc.apps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name || app.id}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <section className="form-section">
        <div className="form-section-head">
          <h3>TLS</h3>
        </div>
        <div className="form-grid">
          <Field label="Сертификат">
            <select
              value={host.tls?.cert_policy || "auto_local_ca"}
              onChange={(e) =>
                update((c) =>
                  updateHost(
                    { ...c, tls: { ...(c.tls || { cert_ref: "auto", san: [] }), cert_policy: e.target.value as CertPolicy } },
                    {},
                  ),
                )
              }
            >
              {(Object.keys(TLS_LABELS) as CertPolicy[]).map((key) => (
                <option key={key} value={key}>
                  {TLS_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Перенаправление">
            <select
              value={(getWebEndpoint(host)?.behavior?.redirect as string) || "https"}
              onChange={(e) => update((c) => updateHost(c, { redirect: e.target.value as "https" | "http" | "off" }))}
            >
              {(Object.keys(REDIRECT_LABELS) as Array<keyof typeof REDIRECT_LABELS>).map((key) => (
                <option key={key} value={key}>
                  {REDIRECT_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Дополнительные имена (SAN)" hint="Через запятую." className="span-2">
            <ListInput
              value={host.tls?.san || []}
              placeholder="alt.home.arpa, 192.168.1.2"
              onCommit={(san) =>
                update((c) => ({ ...c, tls: { ...(c.tls || { cert_policy: "auto_local_ca", cert_ref: "auto" }), san } }))
              }
            />
          </Field>
        </div>
      </section>

      <section className="form-section">
        <div className="form-section-head">
          <h3>DNS и доступ</h3>
        </div>
        <div className="switch-list">
          <Switch
            checked={localDns}
            onChange={(next) => update((c) => ({ ...c, dns: { ...(c.dns || { publish: [] }), publish: next ? ["local"] : [] } }))}
            label="Локальная DNS-запись"
            hint="Роутер будет разрешать домен в IP прокси."
          />
          <Switch
            checked={!!ndns}
            onChange={(next) => update((c) => updateHost(c, { ndnsEnabled: next }))}
            label="Публичный вход KeenDNS"
            hint="Отдельный порт для внешнего трафика."
          />
          <Switch
            checked={!!host.verify_upstream_ssl}
            onChange={(next) => update((c) => ({ ...c, verify_upstream_ssl: next }))}
            label="Проверять сертификат приложения"
            hint="Для приложений, работающих по HTTPS."
          />
        </div>
        {localDns ? (
          <Field label="IP для DNS-записи" hint="auto — первый адрес прослушивания прокси.">
            <input
              className="mono"
              value={host.dns?.local_record_ip || "auto"}
              onChange={(e) => update((c) => ({ ...c, dns: { ...(c.dns || { publish: ["local"] }), local_record_ip: e.target.value } }))}
            />
          </Field>
        ) : null}
        {ndns ? (
          <div className="subpanel">
            <h3>Вход KeenDNS</h3>
            <div className="form-grid">
              <Field label="Имя">
                <input className="mono" value={String(ndns.behavior?.ndns_name || "")} onChange={(e) => setNdns((ep) => (ep.behavior.ndns_name = e.target.value))} />
              </Field>
              <Field label="Домен KeenDNS">
                <input className="mono" value={String(ndns.behavior?.ndns_domain || "ndns")} onChange={(e) => setNdns((ep) => (ep.behavior.ndns_domain = e.target.value))} />
              </Field>
              <Field label="IP назначения">
                <input className="mono" value={String(ndns.behavior?.ndns_target_ip || "auto")} onChange={(e) => setNdns((ep) => (ep.behavior.ndns_target_ip = e.target.value))} />
              </Field>
              <Field label="Порт входа" hint="auto_random — назначить при сохранении.">
                <input
                  className="mono"
                  value={String(ndns.listen?.port || "auto_random")}
                  onChange={(e) => setNdns((ep) => (ep.listen.port = Number(e.target.value) || "auto_random"))}
                />
              </Field>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}

function ListenSettings({
  doc,
  busy,
  setGlobal,
  onApplyStub,
  onUploadStub,
  onRestartUi,
}: {
  doc: RoutesDocument;
  busy: boolean;
  setGlobal: (patch: Partial<RoutesDocument["globals"]>) => void;
  onApplyStub: () => void;
  onUploadStub: (content: string) => void;
  onRestartUi: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const { ports, ui, stub } = doc.globals;
  return (
    <div className="grid-2 align-start">
      <section className="card">
        <div className="card-header">
          <div className="card-title">
            <h2>Прослушивание</h2>
            <p>Адреса и порты выделенного nginx</p>
          </div>
        </div>
        <div className="card-body">
          <div className="form-grid">
            <Field label="IP-адреса прослушивания" hint="Через запятую." className="span-2">
              <ListInput value={doc.globals.listen_ips} placeholder="192.168.1.2, 192.168.99.2" onCommit={(listen_ips) => setGlobal({ listen_ips })} />
            </Field>
            <Field label="Порт HTTP">
              <input type="number" inputMode="numeric" value={ports.http} onChange={(e) => setGlobal({ ports: { ...ports, http: Number(e.target.value) || 80 } })} />
            </Field>
            <Field label="Порт HTTPS">
              <input type="number" inputMode="numeric" value={ports.https} onChange={(e) => setGlobal({ ports: { ...ports, https: Number(e.target.value) || 443 } })} />
            </Field>
            <Field label="Доп. порты HTTP">
              <ListInput numeric value={ports.http_extra.map(String)} placeholder="8080" onCommit={(list) => setGlobal({ ports: { ...ports, http_extra: list.map(Number) } })} />
            </Field>
            <Field label="Доп. порты HTTPS">
              <ListInput numeric value={ports.https_extra.map(String)} placeholder="8443" onCommit={(list) => setGlobal({ ports: { ...ports, https_extra: list.map(Number) } })} />
            </Field>
          </div>
        </div>
      </section>

      <div className="stack">
        <section className="card">
          <div className="card-header">
            <div className="card-title">
              <h2>Сервер-заглушка</h2>
              <p>Ответ для запросов к неизвестным доменам</p>
            </div>
          </div>
          <div className="card-body stack">
            <Switch
              checked={stub.enabled}
              onChange={(enabled) => setGlobal({ stub: { ...stub, enabled } })}
              label="Включить заглушку по умолчанию"
              hint={<span className="mono">{stub.root}</span>}
            />
            <div className="button-row">
              <button type="button" className="btn" onClick={onApplyStub} disabled={busy}>
                <Icon name="bolt" />
                Сохранить и применить
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
                <Icon name="upload" />
                Загрузить страницу
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".html,.htm,.txt"
                hidden
                onChange={async (e) => {
                  const input = e.currentTarget;
                  const file = input.files?.[0];
                  if (!file) return;
                  onUploadStub(await file.text());
                  input.value = "";
                }}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div className="card-title">
              <h2>Интерфейс менеджера</h2>
              <p>Адрес этой панели управления</p>
            </div>
          </div>
          <div className="card-body stack">
            <div className="form-grid">
              <Field label="Адрес">
                <input className="mono" value={ui.host} onChange={(e) => setGlobal({ ui: { ...ui, host: e.target.value } })} />
              </Field>
              <Field label="Порт">
                <input type="number" inputMode="numeric" value={ui.port} onChange={(e) => setGlobal({ ui: { ...ui, port: Number(e.target.value) || 8080 } })} />
              </Field>
            </div>
            <p className="field-hint">
              Новый адрес начнёт работать после сохранения черновика и перезапуска интерфейса.
            </p>
            <div className="button-row">
              <button type="button" className="btn" onClick={onRestartUi} disabled={busy}>
                <Icon name="refresh" />
                Перезапустить интерфейс
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
