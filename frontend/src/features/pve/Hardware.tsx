import { usePve } from "./context";
import { bytes, celsius, cpuSensor, cpuShort, platformName, sensorLabel, sensorThreshold, tempTone, type PveHost } from "./model";
import { Empty, Pill } from "./parts";
import { Chart, HostHead, NoMatches, SnapshotNote } from "./ui";

export function Inventory({ h }: { h: PveHost }) { const hw = h.hardware; return <details className="pv-inventory"><summary>Инвентарь железа</summary>{hw ? <dl className="pv-kv"><dt>Модель</dt><dd>{platformName(hw)}</dd><dt>Процессор</dt><dd>{cpuShort(hw.cpu.model)} · {hw.cpu.cores} ядер / {hw.cpu.threads} потоков</dd><dt>Память</dt><dd>{bytes(hw.memory.total)}{hw.memory.modules.map((m, i) => <div key={i}>{m.slot} · {m.size} {m.type} {m.speed}</div>)}</dd><dt>Контроллеры</dt><dd>{hw.controllers.join("; ") || "Нет данных"}</dd><dt>Плата</dt><dd>{hw.board || "—"}</dd><dt>Прошивка</dt><dd>{hw.bios || "—"}</dd></dl> : <Empty title="Инвентарь ещё не собран" />}</details>; }
export function Hardware({ hosts }: { hosts: PveHost[] }) {
  const { history, historyErrors } = usePve();
  return hosts.length ? <div className="pv-columns">{hosts.map(h => {
    const c = h.current, points = (history[h.id]?.points || []).filter(p => p.t >= Date.now() / 1000 - 86400), threshold = sensorThreshold(cpuSensor(h));
    return <article className="pv-card" key={h.id}><HostHead h={h} /><SnapshotNote h={h} />{c ? <><div className="pv-heat">{c.temps.map((t, i) => { const bounds = sensorThreshold(t); return <div key={i} className={`tone-${tempTone(t.c, bounds.warn, bounds.bad)}`} title={`Предупреждение ${bounds.warn} °C, критическая ${bounds.crit} °C`}><b>{celsius(t.c)}</b><small>{sensorLabel(t)}</small></div>; })}{!c.temps.length && <small>Датчики недоступны</small>}</div><p className="pv-spec-line">{c.fans.length ? c.fans.map(f => `${f.label}: ${f.rpm} об/мин`).join(" · ") : "Датчиков вентиляторов нет"}</p>
      <Chart title={`Процессор · сутки · порог ${threshold.warn} °C`} times={points.map(p => p.t)} values={points.map(p => p.temp)} threshold={threshold.warn} format={celsius} />{historyErrors[h.id] && <small role="status">История не обновилась: {historyErrors[h.id]}</small>}
      <div className="pv-disks">{c.disks.map(d => <div className="pv-disk" key={d.dev}><span className="pv-avatar disk">{d.kind.toUpperCase()}</span><div className="pv-grow"><b>{d.model || "Диск"}</b><small>/dev/{d.dev.replace(/^\/dev\//, "")} · {d.wear == null ? "износ неизвестен" : `износ ${d.wear} %`} · {celsius(d.temp)}</small></div><Pill tone={d.health === false ? "bad" : d.health == null ? "idle" : d.wear != null && d.wear >= 30 ? "warn" : "ok"}>{d.health == null ? "нет данных" : d.health ? "SMART ок" : "SMART ошибка"}</Pill></div>)}{!c.disks.length && <small>Данные о дисках недоступны</small>}</div></> : <Empty title="Нет снимка сервера" />}<Inventory h={h} /></article>;
  })}</div> : <NoMatches />;
}
