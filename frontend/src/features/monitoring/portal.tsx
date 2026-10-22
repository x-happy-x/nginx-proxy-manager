import { useEffect, useState } from "react";
import type { LauncherConfig } from "../../api";
import type { RoutesDocument } from "../../types";
import { buildItems, defaultLauncher, type LauncherItem } from "../launcher/model";

// Shared portal controls/data for the Computers and Servers modules.
export function useSaved<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => { try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; } });
  const save = (next: T) => { setValue(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Private browsing still works. */ } };
  return [value, save] as const;
}

export function ViewSwitch<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (next: T) => void }) {
  return <div className="hp-view" role="group" aria-label={label}>{options.map(o => <button type="button" key={o.value} aria-pressed={value === o.value} className={value === o.value ? "is-on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}
export function usePortalItems() {
  const [items, setItems] = useState<LauncherItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch("/api/portal");
        if (!r.ok) throw new Error();
        const d = await r.json() as { doc: RoutesDocument; launcher: LauncherConfig | null; links: Record<string, { ip_url?: string; domain_url?: string }> };
        if (alive) setItems(buildItems(d.doc, d.launcher || defaultLauncher(), d.links).filter(i => !i.hidden));
      } catch { if (alive) setItems(null); }
    };
    void pull();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void pull(); }, 60000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return items;
}

