import { useEffect, useMemo, useRef, useState } from "react";
import { fetchStats, type ProxyStats } from "../api";
import type { NginxStatus, RoutesDocument } from "../types";
import { Icon, type IconName } from "../components/ui/Icon";
import { Alert, EmptyState, Segmented } from "../components/ui/controls";
import { bytes, compact, count, ms, number, timeOf } from "../lib/format";
import { PageHeader } from "../navigation";

type Period = "1h" | "6h" | "24h";
type Traffic = "" | "local" | "external";

export function Dashboard({
  doc,
  status,
  onNavigate,
}: {
  doc: RoutesDocument;
  status: NginxStatus | null;
  onNavigate: (page: "servers" | "logs" | "system") => void;
}) {
  const [period, setPeriod] = useState<Period>("24h");
  const [host, setHost] = useState("");
  const [traffic, setTraffic] = useState<Traffic>("");
  const [stats, setStats] = useState<ProxyStats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async (visibleOnly: boolean) => {
      if (visibleOnly && document.hidden) return;
      setLoading(true);
      try {
        const result = await fetchStats(period, host, traffic);
        if (!active) return;
        setStats(result.stats);
        setError("");
        setUpdated(new Date());
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load(false);
    const timer = window.setInterval(() => void load(true), 30000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [period, host, traffic, reload]);

  const total = stats?.total_requests || 0;
  const errors = (stats?.errors_4xx || 0) + (stats?.errors_5xx || 0);
  const success = total ? 100 - (errors / total) * 100 : null;
  const hostOptions = useMemo(
    () => Array.from(new Set(doc.hosts.map((item) => item.host))).sort(),
    [doc.hosts],
  );
  const ports = Array.from(
    new Set(status?.parsed_listeners.map((item) => item.port) || []),
  ).sort((a, b) => a - b);

  return (
    <div className="stack">
      <PageHeader page="overview" />
      <div className="toolbar dashboard-filters">
        <Segmented
          label="Период"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "1h", label: "1 час" },
            { value: "6h", label: "6 часов" },
            { value: "24h", label: "24 часа" },
          ]}
        />
        <select
          aria-label="Домен"
          value={host}
          onChange={(event) => setHost(event.target.value)}
        >
          <option value="">Все домены</option>
          {hostOptions.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select
          aria-label="Источник трафика"
          value={traffic}
          onChange={(event) => setTraffic(event.target.value as Traffic)}
        >
          <option value="">Весь трафик</option>
          <option value="local">Локальный</option>
          <option value="external">Внешний</option>
        </select>
        <span className="spacer" />
        <span className="toolbar-meta">
          {loading ? <span className="spinner" aria-hidden="true" /> : null}
          {updated
            ? `Обновлено в ${updated.toLocaleTimeString("ru-RU")}`
            : "Загрузка…"}
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            aria-label="Обновить статистику"
            title="Обновить (автоматически каждые 30 секунд)"
            onClick={() => setReload((n) => n + 1)}
          >
            <Icon name="refresh" />
          </button>
        </span>
      </div>

      {error ? (
        <Alert
          tone="danger"
          title="Статистика недоступна"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setReload((n) => n + 1)}
            >
              Повторить
            </button>
          }
        >
          {error}
        </Alert>
      ) : null}

      <div className={`stats${loading && stats ? " is-refreshing" : ""}`}>
        <StatTile
          icon="activity"
          label="Запросы"
          value={compact(stats?.total_requests)}
          meta={
            stats
              ? `${number(stats.requests_per_minute)} в минуту`
              : "По журналу прокси"
          }
        />
        <StatTile
          icon="checkCircle"
          label="Успешные ответы"
          value={success == null ? "—" : `${number(success)}%`}
          meta={
            stats
              ? `${number(stats.errors_4xx)} × 4xx · ${number(stats.errors_5xx)} × 5xx`
              : "Без ошибок 4xx и 5xx"
          }
          tone={
            success == null
              ? undefined
              : success < 95
                ? "danger"
                : success < 99
                  ? "warning"
                  : "success"
          }
        />
        <StatTile
          icon="clock"
          label="Задержка p95"
          value={
            total
              ? `${stats?.p95_approximate || stats?.sample.p95_approximate ? "≈ " : ""}${ms(stats?.p95_latency_ms)}`
              : "—"
          }
          meta={total ? `Средняя ${ms(stats?.avg_latency_ms)}` : "Время обработки"}
        />
        <StatTile
          icon="download"
          label="Отдано клиентам"
          value={bytes(stats?.bytes_sent)}
          meta="Тела HTTP-ответов"
        />
      </div>

      <div className="dashboard-grid">
        <section className="card chart-card">
          <ActivityChart stats={stats} loading={loading} />
        </section>
        <section className="card">
          <div className="card-header">
            <div className="card-title">
              <h2>Источники трафика</h2>
              <p>По входному порту прокси</p>
            </div>
          </div>
          <div className="card-body">
            <TrafficBreakdown stats={stats} />
            <div className="divider" />
            <StatusBreakdown stats={stats} />
          </div>
        </section>
      </div>

      <div className="dashboard-grid">
        <section className="card card-flush">
          <div className="card-header">
            <div className="card-title">
              <h2>Нагрузка по доменам</h2>
              <p>Самые активные маршруты за период</p>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onNavigate("logs")}
            >
              Журнал запросов
              <Icon name="arrowRight" size={14} />
            </button>
          </div>
          <TopHosts stats={stats} />
        </section>
        <section className="card">
          <div className="card-header">
            <div className="card-title">
              <h2>Состояние прокси</h2>
              <p>Отдельный экземпляр nginx на роутере</p>
            </div>
            <StatusBadge status={status} />
          </div>
          <div className="card-body">
            <dl className="kv">
              <div>
                <dt>Сервисы</dt>
                <dd>{count(doc.apps.length, ["сервис", "сервиса", "сервисов"])}</dd>
              </div>
              <div>
                <dt>Домены</dt>
                <dd>{count(doc.hosts.length, ["домен", "домена", "доменов"])}</dd>
              </div>
              <div>
                <dt>Версия nginx</dt>
                <dd className="mono">{status?.version || "—"}</dd>
              </div>
              <div>
                <dt>Память</dt>
                <dd>{status ? bytes(status.rss_kb * 1024) : "—"}</dd>
              </div>
              <div>
                <dt>Входные порты</dt>
                <dd className="mono">{ports.join(", ") || "—"}</dd>
              </div>
            </dl>
            <div className="button-row" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onNavigate("servers")}
              >
                Сервисы
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onNavigate("system")}
              >
                Система
                <Icon name="arrowRight" size={14} />
              </button>
            </div>
          </div>
        </section>
      </div>

      {stats ? <CoverageNote stats={stats} /> : null}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  meta,
  tone,
}: {
  icon: IconName;
  label: string;
  value: string;
  meta: string;
  tone?: "success" | "warning" | "danger";
}) {
  return (
    <article className="card stat">
      <span className="stat-label">
        <Icon name={icon} />
        {label}
      </span>
      <strong className={`stat-value${tone ? ` text-${tone}` : ""}`}>
        {value}
      </strong>
      <span className="stat-meta">{meta}</span>
    </article>
  );
}

export function StatusBadge({ status }: { status: NginxStatus | null }) {
  if (!status) return <span className="badge">Нет данных</span>;
  return status.running ? (
    <span className="badge badge-success">
      <span className="dot success" /> Работает
    </span>
  ) : (
    <span className="badge badge-danger">
      <span className="dot danger" /> Остановлен
    </span>
  );
}

/* ---------- Activity chart ---------- */

function niceScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 4, ticks: [0, 1, 2, 3, 4] };
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ||
    10 * power;
  const top = step * 4;
  return { top, ticks: [0, 1, 2, 3, 4].map((i) => i * step) };
}

function ActivityChart({
  stats,
  loading,
}: {
  stats: ProxyStats | null;
  loading: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const series = stats?.series || [];
  const max = Math.max(0, ...series.map((item) => item.requests));
  const { top, ticks } = niceScale(max);
  const W = 1000;
  const H = 240;
  const x = (i: number) => (series.length > 1 ? (i / (series.length - 1)) * W : 0);
  const y = (v: number) => H - (v / top) * H;
  const requestsLine = series.map((item, i) => `${x(i)},${y(item.requests)}`).join(" ");
  const errorsLine = series.map((item, i) => `${x(i)},${y(item.errors)}`).join(" ");
  const xTicks = series.length
    ? [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (series.length - 1)))
    : [];
  const hasData = !!stats?.total_requests;
  const active = hover != null ? series[hover] : null;

  const pick = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || series.length < 2) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * (series.length - 1)));
  };

  return (
    <>
      <div className="card-header">
        <div className="card-title">
          <h2>Активность прокси</h2>
          <p>Запросы и ошибки за выбранный период</p>
        </div>
        <div className="chart-legend">
          <span>
            <i className="key key-requests" />
            Запросы
          </span>
          <span>
            <i className="key key-errors" />
            Ошибки 4xx/5xx
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? "График" : "Таблица"}
          </button>
        </div>
      </div>
      {!hasData ? (
        <EmptyState icon="activity" title={loading ? "Загружаем статистику…" : "Запросов за период нет"}>
          График появится после первых обращений к сервисам. Данные берутся из
          журнала nginx.
        </EmptyState>
      ) : asTable ? (
        <div className="table-wrap chart-table">
          <table className="table">
            <thead>
              <tr>
                <th>Интервал с</th>
                <th className="col-num">Запросы</th>
                <th className="col-num">Ошибки</th>
                <th className="col-num">Средняя задержка</th>
              </tr>
            </thead>
            <tbody>
              {series.map((item) => (
                <tr key={item.time}>
                  <td className="mono">{timeOf(item.time)}</td>
                  <td className="col-num">{number(item.requests)}</td>
                  <td className="col-num">{number(item.errors)}</td>
                  <td className="col-num">{item.requests ? ms(item.avg_latency_ms) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={`chart${loading ? " is-refreshing" : ""}`}>
          <div className="chart-y" aria-hidden="true">
            {[...ticks].reverse().map((tick) => (
              <span key={tick}>{compact(tick)}</span>
            ))}
          </div>
          <div
            ref={plotRef}
            className="chart-plot"
            role="img"
            aria-label={`График запросов: всего ${number(stats?.total_requests)}, ошибок ${number(
              (stats?.errors_4xx || 0) + (stats?.errors_5xx || 0),
            )}`}
            onPointerMove={(event) => pick(event.clientX)}
            onPointerDown={(event) => pick(event.clientX)}
            onPointerLeave={() => setHover(null)}
          >
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              {ticks.map((tick) => (
                <line
                  key={tick}
                  className={tick === 0 ? "chart-baseline" : "chart-gridline"}
                  x1="0"
                  x2={W}
                  y1={y(tick)}
                  y2={y(tick)}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              <polygon className="chart-area" points={`0,${H} ${requestsLine} ${W},${H}`} />
              <polyline className="chart-line requests" points={requestsLine} vectorEffect="non-scaling-stroke" />
              <polyline className="chart-line errors" points={errorsLine} vectorEffect="non-scaling-stroke" />
              {active ? (
                <line
                  className="chart-crosshair"
                  x1={x(hover!)}
                  x2={x(hover!)}
                  y1="0"
                  y2={H}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </svg>
            {active ? (
              <>
                <span
                  className="chart-dot requests"
                  style={{ left: `${(x(hover!) / W) * 100}%`, top: `${(y(active.requests) / H) * 100}%` }}
                />
                <span
                  className="chart-dot errors"
                  style={{ left: `${(x(hover!) / W) * 100}%`, top: `${(y(active.errors) / H) * 100}%` }}
                />
                <div
                  className={`chart-tooltip${hover! > series.length * 0.62 ? " flip" : ""}`}
                  style={{ left: `${(x(hover!) / W) * 100}%` }}
                >
                  <span className="chart-tooltip-time">с {timeOf(active.time)}</span>
                  <span>
                    <i className="key key-requests" />
                    <strong>{number(active.requests)}</strong> запросов
                  </span>
                  <span>
                    <i className="key key-errors" />
                    <strong>{number(active.errors)}</strong> ошибок
                  </span>
                  {active.requests ? (
                    <span className="muted">Средняя задержка {ms(active.avg_latency_ms)}</span>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          <div className="chart-x" aria-hidden="true">
            {xTicks.map((i, n) => (
              <span key={n} style={{ left: `${(x(i) / W) * 100}%` }}>
                {series[i] ? timeOf(series[i].time).slice(0, 5) : ""}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- Breakdown panels ---------- */

function Breakdown({
  title,
  total,
  items,
}: {
  title: string;
  total: number;
  items: Array<{ key: string; label: string; value: number; color: string }>;
}) {
  const visible = items.filter((item) => item.value > 0);
  return (
    <div className="breakdown">
      <div className="breakdown-head">
        <h3>{title}</h3>
      </div>
      <div className="breakdown-bar" role="img" aria-label={items.map((i) => `${i.label}: ${i.value}`).join(", ")}>
        {total && visible.length ? (
          visible.map((item) => (
            <span
              key={item.key}
              title={`${item.label}: ${number(item.value)}`}
              style={{ flexGrow: item.value, background: item.color }}
            />
          ))
        ) : (
          <span className="empty-bar" />
        )}
      </div>
      <ul className="breakdown-list">
        {items.map((item) => (
          <li key={item.key}>
            <i style={{ background: item.color }} />
            <span>{item.label}</span>
            <strong className="num">{number(item.value)}</strong>
            <small className="num">{total ? `${number((item.value / total) * 100)}%` : "—"}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TrafficBreakdown({ stats }: { stats: ProxyStats | null }) {
  return (
    <Breakdown
      title="Входной маршрут"
      total={stats?.total_requests || 0}
      items={[
        { key: "local", label: "Локальный", value: stats?.traffic.local || 0, color: "var(--series-1)" },
        { key: "external", label: "Внешний (KeenDNS)", value: stats?.traffic.external || 0, color: "var(--series-2)" },
        { key: "unknown", label: "Не определён", value: stats?.traffic.unknown || 0, color: "var(--series-neutral)" },
      ]}
    />
  );
}

function StatusBreakdown({ stats }: { stats: ProxyStats | null }) {
  const classes = { "2": 0, "3": 0, "4": 0, "5": 0, other: 0 };
  for (const [code, value] of Object.entries(stats?.status_codes || {})) {
    const key = code[0] as keyof typeof classes;
    if (key in classes) classes[key] += value;
    else classes.other += value;
  }
  return (
    <Breakdown
      title="Коды ответов"
      total={stats?.total_requests || 0}
      items={[
        { key: "2", label: "2xx — успех", value: classes["2"], color: "var(--status-good)" },
        { key: "3", label: "3xx — перенаправление", value: classes["3"] + classes.other, color: "var(--series-neutral)" },
        { key: "4", label: "4xx — ошибка клиента", value: classes["4"], color: "var(--status-warning)" },
        { key: "5", label: "5xx — ошибка сервера", value: classes["5"], color: "var(--status-critical)" },
      ]}
    />
  );
}

function TopHosts({ stats }: { stats: ProxyStats | null }) {
  const hosts = (stats?.hosts || []).slice(0, 8);
  const max = Math.max(1, ...hosts.map((item) => item.requests));
  if (!hosts.length) {
    return (
      <EmptyState icon="dns" title="Нет данных по доменам">
        За выбранный период запросов к доменам не было.
      </EmptyState>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Домен</th>
            <th style={{ width: "36%" }}>Запросы</th>
            <th className="col-num">Ошибки</th>
            <th className="col-num col-latency">Задержка</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((item) => (
            <tr key={item.host}>
              <td className="mono break">{item.host}</td>
              <td>
                <div className="bar-cell">
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(item.requests / max) * 100}%` }} />
                  </div>
                  <span className="num">{number(item.requests)}</span>
                </div>
              </td>
              <td className={`col-num${item.errors ? " text-danger" : " muted"}`}>{number(item.errors)}</td>
              <td className="col-num muted col-latency">{ms(item.avg_latency_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CoverageNote({ stats }: { stats: ProxyStats }) {
  const sample = stats.sample;
  const parts: string[] = [];
  if (sample.source === "persistent") {
    parts.push(`Накопленная статистика, шаг ${number((sample.resolution_seconds || 60) / 60)} мин.`);
    if (sample.coverage_from) {
      parts.push(`Сбор с ${new Date(sample.coverage_from).toLocaleString("ru-RU")}.`);
    }
    if (sample.truncated) parts.push("Данные за период неполные.");
    if (sample.backlog_bytes) parts.push(`Ожидает обработки: ${bytes(sample.backlog_bytes)}.`);
    if (sample.gaps?.length) parts.push(`Пропусков сбора: ${sample.gaps.length}.`);
    if (sample.persisted === false) parts.push("Ожидается первое сохранение.");
    if (stats.p95_approximate || sample.p95_approximate) parts.push("p95 — оценка по гистограмме.");
  } else {
    parts.push(
      sample.truncated
        ? `Показана выборка последних ${bytes(sample.max_bytes)} журнала: данные за период неполные.`
        : "В пределах сохранённого журнала; история зависит от ротации логов.",
    );
  }
  if (sample.malformed_lines) parts.push(`Не удалось прочитать строк: ${number(sample.malformed_lines)}.`);
  return (
    <div className="coverage-note">
      <Icon name="info" size={14} />
      <p>
        {parts.join(" ")}
        {sample.persistence_error ? (
          <span className="text-danger"> Ошибка сохранения статистики: {sample.persistence_error}.</span>
        ) : null}
      </p>
    </div>
  );
}
