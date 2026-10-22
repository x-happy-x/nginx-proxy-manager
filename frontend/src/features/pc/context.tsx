import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { LauncherItem } from "../launcher/model";
import type { Host } from "../../platform/sdk";
import { useSaved, usePortalItems } from "../monitoring/portal";
import { placeOf, usePlacement } from "../launcher/placement";
import { containersOf, type Computer, type Container, type History } from "./model";

export type ContainerTarget = { host: string; context: string; id: string; logs?: boolean };
export type Environment = { host: string; context: string };
export { useSaved } from "../monitoring/portal";

function useHistories(host: Host, computers: Computer[]) {
  const ids = computers.map(h => h.id).sort().join("\n");
  const [data, setData] = useState<Record<string, History>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    let busy = false;
    const pull = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      await Promise.all(ids.split("\n").filter(Boolean).map(async id => {
        try {
          const r = await host.api(`/api/pc/history?host=${encodeURIComponent(id)}`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const next = await r.json() as History;
          if (alive) { setData(old => ({ ...old, [id]: next })); setErrors(old => ({ ...old, [id]: "" })); }
        } catch (e) { if (alive) setErrors(old => ({ ...old, [id]: String(e) })); }
      }));
      busy = false;
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 60000);
    document.addEventListener("visibilitychange", pull);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", pull); };
  }, [host, ids]);
  return { data, errors };
}


function usePcState(host: Host, computers: Computer[]) {
  const [hideAddresses, setHideAddresses] = useSaved("homenet.portal.hide-hosts", false);
  const [computer, setComputer] = useState<string | null>(null);
  const [container, setContainer] = useState<ContainerTarget | null>(null);
  const [application, setApplication] = useState<LauncherItem | null>(null);
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const history = useHistories(host, computers);
  const placement = usePlacement(true);
  const items = usePortalItems();
  const vmOf = (h: Computer) => placement?.machines.find(m => !m.stale && m.ips.includes(h.address));
  const appsOf = (h: Computer, context: string, c: Container) => (items || []).filter(i => {
    const p = placeOf(i.probe, placement)?.container;
    return p?.host === h.id && p.context === context && p.id === c.id;
  });
  return { host, computers, hideAddresses, setHideAddresses, computer, container, application, environment, history, vmOf, appsOf,
    appsKnown: items !== null && placement !== null && computers.every(h => placement.hosts.some(p => p.id === h.id)),
    openComputer: (id: string | null) => { setApplication(null); setContainer(null); setComputer(id); },
    openContainer: (target: ContainerTarget | null) => { setApplication(null); setComputer(null); setContainer(target); },
    openApplication: (item: LauncherItem | null) => { setComputer(null); setContainer(null); setApplication(item); },
    openEnvironment: (where: Environment) => { setComputer(null); setContainer(null); setEnvironment(where); host.navigate("pcdocker"); },
    setEnvironment,
  };
}
const PcContext = createContext<ReturnType<typeof usePcState> | null>(null);
export function PcProvider({ host, computers, children }: { host: Host; computers: Computer[]; children: ReactNode }) {
  const value = usePcState(host, computers);
  return <PcContext.Provider value={value}>{children}</PcContext.Provider>;
}
export function usePc() { const ctx = useContext(PcContext); if (!ctx) throw new Error("PC context missing"); return ctx; }
export const diskOf = (h: Computer) => [...(h.current?.disks || [])].filter(d => d.total > 0).sort((a, b) => b.used / b.total - a.used / a.total)[0];
export const matchesComputer = (h: Computer, query: string) => !query.trim() || [h.name, h.address, h.current?.os || "", ...containersOf([h]).flatMap(({ c, d }) => [c.name, c.image, c.ports, d.context])].some(s => s.toLowerCase().includes(query.trim().toLowerCase()));
