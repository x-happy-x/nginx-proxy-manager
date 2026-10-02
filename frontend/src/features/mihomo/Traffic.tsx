import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../navigation";
import { TimeChart } from "../../components/charts/TimeChart";
import { bytes, number } from "../../lib/format";
import { mihomo, openStream, type MConnection, type MProxy, type MRule } from "./api";
import { useMihomo } from "./context";
import { Delay, lastDelay, speed } from "./shared";

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

export function Traffic() {
  const { traffic, deviceName, configs } = useMihomo();
  const [memory, setMemory] = useState<number[]>([]);
  const [conns, setConns] = useState<MConnection[]>([]);
  const [peak, setPeak] = useState(0);
  const [rules, setRules] = useState<MRule[]>([]);
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [ip, setIp] = useState<{ ip?: string; country?: string } | null>(null);

  useEffect(() => openStream<{ inuse: number }>("/memory", (d) => setMemory((p) => [...p.slice(-119), d.inuse])), []);
  useEffect(
    () =>
      openStream<{ connections: MConnection[] | null }>("/connections?interval=3000", (d) => {
        const list = d.connections || [];
        setConns(list);
        setPeak((p) => Math.max(p, list.length));
      }),
    [],
  );
  useEffect(() => {
    const pull = () => {
      void mihomo.rules().then((r) => setRules(r.rules || [])).catch(() => undefined);
      void mihomo.allProxies().then((r) => setProxies(r.proxies)).catch(() => undefined);
    };
    pull();
    const t = setInterval(() => document.visibilityState === "visible" && pull(), 30000);
    return () => clearInterval(t);
  }, []);
  // Exit IP as seen by the internet; asked only on demand (third-party service).
  const checkIp = () => {
    setIp({ ip: "…" });
    fetch("https://api.ip.sb/geoip", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setIp({ ip: d.ip, country: d.country }))
      .catch(() => setIp({}));
  };

  const now = traffic[traffic.length - 1];
  const times = traffic.map((p) => Math.round(p.t / 1000));

  const outbounds = useMemo(() => {
    const m = new Map<string, number>();
    conns.forEach((c) => m.set(c.chains[0] || "—", (m.get(c.chains[0] || "—") || 0) + c.download + c.upload));
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [conns]);
  const devices = useMemo(() => {
    const m = new Map<string, number>();
    conns.forEach((c) => m.set(c.metadata.sourceIP, (m.get(c.metadata.sourceIP) || 0) + c.download));
    return [...m.entries()]
      .map(([ip, value]) => ({ label: deviceName(ip) || ip, sub: ip, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [conns, deviceName]);
  const ruleHits = useMemo(
    () =>
      rules
        .filter((r) => r.extra?.hitCount)
        .map((r) => ({ label: `${r.type} ${r.payload}`, value: r.extra!.hitCount, sub: r.proxy }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8),
    [rules],
  );
  const mainGroup = useMemo(() => {
    const order = proxies.GLOBAL?.all || [];
    return order.map((n) => proxies[n]).find((p) => p && p.type === "Selector");
  }, [proxies]);
  const latency = (mainGroup?.all || [])
    .map((n) => ({ name: n, d: lastDelay(proxies[n], mainGroup?.testUrl) }))
    .filter((x) => x.d != null)
    .sort((a, b) => (a.d! <= 0 ? 1e9 : a.d!) - (b.d! <= 0 ? 1e9 : b.d!))
    .slice(0, 8);

  return (
    <div className="stack">
      <PageHeader page="traffic">Скорость, соединения и память ядра в реальном времени; режим: {configs?.mode || "—"}.</PageHeader>
      <div className="stats">
        <div className="stat">
          <span className="stat-label">Скорость сейчас</span>
          <span className="stat-value">↓ {speed(now?.down)}</span>
          <span className="stat-meta">↑ {speed(now?.up)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Активные соединения</span>
          <span className="stat-value">{number(conns.length)}</span>
          <span className="stat-meta">пик за сеанс: {number(peak)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Память ядра</span>
          <span className="stat-value">{bytes(memory[memory.length - 1])}</span>
          <span className="stat-meta">за 2 минуты до {bytes(Math.max(0, ...memory))}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Внешний IP браузера</span>
          <span className="stat-value mono">{ip ? ip.ip || "—" : "—"}</span>
          <span className="stat-meta">
            {ip?.country || (ip && !ip.ip ? "сервис ip.sb недоступен" : null)}{" "}
            <button type="button" className="btn btn-ghost btn-sm" onClick={checkIp}>
              Проверить через ip.sb
            </button>
          </span>
        </div>
      </div>
      <div className="grid-2 mh-grid-wide">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Скорость</h2>
            <span className="chart-legend">
              <span><i style={{ background: "var(--series-1)" }} />Загрузка</span>
              <span><i style={{ background: "var(--series-2)" }} />Отдача</span>
            </span>
          </div>
          <div className="card-body">
            {traffic.length > 1 ? (
              <TimeChart
                label="Скорость через mihomo за последние минуты"
                times={times}
                format={(v) => speed(v)}
                height={180}
                series={[
                  { label: "Загрузка", values: traffic.map((p) => p.down), color: "var(--series-1)" },
                  { label: "Отдача", values: traffic.map((p) => p.up), color: "var(--series-2)" },
                ]}
              />
            ) : (
              <p className="mh-muted">Собираю точки графика…</p>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Задержка узлов</h2>
            <span className="cell-sub">{mainGroup?.name || "—"}</span>
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
      </div>
      <div className="grid-3">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Трафик по выходам</h2>
          </div>
          <div className="card-body">
            <Bars items={outbounds} format={bytes} empty="Нет активных соединений." />
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Устройства</h2>
          </div>
          <div className="card-body">
            <Bars items={devices} format={bytes} empty="Нет активных устройств." />
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
      <p className="mh-muted">Трафик по выходам и устройствам считается по открытым сейчас соединениям.</p>
    </div>
  );
}
