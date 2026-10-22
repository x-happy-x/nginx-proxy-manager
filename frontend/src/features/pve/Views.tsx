import { useState } from "react";
import { ActionButtons } from "./Actions";
import { usePve, useSaved } from "./context";
import { ago, backupFailed, bits, bytes, celsius, cpuSensor, cpuShort, mainStorage, percent, platformName, ratio, sensorThreshold, tempTone, uptime, usageTone, type PveGuest, type PveHost } from "./model";
import { Bar, Empty, Pill } from "./parts";
import { AppChips, Chart, Gauge, GuestMetrics, GuestName, HostHead, More, NoMatches, SnapshotNote } from "./ui";

export function Rack({ hosts }: { hosts: PveHost[] }) {
  const { guestMatches } = usePve();
  return hosts.length ? <div className="pv-rack">{hosts.map(h => {
    const c = h.current, s = mainStorage(c), thresholds = sensorThreshold(cpuSensor(h));
    return <article className="pv-card pv-server" key={h.id}><HostHead h={h} /><SnapshotNote h={h} />
      <p className="pv-spec-line">{platformName(h.hardware)} · {cpuShort(h.hardware?.cpu.model) || "CPU неизвестен"} · {bytes(c?.node.mem.total)} · PVE {c?.versions.pve || "—"}</p>
      {c ? <><div className="pv-gauges"><Gauge label="CPU" value={c.node.cpu} display={percent(c.node.cpu)} tone={usageTone(c.node.cpu)} /><Gauge label="Память" value={ratio(c.node.mem.used, c.node.mem.total)} display={percent(ratio(c.node.mem.used, c.node.mem.total))} tone={usageTone(ratio(c.node.mem.used, c.node.mem.total))} /><Gauge label="Процессор" value={c.node.cpu_temp == null ? null : c.node.cpu_temp / thresholds.crit * 100} display={celsius(c.node.cpu_temp)} tone={tempTone(c.node.cpu_temp, thresholds.warn, thresholds.bad)} /><Gauge label={s?.name || "Хранилище"} value={s ? ratio(s.used, s.total) : null} display={s ? percent(ratio(s.used, s.total)) : "—"} tone={usageTone(s ? ratio(s.used, s.total) : 0)} /></div>
      <div className="pv-guests">{c.guests.filter(g => guestMatches(h, g)).map(g => <div className={`pv-guest ${g.status !== "running" ? "off" : ""}`} key={`${g.type}:${g.vmid}`}><GuestName h={h} g={g} /><div className="pv-guest-metrics"><GuestMetrics g={g} /></div><More h={h} g={g} /><div className="pv-guest-apps"><AppChips g={g} /></div></div>)}{!c.guests.length && <small>На сервере нет машин</small>}</div>
      <footer className="pv-footer"><span>↓{bits(c.net.filter(n => !n.bridge).reduce((v, n) => v + n.rx, 0))} ↑{bits(c.net.filter(n => !n.bridge).reduce((v, n) => v + n.tx, 0))}</span><span>{c.disks.length} дисков</span>{c.updates ? <Pill tone="warn">{c.updates} обновлений</Pill> : null}<span>{ago(c.ts)}</span></footer></> : <Empty title="Нет снимка">{h.error}</Empty>}
    </article>;
  })}</div> : <NoMatches />;
}

type Sort = "name" | "cpu" | "mem" | "net" | "apps" | "uptime";
export function Machines({ hosts }: { hosts: PveHost[] }) {
  const ctx = usePve(); const [grouped, setGrouped] = useSaved("homenet.pve.grouped", true);
  const [sort, setSort] = useState<Sort>("name"), [desc, setDesc] = useState(false);
  const value = (g: PveGuest, key: Sort) => key === "name" ? g.name.toLocaleLowerCase() : key === "apps" ? ctx.appsOf(g).length : key === "net" ? (g.netin_rate || 0) + (g.netout_rate || 0) : g[key];
  const rows = hosts.flatMap(h => (h.current?.guests || []).filter(g => ctx.guestMatches(h, g)).map(g => ({ h, g }))).sort((a, b) => {
    if (grouped && a.h.id !== b.h.id) return a.h.name.localeCompare(b.h.name, "ru");
    const av = value(a.g, sort), bv = value(b.g, sort); return (typeof av === "string" ? av.localeCompare(String(bv), "ru") : Number(av) - Number(bv)) * (desc ? -1 : 1);
  });
  const columns: [Sort, string][] = [["name", "Машина"], ["cpu", "CPU · сутки"], ["mem", "Память"], ["net", "Сеть и диск"], ["apps", "Приложения"], ["uptime", "Работает"]];
  return <><div className="pv-tools"><div className="hp-view" role="group" aria-label="Группировка">{[true, false].map(v => <button key={String(v)} aria-pressed={grouped === v} className={grouped === v ? "is-on" : ""} onClick={() => setGrouped(v)}>{v ? "По серверам" : "Одним списком"}</button>)}</div><label className="pv-mobile-sort">Сортировка <select value={sort} onChange={e => setSort(e.target.value as Sort)}>{columns.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button onClick={() => setDesc(!desc)}>{desc ? "↓" : "↑"}</button></label></div>
    {rows.length ? <div className="pv-table" role="table" aria-label="Машины"><div className="pv-tr pv-thead" role="row">{columns.map(([key, label]) => <div role="columnheader" key={key} aria-sort={sort === key ? desc ? "descending" : "ascending" : "none"}><button onClick={() => { if (sort === key) setDesc(!desc); else { setSort(key); setDesc(false); } }}>{label} {sort === key ? desc ? "↓" : "↑" : ""}</button></div>)}<span role="columnheader">Питание</span></div>
      {rows.map(({ h, g }, i) => <div className="pv-rowgroup" role="rowgroup" key={`${h.id}:${g.type}:${g.vmid}`}>{grouped && rows[i - 1]?.h.id !== h.id && <div className="pv-group" role="row"><span role="cell">{h.name} · {ctx.hide ? "Адрес скрыт" : h.address} · {cpuShort(h.hardware?.cpu.model)}</span></div>}<div className={`pv-tr ${g.status !== "running" ? "off" : ""}`} role="row">
        <div role="cell"><GuestName h={h} g={g} />{!h.online && <small>Нет связи с сервером</small>}</div>
        <div role="cell" className="pv-metric">{percent(g.cpu)}<Chart title={`CPU ${g.name} за сутки`} times={(ctx.history[h.id]?.guests?.[g.vmid] || []).map(p => p[0])} values={(ctx.history[h.id]?.guests?.[g.vmid] || []).map(p => p[1])} format={percent} max={100} compact /></div>
        <div role="cell" className="pv-metric">{bytes(g.mem)} / {bytes(g.maxmem)}<Bar thin value={ratio(g.mem, g.maxmem)} tone={usageTone(ratio(g.mem, g.maxmem))} /></div>
        <div role="cell" className="pv-metric">↓{bits(g.netin_rate)} ↑{bits(g.netout_rate)}<small>R {bytes(g.diskread_rate)}/с · W {bytes(g.diskwrite_rate)}/с</small></div>
        <div role="cell"><AppChips g={g} /></div><div role="cell">{uptime(g.uptime)}</div><div role="cell" className="pv-power-cell"><ActionButtons h={h} g={g} compact /><More h={h} g={g} /></div>
      </div></div>)}
    </div> : <NoMatches />}</>;
}

export function Resources({ hosts }: { hosts: PveHost[] }) {
  const [resource, setResource] = useSaved<"mem" | "cpu" | "disk">("homenet.pve.resource", "mem");
  const { guestMatches, setTarget } = usePve(); const format = resource === "cpu" ? (n: number) => `${Number(n.toFixed(1))} vCPU` : bytes;
  return <><div className="pv-tools">{([['mem', 'Память'], ['cpu', 'Процессор'], ['disk', 'Диск']] as const).map(([key, text]) => <button className={`pv-chip ${resource === key ? "is-on" : ""}`} aria-pressed={resource === key} key={key} onClick={() => setResource(key)}>{text}</button>)}</div><div className="pv-columns">{hosts.map(h => {
    const c = h.current, storage = mainStorage(c);
    const total = resource === "mem" ? c?.node.mem.total || 0 : resource === "cpu" ? c?.node.threads || 0 : (c?.storage || []).filter(s => s.active && /images|rootdir/.test(s.content)).reduce((v, s) => v + s.total, 0) || storage?.total || 0;
    const actual = resource === "mem" ? c?.node.mem.used || 0 : resource === "cpu" ? total * (c?.node.cpu || 0) / 100 : (c?.storage || []).filter(s => s.active && /images|rootdir/.test(s.content)).reduce((v, s) => v + s.used, 0) || storage?.used || 0;
    const allocation = (g: PveGuest) => resource === "mem" ? g.maxmem : resource === "cpu" ? g.cpus : g.maxdisk;
    const guests = c?.guests || [], allocated = guests.reduce((n, g) => n + allocation(g), 0), scale = Math.max(total, allocated, 1), free = Math.max(0, total - allocated);
    return <article className="pv-card" key={h.id}><HostHead h={h} /><SnapshotNote h={h} /><div className="pv-cap"><span>Выделено машинам</span><b>{format(allocated)} / {format(total)}</b></div><div className="pv-allocation">{guests.map((g, i) => <span key={g.vmid} title={`${g.name}: ${format(allocation(g))}`} className={g.status !== "running" ? "off" : ""} style={{ width: `${allocation(g) / scale * 100}%`, background: `hsl(${255 - i * 16} 52% 54%)` }}>{g.name}</span>)}</div><div className="pv-cap"><span>Фактически занято</span><b>{format(actual)} · {percent(ratio(actual, total))}</b></div><Bar value={ratio(actual, total)} tone={usageTone(ratio(actual, total))} />
    {allocated > total && <p className="pv-warning">Выделено больше физического ресурса: {format(allocated - total)}</p>}
    <div className="pv-blocks">{guests.filter(g => guestMatches(h, g)).map((g, i) => <button key={g.vmid} className={`pv-block ${g.status !== "running" ? "off" : ""}`} style={{ flexGrow: Math.max(0.1, allocation(g) / scale * 100), minHeight: `${Math.max(64, allocation(g) / scale * 300)}px`, backgroundColor: `hsl(${255 - i * 16} 52% 54%)` }} onClick={() => setTarget({ host: h.id, vmid: g.vmid, type: g.type })}><b>{g.name}</b><small>{format(allocation(g))} · {g.status === "running" ? percent(g.cpu) : "выкл"}</small></button>)}<div className="pv-free">Свободно {format(free)}{resource === "mem" && free >= 2 * 1024 ** 3 && <small>Можно перенести VM, если подходят остальные ресурсы</small>}</div></div>{resource === "disk" && <small>Диск: максимальные объёмы гостей и хранилища для образов; общие пулы могут пересекаться.</small>}</article>;
  })}</div>{!hosts.length && <NoMatches />}</>;
}
export function hostFilter(h: PveHost, filter: string) { const c = h.current; return filter === "offline" ? !h.online : filter === "updates" ? !!c?.updates : filter === "memory" ? !!c && ratio(c.node.mem.used, c.node.mem.total) >= 85 : filter === "backups" ? !!c?.backups.some(backupFailed) : true; }
