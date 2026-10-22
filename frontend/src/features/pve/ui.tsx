import { useState } from "react";
import { TimeChart } from "../../components/charts/TimeChart";
import { ActionButtons } from "./Actions";
import { usePve } from "./context";
import { ago, bytes, cpuShort, percent, ratio, guestStatus, stale, type PveGuest, type PveHost, type Tone } from "./model";
import { Bar, Dot, Empty } from "./parts";

// NPM-92: each server keeps its own colour, in the order of the server list
const SERVER_HUES = [28, 205, 155, 265, 340, 190];
export function ServerAvatar({ h }: { h: PveHost }) {
  const { hosts } = usePve();
  const hue = SERVER_HUES[Math.max(0, hosts.findIndex(x => x.id === h.id)) % SERVER_HUES.length];
  return <span className="pv-avatar server" style={{ ["--hue" as string]: String(hue) }}>{h.name.slice(0, 2)}</span>;
}

/** Addresses a person uses: the server's own subnet first, bridges inside the guest (Docker, HA) left out. */
export function lanIPs(h: PveHost, g: PveGuest) {
  const ips = g.ips || [];
  const net = h.address.split(".").slice(0, 3).join(".") + ".";
  const own = ips.filter(ip => ip.startsWith(net));
  return own.length ? own : ips.filter(ip => !/^172\.(1[6-9]|2\d|3[01])\./.test(ip));
}

export function HostHead({ h }: { h: PveHost }) {
  const { hide, setTarget } = usePve();
  return <header className="pv-host-head"><ServerAvatar h={h} /><div className="pv-grow"><button className="pv-name" onClick={() => setTarget({ host: h.id })}>{h.name}</button> <Dot tone={!h.online ? "idle" : stale(h) ? "warn" : "ok"} /><small>{hide ? "Адрес скрыт" : h.address} · {h.current?.host !== h.name ? h.current?.host : cpuShort(h.hardware?.cpu.model)}</small></div><More h={h} /></header>;
}
export function More({ h, g }: { h: PveHost; g?: PveGuest }) {
  const [open, setOpen] = useState(false);
  const { setTarget } = usePve();
  return <span className="pv-more" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}>
    <button className="pv-dots" aria-label={`Ещё: ${g?.name || h.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
    {open && <span className="pv-menu"><button onClick={() => { setOpen(false); setTarget({ host: h.id, vmid: g?.vmid, type: g?.type }); }}>Подробнее</button><ActionButtons h={h} g={g} onAction={() => setOpen(false)} /></span>}
  </span>;
}
export function AppChips({ g, all = false, limit = 5 }: { g: PveGuest; all?: boolean; limit?: number }) {
  const { appsOf, appsKnown, hosts, setTarget } = usePve(); const apps = appsOf(g);
  return <div className="pv-apps">{apps.slice(0, all ? undefined : limit).map(a => <span key={a.key}>{a.title}</span>)}{!all && apps.length > limit && <button onClick={() => setTarget({ host: hosts.find(h => h.current?.guests.includes(g))?.id || "", vmid: g.vmid, type: g.type })} title={apps.slice(limit).map(a => a.title).join(", ")}>+{apps.length - limit}</button>}{all && !apps.length && <small>{appsKnown ? "Приложения не найдены по IP машины" : "Список приложений недоступен"}</small>}</div>;
}
export function GuestName({ h, g }: { h: PveHost; g: PveGuest }) { const { hide, setTarget } = usePve(); return <div className="pv-guest-name"><span className={`pv-avatar ${g.type}`}>{g.type === "lxc" ? "CT" : "VM"}</span><div><button className="pv-name" onClick={() => setTarget({ host: h.id, vmid: g.vmid, type: g.type })}>{g.name || g.vmid}</button> <Dot tone={g.status === "running" ? "ok" : "idle"} /><small>{g.vmid} · {hide ? "Адрес скрыт" : lanIPs(h, g).join(", ") || "IP неизвестен"} · {g.cpus || "—"} vCPU</small></div></div>; }
export function Gauge({ value, label, display, tone = "ok" }: { value: number | null; label: string; display: string; tone?: Tone }) {
  return <div className={`pv-gauge tone-${value === null ? "idle" : tone}`}><svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="21" className="track" /><circle cx="26" cy="26" r="21" className="fill" strokeDasharray={`${Math.max(0, Math.min(100, value || 0)) * 1.3195} 131.95`} transform="rotate(-90 26 26)" /></svg><b>{display}</b><small>{label}</small></div>;
}
export function Chart({ title, times, values, format, max, threshold, compact = false }: { title: string; times: number[]; values: (number | null)[]; format: (v: number) => string; max?: number; threshold?: number; compact?: boolean }) {
  return <div className={compact ? "pv-spark" : "pv-chart"}>{!compact && <h4>{title}</h4>}{times.length > 1 ? <TimeChart times={times} series={[{ label: title, values, color: title.startsWith("Память") ? "var(--hp-blue)" : "var(--hp-acc)" }, ...(threshold === undefined ? [] : [{ label: "Порог", values: times.map(() => threshold), color: "var(--hp-warn)" }])]} format={format} max={max} height={compact ? 24 : 90} compact={compact} axis={!compact} label={title} /> : <small className="pve-muted">Нет истории</small>}</div>;
}
export function GuestMetrics({ g }: { g: PveGuest }) { return <><div className="pv-metric"><span>{percent(g.cpu)} CPU</span><Bar thin value={g.cpu} tone={g.cpu >= 85 ? "warn" : "ok"} /></div><div className="pv-metric"><span>{bytes(g.mem)} / {bytes(g.maxmem)}</span><Bar thin value={ratio(g.mem, g.maxmem)} tone={ratio(g.mem, g.maxmem) >= 85 ? "warn" : "ok"} /></div></>; }
export function SnapshotNote({ h }: { h: PveHost }) { return !h.online || stale(h) ? <p className="pv-warning">{!h.online ? `Нет связи: ${h.error || "сервер недоступен"}` : "Данные устарели"}. Последний снимок: {ago(h.current?.ts)}.</p> : null; }
export function NoMatches() { return <Empty title="Ничего не найдено">Измените поиск или фильтры.</Empty>; }
export function GuestState({ g }: { g: PveGuest }) { return <small>{guestStatus(g)}</small>; }
