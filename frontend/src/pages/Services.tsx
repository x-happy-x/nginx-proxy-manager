import { useEffect, useMemo, useState } from "react";
import type { RouteApp, RouteHost, RoutesDocument } from "../types";
import { Icon } from "../components/ui/Icon";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Alert, EmptyState, Field, SearchInput, Segmented } from "../components/ui/controls";
import { count, initials } from "../lib/format";
import { getWebEndpoint } from "../features/servers/lib/utils";
import { PageHeader } from "../navigation";
import { PublicServers, loadPublicServers, type PublicServerItem } from "../features/servers/PublicServers";
import { publicDomainDraft, vpsHost, type PublicDomainDraft } from "../features/servers/publication";

type ServiceDraft = {
  id: string;
  name: string;
  address: string;
  port: number;
  scheme: "http" | "https";
  local: string;
  publicDomains: PublicDomainDraft[];
  proxyIp: string;
};

type AccessFilter = "all" | "local" | "public";

export const PUBLIC_DOMAIN_SUFFIX = "crubs.crazedns.ru";
const PUBLIC_DOMAIN_ENDING = `.${PUBLIC_DOMAIN_SUFFIX}`;

function publicDomainLabel(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized.endsWith(PUBLIC_DOMAIN_ENDING)
    ? normalized.slice(0, -PUBLIC_DOMAIN_ENDING.length)
    : "";
}

export function hostUrl(host: RouteHost): string {
  const web = getWebEndpoint(host);
  const secure = host.kind === "public" || web?.listen.protocol === "https";
  return `${secure ? "https" : "http"}://${host.host}/`;
}

export function DomainChips({ hosts }: { hosts: RouteHost[] }) {
  if (!hosts.length) return <span className="muted">Домен не назначен</span>;
  return (
    <div className="chip-list">
      {hosts.map((host) => (
        <a
          key={host.host}
          className="chip"
          href={hostUrl(host)}
          target="_blank"
          rel="noreferrer"
          title={`${host.kind === "public" ? "Публичный" : "Локальный"} домен — открыть в новой вкладке`}
        >
          <Icon name={host.kind === "public" ? "globe" : "home"} size={13} />
          {host.host}
        </a>
      ))}
    </div>
  );
}

function AccessBadge({ hosts }: { hosts: RouteHost[] }) {
  return hosts.some((h) => h.kind === "public") ? (
    <span className="badge badge-accent">
      <Icon name="globe" /> Локальный и внешний
    </span>
  ) : (
    <span className="badge">
      <Icon name="home" /> Только локальный
    </span>
  );
}

export function AppAvatar({ app, large }: { app: RouteApp; large?: boolean }) {
  return (
    <span className={`avatar${large ? " avatar-lg" : ""}`} aria-hidden="true">
      {app.ui?.icon_data_url ? (
        <img src={String(app.ui.icon_data_url)} alt="" />
      ) : (
        initials(app.name || app.id)
      )}
    </span>
  );
}

export function Services({
  doc,
  onChange,
  busy,
  onAdvanced,
}: {
  doc: RoutesDocument;
  onChange: (doc: RoutesDocument) => void;
  busy: boolean;
  onAdvanced: () => void;
}) {
  const [search, setSearch] = useState("");
  const [access, setAccess] = useState<AccessFilter>("all");
  const [draft, setDraft] = useState<ServiceDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [publicServers, setPublicServers] = useState<PublicServerItem[]>([]);
  useEffect(() => { if (draft) void loadPublicServers().then(v => setPublicServers(v.items)).catch(() => {}); }, [!!draft]);
  const [error, setError] = useState("");
  const [remove, setRemove] = useState<RouteApp | null>(null);

  const hostsByApp = useMemo(() => {
    const map = new Map<string, RouteHost[]>();
    for (const host of doc.hosts) {
      map.set(host.app_id, [...(map.get(host.app_id) || []), host]);
    }
    return map;
  }, [doc.hosts]);
  const isPublic = (app: RouteApp) =>
    (hostsByApp.get(app.id) || []).some((h) => h.kind === "public");
  const publicCount = doc.apps.filter(isPublic).length;
  const needle = search.trim().toLowerCase();
  const rows = doc.apps.filter((app) => {
    if (access === "public" && !isPublic(app)) return false;
    if (access === "local" && isPublic(app)) return false;
    if (!needle) return true;
    return `${app.name} ${app.id} ${app.upstream.address}:${app.upstream.port} ${(hostsByApp.get(app.id) || [])
      .map((host) => host.host)
      .join(" ")}`
      .toLowerCase()
      .includes(needle);
  });

  const edit = (app?: RouteApp) => {
    const hosts = doc.hosts.filter((h) => h.app_id === app?.id);
    const external = hosts.find(
      (h) => h.kind === "public" && !!publicDomainLabel(h.host),
    );
    const dnsHost = external || hosts[0];
    setEditing(!!app);
    setError("");
    setDraft({
      id: app?.id || "",
      name: app?.name || "",
      address: app?.upstream.address || "",
      port: app?.upstream.port || 80,
      scheme: app?.upstream.scheme || "http",
      local: hosts.find((h) => h.kind === "private")?.host || "",
      publicDomains: hosts.filter(h => h.kind === "public").map(h => publicDomainDraft(h, PUBLIC_DOMAIN_SUFFIX)),
      proxyIp:
        dnsHost?.dns?.local_record_ip && dnsHost.dns.local_record_ip !== "auto"
          ? dnsHost.dns.local_record_ip
          : doc.globals.listen_ips.find(
              (ip) => ip !== "0.0.0.0" && ip !== "::",
            ) || "",
    });
  };

  const commit = () => {
    if (!draft) return;
    const d = {
      ...draft,
      name: draft.name.trim(),
      address: draft.address.trim(),
      local: draft.local.trim().toLowerCase(),
      publicDomains: draft.publicDomains.filter(p => p.host.trim()).map(p => ({ ...p, host: p.host.trim().toLowerCase().replace(/\.$/, "") })),
      proxyIp: draft.proxyIp.trim(),
    };
    const domains = [d.local, ...d.publicDomains.map(p => p.host)].filter(Boolean);
    if (
      !d.name ||
      !d.address ||
      !Number.isInteger(d.port) ||
      d.port < 1 ||
      d.port > 65535
    ) {
      setError("Укажите название, адрес сервиса и порт от 1 до 65535.");
      return;
    }
    if (
      !domains.length ||
      domains.some(
        (host) =>
          !host.includes(".") ||
          host.includes("://") ||
          !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host),
      )
    ) {
      setError(
        "Укажите хотя бы один домен без протокола, порта и пути, например sub.local.",
      );
      return;
    }
    for (const pub of d.publicDomains) {
      if (!pub.serverId && !publicDomainLabel(pub.host)) {
        setError(`Для KeenDNS укажите имя в зоне ${PUBLIC_DOMAIN_SUFFIX} или выберите VPS.`); return;
      }
      if (pub.serverId && pub.serverId !== "manual" && !publicServers.some(s => s.server.id === pub.serverId)) {
        setError("Выберите подключённый публичный сервер."); return;
      }
    }
    if (
      new Set(domains).size !== domains.length ||
      doc.hosts.some(
        (host) => domains.includes(host.host) && host.app_id !== d.id,
      )
    ) {
      setError("Этот домен уже используется другим маршрутом.");
      return;
    }
    if (
      (d.local || d.publicDomains.some(p => !p.serverId)) && (!d.proxyIp ||
      !/^(\d{1,3}\.){3}\d{1,3}$/.test(d.proxyIp) ||
      d.proxyIp.split(".").some((part) => Number(part) > 255))
    ) {
      setError("Укажите локальный IPv4-адрес прокси, например 192.168.1.2.");
      return;
    }
    if (d.publicDomains.some(p => !p.serverId && p.externalPort !== "auto_random" && (!/^\d+$/.test(p.externalPort) || +p.externalPort < 1024 || +p.externalPort > 65535))) {
      setError("Внешний вход: auto_random или порт от 1024 до 65535."); return;
    }
    const id = d.id || `service-${Date.now().toString(36)}`;
    const existing = doc.apps.find((app) => app.id === id);
    const app: RouteApp = {
      ...existing,
      id,
      name: d.name,
      upstream: { address: d.address, port: d.port, scheme: d.scheme },
    };
    // Preserve access rules and advanced settings by hostname, including extra local aliases.
    const current = doc.hosts.filter((host) => host.app_id === id),
      managed = [
        current.find((h) => h.kind === "private"),
        ...current.filter((h) => h.kind === "public"),
      ].filter(Boolean) as RouteHost[];
    const makeHost = (domain: string, kind: "private" | "public", serverId = ""): RouteHost => {
      const pub = d.publicDomains.find(p => p.host === domain);
      const original = current.find(h => h.host === (pub?.originalHost || domain)) || (kind === "private" ? managed.find(h => h.kind === kind) : undefined);
      if (serverId === "manual" && original) return original;
      if (serverId) return vpsHost(original, domain, id, serverId);
      const endpoints = (original?.publication ? undefined : original?.endpoints)?.map((ep) => ({
        ...ep,
        listen: { ...ep.listen },
        behavior: { ...ep.behavior },
      })) || [
        {
          name: "web",
          listen: {
            protocol: kind === "public" ? ("https" as const) : ("http" as const),
            port:
              kind === "public"
                ? doc.globals.ports.https || 443
                : doc.globals.ports.http || 80,
          },
          behavior: {
            redirect: kind === "public" ? ("https" as const) : ("off" as const),
          },
        },
      ];
      if (kind === "public") {
        let ep = endpoints.find((e) => e.behavior.ndns_profile);
        if (!ep) {
          ep = {
            name: "ndns",
            listen: { protocol: "http", port: "auto_random" },
            behavior: {},
          };
          endpoints.push(ep);
        }
        ep.listen = {
          protocol: ep.listen.protocol || "http",
          port: pub?.externalPort && pub.externalPort !== "auto_random" ? +pub.externalPort : "auto_random",
        };
        ep.behavior = {
          ...ep.behavior,
          ndns_profile: "ndns_proxy",
          ndns_name:
            original?.host === domain
              ? ep.behavior.ndns_name || domain.split(".")[0]
              : domain.split(".")[0],
          ndns_domain: ep.behavior.ndns_domain || "ndns",
          ndns_security_level: ep.behavior.ndns_security_level || "public",
          ndns_ssl_redirect: ep.behavior.ndns_ssl_redirect ?? true,
          ndns_target_ip: d.proxyIp,
        };
      }
      return {
        ...original,
        host: domain,
        publication: undefined,
        app_id: id,
        kind,
        dns: {
          ...original?.dns,
          publish: Array.from(new Set([...(original?.dns?.publish || []), "local"])),
          local_record_ip: d.proxyIp,
        },
        tls: (!original?.publication && original?.tls) || {
          cert_policy: kind === "public" ? "keenetic" : "off",
          cert_ref: "auto",
          san: [],
        },
        endpoints,
      };
    };
    onChange({
      ...doc,
      apps: existing
        ? doc.apps.map((a) => (a.id === id ? app : a))
        : [...doc.apps, app],
      hosts: [
        ...doc.hosts.filter((h) => !managed.includes(h)),
        ...(d.local ? [makeHost(d.local, "private")] : []),
        ...d.publicDomains.map(p => makeHost(p.host, "public", p.serverId)),
      ],
    });
    setDraft(null);
  };

  return (
    <div className="stack">
      <PageHeader
        page="servers"
        actions={
          <>
            <button type="button" className="btn" onClick={onAdvanced}>
              <Icon name="route" />
              Маршрутизация
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => edit()}
              disabled={busy}
            >
              <Icon name="plus" />
              Добавить сервис
            </button>
          </>
        }
      >
        {count(doc.apps.length, ["сервис", "сервиса", "сервисов"])},{" "}
        {count(doc.hosts.length, ["домен", "домена", "доменов"])}. Приложения и их
        домены для доступа из дома и извне.
      </PageHeader>
      <div className="toolbar">
        <SearchInput
          label="Поиск сервиса"
          placeholder="Название, домен или адрес"
          value={search}
          onChange={setSearch}
          meta={needle ? `${rows.length} из ${doc.apps.length}` : undefined}
        />
        <Segmented
          label="Доступ"
          value={access}
          onChange={setAccess}
          options={[
            { value: "all", label: "Все", count: doc.apps.length },
            { value: "local", label: "Локальные", count: doc.apps.length - publicCount },
            { value: "public", label: "С внешним доступом", count: publicCount },
          ]}
        />
      </div>

      <section className="card card-flush">
        {rows.length ? (
          <div className="table-wrap">
            <table className="table responsive services-table">
              <thead>
                <tr>
                  <th>Сервис</th>
                  <th>Приложение</th>
                  <th>Домены</th>
                  <th className="col-access">Доступ</th>
                  <th className="col-actions">
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((app) => {
                  const hosts = hostsByApp.get(app.id) || [];
                  return (
                    <tr key={app.id}>
                      <td className="cell-primary" data-label="">
                        <div className="cell-title">
                          <AppAvatar app={app} />
                          <div>
                            <strong className="break">{app.name || app.id}</strong>
                            <span className="cell-sub mono">{app.id}</span>
                          </div>
                        </div>
                      </td>
                      <td data-label="Приложение">
                        <span className="mono">
                          {app.upstream.address}:{app.upstream.port}
                        </span>
                        <span className="cell-sub">
                          {app.upstream.scheme.toUpperCase()}
                        </span>
                      </td>
                      <td data-label="Домены">
                        <DomainChips hosts={hosts} />
                      </td>
                      <td className="cell-aside col-access" data-label="Доступ">
                        <AccessBadge hosts={hosts} />
                      </td>
                      <td className="col-actions">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            aria-label={`Изменить ${app.name || app.id}`}
                            title="Изменить"
                            onClick={() => edit(app)}
                            disabled={busy}
                          >
                            <Icon name="edit" size={14} />
                            <span className="btn-label">Изменить</span>
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-icon btn-danger-ghost"
                            aria-label={`Удалить ${app.name}`}
                            title="Удалить из черновика"
                            onClick={() => setRemove(app)}
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
          <EmptyState
            icon={needle || access !== "all" ? "search" : "servers"}
            title={needle || access !== "all" ? "Ничего не найдено" : "Добавьте первый сервис"}
            action={
              needle || access !== "all" ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setSearch("");
                    setAccess("all");
                  }}
                >
                  Сбросить фильтры
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => edit()}>
                  <Icon name="plus" />
                  Добавить сервис
                </button>
              )
            }
          >
            {needle || access !== "all"
              ? "Попробуйте другое название, домен или адрес."
              : "Укажите адрес приложения и его домены — менеджер создаст маршруты для локального и внешнего доступа."}
          </EmptyState>
        )}
        <div className="card-footer">
          KeenDNS и VPS используют отдельные входы HomeNet. Источник внешних запросов виден в статистике и журнале. Дополнительные настройки TLS и портов —{" "}
          <button type="button" className="link-button" onClick={onAdvanced}>
            в маршрутизации
          </button>
          .
        </div>
      </section>

      <PublicServers />
      <ServiceWizard
        servers={publicServers}
        draft={draft}
        editing={editing}
        error={error}
        onDraft={setDraft}
        onClose={() => setDraft(null)}
        onSubmit={commit}
      />

      <ConfirmDialog
        open={!!remove}
        title={`Удалить «${remove?.name || remove?.id}»?`}
        confirmLabel="Удалить из черновика"
        onClose={() => setRemove(null)}
        onConfirm={() => {
          if (remove)
            onChange({
              ...doc,
              apps: doc.apps.filter((a) => a.id !== remove.id),
              hosts: doc.hosts.filter((h) => h.app_id !== remove.id),
            });
          setRemove(null);
        }}
      >
        Сервис и{" "}
        {count(doc.hosts.filter((h) => h.app_id === remove?.id).length, [
          "связанный домен",
          "связанных домена",
          "связанных доменов",
        ])}{" "}
        будут удалены из черновика. На роутере ничего не изменится до применения.
      </ConfirmDialog>

    </div>
  );
}

function ServiceWizard({
  servers,
  draft,
  editing,
  error,
  onDraft,
  onClose,
  onSubmit,
}: {
  servers: PublicServerItem[];
  draft: ServiceDraft | null;
  editing: boolean;
  error: string;
  onDraft: (draft: ServiceDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const formId = "service-wizard";
  return (
    <Modal
      open={!!draft}
      onClose={onClose}
      size="lg"
      autoFocusBody
      title={editing ? "Изменить сервис" : "Новый сервис"}
      description="Приложение, его домены и вход для внешнего трафика. Изменения попадут в черновик."
      footer={
        <>
          <span className="foot-note">Затем сохраните черновик и примените его.</span>
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" form={formId} className="btn btn-primary">
            {editing ? "Обновить черновик" : "Добавить в черновик"}
          </button>
        </>
      }
    >
      {draft ? (
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <section className="form-section">
            <div className="form-section-head">
              <h3>Приложение</h3>
              <p>Куда прокси передаёт запросы</p>
            </div>
            <Field label="Название">
              <input
                required
                placeholder="Например, Sublab"
                value={draft.name}
                onChange={(e) => onDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <div className="form-grid cols-upstream">
              <Field label="IP-адрес или имя хоста">
                <input
                  required
                  className="mono"
                  placeholder="192.168.99.20"
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={draft.address}
                  onChange={(e) => onDraft({ ...draft, address: e.target.value })}
                />
              </Field>
              <Field label="Порт">
                <input
                  required
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="65535"
                  value={draft.port}
                  onChange={(e) => onDraft({ ...draft, port: +e.target.value })}
                />
              </Field>
              <Field label="Протокол">
                <select
                  value={draft.scheme}
                  onChange={(e) =>
                    onDraft({ ...draft, scheme: e.target.value as "http" | "https" })
                  }
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                </select>
              </Field>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <h3>Домены</h3>
              <p>Нужен хотя бы один</p>
            </div>
            <div className="form-grid">
              <Field
                label="Локальный домен"
                hint="Для .local часть устройств использует mDNS; для обычного DNS надёжнее .home.arpa."
              >
                <input
                  className="mono"
                  placeholder="sub.local"
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={draft.local}
                  onChange={(e) => onDraft({ ...draft, local: e.target.value })}
                />
              </Field>
              <div className="public-domain-list">
                {draft.publicDomains.map((pub, i) => <div className="public-domain-row" key={i}>
                  <Field label={`Публичный домен ${i + 1}`}>
                    <input aria-label={`Публичный домен ${i + 1}`} className="mono" autoCapitalize="none" autoCorrect="off" placeholder="app.cdn6.ru" value={pub.host} onChange={e => onDraft({ ...draft, publicDomains: draft.publicDomains.map((p, n) => n === i ? { ...p, host: e.target.value } : p) })} />
                  </Field>
                  <Field label="Публиковать через">
                    <select aria-label={`Сервер домена ${i + 1}`} value={pub.serverId} onChange={e => onDraft({ ...draft, publicDomains: draft.publicDomains.map((p, n) => n === i ? { ...p, serverId: e.target.value } : p) })}>
                      <option value="">KeenDNS · {PUBLIC_DOMAIN_SUFFIX}</option>
                      {servers.map(({ server }) => <option key={server.id} value={server.id}>{server.name} · {server.address}</option>)}
                      {pub.serverId && pub.serverId !== "manual" && !servers.some(s => s.server.id === pub.serverId) && <option value={pub.serverId}>Недоступный сервер: {pub.serverId}</option>}
                      {pub.serverId === "manual" && <option value="manual">Существующая настройка</option>}
                    </select>
                  </Field>
                  {!pub.serverId && <Field label="Внешний порт"><input aria-label={`Внешний порт домена ${i + 1}`} value={pub.externalPort} placeholder="auto_random" onChange={e => onDraft({ ...draft, publicDomains: draft.publicDomains.map((p, n) => n === i ? { ...p, externalPort: e.target.value } : p) })} /></Field>}
                  <button type="button" className="btn btn-icon" aria-label={`Удалить домен ${i + 1}`} onClick={() => onDraft({ ...draft, publicDomains: draft.publicDomains.filter((_, n) => n !== i) })}><Icon name="trash" /></button>
                </div>)}
                <button type="button" className="btn" onClick={() => onDraft({ ...draft, publicDomains: [...draft.publicDomains, { host: "", serverId: servers[0]?.server.id || "", externalPort: "auto_random" }] })}><Icon name="plus" />Добавить публичный домен</button>
                <p className="field-hint">Для VPS укажите полное имя. DNS A/AAAA должен указывать на выбранный сервер; можно настроить wildcard всей зоны. Подключить сервер можно в разделе «Публичные серверы» под списком сервисов или в «Машины → Настройка».</p>
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <h3>Входной прокси</h3>
              <p>Адрес, на который указывают DNS-записи</p>
            </div>
            <div className="form-grid">
              <Field label="Локальный IP прокси">
                <input
                  required={!!draft.local || draft.publicDomains.some(p => !p.serverId)}
                  className="mono"
                  inputMode="decimal"
                  placeholder="192.168.1.2"
                  value={draft.proxyIp}
                  onChange={(e) => onDraft({ ...draft, proxyIp: e.target.value })}
                />
              </Field>
            </div>
            <RoutePreview draft={draft} />
            <p className="field-hint">
              VPS обслуживает HTTPS и автоматически продлевает сертификаты. Домашний туннель восстанавливается после обрыва и перезапуска HomeNet. Настройка начинается после применения маршрутов; её состояние видно в карточке сервера.
            </p>
          </section>

          {error ? (
            <div style={{ marginTop: 16 }}>
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}
        </form>
      ) : null}
    </Modal>
  );
}

function RoutePreview({ draft }: { draft: ServiceDraft }) {
  const domain =
    draft.publicDomains[0]?.host || draft.local || "домен";
  return (
    <div className="route-preview" aria-label="Схема маршрута">
      <div>
        <small>Домен</small>
        <span className="mono">{domain}</span>
      </div>
      <Icon name="arrowRight" />
      <div>
        <small>Прокси</small>
        <span className="mono">{draft.proxyIp || "—"}</span>
      </div>
      <Icon name="arrowRight" />
      <div>
        <small>Приложение</small>
        <span className="mono">
          {draft.scheme}://{draft.address || "—"}:{draft.port || "—"}
        </span>
      </div>
    </div>
  );
}
