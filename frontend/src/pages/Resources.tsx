import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchResources, type AppGroupUsage, type MeshNode, type MeshSample, type MikrotikSample, type PveSample, type PveState, type ResourceSample, type ResourcesPayload } from "../api";
import { Icon } from "../components/ui/Icon";
import { Alert, Segmented } from "../components/ui/controls";
import { Legend, TimeChart } from "../components/charts/TimeChart";
import { PageHeader } from "../navigation";
import { bytes, errText, number } from "../lib/format";

type Period = 15 | 60;
type Tab = "keenetic" | "mesh" | "mikrotik" | "proxmox";
const TAB_KEY = "homenet.resources.tab";

function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === "mesh" || v === "mikrotik" || v === "proxmox" ? v : "keenetic";
  } catch {
    return "keenetic";
  }
}
type Kind = "app" | "system" | "all";
type SortKey = "rss" | "cpu";

const POLL_MS = 5000;

export function formatBps(bps: number) {
  if (!bps) return "0";
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Мбит/с`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} кбит/с`;
  return `${Math.round(bps)} бит/с`;
}

export function formatUptime(sec: number) {
  if (!sec) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
}

const pct = (v: number) => `${v >= 10 ? Math.round(v) : v.toFixed(1)} %`;
const mb = (v: number) => bytes(v);

type Tone = "good" | "warning" | "critical";

function StatusNote({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const icon = tone === "good" ? "checkCircle" : tone === "warning" ? "alert" : "error";
  return (
    <span className={`res-status res-${tone}`}>
      <Icon name={icon} size={13} /> {children}
    </span>
  );
}

function Meter({ value, max, tone }: { value: number; max: number; tone?: Tone }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span className={`res-meter${tone ? " res-meter-" + tone : ""}`} aria-hidden="true">
      <i style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}

// useResources polls the manager and keeps a rolling hour of history.
export function useResources(withHistory = true) {
  const [data, setData] = useState<ResourcesPayload | null>(null);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState(0);
  // The server returns history newer than `since`; each stream is merged
  // separately by timestamp, so asking from the oldest stream's end is safe.
  const lastSeen = useRef(0);

  const load = useCallback(async () => {
    try {
      const next = await fetchResources(withHistory ? lastSeen.current : 4e9);
      setError("");
      setUpdated(Date.now());
      setData((prev) => {
        const cutoff = Date.now() / 1000 - 3600;
        const merge = <T extends { t: number }>(old: T[] | undefined, fresh: T[]) => {
          const tail = (old || []).filter((s) => s.t > cutoff);
          const end = tail.length ? tail[tail.length - 1].t : 0;
          return [...tail, ...fresh.filter((s) => s.t > end)];
        };
        const history = merge(prev?.history, next.history);
        const mtHistory = merge(prev?.mikrotik_history, next.mikrotik_history);
        const pveHistory = merge(prev?.proxmox_history, next.proxmox_history || []);
        const meshHistory: Record<string, MeshSample[]> = {};
        const liveNodes = new Set((next.mesh?.nodes || []).map((n) => n.cid || n.ip));
        for (const key of new Set([...Object.keys(prev?.mesh_history || {}), ...Object.keys(next.mesh_history || {})])) {
          if (liveNodes.has(key)) meshHistory[key] = merge(prev?.mesh_history?.[key], next.mesh_history?.[key] || []);
        }
        const ends = [history, mtHistory, pveHistory, ...Object.values(meshHistory)].filter((l) => l.length).map((l) => l[l.length - 1].t);
        lastSeen.current = ends.length ? Math.min(...ends) : 0;
        return { ...next, history, mikrotik_history: mtHistory, proxmox_history: pveHistory, mesh_history: meshHistory };
      });
    } catch (err) {
      setError(errText(err));
    }
  }, [withHistory]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return { data, error, updated };
}

export function Resources() {
  const { data, error, updated } = useResources(true);
  const [period, setPeriod] = useState<Period>(15);
  const [kind, setKind] = useState<Kind>("app");
  const [sort, setSort] = useState<SortKey>("rss");
  const [showTop, setShowTop] = useState(false);
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (next: Tab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* per-browser preference */
    }
  };
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const history = useMemo(() => {
    const cutoff = Date.now() / 1000 - period * 60;
    return (data?.history || []).filter((s) => s.t >= cutoff);
  }, [data, period]);
  const mtHistory = useMemo(() => {
    const cutoff = Date.now() / 1000 - period * 60;
    return (data?.mikrotik_history || []).filter((s) => s.t >= cutoff);
  }, [data, period]);

  const ago = updated ? Math.max(0, Math.round((Date.now() - updated) / 1000)) : null;
  const meshCount = data?.mesh?.nodes.length ?? 0;
  const pve = data?.proxmox;

  return (
    <>
      <PageHeader
        page="resources"
        actions={
          <>
            <span className="res-live" title="Данные обновляются каждые 5 секунд">
              <span className={`res-live-dot${error ? " is-off" : ""}`} />
              {error ? "нет связи" : ago == null ? "загрузка…" : ago < 3 ? "сейчас" : `${ago} с назад`}
            </span>
            <Segmented<`${Period}`>
              label="Период графиков"
              value={`${period}` as `${Period}`}
              onChange={(v) => setPeriod(Number(v) as Period)}
              options={[
                { value: "15", label: "15 мин" },
                { value: "60", label: "1 час" },
              ]}
            />
          </>
        }
      />
      {error ? <Alert tone="danger" title="Нет данных от менеджера">{error}</Alert> : null}
      {!data ? <div className="launcher-loading">Собираю данные…</div> : (
        <div className="res">
          <div className="res-tabs" role="tablist" aria-label="Устройство">
            {([
              ["keenetic", "Keenetic"],
              ["mesh", `Mesh-узлы${meshCount ? ` · ${meshCount}` : ""}`],
              ["mikrotik", "MikroTik"],
              ["proxmox", `Proxmox${pve?.nodes.length ? ` · ${pve.nodes.map((n) => n.node).join(", ")}` : ""}`],
            ] as Array<[Tab, string]>).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={`res-tab${tab === id ? " is-active" : ""}`} onClick={() => setTab(id)}>
                {label}
                <TabAlert data={data} tab={id} />
              </button>
            ))}
          </div>
          {tab === "keenetic" ? (
            <>
              <KeeneticSection data={data} history={history} />
              <AppsSection data={data} history={history} kind={kind} setKind={setKind} sort={sort} setSort={setSort} />
              <TopProcesses data={data} open={showTop} onToggle={() => setShowTop((v) => !v)} />
            </>
          ) : null}
          {tab === "mesh" ? <MeshSection data={data} period={period} /> : null}
          {tab === "mikrotik" ? <MikrotikSection data={data} history={mtHistory} /> : null}
          {tab === "proxmox" ? <ProxmoxSection state={pve} history={(data.proxmox_history || []).filter((s) => s.t >= Date.now() / 1000 - period * 60)} /> : null}
        </div>
      )}
    </>
  );
}

function series(history: ResourceSample[], pick: (s: ResourceSample) => number | null) {
  return history.map(pick);
}

function KeeneticSection({ data, history }: { data: ResourcesPayload; history: ResourceSample[] }) {
  const now = data.now;
  const times = history.map((s) => s.t);
  const memPct = now.mem_total ? (now.mem_used / now.mem_total) * 100 : 0;
  const hottest = now.temps.reduce((a, b) => (b.temp > (a?.temp ?? -1) ? b : a), now.temps[0]);
  const wan = now.interfaces.find((i) => i.wan);
  const tempTone: Tone = now.temp_max >= 90 ? "critical" : now.temp_max >= 80 ? "warning" : "good";
  const memTone: Tone = memPct >= 92 ? "critical" : memPct >= 85 ? "warning" : "good";
  const connRatio = now.conns_max ? now.conns / now.conns_max : 0;

  return (
    <section className="res-section">
      <header className="res-section-head">
        <div>
          <h2>Keenetic · {now.hostname}</h2>
          <p>
            аптайм {formatUptime(now.uptime_sec)} · нагрузка {now.load.map((l) => l.toFixed(2)).join(" / ")} · {now.cores} ядра · {now.processes} процессов
          </p>
        </div>
      </header>
      <div className="res-kpis">
        <div className="card res-kpi">
          <span className="res-kpi-label">Процессор</span>
          <strong className="res-kpi-value">{pct(now.cpu)}</strong>
          <span className="res-kpi-sub">всех {now.cores} ядер</span>
          <TimeChart label="Загрузка процессора" times={times} series={[{ label: "CPU", values: series(history, (s) => s.cpu) }]} format={pct} max={100} height={70} />
        </div>
        <div className="card res-kpi">
          <span className="res-kpi-label">Память</span>
          <strong className="res-kpi-value">{mb(now.mem_used)} <small>из {mb(now.mem_total)}</small></strong>
          <span className="res-kpi-sub">
            {memTone !== "good" ? <StatusNote tone={memTone}>{pct(memPct)} занято</StatusNote> : `${pct(memPct)} · кэш ${mb(now.mem_cache)}`}
            {now.swap_total ? ` · swap ${mb(now.swap_used)}` : ""}
          </span>
          <TimeChart label="Использование памяти" times={times} series={[{ label: "Память", values: series(history, (s) => s.mem) }]} format={mb} max={now.mem_total} height={70} />
        </div>
        <div className="card res-kpi">
          <span className="res-kpi-label">Температура</span>
          <strong className="res-kpi-value">{now.temp_max ? `${now.temp_max.toFixed(1)} °C` : "—"}</strong>
          <span className="res-kpi-sub">
            {tempTone !== "good" ? <StatusNote tone={tempTone}>горячо</StatusNote> : hottest ? `максимум: ${hottest.name}` : "датчиков нет"}
          </span>
          <TimeChart label="Температура" times={times} series={[{ label: "Температура", values: series(history, (s) => s.temp || null) }]} format={(v) => `${v.toFixed(1)} °C`} max={100} height={70} />
        </div>
        <div className="card res-kpi">
          <span className="res-kpi-label">Интернет {wan ? `(${wan.name})` : ""}</span>
          <strong className="res-kpi-value res-kpi-traffic">
            <span>↓ {formatBps(wan?.rx_bps || 0)}</span>
            <span>↑ {formatBps(wan?.tx_bps || 0)}</span>
          </strong>
          <Legend series={[{ label: "Входящий", values: [] }, { label: "Исходящий", values: [] }]} />
          <TimeChart
            label="Трафик через интернет-подключение"
            times={times}
            series={[{ label: "↓ входящий", values: series(history, (s) => s.rx) }, { label: "↑ исходящий", values: series(history, (s) => s.tx) }]}
            format={formatBps}
            height={70}
            area={false}
          />
        </div>
      </div>
      <div className="res-strip">
        <div className="card res-mini">
          <span className="res-kpi-label">Соединения (conntrack)</span>
          <strong>{number(now.conns)} <small>из {number(now.conns_max)}</small></strong>
          <Meter value={now.conns} max={now.conns_max} tone={connRatio > 0.9 ? "critical" : connRatio > 0.7 ? "warning" : undefined} />
        </div>
        {now.disks.map((d) => {
          const used = d.total - d.free;
          const freeRatio = d.total ? d.free / d.total : 1;
          const tone: Tone | undefined = freeRatio < 0.05 ? "critical" : freeRatio < 0.15 ? "warning" : undefined;
          return (
            <div key={d.path} className="card res-mini">
              <span className="res-kpi-label">Диск {d.path === "/opt" ? "Entware (/opt)" : d.path}</span>
              <strong>{mb(used)} <small>из {mb(d.total)}</small></strong>
              <Meter value={used} max={d.total} tone={tone} />
              {tone ? <StatusNote tone={tone}>свободно {mb(d.free)}</StatusNote> : null}
            </div>
          );
        })}
        <div className="card res-mini res-mini-list">
          <span className="res-kpi-label">Интерфейсы</span>
          {now.interfaces.slice(0, 4).map((i) => (
            <div key={i.name} className="res-iface">
              <span className="mono">{i.name}{i.wan ? " · WAN" : ""}</span>
              <span>↓ {formatBps(i.rx_bps)}</span>
              <span>↑ {formatBps(i.tx_bps)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AppsSection({
  data, history, kind, setKind, sort, setSort,
}: {
  data: ResourcesPayload;
  history: ResourceSample[];
  kind: Kind;
  setKind: (k: Kind) => void;
  sort: SortKey;
  setSort: (s: SortKey) => void;
}) {
  const now = data.now;
  const times = history.map((s) => s.t);
  const list = now.apps
    .filter((a) => kind === "all" || a.kind === kind)
    .sort((a, b) => (sort === "cpu" ? b.cpu - a.cpu || b.rss - a.rss : b.rss - a.rss));
  const totalRss = now.apps.reduce((n, a) => n + a.rss, 0);
  const counts = { app: now.apps.filter((a) => a.kind === "app").length, system: now.apps.filter((a) => a.kind === "system").length };

  return (
    <section className="card card-flush res-apps">
      <div className="card-header">
        <div className="card-title">
          <h2>Кто сколько потребляет</h2>
          <p>Процессы сгруппированы по приложениям; дочерние процессы (воркеры nginx и т.п.) считаются вместе с родителем</p>
        </div>
        <Segmented<Kind>
          label="Что показывать"
          value={kind}
          onChange={setKind}
          options={[
            { value: "app", label: "Приложения", count: counts.app },
            { value: "system", label: "Прошивка", count: counts.system },
            { value: "all", label: "Всё" },
          ]}
        />
      </div>
      <div className="table-wrap">
        <table className="table res-table">
          <thead>
            <tr>
              <th>Приложение</th>
              <th className="col-num">
                <button type="button" className={`res-sort${sort === "cpu" ? " is-active" : ""}`} onClick={() => setSort("cpu")}>CPU</button>
              </th>
              <th className="res-col-chart">CPU за период</th>
              <th className="col-num">
                <button type="button" className={`res-sort${sort === "rss" ? " is-active" : ""}`} onClick={() => setSort("rss")}>Память</button>
              </th>
              <th className="res-col-share">Доля памяти</th>
              <th className="col-num">Процессы</th>
            </tr>
          </thead>
          <tbody>
            {list.map((app) => (
              <AppRow key={app.id} app={app} times={times} history={history} totalRss={totalRss} memTotal={now.mem_total} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-footer">
        CPU — доля всего процессора ({now.cores} ядра = 100 %). Память — RSS процессов; общая память роутера включает ещё кэш и ядро.
      </div>
    </section>
  );
}

function AppRow({ app, times, history, totalRss, memTotal }: { app: AppGroupUsage; times: number[]; history: ResourceSample[]; totalRss: number; memTotal: number }) {
  const cpuSeries = history.map((s) => (s.apps[app.id] ? s.apps[app.id].cpu : null));
  const ports = app.ports.filter((p) => p < 40000).slice(0, 5);
  return (
    <tr>
      <td>
        <div className="res-app">
          <strong>{app.name}</strong>
          <span className="res-app-meta">
            <span className={`res-kind res-kind-${app.kind}`}>{app.kind === "app" ? "приложение" : "прошивка"}</span>
            {ports.map((p) => <span key={p} className="res-port mono">:{p}</span>)}
            {app.ports.length > ports.length ? <span className="res-port">+{app.ports.length - ports.length}</span> : null}
          </span>
        </div>
      </td>
      <td className="col-num mono">{pct(app.cpu)}</td>
      <td className="res-col-chart">
        <TimeChart label={`CPU: ${app.name}`} times={times} series={[{ label: "CPU", values: cpuSeries }]} format={pct} height={28} compact />
      </td>
      <td className="col-num mono">{mb(app.rss)}</td>
      <td className="res-col-share">
        <Meter value={app.rss} max={memTotal || totalRss} />
      </td>
      <td className="col-num mono">{app.procs}</td>
    </tr>
  );
}

function TopProcesses({ data, open, onToggle }: { data: ResourcesPayload; open: boolean; onToggle: () => void }) {
  const names = new Map(data.now.apps.map((a) => [a.id, a.name]));
  return (
    <section className="card card-flush">
      <div className="card-header">
        <div className="card-title">
          <h2>Самые активные процессы</h2>
          <p>По загрузке процессора за последние 5 секунд</p>
        </div>
        <button type="button" className="btn btn-sm" onClick={onToggle} aria-expanded={open}>
          <Icon name={open ? "chevronDown" : "chevronRight"} /> {open ? "Скрыть" : "Показать"}
        </button>
      </div>
      {open ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>PID</th>
                <th>Процесс</th>
                <th>Группа</th>
                <th className="col-num">CPU</th>
                <th className="col-num">Память</th>
              </tr>
            </thead>
            <tbody>
              {data.now.top.map((p) => (
                <tr key={p.pid}>
                  <td className="mono">{p.pid}</td>
                  <td className="mono">{p.name}</td>
                  <td>{names.get(p.group) || p.group}</td>
                  <td className="col-num mono">{pct(p.cpu)}</td>
                  <td className="col-num mono">{mb(p.rss)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function MikrotikSection({ data, history }: { data: ResourcesPayload; history: MikrotikSample[] }) {
  const mt = data.mikrotik || {};
  const sys = mt.system;
  const times = history.map((s) => s.t);
  const signal = mt.signal;
  const lte = sys?.interfaces.find((i) => i.type === "lte");
  const memUsed = sys ? sys.memory_total - sys.memory_free : 0;
  const diskFreeRatio = sys && sys.disk_total ? sys.disk_free / sys.disk_total : 1;
  const diskTone: Tone | undefined = diskFreeRatio < 0.05 ? "critical" : diskFreeRatio < 0.15 ? "warning" : undefined;
  const quality = signal?.quality ?? 0;
  const qualityTone: Tone = quality >= 60 ? "good" : quality >= 35 ? "warning" : "critical";

  return (
    <section className="res-section">
      <header className="res-section-head">
        <div>
          <h2>MikroTik 192.168.188.1{sys ? ` · ${sys.board}` : ""}</h2>
          <p>
            {sys ? `RouterOS ${sys.version} · аптайм ${formatUptime(sys.uptime_seconds)} · ${sys.cpu_count} ядра` : "LTE-роутер выше Keenetic"} · данные Netping
          </p>
        </div>
        {mt.internet_ok !== undefined ? (
          <StatusNote tone={mt.internet_ok ? "good" : "critical"}>{mt.internet_ok ? "интернет есть" : "интернета нет"}</StatusNote>
        ) : null}
      </header>
      {mt.error ? <Alert tone="warning" title="MikroTik: не все данные">{mt.error}</Alert> : null}
      {sys ? (
        <>
          <div className="res-kpis">
            <div className="card res-kpi">
              <span className="res-kpi-label">Процессор</span>
              <strong className="res-kpi-value">{pct(sys.cpu_load)}</strong>
              <span className="res-kpi-sub">{sys.architecture}</span>
              <TimeChart label="Загрузка процессора MikroTik" times={times} series={[{ label: "CPU", values: history.map((s) => s.cpu) }]} format={pct} max={100} height={70} />
            </div>
            <div className="card res-kpi">
              <span className="res-kpi-label">Память</span>
              <strong className="res-kpi-value">{mb(memUsed)} <small>из {mb(sys.memory_total)}</small></strong>
              <span className="res-kpi-sub">
                {diskTone ? <StatusNote tone={diskTone}>диск: свободно {mb(sys.disk_free)} из {mb(sys.disk_total)}</StatusNote> : `диск: свободно ${mb(sys.disk_free)} из ${mb(sys.disk_total)}`}
              </span>
              <TimeChart label="Память MikroTik" times={times} series={[{ label: "Память", values: history.map((s) => s.mem) }]} format={mb} max={sys.memory_total} height={70} />
            </div>
            <div className="card res-kpi">
              <span className="res-kpi-label">LTE {signal?.operator ? `· ${signal.operator}` : ""}{signal?.band ? ` · ${signal.band.split(" ")[0]}` : ""}</span>
              <strong className="res-kpi-value">{signal ? `${quality} %` : "—"}</strong>
              <span className="res-kpi-sub">
                <StatusNote tone={qualityTone}>{qualityTone === "good" ? "хороший сигнал" : qualityTone === "warning" ? "средний сигнал" : "слабый сигнал"}</StatusNote>
                {signal ? ` RSRP ${signal.rsrp} · SINR ${signal.sinr}` : ""}
              </span>
              <TimeChart label="SINR сигнала LTE" times={times} series={[{ label: "SINR, дБ", values: history.map((s) => s.sinr) }]} format={(v) => `${v.toFixed(0)} дБ`} height={70} />
            </div>
            <div className="card res-kpi">
              <span className="res-kpi-label">Трафик LTE</span>
              <strong className="res-kpi-value res-kpi-traffic">
                <span>↓ {formatBps(lte?.rx_bps || 0)}</span>
                <span>↑ {formatBps(lte?.tx_bps || 0)}</span>
              </strong>
              <Legend series={[{ label: "Входящий", values: [] }, { label: "Исходящий", values: [] }]} />
              <TimeChart
                label="Трафик LTE"
                times={times}
                series={[{ label: "↓ входящий", values: history.map((s) => s.rx) }, { label: "↑ исходящий", values: history.map((s) => s.tx) }]}
                format={formatBps}
                height={70}
                area={false}
              />
            </div>
          </div>
          <div className="res-strip">
            {sys.interfaces.filter((i) => i.type !== "loopback").map((i) => (
              <div key={i.name} className="card res-mini">
                <span className="res-kpi-label">{i.name} · {i.type}</span>
                <strong>{i.running ? "работает" : "не подключён"}</strong>
                <span className="res-kpi-sub">↓ {formatBps(i.rx_bps)} · ↑ {formatBps(i.tx_bps)}</span>
              </div>
            ))}
            {sys.sensors.map((s) => (
              <div key={s.name} className="card res-mini">
                <span className="res-kpi-label">{s.name}</span>
                <strong>{s.value} {s.unit === "C" ? "°C" : s.unit}</strong>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

// TabAlert marks a tab that has something worth a look (icon + hidden label).
function TabAlert({ data, tab }: { data: ResourcesPayload; tab: Tab }) {
  let warn = false;
  if (tab === "mikrotik") {
    const sys = data.mikrotik?.system;
    warn = !!data.mikrotik?.error || data.mikrotik?.internet_ok === false || (!!sys && sys.disk_total > 0 && sys.disk_free / sys.disk_total < 0.15);
  } else if (tab === "mesh") {
    warn = !!data.mesh?.error || (data.mesh?.nodes || []).some((n) => !n.internet);
  } else if (tab === "proxmox") {
    warn = !!data.proxmox?.error || pveWarnings(data.proxmox).length > 0;
  } else {
    warn = data.now.temp_max >= 80 || (data.now.mem_total > 0 && data.now.mem_used / data.now.mem_total > 0.9);
  }
  return warn ? (
    <span className="res-tab-alert" title="Есть предупреждения">
      <Icon name="alert" size={13} />
      <span className="sr-only">есть предупреждения</span>
    </span>
  ) : null;
}

function uplinkLabel(node: MeshNode) {
  if (node.uplink_wifi) return `Wi-Fi${node.rssi ? ` · ${node.rssi} дБм` : ""}${node.txrate ? ` · ${node.txrate} Мбит/с` : ""}`;
  if (node.uplink.startsWith("Gigabit")) return "кабель, 1 Гбит/с";
  return node.uplink || "—";
}

function MeshSection({ data, period }: { data: ResourcesPayload; period: Period }) {
  const nodes = data.mesh?.nodes || [];
  const cutoff = Date.now() / 1000 - period * 60;
  return (
    <section className="res-section">
      <header className="res-section-head">
        <div>
          <h2>Mesh-узлы Keenetic</h2>
          <p>Находятся сами по данным контроллера; новый узел появится здесь без настройки</p>
        </div>
      </header>
      {data.mesh?.error ? <Alert tone="warning" title="Контроллер не ответил">{data.mesh.error}</Alert> : null}
      {!nodes.length && !data.mesh?.error ? <div className="launcher-empty">Mesh-узлов нет</div> : null}
      <div className="res-mesh">
        {nodes.map((node) => {
          const hist: MeshSample[] = (data.mesh_history?.[node.cid || node.ip] || []).filter((s) => s.t >= cutoff);
          const times = hist.map((s) => s.t);
          const memPct = node.mem_total ? (node.mem_used / node.mem_total) * 100 : 0;
          const weak = node.uplink_wifi && (node.rssi ?? 0) < -70;
          return (
            <article key={node.cid || node.ip} className="card res-node">
              <header className="res-node-head">
                <div>
                  <h3>{node.name}</h3>
                  <p>
                    {node.model} · <span className="mono">{node.ip}</span> · {node.mode === "extender" ? "ретранслятор" : node.mode}
                  </p>
                </div>
                <StatusNote tone={node.internet ? "good" : "critical"}>{node.internet ? "в сети" : "нет интернета"}</StatusNote>
              </header>
              <div className="res-node-grid">
                <div>
                  <span className="res-kpi-label">Процессор</span>
                  <strong className="res-node-value">{pct(node.cpu)}</strong>
                  <TimeChart label={`Процессор: ${node.name}`} times={times} series={[{ label: "CPU", values: hist.map((s) => s.cpu) }]} format={pct} max={100} height={54} />
                </div>
                <div>
                  <span className="res-kpi-label">Память</span>
                  <strong className="res-node-value">
                    {mb(node.mem_used)} <small>из {mb(node.mem_total)}</small>
                  </strong>
                  <TimeChart label={`Память: ${node.name}`} times={times} series={[{ label: "Память", values: hist.map((s) => s.mem) }]} format={mb} max={node.mem_total} height={54} />
                </div>
              </div>
              <dl className="res-facts">
                <div>
                  <dt>Клиенты Wi-Fi</dt>
                  <dd>{node.clients}</dd>
                </div>
                <div>
                  <dt>Связь с роутером</dt>
                  <dd>{weak ? <StatusNote tone="warning">{uplinkLabel(node)}</StatusNote> : uplinkLabel(node)}</dd>
                </div>
                <div>
                  <dt>Аптайм</dt>
                  <dd>{formatUptime(node.uptime_sec)}</dd>
                </div>
                <div>
                  <dt>Прошивка</dt>
                  <dd>
                    {node.firmware}
                    {node.update_available && node.firmware_next ? (
                      <>
                        {" · "}
                        <StatusNote tone="warning">доступна {node.firmware_next}</StatusNote>
                      </>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>Занято памяти</dt>
                  <dd>{pct(memPct)}</dd>
                </div>
                {node.ports.length ? (
                  <div>
                    <dt>Порты</dt>
                    <dd className="res-ports">
                      {node.ports.map((p) => (
                        <span
                          key={p.label}
                          className={`res-port-dot${p.link ? " is-up" : ""}`}
                          title={`Порт ${p.label}: ${p.link ? `подключён${p.speed ? `, ${p.speed} Мбит/с` : ""}` : "не подключён"}`}
                        >
                          {p.label}
                        </span>
                      ))}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// pveWarnings flags things a person should look at on the Proxmox tab.
function pveWarnings(state: PveState | null | undefined) {
  const out: string[] = [];
  if (!state) return out;
  for (const node of state.nodes) {
    if (!node.online) out.push(`Узел ${node.node} не в сети`);
    if (node.mem_total && node.mem_used / node.mem_total >= 0.9) out.push(`Узел ${node.node}: занято ${pct((node.mem_used / node.mem_total) * 100)} памяти`);
    // A directory storage the size of the root filesystem usually means its
    // disk is not mounted and data is landing on the system disk.
    for (const st of state.storage) {
      if (st.node === node.node && st.type === "dir" && st.name !== "local" && node.root_total && Math.abs(st.total - node.root_total) < node.root_total * 0.02) {
        out.push(`Хранилище ${st.name} на ${node.node} совпадает по размеру с системным диском — похоже, его диск не смонтирован, и данные пишутся на системный`);
      }
    }
  }
  return out;
}

function ProxmoxSection({ state, history }: { state: PveState | null | undefined; history: PveSample[] }) {
  if (!state) {
    return <Alert tone="info" title="Proxmox не настроен">Задайте PROXMOX_URL, PROXMOX_FINGERPRINT и файл токена в настройках менеджера.</Alert>;
  }
  const times = history.map((s) => s.t);
  const warnings = pveWarnings(state);
  return (
    <section className="res-section">
      {state.error ? <Alert tone="danger" title="Proxmox не ответил">{state.error}</Alert> : null}
      {warnings.map((w) => (
        <Alert key={w} tone="warning">{w}</Alert>
      ))}
      {state.nodes.map((node) => {
        const memPct = node.mem_total ? (node.mem_used / node.mem_total) * 100 : 0;
        const guests = state.guests.filter((g) => g.node === node.node);
        const running = guests.filter((g) => g.status === "running").length;
        return (
          <div key={node.node} className="res-section">
            <header className="res-section-head">
              <div>
                <h2>Proxmox · {node.node}</h2>
                <p>
                  {node.pve_version?.split("/").slice(0, 2).join(" ")} · {node.cpu_model ? `${node.cpu_model}, ` : ""}
                  {node.cores} ядра · аптайм {formatUptime(node.uptime_sec)} · нагрузка {node.load.map((l) => l.toFixed(2)).join(" / ")}
                </p>
              </div>
              <StatusNote tone={node.online ? "good" : "critical"}>
                {node.online ? `в сети · запущено ${running} из ${guests.filter((g) => !g.template).length} ВМ` : "не в сети"}
              </StatusNote>
            </header>
            <div className="res-kpis">
              <div className="card res-kpi">
                <span className="res-kpi-label">Процессор</span>
                <strong className="res-kpi-value">{pct(node.cpu)}</strong>
                <span className="res-kpi-sub">всех {node.cores} ядер</span>
                <TimeChart label={`Процессор ${node.node}`} times={times} series={[{ label: "CPU", values: history.map((s) => s.nodes[node.node]?.cpu ?? null) }]} format={pct} max={100} height={70} />
              </div>
              <div className="card res-kpi">
                <span className="res-kpi-label">Память</span>
                <strong className="res-kpi-value">
                  {mb(node.mem_used)} <small>из {mb(node.mem_total)}</small>
                </strong>
                <span className="res-kpi-sub">
                  {memPct >= 90 ? <StatusNote tone="warning">{pct(memPct)} занято</StatusNote> : pct(memPct)}
                  {node.swap_total ? ` · swap ${mb(node.swap_used)}` : ""}
                </span>
                <TimeChart label={`Память ${node.node}`} times={times} series={[{ label: "Память", values: history.map((s) => s.nodes[node.node]?.mem ?? null) }]} format={mb} max={node.mem_total} height={70} />
              </div>
              <div className="card res-kpi">
                <span className="res-kpi-label">Системный диск</span>
                <strong className="res-kpi-value">
                  {mb(node.root_used)} <small>из {mb(node.root_total)}</small>
                </strong>
                <Meter value={node.root_used} max={node.root_total} tone={node.root_total && node.root_used / node.root_total > 0.9 ? "warning" : undefined} />
                <span className="res-kpi-sub">ядро {node.kernel || "—"}</span>
              </div>
              <div className="card res-kpi">
                <span className="res-kpi-label">Хранилища</span>
                {state.storage
                  .filter((s) => s.node === node.node)
                  .map((st) => (
                    <div key={st.name} className="res-storage">
                      <span>
                        {st.name} <small className="muted">{st.type}</small>
                      </span>
                      <Meter value={st.used} max={st.total} tone={st.total && st.used / st.total > 0.9 ? "warning" : undefined} />
                      <small className="muted">
                        {mb(st.used)} из {mb(st.total)}
                      </small>
                    </div>
                  ))}
              </div>
            </div>
            <section className="card card-flush">
              <div className="card-header">
                <div className="card-title">
                  <h2>Виртуальные машины и контейнеры</h2>
                  <p>CPU — доля собственных ядер машины</p>
                </div>
              </div>
              <div className="table-wrap">
                <table className="table res-table">
                  <thead>
                    <tr>
                      <th>Машина</th>
                      <th className="col-num">CPU</th>
                      <th className="res-col-chart">CPU за период</th>
                      <th className="col-num">Память</th>
                      <th className="res-col-share">Из выделенной</th>
                      <th className="col-num">Сеть ↓ / ↑</th>
                      <th className="col-num">Аптайм</th>
                    </tr>
                  </thead>
                  <tbody>
                    {guests.map((g) => {
                      const on = g.status === "running";
                      return (
                        <tr key={g.id} className={on ? "" : "res-row-off"}>
                          <td>
                            <div className="res-app">
                              <strong>{g.name || g.id}</strong>
                              <span className="res-app-meta">
                                <span className={`res-kind${on ? " res-kind-app" : ""}`}>{g.template ? "шаблон" : on ? "работает" : "остановлена"}</span>
                                <span className="res-port mono">
                                  {g.type === "lxc" ? "CT" : "VM"} {g.vmid}
                                </span>
                                <span className="res-port">{g.cores} vCPU</span>
                              </span>
                            </div>
                          </td>
                          <td className="col-num mono">{on ? pct(g.cpu) : "—"}</td>
                          <td className="res-col-chart">
                            {on ? <TimeChart label={`CPU ${g.name}`} times={times} series={[{ label: "CPU", values: history.map((s) => s.guests[g.id] ?? null) }]} format={pct} height={28} compact /> : null}
                          </td>
                          <td className="col-num mono">
                            {on ? mb(g.mem_used) : "—"}
                            <small className="muted"> / {mb(g.mem_total)}</small>
                          </td>
                          <td className="res-col-share">{on ? <Meter value={g.mem_used} max={g.mem_total} /> : null}</td>
                          <td className="col-num mono">{on ? `${formatBps(g.net_in_bps)} / ${formatBps(g.net_out_bps)}` : "—"}</td>
                          <td className="col-num">{on ? formatUptime(g.uptime_sec) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        );
      })}
    </section>
  );
}
