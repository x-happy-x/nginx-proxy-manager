import type { ReactNode } from "react";
import { TimeChart } from "../../components/charts/TimeChart";
import { Icon } from "../../components/ui/Icon";
import { bytes, percent, ratio } from "../pve/model";
import { outdated, systemName, type Computer, type History } from "./model";
import { usePc } from "./context";

export function Chip({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return <button type="button" className={`pc-chip${active ? " is-on" : ""}`} aria-pressed={active} onClick={onClick}>{children}</button>;
}
export { ViewSwitch } from "../monitoring/portal";

export function PcHeading({ title, subtitle, query, setQuery, children, privacy = true }: { title: string; subtitle: string; query?: string; setQuery?: (q: string) => void; children?: ReactNode; privacy?: boolean }) {
  const { hideAddresses, setHideAddresses } = usePc();
  return <header className="pc-heading"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="pc-heading-tools">{setQuery ? <label className="pc-search"><Icon name="search" size={16} /><input aria-label="Поиск" placeholder="Компьютер, контейнер, образ, порт" value={query} onChange={e => setQuery(e.target.value)} /></label> : null}{children}{privacy ? <button type="button" className="hp-btn is-quiet" aria-pressed={hideAddresses} onClick={() => setHideAddresses(!hideAddresses)}>{hideAddresses ? "Адреса скрыты" : "Скрыть адреса"}</button> : null}</div></header>;
}
export function OsIcon({ h }: { h: Computer }) {
  const os = h.current?.os;
  return <span className={`pc-os ${os || "unknown"}`} role="img" aria-label={systemName(h)}>
    {os === "windows" ? <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M4 6.3 14.5 4.9v10H4Zm12.5-1.7L28 3v11.9H16.5ZM4 17h10.5v10.1L4 25.7Zm12.5 0H28v12l-11.5-1.6Z" />
    </svg> : os === "linux" ? <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M16 3c-4 0-6.2 3.2-6.2 7.5v2c-2.2 2.8-4 6.1-4 9.1 0 4.6 4.5 7 10.2 7s10.2-2.4 10.2-7c0-3-1.8-6.3-4-9.1v-2C22.2 6.2 20 3 16 3Z" />
      <ellipse cx="16" cy="20.5" rx="6.3" ry="6.8" fill="var(--pc-os-paper)" />
      <ellipse cx="13.5" cy="10.5" rx="2" ry="2.7" fill="var(--pc-os-paper)" />
      <ellipse cx="18.5" cy="10.5" rx="2" ry="2.7" fill="var(--pc-os-paper)" />
      <ellipse cx="14" cy="11" rx=".8" ry="1.3" fill="currentColor" />
      <ellipse cx="18" cy="11" rx=".8" ry="1.3" fill="currentColor" />
      <path d="m12.8 14 3.2-1.7 3.2 1.7-3.2 2.4Z" fill="var(--pc-os-beak)" />
      <path d="M10.8 25.2c-1.2-.8-3.7.2-5 2.5-.5.8.1 1.5 1 1.5h6.5c1 0 1.5-.7 1-1.5Zm10.4 0c1.2-.8 3.7.2 5 2.5.5.8-.1 1.5-1 1.5h-6.5c-1 0-1.5-.7-1-1.5Z" fill="var(--pc-os-beak)" />
    </svg> : <Icon name="servers" size={25} />}
  </span>;
}
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

export type PortBinding = { label: string; local: boolean; raw: string[] };

// NPM-92: `docker ps` lists one published port per address family and also the
// ports a container only exposes inside Docker. Show each published binding
// once («4161», «4191→3001», «lo:5001» for loopback); unpublished ones only in details.
export function publishedPorts(value: string): { published: PortBinding[]; internal: string[] } {
  const published = new Map<string, PortBinding>();
  const internal: string[] = [];
  for (const raw of value ? value.split(/,\s*/) : []) {
    const m = raw.match(/^(?:\[?([0-9a-fA-F:.]*)\]?:)?(\d+(?:-\d+)?)->(\d+(?:-\d+)?)\/(tcp|udp)$/);
    if (!m) {
      if (raw.trim()) internal.push(raw.replace(/\/tcp$/, ""));
      continue;
    }
    const local = /^(127\.|::1$|localhost)/.test(m[1] || "");
    const label = `${local ? "lo:" : ""}${m[2]}${m[2] === m[3] ? "" : `→${m[3]}`}${m[4] === "udp" ? "/udp" : ""}`;
    const seen = published.get(label);
    if (seen) seen.raw.push(raw);
    else published.set(label, { label, local, raw: [raw] });
  }
  return { published: [...published.values()], internal: [...new Set(internal)] };
}

export function Ports({ value, all = false, limit = 0 }: { value: string; all?: boolean; limit?: number }) {
  const { hideAddresses } = usePc();
  const { published, internal } = publishedPorts(value);
  const shown = limit && published.length > limit ? published.slice(0, limit) : published;
  const more = published.length - shown.length;
  if (!published.length && !(all && internal.length)) return <span className="pc-ports">{all ? "—" : ""}</span>;
  return <span className="pc-ports">
    {shown.map(p => <span key={p.label} className={p.local ? "" : "public"} title={hideAddresses ? undefined : p.raw.join(", ")}>{p.label}</span>)}
    {more > 0 ? <span title={published.slice(limit).map(p => p.label).join(", ")}>+{more}</span> : null}
    {all && internal.length ? <span title="Порты внутри Docker, не опубликованы">внутри: {internal.join(", ")}</span> : null}
  </span>;
}
export const shortImage = (s: string) => s.replace(/([:@](?:sha256:)?)([a-f0-9]{12})[a-f0-9]+$/i, "$1$2…");
