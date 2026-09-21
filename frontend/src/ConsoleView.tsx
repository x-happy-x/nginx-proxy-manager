import { useEffect, useState, type ReactNode } from "react";
import { fetchStats, type ProxyStats } from "./api";
import type {
  NginxStatus,
  RouteApp,
  RouteHost,
  RouteLogItem,
  RoutesDocument,
} from "./types";
import { ModalShell } from "./components/ui";

export function Glyph({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    servers: (
      <>
        <rect x="3" y="3" width="18" height="7" rx="2" />
        <rect x="3" y="14" width="18" height="7" rx="2" />
        <path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" />
      </>
    ),
    logs: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h3" />
      </>
    ),
    dns: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z" />
      </>
    ),
    certs: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    advanced: (
      <>
        <path d="M4 6h16M4 12h16M4 18h16" />
        <circle cx="9" cy="6" r="2" />
        <circle cx="15" cy="12" r="2" />
        <circle cx="8" cy="18" r="2" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7Z" />,
    dms: (
      <>
        <path d="m12 3 9 5-9 5-9-5ZM3 8v9l9 5 9-5V8M12 13v9" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.advanced}
    </svg>
  );
}
export const number = (value: number | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(
        value,
      );
export function bytes(value: number | undefined) {
  if (value == null) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let i = 0;
  while (value >= 1024 && i < 3) {
    value /= 1024;
    i++;
  }
  return `${number(value)} ${units[i]}`;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <Glyph name="servers" size={28} />
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
export function StatusPill({ status }: { status: NginxStatus | null }) {
  return (
    <span className={`status-pill ${status?.running ? "good" : "neutral"}`}>
      <i />
      {status
        ? status.running
          ? "Прокси работает"
          : "Прокси остановлен"
        : "Нет данных о прокси"}
    </span>
  );
}

export function Dashboard({
  doc,
  status,
  onServices,
  onLogs,
}: {
  doc: RoutesDocument;
  status: NginxStatus | null;
  onServices: () => void;
  onLogs: () => void;
}) {
  const [window, setWindow] = useState("24h"),
    [traffic, setTraffic] = useState(""),
    [host, setHost] = useState("");
  const [stats, setStats] = useState<ProxyStats | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [updated, setUpdated] = useState<Date | null>(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (document.hidden) return;
      setLoading(true);
      try {
        const result = await fetchStats(window, host, traffic);
        if (active) {
          setStats(result.stats);
          setError("");
          setUpdated(new Date());
        }
      } catch (e) {
        if (active) setError(String(e instanceof Error ? e.message : e));
      } finally {
        if (active) setLoading(false);
      }
    };
    setStats(null);
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [window, host, traffic, refresh]);
  const max = Math.max(
    1,
    ...(stats?.series || []).map((item) => item.requests),
  );
  const success = stats?.total_requests
    ? 100 - ((stats.errors_4xx + stats.errors_5xx) / stats.total_requests) * 100
    : null;
  const points = (stats?.series || [])
    .map(
      (item, i, arr) =>
        `${(i / Math.max(1, arr.length - 1)) * 1000},${178 - (item.requests / max) * 145}`,
    )
    .join(" ");
  const trafficItems = [
    { name: "Локальный", value: stats?.traffic.local || 0, color: "mint" },
    { name: "Внешний", value: stats?.traffic.external || 0, color: "blue" },
    { name: "Не определён", value: stats?.traffic.unknown || 0, color: "gray" },
  ];
  return (
    <div className="view-stack">
      <div className="dashboard-toolbar">
        <div className="live-caption">
          <span className="live-dot" />
          Обновление каждые 30 секунд
          {updated && (
            <span className="muted">
              {" "}
              · {updated.toLocaleTimeString("ru-RU")}
            </span>
          )}
        </div>
        <div className="segmented" aria-label="Период статистики">
          {[
            ["1h", "1 час"],
            ["6h", "6 часов"],
            ["24h", "24 часа"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={window === key ? "selected" : ""}
              onClick={() => setWindow(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <div role="alert" className="notice error">
          <strong>Статистика недоступна</strong>
          <span>{error}</span>
          <button onClick={() => setRefresh((n) => n + 1)}>Повторить</button>
        </div>
      )}
      <div className="metrics-grid">
        <Metric
          label="Всего запросов"
          value={number(stats?.total_requests)}
          detail={
            stats
              ? `${number(stats.requests_per_minute)} запросов / мин`
              : "По журналу прокси"
          }
          icon="logs"
        />
        <Metric
          label="Успешные ответы"
          value={success == null ? "—" : `${number(success)}%`}
          detail={
            stats
              ? `${number(stats.errors_4xx)} ошибок 4xx · ${number(stats.errors_5xx)} ошибок 5xx`
              : "Ответы без ошибок 4xx и 5xx"
          }
          icon="certs"
        />
        <Metric
          label="Задержка p95"
          value={
            stats?.total_requests
              ? `${stats.p95_approximate || stats.sample.p95_approximate ? "≈ " : ""}${number(stats.p95_latency_ms)} мс`
              : "—"
          }
          detail={
            stats?.total_requests
              ? `Средняя ${number(stats.avg_latency_ms)} мс`
              : "Время обработки запроса"
          }
          icon="bolt"
        />
        <Metric
          label="Передано клиентам"
          value={bytes(stats?.bytes_sent)}
          detail="Размер тела HTTP-ответов"
          icon="arrow"
        />
      </div>
      <div className="analytics-grid">
        <section className="surface chart-panel">
          <div className="panel-heading">
            <div>
              <h2>Активность прокси</h2>
              <p>Запросы и ошибки за выбранный период</p>
            </div>
            <span className="chart-legend">
              <i />
              Запросы <i className="error-dot" />
              Ошибки
            </span>
          </div>
          <div className="chart-filters">
            <select
              aria-label="Домен статистики"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            >
              <option value="">Все домены</option>
              {doc.hosts.map((item, i) => (
                <option key={i}>{item.host}</option>
              ))}
            </select>
            <select
              aria-label="Источник трафика"
              value={traffic}
              onChange={(e) => setTraffic(e.target.value)}
            >
              <option value="">Весь трафик</option>
              <option value="local">Локальный</option>
              <option value="external">Внешний</option>
            </select>
          </div>
          {stats?.total_requests ? (
            <div className="chart">
              <div className="chart-y">
                <span>{number(max)}</span>
                <span>{number(max / 2)}</span>
                <span>0</span>
              </div>
              <svg
                viewBox="0 0 1000 200"
                preserveAspectRatio="none"
                role="img"
                aria-label={`График: ${number(stats.total_requests)} запросов`}
              >
                <defs>
                  <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                    <stop stopColor="#72dcb2" stopOpacity=".19" />
                    <stop offset="1" stopColor="#72dcb2" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[33, 105, 178].map((y) => (
                  <line
                    key={y}
                    x1="0"
                    x2="1000"
                    y1={y}
                    y2={y}
                    stroke="#2a3435"
                    strokeDasharray="3 6"
                  />
                ))}
                <polygon
                  points={`0,178 ${points} 1000,178`}
                  fill="url(#area)"
                />
                <polyline
                  points={points}
                  fill="none"
                  stroke="#72dcb2"
                  strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                />
                <polyline
                  points={stats.series
                    .map(
                      (item, i, arr) =>
                        `${(i / Math.max(1, arr.length - 1)) * 1000},${178 - (item.errors / max) * 145}`,
                    )
                    .join(" ")}
                  fill="none"
                  stroke="#e5a786"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <div className="chart-x">
                {[stats.from, stats.to].map((time, i) => (
                  <span key={i}>
                    {new Date(time).toLocaleTimeString("ru-RU", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <Empty
              title={loading ? "Загружаем статистику…" : "Запросов пока нет"}
            >
              График появится после первых обращений к сервисам. Данные берутся
              из журнала nginx.
            </Empty>
          )}
          <div className="panel-foot">
            {stats?.sample.source === "persistent" ? (
              <>
                Накопленная статистика · шаг{" "}
                {number((stats.sample.resolution_seconds || 60) / 60)} мин.{" "}
                {stats.sample.coverage_from
                  ? `Сбор с ${new Date(stats.sample.coverage_from).toLocaleString("ru-RU")}. `
                  : ""}
                {stats.sample.truncated
                  ? "Данные за выбранный период неполные. "
                  : ""}
                {stats.sample.backlog_bytes
                  ? `Ожидает обработки: ${bytes(stats.sample.backlog_bytes)}. `
                  : ""}
                {stats.sample.gaps?.length
                  ? `Пропусков сбора: ${stats.sample.gaps.length}. `
                  : ""}
                {stats.sample.persisted === false
                  ? "Ожидается первое сохранение. "
                  : ""}
                {stats.p95_approximate || stats.sample.p95_approximate
                  ? "p95 — оценка по гистограмме. "
                  : ""}
                {stats.sample.persistence_error ? (
                  <span role="alert" className="warn-text">
                    Ошибка сохранения статистики:{" "}
                    {stats.sample.persistence_error}.{" "}
                  </span>
                ) : null}
              </>
            ) : stats ? (
              <>
                {stats.sample.truncated
                  ? `Показана выборка последних ${bytes(stats.sample.max_bytes)} журнала: данные за период неполные. `
                  : "В пределах сохранённого журнала. "}
                Исторические данные зависят от ротации логов.{" "}
              </>
            ) : null}
            {stats?.sample.malformed_lines
              ? `Не удалось прочитать строк: ${stats.sample.malformed_lines}. `
              : ""}
          </div>
        </section>
        <section className="surface traffic-panel">
          <div className="panel-heading">
            <div>
              <h2>Откуда трафик</h2>
              <p>Разделение по входному порту</p>
            </div>
            <Glyph name="dns" />
          </div>
          <div className="traffic-total">
            <strong>{number(stats?.total_requests)}</strong>
            <span>обращений</span>
          </div>
          <div className="traffic-bar">
            {trafficItems.map((item) => (
              <div
                key={item.name}
                className={item.color}
                style={{
                  width: `${stats?.total_requests ? (item.value / stats.total_requests) * 100 : 0}%`,
                }}
              />
            ))}
          </div>
          <div className="traffic-list">
            {trafficItems.map((item) => (
              <div key={item.name}>
                <span>
                  <i className={item.color} />
                  {item.name}
                </span>
                <strong>{number(item.value)}</strong>
                <small>
                  {stats?.total_requests
                    ? number((item.value / stats.total_requests) * 100)
                    : "0"}
                  %
                </small>
              </div>
            ))}
          </div>
          <p className="quiet-note">
            Внешние запросы приходят через выделенный порт KeenDNS. Для старых
            записей источник может быть неизвестен.
          </p>
        </section>
      </div>
      <div className="analytics-grid">
        <section className="surface">
          <div className="panel-heading">
            <div>
              <h2>Нагрузка по доменам</h2>
              <p>Наиболее активные маршруты</p>
            </div>
            <button className="text-button" onClick={onLogs}>
              Журнал <Glyph name="arrow" size={16} />
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Домен</th>
                  <th className="numeric">Запросы</th>
                  <th className="numeric">Ошибки</th>
                  <th className="numeric">Среднее</th>
                </tr>
              </thead>
              <tbody>
                {stats?.hosts.slice(0, 6).map((item) => (
                  <tr key={item.host}>
                    <td className="mono">{item.host}</td>
                    <td className="numeric">{number(item.requests)}</td>
                    <td className={`numeric ${item.errors ? "warn-text" : ""}`}>
                      {number(item.errors)}
                    </td>
                    <td className="numeric muted">
                      {number(item.avg_latency_ms)} мс
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!stats?.hosts.length && (
              <p className="table-empty">
                За этот период нет данных по доменам
              </p>
            )}
          </div>
        </section>
        <section className="surface system-panel">
          <div className="panel-heading">
            <div>
              <h2>Состояние системы</h2>
              <p>Работающий экземпляр на роутере</p>
            </div>
            <Glyph name="servers" />
          </div>
          <StatusPill status={status} />
          <dl className="facts">
            <div>
              <dt>Сервисы / домены</dt>
              <dd>
                {doc.apps.length} / {doc.hosts.length}
              </dd>
            </div>
            <div>
              <dt>Память nginx</dt>
              <dd>{status ? bytes(status.rss_kb * 1024) : "—"}</dd>
            </div>
            <div>
              <dt>Версия</dt>
              <dd>{status?.version || "—"}</dd>
            </div>
            <div>
              <dt>Входные порты</dt>
              <dd>
                {Array.from(
                  new Set(
                    status?.parsed_listeners.map((item) => item.port) || [],
                  ),
                ).join(", ") || "—"}
              </dd>
            </div>
          </dl>
          <button className="full-button" onClick={onServices}>
            Управление сервисами <Glyph name="arrow" size={16} />
          </button>
        </section>
      </div>
    </div>
  );
}
function Metric({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: string;
}) {
  return (
    <article className="surface metric">
      <div>
        <span>{label}</span>
        <Glyph name={icon} size={18} />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

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
  const [search, setSearch] = useState(""),
    [draft, setDraft] = useState<ServiceDraft | null>(null),
    [editing, setEditing] = useState(false),
    [error, setError] = useState("");
  const [remove, setRemove] = useState<RouteApp | null>(null);
  const rows = doc.apps.filter((app) =>
    `${app.name} ${app.upstream.address} ${doc.hosts
      .filter((host) => host.app_id === app.id)
      .map((host) => host.host)
      .join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const edit = (app?: RouteApp) => {
    const hosts = doc.hosts.filter((h) => h.app_id === app?.id);
    const external = hosts.find((h) => h.kind === "public");
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
      public: external?.host || "",
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
      public: draft.public.trim().toLowerCase(),
      proxyIp: draft.proxyIp.trim(),
    };
    const domains = [d.local, d.public].filter(Boolean);
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
        current.find((h) => h.kind === "public"),
      ].filter(Boolean) as RouteHost[];
    const makeHost = (
      domain: string,
      kind: "private" | "public",
    ): RouteHost => {
      const original = managed.find((h) => h.kind === kind);
      const endpoints = original?.endpoints?.map((ep) => ({
        ...ep,
        listen: { ...ep.listen },
        behavior: { ...ep.behavior },
      })) || [
        {
          name: "web",
          listen: {
            protocol:
              kind === "public" ? ("https" as const) : ("http" as const),
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
          port:
            d.externalPort === "auto_random" ? "auto_random" : +d.externalPort,
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
          publish: Array.from(
            new Set([...(original?.dns?.publish || []), "local"]),
          ),
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
        ...(d.public ? [makeHost(d.public, "public")] : []),
      ],
    });
    setDraft(null);
  };
  return (
    <div className="view-stack">
      <div className="service-toolbar">
        <label className="search-input">
          <Glyph name="search" size={18} />
          <input
            aria-label="Поиск сервиса"
            placeholder="Найти сервис, домен или IP…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="button-group">
          <button onClick={onAdvanced}>Расширенные настройки</button>
          <button className="primary" disabled={busy} onClick={() => edit()}>
            <Glyph name="plus" size={18} />
            Добавить сервис
          </button>
        </div>
      </div>
      <div className="surface services-table">
        <div className="panel-heading">
          <h2>
            Сервисы <span className="count">{doc.apps.length}</span>
          </h2>
          <span className="muted">Один сервис — несколько доменов</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Сервис</th>
                <th>Назначение</th>
                <th>Домены</th>
                <th>Доступ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((app) => {
                const hosts = doc.hosts.filter((h) => h.app_id === app.id);
                return (
                  <tr key={app.id}>
                    <td>
                      <div className="service-name">
                        <div className="service-avatar">
                          {app.ui?.icon_data_url ? (
                            <img src={String(app.ui.icon_data_url)} alt="" />
                          ) : (
                            app.name.slice(0, 2).toUpperCase()
                          )}
                        </div>
                        <div>
                          <strong>{app.name || app.id}</strong>
                          <small>{app.id}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="mono">
                        {app.upstream.address}:{app.upstream.port}
                      </span>
                      <small className="subtext">
                        {app.upstream.scheme.toUpperCase()} upstream
                      </small>
                    </td>
                    <td>
                      <div className="domain-list">
                        {hosts.map((host, i) => (
                          <span key={i}>
                            <Glyph
                              name={host.kind === "public" ? "dns" : "servers"}
                              size={14}
                            />
                            {host.host}
                          </span>
                        ))}
                        {!hosts.length && (
                          <span className="muted">Домен не назначен</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span
                        className={`badge ${hosts.some((h) => h.kind === "public") ? "blue" : "subtle"}`}
                      >
                        {hosts.some((h) => h.kind === "public")
                          ? "Локальный + внешний"
                          : "Локальный"}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          aria-label={`Изменить ${app.name}`}
                          onClick={() => edit(app)}
                          disabled={busy}
                        >
                          Изменить
                        </button>
                        <button
                          className="icon-plain"
                          aria-label={`Удалить ${app.name}`}
                          onClick={() => setRemove(app)}
                          disabled={busy}
                        >
                          <Glyph name="close" size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && (
            <Empty
              title={search ? "Ничего не найдено" : "Добавьте первый сервис"}
            >
              {search
                ? "Попробуйте другое название, домен или адрес."
                : "Укажите адрес приложения и его домены. Менеджер создаст маршруты для локального и внешнего доступа."}
            </Empty>
          )}
        </div>
      </div>
      <div className="info-strip">
        <Glyph name="dns" />
        <p>
          Оба домена внутри сети ведут на локальный прокси. Для внешнего доступа
          KeenDNS использует отдельный порт — источник запроса виден в
          статистике и журнале.
        </p>
      </div>
      <ModalShell open={!!draft} onClose={() => setDraft(null)} size="big">
        {draft && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              commit();
            }}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">МАРШРУТИЗАЦИЯ</span>
                <h2>{editing ? "Изменить сервис" : "Новый сервис"}</h2>
                <p>Приложение, домены и вход для внешнего трафика.</p>
              </div>
              <button
                type="button"
                className="icon-plain"
                aria-label="Закрыть"
                onClick={() => setDraft(null)}
              >
                <Glyph name="close" />
              </button>
            </div>
            <div className="form-section">
              <h3>
                <span>01</span> Приложение
              </h3>
              <label>
                Название
                <input
                  required
                  autoFocus
                  placeholder="Sublab"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <div className="form-grid-three">
                <label>
                  IP или имя хоста
                  <input
                    required
                    placeholder="192.168.99.20"
                    value={draft.address}
                    onChange={(e) =>
                      setDraft({ ...draft, address: e.target.value })
                    }
                  />
                </label>
                <label>
                  Порт
                  <input
                    required
                    type="number"
                    min="1"
                    max="65535"
                    value={draft.port}
                    onChange={(e) =>
                      setDraft({ ...draft, port: +e.target.value })
                    }
                  />
                </label>
                <label>
                  Протокол
                  <select
                    value={draft.scheme}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        scheme: e.target.value as "http" | "https",
                      })
                    }
                  >
                    <option>http</option>
                    <option>https</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="form-section">
              <h3>
                <span>02</span> Домены
              </h3>
              <div className="row-2">
                <label>
                  Локальный домен
                  <input
                    placeholder="sub.local"
                    value={draft.local}
                    onChange={(e) =>
                      setDraft({ ...draft, local: e.target.value })
                    }
                  />
                </label>
                <label>
                  Публичный домен
                  <input
                    placeholder="sub.crubs.crazedns.ru"
                    value={draft.public}
                    onChange={(e) =>
                      setDraft({ ...draft, public: e.target.value })
                    }
                  />
                </label>
              </div>
              <p className="quiet-note">
                Локальные записи DNS создаются для обоих доменов. Имя .local
                использует mDNS на некоторых устройствах; для обычного DNS
                рекомендуется .home.arpa.
              </p>
            </div>
            <div className="form-section">
              <h3>
                <span>03</span> Входной прокси
              </h3>
              <div className="row-2">
                <label>
                  Локальный IP прокси
                  <input
                    required
                    placeholder="192.168.1.2"
                    value={draft.proxyIp}
                    onChange={(e) =>
                      setDraft({ ...draft, proxyIp: e.target.value })
                    }
                  />
                </label>
                {draft.public && (
                  <label>
                    Порт внешнего входа
                    <input
                      placeholder="auto_random"
                      value={draft.externalPort}
                      onChange={(e) =>
                        setDraft({ ...draft, externalPort: e.target.value })
                      }
                    />
                  </label>
                )}
              </div>
              <div className="route-preview">
                <span>{draft.public || draft.local || "домен"}</span>
                <Glyph name="arrow" size={16} />
                <span>{draft.proxyIp || "прокси"}</span>
                <Glyph name="arrow" size={16} />
                <span>
                  {draft.address || "приложение"}:{draft.port}
                </span>
              </div>
              <p className="quiet-note">
                Локальный домен использует HTTP. Публичный домен внутри сети
                использует HTTPS с сертификатом Keenetic; внешний HTTPS
                обслуживает KeenDNS. Дополнительные настройки TLS доступны в
                маршрутизации.
              </p>
            </div>
            {error && (
              <div role="alert" className="notice error">
                {error}
              </div>
            )}
            <div className="modal-footer">
              <span>Сначала черновик, затем проверка и применение</span>
              <button type="button" onClick={() => setDraft(null)}>
                Отмена
              </button>
              <button className="primary" type="submit">
                {editing ? "Обновить черновик" : "Добавить в черновик"}
              </button>
            </div>
          </form>
        )}
      </ModalShell>
      <ModalShell open={!!remove} onClose={() => setRemove(null)}>
        <div className="modal-heading">
          <div>
            <h2>Удалить {remove?.name}?</h2>
            <p>Сервис и связанные домены будут удалены из черновика.</p>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={() => setRemove(null)}>Отмена</button>
          <button
            className="danger"
            onClick={() => {
              if (remove)
                onChange({
                  ...doc,
                  apps: doc.apps.filter((a) => a.id !== remove.id),
                  hosts: doc.hosts.filter((h) => h.app_id !== remove.id),
                });
              setRemove(null);
            }}
          >
            Удалить из черновика
          </button>
        </div>
      </ModalShell>
    </div>
  );
}

export function RequestLog({
  items,
  filter,
  onFilter,
  mode,
  onMode,
  limit,
  onLimit,
  busy,
  onRefresh,
}: {
  items: RouteLogItem[];
  filter: string;
  onFilter: (s: string) => void;
  mode: "all" | "4xx" | "5xx" | "errors";
  onMode: (m: "all" | "4xx" | "5xx" | "errors") => void;
  limit: number;
  onLimit: (n: number) => void;
  busy: boolean;
  onRefresh: () => void;
}) {
  const [source, setSource] = useState(""),
    [selected, setSelected] = useState<RouteLogItem | null>(null);
  const visible = items.filter(
    (item) => !source || String(item.traffic || "unknown") === source,
  );
  const download = () => {
    const blob = new Blob(
      [visible.map((item) => JSON.stringify(item)).join("\n")],
      { type: "application/x-ndjson" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `proxy-requests-${new Date().toISOString().slice(0, 10)}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="view-stack">
      <div className="service-toolbar">
        <form
          className="search-input"
          onSubmit={(e) => {
            e.preventDefault();
            onRefresh();
          }}
        >
          <Glyph name="search" size={18} />
          <input
            aria-label="Фильтр журнала"
            placeholder="Поиск по домену, IP или пути…"
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
          />
        </form>
        <div className="button-group">
          <button onClick={download} disabled={!visible.length}>
            Экспорт JSONL
          </button>
          <button onClick={onRefresh} disabled={busy}>
            <Glyph name="refresh" size={16} />
            Обновить
          </button>
        </div>
      </div>
      <div className="surface">
        <div className="log-toolbar">
          <div className="segmented">
            {(["all", "4xx", "5xx", "errors"] as const).map((item) => (
              <button
                key={item}
                className={item === mode ? "selected" : ""}
                onClick={() => onMode(item)}
              >
                {
                  {
                    all: "Все запросы",
                    "4xx": "Ошибки 4xx",
                    "5xx": "Ошибки 5xx",
                    errors: "Все ошибки",
                  }[item]
                }
              </button>
            ))}
          </div>
          <div className="button-group">
            <select
              aria-label="Источник запросов"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">Все источники</option>
              <option value="local">Локальный</option>
              <option value="external">Внешний</option>
              <option value="unknown">Не определён</option>
            </select>
            <select
              aria-label="Количество записей"
              value={limit}
              onChange={(e) => onLimit(+e.target.value)}
            >
              {[100, 200, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n} записей
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table className="request-table">
            <thead>
              <tr>
                <th>Время</th>
                <th>Источник</th>
                <th>Запрос</th>
                <th>Статус</th>
                <th>Назначение</th>
                <th className="numeric">Время</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item, i) => (
                <tr
                  key={i}
                  tabIndex={0}
                  onClick={() => setSelected(item)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setSelected(item);
                  }}
                >
                  <td className="mono muted">
                    {String(item.time || item.time_local || item.timestamp || "—")}
                  </td>
                  <td>
                    <span
                      className={`badge ${item.traffic === "external" ? "blue" : item.traffic === "local" ? "mint" : "subtle"}`}
                    >
                      {item.traffic === "external"
                        ? "Внешний"
                        : item.traffic === "local"
                          ? "Локальный"
                          : "Не определён"}
                    </span>
                  </td>
                  <td>
                    <strong>{String(item.route_host || item.host || "—")}</strong>
                    <small className="request-uri">
                      <span>{String(item.method || item.request_method || "GET")}</span>{" "}
                      {String(item.uri || "/")}
                    </small>
                  </td>
                  <td>
                    <span
                      className={`http-status ${Number(item.status) >= 500 ? "bad" : Number(item.status) >= 400 ? "warn" : "good"}`}
                    >
                      {String(item.status || "—")}
                    </span>
                  </td>
                  <td className="mono muted">
                    {String(item.upstream_addr || "—")}
                  </td>
                  <td className="numeric mono">
                    {item.request_time_ms == null
                      ? "—"
                      : `${number(Number(item.request_time_ms))} мс`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && (
            <Empty title="Запросов не найдено">
              Измените фильтр или обновите журнал после обращения к сервису.
            </Empty>
          )}
        </div>
        <div className="panel-foot">
          {visible.length} записей · Нажмите на строку, чтобы увидеть
          подробности. Фильтр источника применяется к загруженной выборке.
        </div>
      </div>
      <ModalShell
        open={!!selected}
        onClose={() => setSelected(null)}
        size="big"
      >
        <div className="modal-heading">
          <div>
            <h2>Детали запроса</h2>
            <p>{String(selected?.host || "")}</p>
          </div>
          <button
            className="icon-plain"
            aria-label="Закрыть"
            onClick={() => setSelected(null)}
          >
            <Glyph name="close" />
          </button>
        </div>
        <pre className="log-detail">{JSON.stringify(selected, null, 2)}</pre>
      </ModalShell>
    </div>
  );
}
