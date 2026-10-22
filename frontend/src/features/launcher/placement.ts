import { useEffect, useState } from "react";
import type { LauncherDevice } from "../../api";
import { deviceFor, OTHER_DEVICE } from "./model";

// NPM-84: where an application runs. The Proxmox module knows which server and
// guest own an address, the computer module which container publishes a port;
// both answer only administrators, through Core's integration gateway.

// cpu is percent, memory in bytes; absent while the module has no fresh snapshot (NPM-86)
export type Load = { cpu?: number | null; mem_used?: number; mem_total?: number; temp?: number | null };
export type PlaceNode = Load & { server: string; server_name: string; ip: string; online: boolean };
export type PlaceMachine = { server: string; server_name: string; vmid: number; name: string; type: string; status: string; ips: string[]; stale?: boolean };
export type PlacePort = { ip: string; port: number; target: string };
export type PlaceHost = Load & { id: string; name: string; ip: string; online: boolean; logs?: boolean };
export type PlaceContainer = { host: string; host_name: string; ip: string; context: string; id: string; name: string; image: string; state: string; status: string; ports: PlacePort[]; stale?: boolean };
export type PlacementData = { nodes: PlaceNode[]; machines: PlaceMachine[]; hosts: PlaceHost[]; containers: PlaceContainer[] };
export type Placement = { server: string; node?: PlaceNode; vm?: PlaceMachine; host?: PlaceHost; container?: PlaceContainer };
export type Found = { key: string; ip: string; port: number; url: string; container: PlaceContainer; place?: Placement };

async function getJSON<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function fetchPlacement(): Promise<PlacementData | null> {
  const [pve, pc] = await Promise.all([
    getJSON<{ nodes?: PlaceNode[]; machines?: PlaceMachine[] }>("/api/integrations/pve/api/pve/placement"),
    getJSON<{ hosts?: PlaceHost[]; containers?: PlaceContainer[] }>("/api/integrations/pc/api/pc/placement"),
  ]);
  if (!pve && !pc) return null;
  return { nodes: pve?.nodes || [], machines: (pve?.machines || []).map((m) => ({ ...m, ips: m.ips || [] })), hosts: pc?.hosts || [], containers: (pc?.containers || []).map((c) => ({ ...c, ports: c.ports || [] })) };
}

/** Placement refreshed every minute while enabled (administrators only). */
export function usePlacement(enabled: boolean) {
  const [data, setData] = useState<PlacementData | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const pull = () => void fetchPlacement().then((d) => alive && d && setData(d));
    pull();
    const t = setInterval(() => document.visibilityState === "visible" && pull(), 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return data;
}

export function splitTarget(target?: string): [string, number] | null {
  if (!target) return null;
  const i = target.lastIndexOf(":");
  const port = Number(target.slice(i + 1));
  return i > 0 && Number.isInteger(port) ? [target.slice(0, i).replace(/^\[|\]$/g, ""), port] : null;
}

const publishes = (c: PlaceContainer, ip: string, port: number) => c.ports.some((p) => p.port === port && (!p.ip || p.ip === ip));

/** Server, guest and container behind host:port, or undefined when no module knows the address. */
export function placeOf(target: string | undefined, data: PlacementData | null): Placement | undefined {
  const t = splitTarget(target);
  if (!t || !data) return undefined;
  const [ip, port] = t;
  const vm = data.machines.find((m) => m.ips.includes(ip));
  const node = data.nodes.find((n) => n.ip === ip) || (vm ? data.nodes.find((n) => n.server === vm.server) : undefined);
  const host = data.hosts.find((h) => h.ip === ip);
  const container = data.containers.find((c) => c.ip === ip && publishes(c, ip, port));
  if (!vm && !node && !host && !container) return undefined;
  return { server: vm?.server_name || node?.server_name || host?.name || ip, node, vm, host, container };
}

export function guestLabel(vm: PlaceMachine) {
  return `${vm.type === "lxc" ? "CT" : "VM"} ${vm.vmid} ${vm.name}`;
}

/** Load of a launcher device: its Proxmox node or a computer at one of its addresses. */
export function deviceLoad(addresses: string[], data: PlacementData | null): Load | undefined {
  if (!data) return undefined;
  const has = (ip: string) => addresses.includes(ip);
  const node = data.nodes.find((n) => has(n.ip) && n.mem_total);
  if (node) return node;
  return data.hosts.find((h) => has(h.ip) && h.mem_total);
}

export function containerLabel(c: PlaceContainer) {
  return c.context.startsWith("wsl:") ? `${c.name} · WSL ${c.context.slice(4)}` : c.name;
}

/** Steps from the outside in: server › VM › container. */
export function placeSteps(p: Placement): string[] {
  return [p.server, p.vm ? guestLabel(p.vm) : "", p.container ? containerLabel(p.container) : ""].filter(Boolean);
}

/** The launcher group of a placed address that matched no device: its Proxmox server's group. */
export function placedDevice(p: Placement | undefined, devices: LauncherDevice[]) {
  if (!p?.node) return OTHER_DEVICE;
  return deviceFor(p.node.ip, devices);
}

// Databases, brokers and remote shells are not applications to open in a browser.
const NOT_WEB = new Set([22, 2222, 2375, 2376, 3306, 5432, 5433, 6379, 7687, 9000, 9092, 11211, 27017]);

/**
 * Containers with a published port on home servers (Proxmox guests and nodes)
 * that no listed application points at. Workstations are left out: their
 * containers are development work, not home services.
 */
export function unlistedContainers(data: PlacementData | null, listed: Set<string>, dismissed: string[] = []): Found[] {
  if (!data) return [];
  const servers = new Set([...data.nodes.map((n) => n.ip), ...data.machines.flatMap((m) => m.ips)]);
  const skip = new Set([...listed, ...dismissed]);
  const out: Found[] = [];
  for (const c of data.containers) {
    if (c.state !== "running" || !servers.has(c.ip) || c.context !== "native") continue;
    for (const p of c.ports) {
      if (p.ip && p.ip !== c.ip) continue; // loopback-only ports are not reachable from the network
      const key = `${c.ip}:${p.port}`;
      if (NOT_WEB.has(p.port) || skip.has(key) || out.some((f) => f.key === key)) continue;
      out.push({ key, ip: c.ip, port: p.port, url: `http://${c.ip}:${p.port}/`, container: c, place: placeOf(key, data) });
    }
  }
  return out;
}
