import { useMemo, useState } from "react";
import { Legend, TimeChart } from "../../components/charts/TimeChart";
import { Segmented } from "../../components/ui/controls";
import type { Host } from "../../platform/sdk";
import {
  ago, bits, bytes, celsius, cpuShort, guestsTotal, loadTone, mainStorage, percent, platformName, rate, ratio, running, tempTone, uptime,
  useHistory, type PveHistory, type PveHost, type PvePoint,
} from "./model";
import { Dot, Empty, Pill, Ring, Section, Stat } from "./parts";

type Period = "1h" | "6h" | "24h";
const PERIODS: Record<Period, number> = { "1h": 3600, "6h": 6 * 3600, "24h": 86400 };

export function HostCard({ h, selected, onSelect }: { h: PveHost; selected?: boolean; onSelect?: () => void }) {
  const c = h.current;
  const hw = h.hardware;
  const mem = c ? ratio(c.node.mem.used, c.node.mem.total) : null;
  const st = mainStorage(c);
  const tone = !h.online ? "bad" : "ok";
  const nets = (c?.net || []).filter((n) => !n.bridge && n.state === "up");
  const rx = nets.reduce((s, n) => s + n.rx, 0);
  const tx = nets.reduce((s, n) => s + n.tx, 0);
  const io = c?.io || [];
  return (
    <article className={`pve-host card${selected ? " selected" : ""}${h.online ? "" : " offline"}`}>
      <button type="button" className="pve-host-hit" onClick={onSelect} aria-pressed={selected} aria-label={`Показать графики ${h.name}`} />
      <header className="pve-host-head">
        <div className="pve-host-title">
          <Dot tone={tone} pulse={h.online} />
          <h3>{h.name}</h3>
          <span className="pve-mono pve-muted">{h.address}</span>
        </div>
        <div className="pve-host-badges">
          {c?.versions.pve ? <Pill tone="accent">PVE {c.versions.pve}</Pill> : null}
          {h.online ? <Pill tone="ok">в сети · {h.latency_ms} мс</Pill> : <Pill tone="bad">нет связи</Pill>}
        </div>
      </header>
      <p className="pve-host-sub">
        {[platformName(hw), cpuShort(hw?.cpu.model), hw ? `${hw.cpu.threads} потоков` : "", c ? bytes(c.node.mem.total, 0) + " ОЗУ" : ""].filter(Boolean).join(" · ") || "Характеристики появятся после первого опроса"}
      </p>
      {!h.online ? (
        <div className="pve-host-error">
          <strong>Хост не отвечает.</strong> {h.error || "Нет данных от агента."}
          {h.last_ok ? <span className="pve-muted"> Последние данные — {ago(h.last_ok)}.</span> : null}
        </div>
      ) : null}
      {c ? (
        <>
          <div className="pve-rings">
            <Ring label="Процессор" value={c.node.cpu} tone={loadTone(c.node.cpu)} display={percent(c.node.cpu)} sub={c.node.freq_mhz ? `${(c.node.freq_mhz / 1000).toFixed(1)} ГГц` : undefined} />
            <Ring label="Память" value={mem} tone={loadTone(mem || 0)} display={percent(mem)} sub={`${bytes(c.node.mem.used, 1)}`} />
            <Ring label="Температура" value={c.node.cpu_temp} max={100} tone={tempTone(c.node.cpu_temp)} display={celsius(c.node.cpu_temp)} sub="процессор" />
            <Ring label={st ? `Диск · ${st.name}` : "Диск"} value={st ? ratio(st.used, st.total) : null} tone={loadTone(st ? ratio(st.used, st.total) : 0)} display={st ? percent(ratio(st.used, st.total)) : "—"} sub={st ? `из ${bytes(st.total, 0)}` : undefined} />
          </div>
          <dl className="pve-host-facts">
            <Stat label="Машины" value={<><b>{running(c)}</b> <span className="pve-muted">из {guestsTotal(c)}</span></>} sub="запущено" />
            <Stat label="Нагрузка" value={c.node.load.map((v) => v.toFixed(2)).join(" · ")} sub={`1 · 5 · 15 мин, ${c.node.threads} потоков`} />
            <Stat label="Сеть" value={<span className="pve-updown"><span>↓ {bits(rx)}</span><span>↑ {bits(tx)}</span></span>} />
            <Stat label="Диски" value={<span className="pve-updown"><span>R {rate(io.reduce((s, d) => s + d.r, 0))}</span><span>W {rate(io.reduce((s, d) => s + d.w, 0))}</span></span>} />
            <Stat label="Работает" value={uptime(c.node.uptime)} sub={c.node.swap.total ? `swap ${percent(ratio(c.node.swap.used, c.node.swap.total))}` : "без swap"} />
            <Stat label="Обновления" value={c.updates ?? "—"} tone={c.updates && c.updates > 0 ? "warn" : undefined} sub={c.failed_units.length ? `сбои служб: ${c.failed_units.length}` : "службы в порядке"} />
          </dl>
        </>
      ) : null}
    </article>
  );
}

function pick(points: PvePoint[], key: keyof PvePoint) {
  return points.map((p) => (p[key] == null ? null : (p[key] as number)));
}

function Charts({ history, period, memTotal }: { history: PveHistory; period: Period; memTotal: number }) {
  const points = useMemo(() => {
    const from = Date.now() / 1000 - PERIODS[period];
    return history.points.filter((p) => p.t >= from);
  }, [history, period]);
  if (points.length < 2) return <Empty title="История копится">Агент записывает точку раз в минуту — графики появятся через пару минут.</Empty>;
  const times = points.map((p) => p.t);
  const charts = [
    { title: "Процессор", series: [{ label: "Загрузка", values: pick(points, "cpu") }, { label: "Ожидание дисков", values: pick(points, "io") }], format: percent, max: 100 },
    { title: "Память", series: [{ label: "Занято", values: points.map((p) => (p.mem == null ? null : ratio(p.mem, memTotal))) }], format: percent, max: 100 },
    { title: "Температура процессора", series: [{ label: "°C", values: pick(points, "temp") }], format: celsius },
    { title: "Сеть", series: [{ label: "Приём", values: pick(points, "rx") }, { label: "Передача", values: pick(points, "tx") }], format: bits },
    { title: "Диски", series: [{ label: "Чтение", values: pick(points, "r") }, { label: "Запись", values: pick(points, "w") }], format: rate },
    { title: "Средняя нагрузка (1 мин)", series: [{ label: "load", values: pick(points, "load") }], format: (v: number) => v.toFixed(2) },
  ];
  return (
    <div className="pve-charts">
      {charts.map((c) => {
        const last = c.series[0].values.filter((v) => v != null).slice(-1)[0];
        return (
          <div className="pve-chart card" key={c.title}>
            <div className="pve-chart-head">
              <h3>{c.title}</h3>
              <strong>{last == null ? "—" : c.format(last)}</strong>
            </div>
            <TimeChart times={times} series={c.series} format={c.format} max={c.max} height={132} label={c.title} axis />
            {c.series.length > 1 ? <Legend series={c.series} /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function Overview({ host, hosts, selected, onSelect }: { host: Host; hosts: PveHost[]; selected: string; onSelect: (id: string) => void }) {
  const [period, setPeriod] = useState<Period>("6h");
  const current = hosts.find((h) => h.id === selected) || hosts[0];
  const history = useHistory(host, current?.id || null);
  return (
    <div className="pve-page">
      <div className={`pve-hosts count-${Math.min(hosts.length, 3)}`}>
        {hosts.map((h) => <HostCard key={h.id} h={h} selected={hosts.length > 1 && h.id === current?.id} onSelect={() => onSelect(h.id)} />)}
      </div>
      {current ? (
        <Section
          title={`Графики · ${current.name}`}
          hint={hosts.length > 1 ? "Нажмите на карточку хоста, чтобы переключиться. Точка — среднее за минуту." : "Точка — среднее за минуту, агент хранит сутки."}
          actions={<Segmented label="Период" value={period} onChange={setPeriod} options={[{ value: "1h", label: "Час" }, { value: "6h", label: "6 часов" }, { value: "24h", label: "Сутки" }]} />}
        >
          {history.data ? <Charts history={history.data} period={period} memTotal={current.current?.node.mem.total || 1} />
            : history.error ? <Empty title="История недоступна">{history.error}</Empty>
            : <div className="pve-skeleton tall" />}
        </Section>
      ) : null}
    </div>
  );
}
