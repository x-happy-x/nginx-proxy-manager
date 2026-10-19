import { useCallback, useEffect, useRef, useState } from "react";
import type { Host } from "../../platform/sdk";

// NPM-76: what the «Умный дом» worker answers on /api/ha/overview.

export type HaOffline = { name: string; area?: string; entities: number; since: string; zigbee: boolean };
export type HaBattery = { name: string; area?: string; level: number | null; low: boolean };
export type HaUpdate = { entity: string; name: string; installed: string; latest: string };
export type HaLight = { name: string; area?: string };
export type HaView = {
  by_device: boolean; total: number; online: number; offline: HaOffline[]; zigbee_down: number;
  bridge: { online: boolean; state: string; since: string } | null;
  batteries: HaBattery[]; updates: HaUpdate[]; lights: HaLight[];
  backup: { last: string | null; state: string } | null; entity_count: number;
};
export type HaAttention = { id: string; severity: "critical" | "warning" | "info"; text: string; since?: string; action?: { label: string; page: string } };
export type HaOverview = {
  configured: boolean; error: string; auth_error: boolean; load_error: string; map_error: string;
  url: string; link: string; version: string; location: string;
  checked_at: string | null; last_ok: string | null; error_since: string | null;
  view: HaView | null; attention: HaAttention[];
};
export type HaConfig = { url: string; token_set: boolean; error: string };
export type HaTest = { ok: boolean; error?: string; version?: string; location?: string; latency_ms?: number; devices?: boolean; devices_error?: string; device_count?: number };

export const BATTERY_LOW = 20;
export const BACKUP_MAX_AGE_H = 48;

/** Polls the overview while the tab is visible; keeps the last good answer on errors. */
export function useHaOverview(host: Host, every = 30) {
  const [data, setData] = useState<HaOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const json = (await (await host.api("/api/ha/overview")).json()) as HaOverview;
      if (id === seq.current) { setData(json); setError(""); }
    } catch (e) {
      if (id === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [host]);
  useEffect(() => {
    let timer = 0;
    const tick = () => { if (document.visibilityState !== "hidden") void load(); };
    tick();
    timer = window.setInterval(tick, every * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [load, every]);
  return { data, error, loading, reload: load };
}

export function plural(n: number, one: string, few: string, many: string) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

/** «20 мин», «5 ч», «3 дня» — how long ago, without the word «назад». */
export function age(iso?: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 120) return `${s} с`;
  if (s < 7200) return `${Math.round(s / 60)} мин`;
  if (s < 172800) return `${Math.round(s / 3600)} ч`;
  const d = Math.floor(s / 86400);
  return `${d} ${plural(d, "день", "дня", "дней")}`;
}

export const backupStale = (v: HaView) => !!v.backup && (!v.backup.last || Date.now() - Date.parse(v.backup.last) > BACKUP_MAX_AGE_H * 3600e3);
