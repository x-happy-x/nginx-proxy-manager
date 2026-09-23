import { useMemo, useState } from "react";
import type { RouteApp, RouteHost, RoutesDocument } from "../types";
import { Icon } from "../components/ui/Icon";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Alert, EmptyState, Field, SearchInput, Segmented } from "../components/ui/controls";
import { count, initials } from "../lib/format";
import { getWebEndpoint } from "../features/servers/lib/utils";
import { PageHeader } from "../navigation";

type ServiceDraft = {
  id: string;
  name: string;
  address: string;
  port: number;
  scheme: "http" | "https";
  local: string;
  public: string;
  proxyIp: string;
  externalPort: string;
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

function fullPublicDomain(label: string): string {
  return label ? `${label}.${PUBLIC_DOMAIN_SUFFIX}` : "";
}

function normalizePublicDomainInput(value: string): string {
  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\//, "").split(/[/:?#]/, 1)[0];
  if (normalized.endsWith(PUBLIC_DOMAIN_ENDING)) {
    normalized = normalized.slice(0, -PUBLIC_DOMAIN_ENDING.length);
  } else if (normalized === PUBLIC_DOMAIN_SUFFIX) {
    normalized = "";
  }
  return normalized.replace(/^\.+|\.+$/g, "");
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
    const ndns = external?.endpoints?.find((ep) => ep.behavior?.ndns_profile);
    setEditing(!!app);
    setError("");
    setDraft({
      id: app?.id || "",
      name: app?.name || "",
      address: app?.upstream.address || "",
      port: app?.upstream.port || 80,
      scheme: app?.upstream.scheme || "http",
      local: hosts.find((h) => h.kind === "private")?.host || "",
      public: external ? publicDomainLabel(external.host) : "",
      proxyIp:
        dnsHost?.dns?.local_record_ip && dnsHost.dns.local_record_ip !== "auto"
          ? dnsHost.dns.local_record_ip
          : doc.globals.listen_ips.find(
              (ip) => ip !== "0.0.0.0" && ip !== "::",
            ) || "",
      externalPort: String(ndns?.listen.port || "auto_random"),
    });
  };

  const commit = () => {
    if (!draft) return;
    const d = {
      ...draft,
      name: draft.name.trim(),
      address: draft.address.trim(),
      local: draft.local.trim().toLowerCase(),
      public: normalizePublicDomainInput(draft.public),
      proxyIp: draft.proxyIp.trim(),
    };
    const publicDomain = fullPublicDomain(d.public);
    const domains = [d.local, publicDomain].filter(Boolean);
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
    if (d.public && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(d.public)) {
      setError(
        `Укажите один поддомен: только латинские буквы, цифры и дефис. Зона ${PUBLIC_DOMAIN_SUFFIX} добавляется автоматически.`,
      );
      return;
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
      !d.proxyIp ||
      !/^(\d{1,3}\.){3}\d{1,3}$/.test(d.proxyIp) ||
      d.proxyIp.split(".").some((part) => Number(part) > 255)
    ) {
      setError("Укажите локальный IPv4-адрес прокси, например 192.168.1.2.");
      return;
    }
    if (
      d.public &&
      d.externalPort !== "auto_random" &&
      (!/^\d+$/.test(d.externalPort) ||
        +d.externalPort < 1024 ||
        +d.externalPort > 65535)
    ) {
      setError("Внешний вход: auto_random или порт от 1024 до 65535.");
      return;
    }
    const id = d.id || `service-${Date.now().toString(36)}`;
    const existing = doc.apps.find((app) => app.id === id);
    const app: RouteApp = {
      ...existing,
      id,
      name: d.name,
      upstream: { address: d.address, port: d.port, scheme: d.scheme },
    };
    // Keep all settings and additional host aliases on edit. Only the first local/public domain is managed here.
    const current = doc.hosts.filter((host) => host.app_id === id),
      managed = [
        current.find((h) => h.kind === "private"),
        current.find((h) => h.kind === "public" && !!publicDomainLabel(h.host)),
      ].filter(Boolean) as RouteHost[];
    const makeHost = (domain: string, kind: "private" | "public"): RouteHost => {
      const original = managed.find((h) => h.kind === kind);
      const endpoints = original?.endpoints?.map((ep) => ({
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
          port: d.externalPort === "auto_random" ? "auto_random" : +d.externalPort,
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
        app_id: id,
        kind,
        dns: {
          ...original?.dns,
          publish: Array.from(new Set([...(original?.dns?.publish || []), "local"])),
          local_record_ip: d.proxyIp,
        },
        tls: original?.tls || {
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
        ...(publicDomain ? [makeHost(publicDomain, "public")] : []),
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
          Внутри сети оба домена ведут на локальный прокси. Внешний доступ KeenDNS
          использует отдельный порт, поэтому источник запроса виден в статистике и журнале.
          Дополнительные домены, TLS и порты —{" "}
          <button type="button" className="link-button" onClick={onAdvanced}>
            в маршрутизации
          </button>
          .
        </div>
      </section>

      <ServiceWizard
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
  draft,
  editing,
  error,
  onDraft,
  onClose,
  onSubmit,
}: {
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
              <Field
                label="Публичный домен"
                hint="Введите только поддомен — зона KeenDNS закреплена."
              >
                <span className="input-group">
                  <input
                    aria-label="Поддомен публичного сервиса"
                    className="mono"
                    autoCapitalize="none"
                    autoCorrect="off"
                    inputMode="url"
                    maxLength={63}
                    pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                    placeholder="sub"
                    value={draft.public}
                    onChange={(e) =>
                      onDraft({ ...draft, public: normalizePublicDomainInput(e.target.value) })
                    }
                  />
                  <span className="input-addon">.{PUBLIC_DOMAIN_SUFFIX}</span>
                </span>
              </Field>
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
                  required
                  className="mono"
                  inputMode="decimal"
                  placeholder="192.168.1.2"
                  value={draft.proxyIp}
                  onChange={(e) => onDraft({ ...draft, proxyIp: e.target.value })}
                />
              </Field>
              {draft.public ? (
                <Field
                  label="Порт внешнего входа"
                  hint="auto_random — назначить свободный порт при сохранении."
                >
                  <input
                    className="mono"
                    placeholder="auto_random"
                    value={draft.externalPort}
                    onChange={(e) => onDraft({ ...draft, externalPort: e.target.value })}
                  />
                </Field>
              ) : null}
            </div>
            <RoutePreview draft={draft} />
            <p className="field-hint">
              Локальный домен работает по HTTP. Публичный домен внутри сети — по HTTPS с
              сертификатом Keenetic, внешний HTTPS обслуживает KeenDNS. Остальные настройки TLS —
              в маршрутизации.
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
    fullPublicDomain(normalizePublicDomainInput(draft.public)) || draft.local || "домен";
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
