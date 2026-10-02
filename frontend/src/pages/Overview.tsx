import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchNetwork, fetchResources, fetchStats, type NetworkPayload, type ProxyStats, type ResourcesPayload } from "../api";
import { PageHeader, type PageKey } from "../navigation";
import { Icon, type IconName } from "../components/ui/Icon";
import { bytes, count, errText, ms, number } from "../lib/format";
import type { NginxStatus, RoutesDocument } from "../types";
import { core, type HealthPoint, type TrafficReport } from "../features/mihomo/api";
import { MODE_LABEL, useMihomo } from "../features/mihomo/context";
import { speed } from "../features/mihomo/shared";
import { useTailscaleIssues } from "../features/mihomo/Extras";
import { bucketize, smoothArea, smoothLine, type Pt } from "../components/charts/smooth";

type Alert = { tone: "warn" | "bad" | "info"; title: string; where: string; page: PageKey; href?: string };
type Stat = { label: string; value: string; note?: string; warn?: boolean };

function Spark({ values, tone = "accent" }: { values: number[]; tone?: "accent" | "good" | "muted" }) {
  if (values.length < 2) return <div className="ov-spark ov-spark-empty" />;
  const vals = bucketize(values.map((_, i) => i), [values], 60).values[0].map((v) => v || 0);
  const max = Math.max(1, ...vals);
  const pts: Pt[] = vals.map((v, i) => [(i / (vals.length - 1)) * 300, 46 - (v / max) * 42]);
  return (
    <svg className={`ov-spark is-${tone}`} viewBox="0 0 300 48" preserveAspectRatio="none" aria-hidden="true">
      <path d={smoothArea(pts, 48)} className="ov-spark-area" />
      <path d={smoothLine(pts)} className="ov-spark-line" />
    </svg>
  );
}

function Widget({
  title,
  icon,
  badge,
  badgeTone,
  stats,
  chartLabel,
  chartNow,
  series,
  tone,
  links,
  onNavigate,
  open,
  error,
}: {
  title: string;
  icon: IconName;
  badge: string;
  badgeTone: "good" | "warn" | "bad" | "muted";
  stats: Stat[];
  chartLabel: string;
  chartNow: string;
  series: number[];
  tone?: "accent" | "good" | "muted";
  links: Array<[string, PageKey]>;
  onNavigate: (p: PageKey) => void;
  open: PageKey;
  error?: string;
}) {
  return (
    <section className="card ov-widget">
      <div className="ov-widget-head">
        <span className="ov-widget-icon">
          <Icon name={icon} size={18} />
        </span>
        <h2>{title}</h2>
        <span className={`ov-badge is-${badgeTone}`}>{badge}</span>
        <span className="ov-grow" />
        <a href={`#/${open}`} onClick={(e) => { e.preventDefault(); onNavigate(open); }}>
          Открыть →
        </a>
      </div>
      {error ? <p className="ov-error">{error}</p> : null}
      <div className="ov-stats">
        {stats.map((s) => (
          <div key={s.label} className="ov-stat">
            <span className="ov-stat-label">{s.label}</span>
            <span className="ov-stat-value">{s.value}</span>
            {s.note ? <span className={`ov-stat-note${s.warn ? " is-warn" : ""}`}>{s.note}</span> : null}
          </div>
        ))}
      </div>
      <div className="ov-chart">
        <div className="ov-chart-head">
          <span>{chartLabel}</span>
          <span className="mono">{chartNow}</span>
        </div>
        <Spark values={series} tone={tone} />
      </div>
      <div className="ov-links">
        {links.map(([label, page]) => (
          <a key={page} href={`#/${page}`} onClick={(e) => { e.preventDefault(); onNavigate(page); }}>
            {label}
          </a>
        ))}
      </div>
    </section>
  );
}

export function useOverviewData(doc: RoutesDocument) {
  const { status: core0, configs, traffic } = useMihomo();
  const [stats, setStats] = useState<ProxyStats | null>(null);
  const [net, setNet] = useState<NetworkPayload | null>(null);
  const [res, setRes] = useState<ResourcesPayload | null>(null);
  const [probes, setProbes] = useState<Record<string, { ok: boolean }>>({});
  const [health, setHealth] = useState<HealthPoint[]>([]);
  const [vpnTraffic, setVpnTraffic] = useState<TrafficReport | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const err: Record<string, string> = {};
    const targets = [...new Set(doc.apps.map((a) => `${a.upstream.address}:${a.upstream.port}`))];
    await Promise.all([
      fetchStats("1h").then((r) => setStats(r.stats)).catch((e) => (err.services = errText(e))),
      fetch("/api/launcher/status?" + targets.map((t) => "t=" + encodeURIComponent(t)).join("&"))
        .then((r) => (r.ok ? r.json() : null))
        .then((r) => r?.status && setProbes(r.status))
        .catch(() => undefined),
      fetchNetwork(60, 60).then(setNet).catch((e) => (err.network = errText(e))),
      fetchResources(0).then(setRes).catch((e) => (err.system = errText(e))),
      core.health("", "1h").then((r) => setHealth(r.series || [])).catch(() => setHealth([])),
      core.traffic("24h").then(setVpnTraffic).catch(() => setVpnTraffic(null)),
    ]);
    setErrors(err);
  }, [doc]);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60000);
    return () => clearInterval(t);
  }, [load]);

  const appsDown = doc.apps.filter((a) => {
    const p = probes[`${a.upstream.address}:${a.upstream.port}`];
    return p && !p.ok;
  });
  const lastHealth = health[health.length - 1];
  const netDown = (net?.availability || []).filter((a) => a.group === "summary" && a.valid && !a.ok);
  return { core: core0, configs, traffic, stats, net, res, probes, appsDown, lastHealth, health, vpnTraffic, netDown, errors, reload: load };
}

export function Overview({ doc, status, onNavigate }: { doc: RoutesDocument; status: NginxStatus | null; onNavigate: (p: PageKey) => void }) {
  const d = useOverviewData(doc);
  const now = d.traffic[d.traffic.length - 1];
  const tsIssues = useTailscaleIssues(!!d.core?.controller_ok);

  const alerts = useMemo(() => {
    const out: Alert[] = [];
    d.appsDown.forEach((a) => out.push({ tone: "warn", title: `${a.name || a.id} не отвечает`, where: `Сервисы · ${a.upstream.address}:${a.upstream.port}`, page: "servers" }));
    if (status && !status.running) out.push({ tone: "bad", title: "Прокси nginx остановлен", where: "Система · Прокси nginx", page: "system" });
    d.netDown.forEach((n) => out.push({ tone: "bad", title: `${n.name}: нет связи`, where: "Сеть · Интернет", page: "network" }));
    if (d.stats && d.stats.total_requests > 50 && d.stats.errors_5xx / d.stats.total_requests > 0.02)
      out.push({ tone: "warn", title: `Ошибок 5xx ${(100 * d.stats.errors_5xx / d.stats.total_requests).toFixed(1)}% за час`, where: "Сервисы · Статистика", page: "stats" });
    if (d.core && d.core.installed && !d.core.controller_ok) out.push({ tone: "bad", title: "mihomo не отвечает", where: "VPN · Ядро", page: "core" });
    if (d.core && !d.core.installed) out.push({ tone: "info", title: "mihomo не установлен", where: "VPN · установка из форка", page: "vpn" });
    if (d.lastHealth && d.lastHealth.whitelist > 0) out.push({ tone: "warn", title: "Сеть в режиме белых списков", where: "VPN · Подписки", page: "checks" });
    if (d.lastHealth && d.lastHealth.total && d.lastHealth.working / d.lastHealth.total < 0.3)
      out.push({ tone: "warn", title: `Работает только ${d.lastHealth.working} из ${d.lastHealth.total} узлов`, where: "VPN · Подписки", page: "checks" });
    tsIssues.forEach((t) => out.unshift({ tone: "bad", title: t.title, where: `VPN · Узлы · Tailscale ${t.name} — ${t.authURL ? "открыть и войти" : "запросить вход"}`, page: "proxies", href: "#/proxies/tailscale" }));
    return out;
  }, [d.appsDown, status, d.netDown, d.stats, d.core, d.lastHealth, tsIssues]);

  const sv = d.stats;
  const errRate = sv && sv.total_requests ? (100 * (sv.errors_5xx || 0)) / sv.total_requests : 0;
  const probed = doc.apps.filter((a) => d.probes[`${a.upstream.address}:${a.upstream.port}`]).length;
  const cur = d.net?.current;
  const firstPing = cur ? Object.values(cur.mt || {}).concat(Object.values(cur.nc || {})).find((p) => p.ok && p.ms != null) : undefined;
  const sys = d.res?.now;
  const memPct = sys && sys.mem_total ? Math.round((100 * sys.mem_used) / sys.mem_total) : null;
  const mode = d.lastHealth ? (d.lastHealth.whitelist ? "белые списки" : d.lastHealth.offline ? "нет сети" : d.lastHealth.normal ? "без ограничений" : "не определён") : d.core?.controller_ok ? "работает" : "нет данных";

  return (
    <div className="stack ov">
      <PageHeader page="overview" />
      <section className="ov-alerts" aria-label="Требует внимания">
        <h2 className="ov-label">Требует внимания</h2>
        {alerts.length ? (
          <div className="ov-alert-grid">
            {alerts.slice(0, 6).map((a, i) => (
              <a
                key={i}
                href={a.href || `#/${a.page}`}
                className={`ov-alert is-${a.tone}`}
                onClick={(e) => {
                  if (a.href) return;
                  e.preventDefault();
                  onNavigate(a.page);
                }}
              >
                <i />
                <span>
                  <strong>{a.title}</strong>
                  <small>{a.where}</small>
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p className="ov-ok">
            <Icon name="checkCircle" size={16} /> Всё в порядке: сервисы отвечают, интернет есть, ядро работает.
          </p>
        )}
      </section>

      <div className="ov-grid">
        <Widget
          title="Сервисы"
          icon="servers"
          open="servers"
          onNavigate={onNavigate}
          badge={probed ? `${probed - d.appsDown.length} из ${probed} отвечают` : count(doc.apps.length, ["сервис", "сервиса", "сервисов"])}
          badgeTone={d.appsDown.length ? "warn" : "good"}
          error={d.errors.services}
          stats={[
            { label: "Запросов за час", value: number(sv?.total_requests ?? 0), note: sv ? `${number(sv.requests_per_minute)} в минуту` : undefined },
            { label: "Ошибки 5xx", value: `${errRate.toFixed(1)}%`, note: sv ? `${number(sv.errors_5xx)} запросов` : undefined, warn: errRate > 2 },
            { label: "p95 ответа", value: sv ? ms(sv.p95_latency_ms) : "—", note: sv ? `среднее ${ms(sv.avg_latency_ms)}` : undefined },
          ]}
          chartLabel="Запросы, 1 час"
          chartNow={sv ? `${number(sv.requests_per_minute)}/мин` : ""}
          series={(sv?.series || []).map((p) => p.requests)}
          links={[["Сервисы", "servers"], ["Статистика", "stats"], ["Запросы", "logs"], ["Сертификаты", "certs"], ["Журналы nginx", "routing"]]}
        />
        <Widget
          title="Сеть"
          icon="network"
          open="network"
          onNavigate={onNavigate}
          badge={d.netDown.length ? `${d.netDown.length} сбой` : d.net ? "интернет есть" : "нет данных"}
          badgeTone={d.netDown.length ? "bad" : d.net ? "good" : "muted"}
          tone="good"
          error={d.errors.network}
          stats={[
            { label: "Задержка", value: firstPing?.ms != null ? `${Math.round(firstPing.ms)} мс` : "—", note: cur?.proxy?.ok ? "прокси отвечает" : undefined },
            { label: "LTE", value: cur?.rsrp != null ? `${cur.rsrp} dBm` : "—", note: cur?.lte || (cur?.sinr != null ? `SINR ${cur.sinr}` : undefined) },
            { label: "Устройства", value: d.res?.mesh ? `${d.res.mesh.nodes.length + 1}` : "—", note: "роутер и mesh-узлы" },
          ]}
          chartLabel="Задержка, 1 час"
          chartNow={firstPing?.ms != null ? `${Math.round(firstPing.ms)} мс` : ""}
          series={(d.net?.series || []).map((b) => {
            const v = Object.values(b.nc || {}).find((x) => x != null) ?? Object.values(b.mt || {}).find((x) => x != null);
            return v ?? 0;
          })}
          links={[["Интернет", "network"], ["Схема", "scheme"], ["Устройства", "resources"], ["DNS и KeenDNS", "dns"], ["Анализатор", "analyzer"]]}
        />
        <Widget
          title="VPN"
          icon="shield"
          open="vpn"
          onNavigate={onNavigate}
          badge={mode}
          badgeTone={!d.core?.controller_ok ? "bad" : d.lastHealth?.whitelist ? "warn" : "good"}
          stats={[
            { label: "Рабочих узлов", value: d.lastHealth ? `${d.lastHealth.working} / ${d.lastHealth.total}` : "—", note: d.lastHealth ? `${d.lastHealth.stable_normal} стабильных` : undefined },
            { label: "Скорость", value: speed(now?.down), note: `↑ ${speed(now?.up)}` },
            { label: "За сутки", value: d.vpnTraffic ? bytes(d.vpnTraffic.down) : "—", note: d.configs ? `режим «${MODE_LABEL[d.configs.mode] || d.configs.mode}»` : undefined },
          ]}
          chartLabel="Загрузка через mihomo, сутки"
          chartNow={d.vpnTraffic ? `↓ ${bytes(d.vpnTraffic.down)}` : ""}
          series={(d.vpnTraffic?.series || []).slice(-120).map((p) => p.down)}
          links={[["Узлы", "proxies"], ["Подписки", "checks"], ["Соединения", "connections"], ["Трафик", "traffic"], ["Настройка", "coreconfig"]]}
        />
        <Widget
          title="Система"
          icon="system"
          open="system"
          onNavigate={onNavigate}
          badge={status ? (status.running ? "прокси работает" : "прокси остановлен") : "нет данных"}
          badgeTone={status ? (status.running ? "good" : "bad") : "muted"}
          tone="muted"
          error={d.errors.system}
          stats={[
            { label: "Роутер, CPU", value: sys ? `${Math.round(sys.cpu)}%` : "—", note: memPct != null ? `память ${memPct}%` : undefined },
            { label: "Соединений", value: sys ? number(sys.conns) : "—", note: sys ? `из ${number(sys.conns_max)}` : undefined },
            { label: "Работает", value: sys ? `${Math.floor(sys.uptime_sec / 86400)} дн` : "—", note: sys?.temp_max ? `${Math.round(sys.temp_max)} °C` : undefined },
          ]}
          chartLabel="Нагрузка роутера"
          chartNow={sys ? `${Math.round(sys.cpu)}%` : ""}
          series={(d.res?.history || []).slice(-60).map((h) => h.cpu)}
          links={[["Прокси nginx", "system"], ["Выкладки", "releases"]]}
        />
      </div>
    </div>
  );
}
