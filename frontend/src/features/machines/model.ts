import type { Computer, Distro } from "../pc/model";
import type { PveGuest, PveHost } from "../pve/model";

export type Machine = {
  key: string; name: string; kind: "server" | "pc" | "vm" | "wsl";
  online: boolean; parent?: Machine; children: Machine[]; pve?: PveHost; guest?: PveGuest; pc?: Computer; wsl?: Distro;
  standalone?: boolean;
};
/** Match addresses, never names: the PC inventory of a VM enriches that guest. */
export function machineTree(hosts: PveHost[], computers: Computer[], placements: { server: string; vmid: number; ips: string[] }[] = []): Machine[] {
  const claimed = new Set<string>();
  const roots: Machine[] = hosts.map(h => {
    const root: Machine = { key: `node:${h.id}`, name: h.name, kind: "server", online: h.online, pve: h, children: [] };
    root.children = (h.current?.guests || []).filter(g => !g.template).map(g => {
      const ips = new Set([...(g.ips || []), ...(placements.find(p => p.server === h.id && p.vmid === g.vmid)?.ips || [])]);
      const pc = computers.find(p => !claimed.has(p.id) && ips.has(p.address));
      if (pc) claimed.add(pc.id);
      return { key: `guest:${h.id}:${g.type}:${g.vmid}`, name: g.name || String(g.vmid), kind: "vm", online: h.online && g.status === "running", parent: root, children: [], pve: h, guest: g, pc };
    });
    return root;
  });
  for (const pc of computers.filter(p => !claimed.has(p.id))) roots.push({ key: `pc:${pc.id}`, name: pc.name, kind: "pc", online: pc.online, children: [], pc });
  for (const m of roots.flatMap(r => [r, ...r.children])) {
    for (const wsl of m.pc?.current?.wsl || []) m.children.push({ key: `wsl:${m.pc!.id}:${wsl.name}`, name: wsl.name, kind: "wsl", online: m.online && wsl.state === "running", parent: m, children: [], pc: m.pc, wsl });
  }
  return roots;
}
export const flatten = (roots: Machine[]): Machine[] => roots.flatMap(m => [m, ...flatten(m.children)]);
/** Reachability and power state differ: an offline PC can have running WSL in its last snapshot. */
export const stoppedWsl = (m: Machine) => m.kind === "wsl" && m.wsl?.state === "stopped";
export function machineRoute(m: Machine): string {
  if (m.standalone) return `pc/host/${encodeURIComponent(m.pc!.id)}${m.wsl ? `/wsl/${encodeURIComponent(m.wsl.name)}` : ""}`;
  if (m.guest) return `pveguests/${encodeURIComponent(m.pve!.id)}/${m.guest.type}/${m.guest.vmid}`;
  if (m.kind === "server") return `pveguests/${encodeURIComponent(m.pve!.id)}/node/0`;
  return `pveguests/pc/${encodeURIComponent(m.pc!.id)}${m.wsl ? `/wsl/${encodeURIComponent(m.wsl.name)}` : ""}`;
}
export function containerLink(m: Machine): string {
  const params = new URLSearchParams();
  if (m.pc) params.set("host", m.pc.id);
  else if (m.kind === "server") params.set("server", m.pve!.id);
  else params.set("machine", m.key);
  if (m.wsl) params.set("context", `wsl:${m.wsl.name}`);
  return `#/${m.standalone ? "pcdocker" : "pve/containers"}?${params}`;
}
export const machineContainers = (m: Machine) => (m.pc?.current?.docker || []).filter(d => !m.wsl || d.context === `wsl:${m.wsl.name}`).flatMap(d => d.containers);
