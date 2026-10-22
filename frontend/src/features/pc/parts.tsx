import type { ReactNode } from "react";
import { TimeChart } from "../../components/charts/TimeChart";
import { Icon } from "../../components/ui/Icon";
import { bytes, percent, ratio } from "../pve/model";
import { outdated, systemName, type Computer, type History } from "./model";
import { usePc } from "./context";

export function Chip({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return <button type="button" className={`pc-chip${active ? " is-on" : ""}`} aria-pressed={active} onClick={onClick}>{children}</button>;
}
export function ViewSwitch<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (next: T) => void }) {
  return <div className="hp-view" role="group" aria-label={label}>{options.map(o => <button type="button" key={o.value} aria-pressed={value === o.value} className={value === o.value ? "is-on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}
export function PcHeading({ title, subtitle, query, setQuery, children, privacy = true }: { title: string; subtitle: string; query?: string; setQuery?: (q: string) => void; children?: ReactNode; privacy?: boolean }) {
  const { hideAddresses, setHideAddresses } = usePc();
  return <header className="pc-heading"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="pc-heading-tools">{setQuery ? <label className="pc-search"><Icon name="search" size={16} /><input aria-label="Поиск" placeholder="Компьютер, контейнер, образ, порт" value={query} onChange={e => setQuery(e.target.value)} /></label> : null}{children}{privacy ? <button type="button" className="hp-btn is-quiet" aria-pressed={hideAddresses} onClick={() => setHideAddresses(!hideAddresses)}>{hideAddresses ? "Адреса скрыты" : "Скрыть адреса"}</button> : null}</div></header>;
}
export function OsIcon({ h }: { h: Computer }) { return <span className={`pc-os ${h.current?.os || "unknown"}`} aria-label={systemName(h)}>{h.current?.os === "windows" ? "⊞" : h.current?.os === "linux" ? "🐧" : <Icon name="system" />}</span>; }
export function StatusDot({ state, label }: { state: "ok" | "warn" | "off"; label: string }) { return <span className={`pc-dot ${state}`} role="img" aria-label={label} title={label} />; }
export function MachineHead({ h, badge = true }: { h: Computer; badge?: boolean }) {
  const { hideAddresses, vmOf, openComputer } = usePc();
  const vm = vmOf(h);
  return <header className="pc-machine-head"><OsIcon h={h} /><div className="pc-machine-name"><button type="button" onClick={() => openComputer(h.id)}>{h.name}</button> <StatusDot state={!h.online ? "off" : outdated(h) ? "warn" : "ok"} label={!h.online ? "Нет связи" : outdated(h) ? "Старые данные" : "На связи"} /><small>{hideAddresses ? "Адрес скрыт" : h.address} · {systemName(h)}{h.current ? ` · ${h.current.cpu.cores} ядер` : ""}</small></div>{badge ? vm ? <a className="pc-badge violet" href="#/pveguests">{vm.type === "lxc" ? "CT" : "VM"} {vm.vmid} · {vm.server_name}</a> : <span className="pc-badge blue">{h.current?.os === "windows" ? "рабочая станция" : "компьютер"}</span> : null}</header>;
}
export function Ring({ value, label, detail }: { value: number | null; label: string; detail?: string }) {
  return <div className={`pc-gauge${value !== null && value >= 85 ? " warning" : ""}`} title={detail || label}><svg viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="19" className="pc-ring-track" /><circle cx="23" cy="23" r="19" className="pc-ring-value" strokeDasharray={`${Math.max(0, Math.min(100, value || 0)) * 1.194} 119.4`} transform="rotate(-90 23 23)" /></svg><div><b>{percent(value)}</b><small>{label}</small></div></div>;
}
export function Meter({ value, children }: { value: number | null; children?: ReactNode }) { return <div className="pc-meter"><span>{children ?? percent(value)}</span><div className="pc-bar"><i className={value !== null && value >= 85 ? "warning" : ""} style={{ width: `${Math.min(100, Math.max(0, value || 0))}%` }} /></div></div>; }
export function Spark({ points, label = "CPU · последний час" }: { points: History["points"]; label?: string }) {
  const recent = points.filter(p => p.t >= Date.now() / 1000 - 3600);
  return <div className="pc-spark"><small>{label}</small>{recent.some(p => p.cpu !== null) ? <TimeChart times={recent.map(p => p.t)} series={[{ label: "CPU", values: recent.map(p => p.cpu), color: "var(--hp-acc)" }]} max={100} height={32} compact area={false} format={percent} label={label} /> : <span className="pc-muted">История пока не накоплена</span>}</div>;
}
export function Disks({ h }: { h: Computer }) { return <div className="pc-disks">{h.current?.disks.length ? h.current.disks.map(d => <div key={d.path} className="pc-disk"><div><b>{d.path}</b><span>{bytes(d.used)} / {bytes(d.total)}</span></div><Meter value={d.total ? ratio(d.used, d.total) : null} /><small>Свободно {bytes(d.free)}</small></div>) : <p className="pc-muted">Нет данных о дисках.</p>}</div>; }

// Keep each binding visible, including loopback and unpublished container ports.
export function Ports({ value }: { value: string }) {
  const { hideAddresses } = usePc();
  return <span className="pc-ports">{value ? value.split(/,\s*/).map((raw, i) => {
    const local = /^(127\.|\[?::1\]?:|localhost:)/.test(raw);
    const published = raw.includes("->");
    const short = published ? raw.replace(/^(?:\[[^\]]+\]|[^:]+|::):(?=\d)/, local ? "lo:" : "") : raw;
    return <span key={i} className={published && !local ? "public" : ""} title={hideAddresses ? undefined : raw}>{short}</span>;
  }) : "—"}</span>;
}
export const shortImage = (s: string) => s.replace(/([:@](?:sha256:)?)([a-f0-9]{12})[a-f0-9]+$/i, "$1$2…");
