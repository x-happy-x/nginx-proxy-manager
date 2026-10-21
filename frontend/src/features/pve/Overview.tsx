import { useMemo, useState } from "react";
import { Legend, TimeChart } from "../../components/charts/TimeChart";
import { Segmented } from "../../components/ui/controls";
import { Icon } from "../../components/ui/Icon";
import type { Host } from "../../platform/sdk";
import {
  ago, bits, bytes, celsius, cpuShort, guestsTotal, loadTone, mainStorage, percent, platformName, proxmoxURL, rate, ratio, running, stale, tempTone, uptime,
  useHistory, type PveHistory, type PveHost, type PvePoint,
} from "./model";
import { Dot, Empty, Pill, Ring, Section, Stat } from "./parts";
import { ActionButtons } from "./Actions";

type Period = "1h" | "6h" | "24h";
const PERIODS: Record<Period, number> = { "1h": 3600, "6h": 6 * 3600, "24h": 86400 };

export function HostCard({ h, selected, onSelect }: { h: PveHost; selected?: boolean; onSelect?: () => void }) {
  const c = h.current;
  const hw = h.hardware;
  const mem = c ? ratio(c.node.mem.used, c.node.mem.total) : null;
  const st = mainStorage(c);
  const old = stale(h);
  const tone = !h.online ? "bad" : old ? "warn" : "ok";
  const nets = (c?.net || []).filter((n) => !n.bridge && n.state === "up");
  const rx = nets.reduce((s, n) => s + n.rx, 0);
  const tx = nets.reduce((s, n) => s + n.tx, 0);
  const io = c?.io || [];
  return (
    <article className={`pve-host card${selected ? " selected" : ""}${h.online ? "" : " offline"}${old ? " stale" : ""}`}>
      <header className="pve-host-head">
        <div className="pve-host-title">
          <span className="pve-host-icon"><Icon name="servers" size={22} /></span>
          <h3>{h.name}</h3>
          <span className="pve-mono pve-muted">{h.address}</span>
        </div>
        <div className="pve-host-badges">
          {c?.versions.pve ? <Pill tone="accent">PVE {c.versions.pve}</Pill> : null}
          <Pill tone={tone}><Dot tone={tone} />{!h.online ? "нет связи" : old ? "данные устарели" : "в сети"}</Pill>
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
      {h.online && old ? <div className="pve-host-error stale">Показан последний снимок — {ago(c?.ts)}. Управление временно недоступно.</div> : null}
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
      <footer className="pve-host-footer">
        <div className="pve-host-links"><button type="button" className={`pve-btn${selected ? " selected" : ""}`} onClick={onSelect} aria-pressed={selected}><Icon name="activity" size={14} />Графики</button>
          <a className="pve-btn ghost" href={proxmoxURL(h)} target="_blank" rel="noopener noreferrer">Proxmox<Icon name="external" size={13} /></a>
          <span className="pve-muted pve-small">{ago(c?.ts || h.last_ok)}</span>
        </div>
        <ActionButtons h={h} />
      </footer>
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
  const fresh = hosts.filter((h) => !stale(h));
  const totalGuests = hosts.reduce((sum, h) => sum + guestsTotal(h.current), 0);
  const activeGuests = fresh.reduce((sum, h) => sum + running(h.current), 0);
  const memory = fresh.reduce((sum, h) => sum + (h.current?.node.mem.used || 0), 0);
  const capacity = fresh.reduce((sum, h) => sum + (h.current?.node.mem.total || 0), 0);
  const issues = hosts.flatMap((h) => {
    const c = h.current;
    if (stale(h)) return [{ host: h, text: h.online ? "Данные устарели" : "Нет связи с сервером", bad: !h.online }];
    if (!c) return [];
    return [
      ...c.failed_units.map((s) => ({ host: h, text: `Сбой службы: ${s}`, bad: true })),
      ...c.disks.filter((d) => d.health === false).map((d) => ({ host: h, text: `SMART: проверьте диск ${d.dev}`, bad: true })),
      ...c.storage.filter((s) => s.enabled && (!s.active || ratio(s.used, s.total) >= 90)).map((s) => ({ host: h, text: s.active ? `Хранилище ${s.name} заполнено на ${percent(ratio(s.used, s.total))}` : `Хранилище ${s.name} недоступно`, bad: !s.active })),
      ...(c.node.cpu_temp != null && c.node.cpu_temp >= 80 ? [{ host: h, text: `Высокая температура CPU: ${celsius(c.node.cpu_temp)}`, bad: c.node.cpu_temp >= 88 }] : []),
      ...(c.cluster?.quorate === false ? [{ host: h, text: "В кластере нет кворума", bad: true }] : []),
    ];
  });
  return (
    <div className="pve-page">
      <div className="pve-fleet">
        <div className="pve-fleet-intro"><span className="pve-eyebrow">Домашняя инфраструктура</span><h2>Серверы под контролем</h2><p>Состояние, ресурсы и управление в одном месте.</p></div>
        <div className="pve-fleet-metrics">
          <Stat label="Серверы на связи" value={<>{fresh.length}<small> / {hosts.length}</small></>} sub="со свежими данными" />
          <Stat label="Машины работают" value={<>{activeGuests}<small> / {totalGuests}</small></>} sub={fresh.length < hosts.length ? "часть состояний неизвестна" : "виртуальные машины и CT"} />
          <Stat label="Память занята" value={bytes(memory, 0)} sub={`из ${bytes(capacity, 0)} доступных`} />
          <Stat label="Требуют внимания" value={issues.length} sub={issues.length ? "проверьте ниже" : "сбоев не обнаружено"} tone={issues.length ? "warn" : undefined} />
        </div>
      </div>
      {issues.length ? <div className="pve-attention card"><div className="pve-card-head"><h3><Icon name="alert" size={15} />Требует внимания</h3><span className="pve-muted pve-small">{issues.length}</span></div>
        {issues.slice(0, 6).map((issue, i) => <button key={`${issue.host.id}/${i}`} type="button" onClick={() => onSelect(issue.host.id)}><Dot tone={issue.bad ? "bad" : "warn"} /><b>{issue.host.name}</b><span>{issue.text}</span><Icon name="chevronRight" size={14} /></button>)}
        {issues.length > 6 ? <p className="pve-muted pve-small">Ещё {issues.length - 6} — подробности в разделах железа и хранилищ.</p> : null}
      </div> : null}
      <div className={`pve-hosts count-${Math.min(hosts.length, 3)}`}>
        {hosts.map((h) => <HostCard key={h.id} h={h} selected={hosts.length > 1 && h.id === current?.id} onSelect={() => onSelect(h.id)} />)}
      </div>
      {current ? (
        <Section
          title={`Графики · ${current.name}`}
          hint={hosts.length > 1 ? "Выберите «Графики» на карточке сервера. Точка — среднее за минуту." : "Точка — среднее за минуту, агент хранит сутки."}
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
