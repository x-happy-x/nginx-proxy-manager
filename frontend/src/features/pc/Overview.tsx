import { useState } from "react";
import { Legend, TimeChart } from "../../components/charts/TimeChart";
import { Segmented } from "../../components/ui/controls";
import { Icon } from "../../components/ui/Icon";
import type { Host } from "../../platform/sdk";
import { ago, bits, bytes, loadTone, percent, ratio, uptime } from "../pve/model";
import { Bar, Dot, Empty, Pill, Section, Stat } from "../pve/parts";
import { containersOf, outdated, systemName, usePcHistory, type Computer } from "./model";

function ComputerCard({ h, selected, select, navigate }: { h: Computer; selected: boolean; select: () => void; navigate: (page: string) => void }) {
  const s = h.current;
  const old = outdated(h);
  const containers = containersOf([h]);
  const mem = s ? ratio(s.memory.used, s.memory.total) : 0;
  return <article className={`pc-computer card${selected ? " selected" : ""}${old ? " outdated" : ""}`}>
    <header><span className={`pc-system-icon ${s?.os || ""}`}><Icon name={s?.os === "windows" ? "overview" : "terminal"} size={22} /></span><div><h3>{h.name}</h3><span className="pve-mono pve-muted">{h.address}</span></div><Pill tone={!h.online ? "bad" : old ? "warn" : "ok"}><Dot tone={!h.online ? "bad" : old ? "warn" : "ok"} />{!h.online ? "Нет связи" : old ? "Старые данные" : "На связи"}</Pill></header>
    <p className="pc-machine-meta">{systemName(h)}{s ? ` · ${s.arch} · ${s.cpu.cores} ядер` : ""}</p>
    {old ? <div className="pc-error">{h.error || "Текущее состояние недоступно."}{s ? ` Последний снимок: ${ago(s.ts)}.` : ""}</div> : null}
    {s ? <>
      <div className="pc-meter"><div><span>Процессор</span><strong>{percent(s.cpu.percent)}</strong></div><Bar value={s.cpu.percent || 0} tone={old ? "idle" : loadTone(s.cpu.percent || 0)} /><small>{s.cpu.model || "Модель не определена"}</small></div>
      <div className="pc-meter"><div><span>Память</span><strong>{bytes(s.memory.used)} <small>/ {bytes(s.memory.total, 0)}</small></strong></div><Bar value={mem} tone={old ? "idle" : loadTone(mem)} /><small>Свободно {bytes(s.memory.available)}</small></div>
      <div className="pc-machine-facts"><Stat label="Работает" value={uptime(s.uptime)} /><Stat label="Docker" value={`${containers.filter(({ c }) => c.state === "running").length} / ${containers.length}`} sub="контейнеров запущено" /><Stat label="WSL" value={`${s.wsl.filter((w) => w.state === "running").length} / ${s.wsl.length}`} sub={s.os === "windows" ? "дистрибутивов запущено" : "не используется"} /></div>
      {s.errors.length ? <details className="pc-diagnostics"><summary><Icon name="alert" size={13} />Часть данных недоступна · {s.errors.length}</summary><ul>{s.errors.map((error, i) => <li key={i}>{error}</li>)}</ul></details> : null}
    </> : <p className="pve-muted">Характеристики появятся после первого опроса агента.</p>}
    <footer><button type="button" className={`pve-btn${selected ? " primary" : ""}`} onClick={select} aria-pressed={selected}><Icon name="activity" size={14} />Ресурсы</button><button type="button" className="pve-btn ghost" onClick={() => navigate("pcdocker")}>Docker</button>{s?.os === "windows" ? <button type="button" className="pve-btn ghost" onClick={() => navigate("pcwsl")}>WSL</button> : null}<span className="pve-muted">{ago(s?.ts || h.last_ok)}</span></footer>
  </article>;
}

export function Overview({ host, computers }: { host: Host; computers: Computer[] }) {
  const [selected, setSelected] = useState("");
  const [period, setPeriod] = useState("6h");
  const h = computers.find((x) => x.id === selected) || computers[0];
  const history = usePcHistory(host, h?.id);
  const from = Date.now() / 1000 - (period === "1h" ? 3600 : period === "6h" ? 21600 : 86400);
  const points = (history.data?.points || []).filter((p) => p.t >= from);
  const times = points.map((p) => p.t);
  const current = computers.filter((c) => !outdated(c));
  const containers = containersOf(current);
  const problems = computers.filter((c) => outdated(c) || c.current?.errors.length || c.current?.disks.some((d) => ratio(d.used, d.total) >= 90));
  const network = [{ label: "Приём", values: points.map((p) => p.net_rx_bps) }, { label: "Передача", values: points.map((p) => p.net_tx_bps) }];
  return <div className="pc-page">
    <section className="pc-hero"><div><span className="pc-eyebrow">Домашние компьютеры</span><h2>Всё важное о ваших ПК</h2><p>Windows и Linux, ресурсы, Docker и окружения WSL.</p></div><div className="pc-summary"><Stat label="На связи" value={`${current.length} / ${computers.length}`} /><Stat label="Контейнеры работают" value={containers.filter(({ c }) => c.state === "running").length} /><Stat label="Требуют внимания" value={problems.length} tone={problems.length ? "warn" : undefined} /></div></section>
    <div className="pc-computers">{computers.map((c) => <ComputerCard key={c.id} h={c} selected={c.id === h?.id} select={() => setSelected(c.id)} navigate={host.navigate} />)}</div>
    {h ? <Section title={`Ресурсы · ${h.name}`} hint="История собирается, пока интеграция работает. Точки — раз в минуту."
      actions={<Segmented label="Период" value={period} onChange={setPeriod} options={[{ value: "1h", label: "Час" }, { value: "6h", label: "6 часов" }, { value: "24h", label: "Сутки" }]} />}>
      {history.error ? <div className="pc-error" role="alert">История не обновлена: {history.error}</div> : null}
      {points.length > 1 ? <div className="pc-charts">
        <div className="pc-chart card"><h3>Процессор</h3><TimeChart times={times} series={[{ label: "Загрузка", values: points.map((p) => p.cpu) }]} max={100} format={percent} height={150} axis label="Загрузка процессора" /></div>
        <div className="pc-chart card"><h3>Память</h3><TimeChart times={times} series={[{ label: "Занято", values: points.map((p) => ratio(p.mem_used, p.mem_total)) }]} max={100} format={percent} height={150} axis label="Использование памяти" /></div>
        <div className="pc-chart card"><h3>Сеть · основной маршрут</h3><TimeChart times={times} series={network} format={(value) => bits(value / 8)} height={150} axis label="Скорость сети по основному маршруту" /><Legend series={network} /></div>
      </div> : history.loading ? <div className="pve-skeleton" /> : <Empty title="История копится">Графики появятся после нескольких минут работы интеграции.</Empty>}
      <div className="pc-resource-details"><section className="card pc-disks"><div className="pve-card-head"><h3>Диски и разделы</h3></div>{h.current?.disks.length ? h.current.disks.map((d) => <div className="pc-disk" key={d.path}><div><strong className="pve-mono">{d.path}</strong><span>{bytes(d.used)} из {bytes(d.total)}</span></div><Bar value={ratio(d.used, d.total)} tone={loadTone(ratio(d.used, d.total))} /><small>Свободно {bytes(d.free)}</small></div>) : <p className="pve-muted pve-small">Нет данных о дисках.</p>}</section>
        <section className="card pc-networks"><div className="pve-card-head"><h3>Сетевые интерфейсы</h3></div>{h.current?.network.length ? h.current.network.map((n) => <div className="pc-network" key={n.name}><strong>{n.name}</strong><span>↓ {bytes(n.rx_bytes)}</span><span>↑ {bytes(n.tx_bytes)}</span></div>) : <p className="pve-muted pve-small">Нет данных о сети.</p>}<p className="pve-muted pve-small">Счётчики трафика с момента запуска интерфейса.</p></section></div>
    </Section> : null}
  </div>;
}
