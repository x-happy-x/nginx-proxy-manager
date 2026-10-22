import { useState } from "react";
import { TimeChart } from "../../components/charts/TimeChart";
import { ActionButtons } from "./Actions";
import { usePve } from "./context";
import { ago, bytes, cpuShort, percent, ratio, guestStatus, stale, type PveGuest, type PveHost, type Tone } from "./model";
import { Bar, Dot, Empty } from "./parts";

export function HostHead({ h }: { h: PveHost }) {
  const { hide, setTarget } = usePve();
  return <header className="pv-host-head"><span className="pv-avatar server">{h.name.slice(0, 2)}</span><div className="pv-grow"><button className="pv-name" onClick={() => setTarget({ host: h.id })}>{h.name}</button> <Dot tone={!h.online ? "idle" : stale(h) ? "warn" : "ok"} /><small>{hide ? "Адрес скрыт" : h.address} · {h.current?.host !== h.name ? h.current?.host : cpuShort(h.hardware?.cpu.model)}</small></div><More h={h} /></header>;
}
export function More({ h, g }: { h: PveHost; g?: PveGuest }) {
  const [open, setOpen] = useState(false);
  const { setTarget } = usePve();
  return <span className="pv-more" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}>
    <button className="pv-dots" aria-label={`Ещё: ${g?.name || h.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
    {open && <span className="pv-menu"><button onClick={() => { setOpen(false); setTarget({ host: h.id, vmid: g?.vmid, type: g?.type }); }}>Подробнее</button><ActionButtons h={h} g={g} onAction={() => setOpen(false)} /></span>}
  </span>;
}
export function AppChips({ g, all = false }: { g: PveGuest; all?: boolean }) {
  const { appsOf, appsKnown, hosts, setTarget } = usePve(); const apps = appsOf(g);
  return <div className="pv-apps">{apps.slice(0, all ? undefined : 5).map(a => <span key={a.key}>{a.title}</span>)}{!all && apps.length > 5 && <button onClick={() => setTarget({ host: hosts.find(h => h.current?.guests.includes(g))?.id || "", vmid: g.vmid, type: g.type })} title="Откройте машину для полного списка">+{apps.length - 5}</button>}{all && !apps.length && <small>{appsKnown ? "Приложения не найдены по IP машины" : "Список приложений недоступен"}</small>}</div>;
}
export function GuestName({ h, g }: { h: PveHost; g: PveGuest }) { const { hide, setTarget } = usePve(); return <div className="pv-guest-name"><span className={`pv-avatar ${g.type}`}>{g.type === "lxc" ? "CT" : "VM"}</span><div><button className="pv-name" onClick={() => setTarget({ host: h.id, vmid: g.vmid, type: g.type })}>{g.name || g.vmid}</button> <Dot tone={g.status === "running" ? "ok" : "idle"} /><small>{g.vmid} · {hide ? "Адрес скрыт" : g.ips?.join(", ") || "IP неизвестен"} · {g.cpus || "—"} vCPU</small></div></div>; }
export function Gauge({ value, label, display, tone = "ok" }: { value: number | null; label: string; display: string; tone?: Tone }) {
  return <div className={`pv-gauge tone-${value === null ? "idle" : tone}`}><svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="21" className="track" /><circle cx="26" cy="26" r="21" className="fill" strokeDasharray={`${Math.max(0, Math.min(100, value || 0)) * 1.3195} 131.95`} transform="rotate(-90 26 26)" /></svg><b>{display}</b><small>{label}</small></div>;
}
export function Chart({ title, times, values, format, max, threshold, compact = false }: { title: string; times: number[]; values: (number | null)[]; format: (v: number) => string; max?: number; threshold?: number; compact?: boolean }) {
  return <div className={compact ? "pv-spark" : "pv-chart"}>{!compact && <h4>{title}</h4>}{times.length > 1 ? <TimeChart times={times} series={[{ label: title, values }, ...(threshold === undefined ? [] : [{ label: "Порог", values: times.map(() => threshold), color: "var(--hp-warn)" }])]} format={format} max={max} height={compact ? 24 : 90} compact={compact} axis={!compact} label={title} /> : <small className="pve-muted">Нет истории</small>}</div>;
}
export function GuestMetrics({ g }: { g: PveGuest }) { return <><div className="pv-metric"><span>{percent(g.cpu)} CPU</span><Bar thin value={g.cpu} tone={g.cpu >= 85 ? "warn" : "ok"} /></div><div className="pv-metric"><span>{bytes(g.mem)} / {bytes(g.maxmem)}</span><Bar thin value={ratio(g.mem, g.maxmem)} tone={ratio(g.mem, g.maxmem) >= 85 ? "warn" : "ok"} /></div></>; }
export function SnapshotNote({ h }: { h: PveHost }) { return !h.online || stale(h) ? <p className="pv-warning">{!h.online ? `Нет связи: ${h.error || "сервер недоступен"}` : "Данные устарели"}. Последний снимок: {ago(h.current?.ts)}.</p> : null; }
export function NoMatches() { return <Empty title="Ничего не найдено">Измените поиск или фильтры.</Empty>; }
export function GuestState({ g }: { g: PveGuest }) { return <small>{guestStatus(g)}</small>; }
