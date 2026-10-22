import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Host } from "../../platform/sdk";
import type { LauncherConfig } from "../../api";
import type { RoutesDocument } from "../../types";
import { buildItems, defaultLauncher, type LauncherItem } from "../launcher/model";
import { splitTarget, type PlaceContainer } from "../launcher/placement";
import { type PveGuest, type PveHost, type PveHistory, guestTags } from "./model";

export function useSaved<T>(key: string, fallback: T) {
  const [value, set] = useState<T>(() => { try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; } });
  const save = (next: T) => { set(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Storage is optional. */ } };
  return [value, save] as const;
}
export type Target = { host: string; vmid?: number; type?: string };
function useStateOf(host: Host, hosts: PveHost[]) {
  const [hide, setHide] = useSaved("homenet.portal.hide-hosts", false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [target, setTarget] = useState<Target | null>(null);
  const [history, setHistory] = useState<Record<string, PveHistory>>({});
  const [historyErrors, setHistoryErrors] = useState<Record<string, string>>({});
  const [apps, setApps] = useState<LauncherItem[] | null>(null);
  const [containers, setContainers] = useState<PlaceContainer[] | null>(null);
  const ids = hosts.map(h => h.id).sort().join("\n");
  useEffect(() => {
    const read = () => { const [, id, type, vmid] = location.hash.replace(/^#\/?/, "").split("/");
      if (id && type && /^\d+$/.test(vmid || "")) setTarget({ host: decodeURIComponent(id), type, vmid: Number(vmid) }); };
    read(); window.addEventListener("hashchange", read); return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    let alive = true, busy = false;
    const pull = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      await Promise.all(ids.split("\n").filter(Boolean).map(async id => {
        try { const r = await host.api(`/api/pve/history?host=${encodeURIComponent(id)}`); if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const next = await r.json() as PveHistory;
          if (alive) { setHistory(old => ({ ...old, [id]: next })); setHistoryErrors(old => ({ ...old, [id]: "" })); }
        } catch (e) { if (alive) setHistoryErrors(old => ({ ...old, [id]: String(e) })); }
      }));
      busy = false;
    };
    void pull(); const timer = setInterval(() => void pull(), 60000);
    return () => { alive = false; clearInterval(timer); };
  }, [host, ids]);
  useEffect(() => {
    let alive = true;
    const get = async (path: string) => { const r = await fetch(path); if (!r.ok) throw new Error(); return r.json(); };
    const pull = () => {
      void get("/api/portal").then((d: { doc: RoutesDocument; launcher: LauncherConfig | null; links: Record<string, { ip_url?: string; domain_url?: string }> }) => {
        if (alive) setApps(buildItems(d.doc, d.launcher || defaultLauncher(), d.links).filter(i => !i.hidden));
      }).catch(() => { if (alive) setApps(null); });
      void get("/api/integrations/pc/api/pc/placement").then(d => { if (alive) setContainers(d.containers || []); }).catch(() => { if (alive) setContainers(null); });
    };
    pull(); const timer = setInterval(() => { if (document.visibilityState !== "hidden") pull(); }, 60000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const appsOf = (g: PveGuest) => (apps || []).filter(i => { const ip = splitTarget(i.probe)?.[0]; return !!ip && (g.ips || []).includes(ip); });
  const containersOf = (g: PveGuest) => (containers || []).filter(c => (g.ips || []).includes(c.ip));
  const matches = (h: PveHost, g?: PveGuest) => {
    const q = query.trim().toLocaleLowerCase();
    return !q || [h.name, h.address, h.current?.host, ...(g ? [g.name, String(g.vmid), ...(g.ips || []), ...guestTags(g)] : (h.current?.guests || []).flatMap(v => [v.name, String(v.vmid), ...(v.ips || []), ...guestTags(v)]))].some(v => v?.toLocaleLowerCase().includes(q));
  };
  const guestMatches = (h: PveHost, g: PveGuest) => matches(h, g) && (filter === "running" ? g.status === "running" : filter === "stopped" ? g.status === "stopped" : filter === "qemu" || filter === "lxc" ? g.type === filter : filter === "apps" ? appsOf(g).length > 0 : true);
  return { host, hosts, hide, setHide, query, setQuery, filter, setFilter, target, setTarget, history, historyErrors, appsOf, containersOf, appsKnown: apps !== null, containersKnown: containers !== null, matches, guestMatches };
}
const Context = createContext<ReturnType<typeof useStateOf> | null>(null);
export function PveProvider({ host, hosts, children }: { host: Host; hosts: PveHost[]; children: ReactNode }) { const value = useStateOf(host, hosts); return <Context.Provider value={value}>{children}</Context.Provider>; }
export function usePve() { const value = useContext(Context); if (!value) throw new Error("PVE context missing"); return value; }
