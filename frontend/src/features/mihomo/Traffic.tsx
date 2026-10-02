import { useEffect, useMemo, useState } from "react";
import { PageHeader, useHashTab } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { TimeChart } from "../../components/charts/TimeChart";
import { Segmented } from "../../components/ui/controls";
import { bytes, number } from "../../lib/format";
import { mihomo, openStream, type MConnection, type MProvider, type MProxy, type MRule } from "./api";
import { useMihomo } from "./context";
import { PeriodStats } from "./PeriodStats";
import { BypassTraffic } from "./BypassTraffic";
import { Delay, Tabs, lastDelay, speed } from "./shared";

type Point = { t: number; v: number };
const KEEP = 150;

function push(list: Point[], v: number) {
  return [...list.slice(-(KEEP - 1)), { t: Math.round(Date.now() / 1000), v }];
}

type Bar = { label: string; value: number; sub?: string };

function Bars({ items, format, empty }: { items: Bar[]; format: (v: number) => string; empty: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="mh-muted">{empty}</p>;
  return (
    <div className="mh-bars">
      {items.map((i) => (
        <div key={i.label} className="mh-bar">
          <span className="mh-bar-label truncate" title={i.sub ? `${i.label} · ${i.sub}` : i.label}>
            {i.label}
          </span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(i.value / max) * 100}%` }} />
          </span>
          <span className="mh-bar-value mono">{format(i.value)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- latency from this browser (through the router and its rules) ---------- */

const SITES: Array<[string, string]> = [
  ["ya.ru", "https://ya.ru/favicon.ico"],
  ["google.com", "https://www.google.com/favicon.ico"],
  ["youtube.com", "https://www.youtube.com/favicon.ico"],
  ["github.com", "https://github.com/favicon.ico"],
  ["cloudflare.com", "https://www.cloudflare.com/favicon.ico"],
  ["telegram.org", "https://telegram.org/favicon.ico"],
];

async function timeFetch(url: string) {
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 6000);
  try {
    await fetch(`${url}?_=${Date.now()}`, { mode: "no-cors", cache: "no-store", signal: ctrl.signal });
    return Math.round(performance.now() - started);
  } catch {
    return 0;
  } finally {
    window.clearTimeout(timer);
  }
}

function SiteLatency() {
  const [res, setRes] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancel = false;
    (async () => {
      setBusy(true);
      for (const [name] of SITES) setRes((r) => ({ ...r, [name]: null }));
      await Promise.all(
        SITES.map(async ([name, url]) => {
          const ms = await timeFetch(url);
          if (!cancel) setRes((r) => ({ ...r, [name]: ms }));
        }),
      );
      if (!cancel) setBusy(false);
    })();
    return () => {
      cancel = true;
    };
  }, []);
  const rerun = async () => {
    setBusy(true);
    await Promise.all(
      SITES.map(async ([name, url]) => {
        setRes((r) => ({ ...r, [name]: null }));
        const ms = await timeFetch(url);
        setRes((r) => ({ ...r, [name]: ms }));
      }),
    );
    setBusy(false);
  };
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Задержка до сайтов</h2>
          <p className="cell-sub">из этого браузера, по правилам роутера</p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Проверить снова" disabled={busy} onClick={() => void rerun()}>
          <Icon name="refresh" />
        </button>
      </div>
      <div className="card-body mh-latency">
        {SITES.map(([name]) => (
          <div key={name} className="mh-latency-row">
            <span>{name}</span>
            <Delay value={res[name] === undefined ? null : res[name]} testing={res[name] === null} />
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------- external IP (on demand, third-party services) ---------- */

type IpInfo = { ip: string; place: string; org: string };
const IP_SERVICES: Array<[string, () => Promise<IpInfo>]> = [
  ["ip.sb", () => fetch("https://api.ip.sb/geoip", { cache: "no-store" }).then((r) => r.json()).then((d) => ({ ip: d.ip, place: [d.country, d.city].filter(Boolean).join(", "), org: d.organization || d.isp || "" }))],
  ["ipwho.is", () => fetch("https://ipwho.is/", { cache: "no-store" }).then((r) => r.json()).then((d) => ({ ip: d.ip, place: [d.country, d.city].filter(Boolean).join(", "), org: d.connection?.org || d.connection?.isp || "" }))],
  ["ipapi.is", () => fetch("https://api.ipapi.is/", { cache: "no-store" }).then((r) => r.json()).then((d) => ({ ip: d.ip, place: [d.location?.country, d.location?.city].filter(Boolean).join(", "), org: d.asn?.org || d.company?.name || "" }))],
];

function ExternalIp() {
  const [res, setRes] = useState<Record<string, IpInfo | "busy" | "fail">>({});
  const [hide, setHide] = useState(true);
  const check = () =>
    IP_SERVICES.forEach(async ([name, fn]) => {
      setRes((r) => ({ ...r, [name]: "busy" }));
      try {
        const info = await fn();
        setRes((r) => ({ ...r, [name]: info }));
      } catch {
        setRes((r) => ({ ...r, [name]: "fail" }));
      }
    });
  const mask = (ip: string) => (hide ? ip.replace(/^(\d+\.\d+)\.\d+\.\d+$/, "$1.•.•").replace(/^([0-9a-f]+:[0-9a-f]+):.*$/i, "$1:…") : ip);
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Внешний IP</h2>
          <p className="cell-sub">как сайты видят этот браузер</p>
        </div>
        <div className="button-row">
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={hide ? "Показать IP" : "Скрыть IP"} onClick={() => setHide(!hide)}>
            <Icon name={hide ? "eye" : "eyeOff"} />
          </button>
          <button type="button" className="btn btn-sm" onClick={check}>
            Проверить
          </button>
        </div>
      </div>
      <div className="card-body mh-latency">
        {IP_SERVICES.map(([name]) => {
          const r = res[name];
          return (
            <div key={name} className="mh-latency-row">
              <span className="cell-sub">{name}</span>
              <span className="mh-ip">
                {!r ? <span className="mh-muted">—</span> : r === "busy" ? <span className="spinner" /> : r === "fail" ? <span className="mh-warn-text">недоступен</span> : (
                  <>
                    <span className="mono">{mask(r.ip)}</span>
                    <span className="cell-sub">{[r.place, r.org].filter(Boolean).join(" · ")}</span>
                  </>
                )}
              </span>
            </div>
          );
        })}
        <p className="mh-muted pt-small">Запросы уходят к сторонним сервисам только по кнопке.</p>
      </div>
    </section>
  );
}

/* ---------- topology: device → rule → group → exit ---------- */

type Flow = { cols: Array<Array<{ name: string; value: number }>>; links: Array<Array<{ a: string; b: string; value: number }>> };

function buildFlow(conns: MConnection[], deviceName: (ip: string) => string, by: "traffic" | "count"): Flow {
  const TOP = 7;
  const paths = conns.map((c) => ({
    w: by === "count" ? 1 : c.download + c.upload,
    keys: [deviceName(c.metadata.sourceIP) || c.metadata.sourceIP || "—", c.rulePayload ? `${c.rule} ${c.rulePayload}` : c.rule || "—", c.chains[c.chains.length - 1] || "—", c.chains[0] || "—"],
  }));
  const cols = [0, 1, 2, 3].map((i) => {
    const m = new Map<string, number>();
    paths.forEach((p) => m.set(p.keys[i], (m.get(p.keys[i]) || 0) + p.w));
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const keep = new Set(sorted.slice(0, TOP).map(([k]) => k));
    paths.forEach((p) => {
      if (!keep.has(p.keys[i])) p.keys[i] = `Остальное·${i}`;
    });
    const out = new Map<string, number>();
    paths.forEach((p) => out.set(p.keys[i], (out.get(p.keys[i]) || 0) + p.w));
    return [...out.entries()].sort((a, b) => (a[0].startsWith("Остальное") ? 1 : b[0].startsWith("Остальное") ? -1 : b[1] - a[1])).map(([name, value]) => ({ name, value }));
  });
  const links = [0, 1, 2].map((i) => {
    const m = new Map<string, { a: string; b: string; value: number }>();
    paths.forEach((p) => {
      const key = p.keys[i] + "→" + p.keys[i + 1];
      const l = m.get(key) || { a: p.keys[i], b: p.keys[i + 1], value: 0 };
      l.value += p.w;
      m.set(key, l);
    });
    return [...m.values()];
  });
  return { cols, links };
}

function Topology({ conns }: { conns: MConnection[] }) {
  const { deviceName } = useMihomo();
  const [by, setBy] = useState<"traffic" | "count">("count");
  const flow = useMemo(() => buildFlow(conns, deviceName, by), [conns, deviceName, by]);
  const W = 1000;
  // Height follows the busiest column, so one device does not become a wall of colour.
  const H = Math.min(380, Math.max(120, Math.max(...flow.cols.map((c) => c.length)) * 46));
  const NW = 10;
  const GAP = 8;
  const total = Math.max(1, flow.cols[0].reduce((s, n) => s + n.value, 0));
  const xs = [0, 1, 2, 3].map((i) => i * ((W - NW) / 3));
  const pos = flow.cols.map((col) => {
    const avail = H - GAP * Math.max(0, col.length - 1);
    let y = 0;
    const map = new Map<string, { y: number; h: number; outY: number; inY: number }>();
    col.forEach((n) => {
      const h = Math.max(2, (n.value / total) * avail);
      map.set(n.name, { y, h, outY: y, inY: y });
      y += h + GAP;
    });
    return map;
  });
  const label = (s: string) => (s.startsWith("Остальное·") ? "Остальное" : s.length > 28 ? s.slice(0, 27) + "…" : s);
  const fmt = (v: number) => (by === "count" ? number(v) : bytes(v));
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Топология соединений</h2>
          <p className="cell-sub">устройство → правило → группа → выход, по открытым сейчас соединениям</p>
        </div>
        <Segmented<"traffic" | "count"> label="Толщина" value={by} onChange={setBy} options={[{ value: "count", label: "Соединения" }, { value: "traffic", label: "Трафик" }]} />
      </div>
      <div className="card-body mh-topo">
        {conns.length ? (
          <svg viewBox={`-4 -18 ${W + 8} ${H + 26}`} role="img" aria-label="Схема соединений">
            {["Устройство", "Правило", "Группа", "Выход"].map((t, i) => (
              <text key={t} x={i === 3 ? xs[i] + NW : xs[i]} y={-6} textAnchor={i === 3 ? "end" : "start"} className="mh-topo-head">
                {t}
              </text>
            ))}
            {flow.links.map((links, i) =>
              links.map((l) => {
                const a = pos[i].get(l.a)!;
                const b = pos[i + 1].get(l.b)!;
                const h = Math.max(1, (l.value / total) * (H - GAP * Math.max(0, flow.cols[i].length - 1)));
                const y1 = a.outY + h / 2;
                const y2 = b.inY + h / 2;
                a.outY += h;
                b.inY += h;
                const x1 = xs[i] + NW;
                const x2 = xs[i + 1];
                const mx = (x1 + x2) / 2;
                return <path key={`${i}:${l.a}:${l.b}`} d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`} className="mh-topo-link" strokeWidth={h}><title>{`${label(l.a)} → ${label(l.b)}: ${fmt(l.value)}`}</title></path>;
              }),
            )}
            {flow.cols.map((col, i) =>
              col.map((n) => {
                const p = pos[i].get(n.name)!;
                const right = i < 3;
                return (
                  <g key={`${i}:${n.name}`}>
                    <rect x={xs[i]} y={p.y} width={NW} height={p.h} rx={2} className="mh-topo-node" />
                    {p.h >= 9 ? (
                      <text x={right ? xs[i] + NW + 6 : xs[i] - 6} y={p.y + p.h / 2 + 4} textAnchor={right ? "start" : "end"} className="mh-topo-label">
                        {label(n.name)} <tspan className="mh-topo-value">{fmt(n.value)}</tspan>
                      </text>
                    ) : null}
                  </g>
                );
              }),
            )}
          </svg>
        ) : (
          <p className="mh-muted">Нет открытых соединений.</p>
        )}
      </div>
    </section>
  );
}

/* ---------- page ---------- */

type TrafficTab = "live" | "period" | "bypass" | "topology";

export function Traffic() {
  const { traffic, deviceName, configs } = useMihomo();
  const [tab, setTab] = useHashTab<TrafficTab>("traffic", "live");
  const [memory, setMemory] = useState<Point[]>([]);
  const [connCount, setConnCount] = useState<Point[]>([]);
  const [conns, setConns] = useState<MConnection[]>([]);
  const [totals, setTotals] = useState({ down: 0, up: 0 });
  const [rules, setRules] = useState<MRule[]>([]);
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [providers, setProviders] = useState<Record<string, MProvider>>({});

  useEffect(() => openStream<{ inuse: number }>("/memory", (d) => setMemory((p) => push(p, d.inuse))), []);
  useEffect(
    () =>
      openStream<{ connections: MConnection[] | null; downloadTotal: number; uploadTotal: number }>("/connections?interval=2000", (d) => {
        const list = d.connections || [];
        setConns(list);
        setConnCount((p) => push(p, list.length));
        setTotals({ down: d.downloadTotal, up: d.uploadTotal });
      }),
    [],
  );
  useEffect(() => {
    const pull = () => {
      void mihomo.rules().then((r) => setRules(r.rules || [])).catch(() => undefined);
      void mihomo.allProxies().then((r) => {
        setProxies(r.proxies);
        setProviders(r.providers);
      }).catch(() => undefined);
    };
    pull();
    const t = setInterval(() => document.visibilityState === "visible" && pull(), 30000);
    return () => clearInterval(t);
  }, []);

  const now = traffic[traffic.length - 1];
  const times = traffic.map((p) => Math.round(p.t / 1000));
  const peak = Math.max(0, ...connCount.map((p) => p.v));

  const outbounds = useMemo(() => {
    const m = new Map<string, number>();
    conns.forEach((c) => m.set(c.chains[0] || "—", (m.get(c.chains[0] || "—") || 0) + c.download + c.upload));
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [conns]);
  const devices = useMemo(() => {
    const m = new Map<string, number>();
    conns.forEach((c) => m.set(c.metadata.sourceIP, (m.get(c.metadata.sourceIP) || 0) + c.download + c.upload));
    return [...m.entries()].map(([ip, value]) => ({ label: deviceName(ip) || ip, sub: ip, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [conns, deviceName]);
  const ruleHits = useMemo(
    () =>
      rules
        .filter((r) => r.extra?.hitCount)
        .map((r) => ({ label: `${r.type} ${r.payload}`, value: r.extra!.hitCount, sub: r.proxy }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10),
    [rules],
  );
  const subs = Object.values(providers).filter((p) => p.subscriptionInfo && (p.subscriptionInfo.Total || p.subscriptionInfo.Expire));
  const mainGroup = useMemo(() => (proxies.GLOBAL?.all || []).map((n) => proxies[n]).find((p) => p && p.type === "Selector"), [proxies]);
  const latency = (mainGroup?.all || [])
    .map((n) => ({ name: n, d: lastDelay(proxies[n], mainGroup?.testUrl) }))
    .filter((x) => x.d != null)
    .sort((a, b) => (a.d! <= 0 ? 1e9 : a.d!) - (b.d! <= 0 ? 1e9 : b.d!))
    .slice(0, 8);

  return (
    <div className="stack">
      <PageHeader page="traffic">Скорость, память и соединения ядра в реальном времени; режим: {configs?.mode || "—"}.</PageHeader>
      <Tabs<TrafficTab>
        label="Раздел трафика"
        value={tab}
        onChange={setTab}
        items={[
          ["live", "Сейчас"],
          ["period", "За период"],
          ["bypass", "Через обходы"],
          ["topology", "Топология"],
        ]}
      />
      {tab === "live" ? (
        <>

      <div className="grid-3">
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Скорость</h2>
              <p className="cell-sub">
                ↓ {speed(now?.down)} · ↑ {speed(now?.up)}
              </p>
            </div>
            <span className="cell-sub mono">
              всего ↓ {bytes(totals.down)} ↑ {bytes(totals.up)}
            </span>
          </div>
          <div className="card-body">
            {traffic.length > 1 ? (
              <TimeChart
                label="Скорость через mihomo"
                times={times}
                format={(v) => speed(v)}
                height={130}
                series={[
                  { label: "Загрузка", values: traffic.map((p) => p.down), color: "var(--series-1)" },
                  { label: "Отдача", values: traffic.map((p) => p.up), color: "var(--series-2)" },
                ]}
              />
            ) : (
              <p className="mh-muted">Собираю точки…</p>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Память ядра</h2>
              <p className="cell-sub">{bytes(memory[memory.length - 1]?.v)} сейчас</p>
            </div>
            <span className="cell-sub mono">макс {bytes(Math.max(0, ...memory.map((p) => p.v)))}</span>
          </div>
          <div className="card-body">
            {memory.length > 1 ? (
              <TimeChart label="Память mihomo" times={memory.map((p) => p.t)} format={(v) => bytes(v)} height={130} series={[{ label: "Память", values: memory.map((p) => p.v), color: "var(--series-1)" }]} />
            ) : (
              <p className="mh-muted">Собираю точки…</p>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Соединения</h2>
              <p className="cell-sub">{number(conns.length)} открыто</p>
            </div>
            <span className="cell-sub mono">пик {number(peak)}</span>
          </div>
          <div className="card-body">
            {connCount.length > 1 ? (
              <TimeChart label="Число соединений" times={connCount.map((p) => p.t)} format={(v) => number(Math.round(v))} height={130} series={[{ label: "Соединения", values: connCount.map((p) => p.v), color: "var(--series-1)" }]} />
            ) : (
              <p className="mh-muted">Собираю точки…</p>
            )}
          </div>
        </section>
      </div>

      <div className="grid-3">
        <SiteLatency />
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Задержка узлов</h2>
              <p className="cell-sub">{mainGroup?.name || "—"}</p>
            </div>
          </div>
          <div className="card-body mh-latency">
            {latency.length ? (
              latency.map((x) => (
                <div key={x.name} className="mh-latency-row">
                  <span className="truncate">{x.name}</span>
                  <Delay value={x.d} />
                </div>
              ))
            ) : (
              <p className="mh-muted">Нет проверенных узлов. Запустите проверку на странице «Прокси».</p>
            )}
          </div>
        </section>
        <ExternalIp />
      </div>

      {subs.length ? (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Трафик подписок</h2>
          </div>
          <div className="card-body mh-subs">
            {subs.map((p) => {
              const i = p.subscriptionInfo!;
              const used = (i.Download || 0) + (i.Upload || 0);
              const total = i.Total || 0;
              const expire = i.Expire ? new Date(i.Expire * 1000) : null;
              return (
                <div key={p.name} className="mh-sub-item">
                  <div className="mh-sub-row">
                    <strong>{p.name}</strong>
                    <span>
                      {total ? `${bytes(used)} из ${bytes(total)} · осталось ${bytes(Math.max(0, total - used))}` : "без лимита"}
                      {expire ? ` · до ${expire.toLocaleDateString("ru-RU")}` : ""}
                    </span>
                  </div>
                  {total ? (
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${Math.min(100, (used / total) * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

        </>
      ) : null}

      {tab === "topology" ? (
        <>
      <Topology conns={conns} />

      <div className="grid-3">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Выходы</h2>
          </div>
          <div className="card-body">
            <Bars items={outbounds} format={bytes} empty="Нет открытых соединений." />
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Устройства</h2>
          </div>
          <div className="card-body">
            <Bars items={devices} format={bytes} empty="Нет открытых соединений." />
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Срабатывания правил</h2>
          </div>
          <div className="card-body">
            <Bars items={ruleHits} format={(v) => number(v)} empty="Ядро не ведёт счётчики правил или срабатываний ещё не было." />
          </div>
        </section>
      </div>

        </>
      ) : null}

      {tab === "period" ? <PeriodStats /> : null}
      {tab === "bypass" ? <BypassTraffic /> : null}
    </div>
  );
}
