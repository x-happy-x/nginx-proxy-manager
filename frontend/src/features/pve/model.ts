import { useCallback, useEffect, useRef, useState } from "react";
import type { Host } from "../../platform/sdk";

// NPM-74: documents written by homenet-pve-agent on each Proxmox host and
// relayed by the «pve» worker. Field names follow the agent.

export type PveTemp = { chip: string; label: string; c: number; crit?: number; max?: number };
export type PveGuest = {
  vmid: number; name: string; type: "qemu" | "lxc"; status: string; template: boolean;
  cpu: number; cpus: number; mem: number; maxmem: number; disk: number; maxdisk: number;
  netin_rate?: number; netout_rate?: number; diskread_rate?: number; diskwrite_rate?: number;
  uptime: number; tags: string; lock: string;
};
export type PveDisk = {
  dev: string; kind: "nvme" | "ssd" | "hdd"; model: string; serial: string; size: number; transport: string; firmware: string;
  health: boolean | null; temp: number | null; hours: number | null; cycles: number | null; wear: number | null;
  written: number | null; media_errors: number | null; reallocated: number | null;
};
export type PveCurrent = {
  host: string; ts: number; interval: number;
  node: {
    cpu: number; iowait: number; load: [number, number, number]; threads: number; freq_mhz: number | null; uptime: number;
    mem: { total: number; avail: number; used: number; cached: number; ksm: number };
    swap: { total: number; used: number }; cpu_temp: number | null;
  };
  temps: PveTemp[]; fans: { chip: string; label: string; rpm: number }[];
  net: { iface: string; rx: number; tx: number; state: string; speed: number | null; bridge: boolean }[];
  io: { dev: string; r: number; w: number; util: number }[];
  guests: PveGuest[];
  storage: { name: string; type: string; used: number; total: number; active: boolean; enabled: boolean; shared: boolean; content: string }[];
  zfs: { name: string; size: number; alloc: number; free: number; frag: number; cap: number; health: string }[];
  disks: PveDisk[]; updates: number | null; failed_units: string[];
  backups: { id: string; status: string; start: number; end: number | null }[];
  versions: { pve?: string; kernel?: string; agent?: string };
};
export type PveHardware = {
  vendor: string; product: string; board: string; bios: string;
  cpu: { model: string; threads: number; cores: number; sockets: number; max_mhz: number | null; virt: string; arch: string };
  memory: { total: number; slots: number; modules: { slot: string; size: string; type: string; speed: string; vendor: string; part: string }[] };
  nics: { iface: string; mac: string; driver: string; speed: number | null; state: string }[];
  gpus: string[]; controllers: string[];
};
export type PveHost = {
  id: string; name: string; address: string; online: boolean; error: string; latency_ms: number;
  checked_at?: string; last_ok?: string; current: PveCurrent | null; hardware: PveHardware | null;
};
export type PveOverview = { hosts: PveHost[]; configured: boolean; error: string };
export type PvePoint = { t: number; cpu: number | null; io: number | null; load: number | null; mem: number | null; temp: number | null; rx: number | null; tx: number | null; r: number | null; w: number | null };
export type PveHistory = { step: number; points: PvePoint[]; guests: Record<string, [number, number, number][]> };

function useVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** Polls a module endpoint while the tab is visible; keeps the last good answer on errors. */
function usePoll<T>(host: Host, path: string | null, every: number): { data: T | null; error: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const visible = useVisible();
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    try {
      const res = await host.api(path);
      const json = (await res.json()) as T;
      if (id === seq.current) { setData(json); setError(""); }
    } catch (e) {
      if (id === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [host, path]);
  useEffect(() => {
    setData(null);
    setLoading(true);
  }, [path]);
  useEffect(() => {
    if (!visible || !path) return;
    void load();
    const timer = window.setInterval(() => void load(), every * 1000);
    return () => window.clearInterval(timer);
  }, [load, visible, every, path]);
  return { data, error, loading, reload: load };
}

export const useOverview = (host: Host) => usePoll<PveOverview>(host, "/api/pve/overview", 10);
export const useHistory = (host: Host, id: string | null) =>
  usePoll<PveHistory>(host, id ? `/api/pve/history?host=${encodeURIComponent(id)}` : null, 60);

// ---------- formatting ----------

const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

export function bytes(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"];
  let i = 0;
  let n = Math.abs(v);
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const f = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: n >= 100 || i === 0 ? 0 : digits });
  return `${f.format(n)} ${units[i]}`;
}
export const rate = (v: number | null | undefined) => (v == null ? "—" : `${bytes(v)}/с`);
/** Network speeds read better in bits, as on the rest of HomeNet. */
export function bits(v: number | null | undefined): string {
  if (v == null) return "—";
  const b = v * 8;
  if (b >= 1e9) return `${nf1.format(b / 1e9)} Гбит/с`;
  if (b >= 1e6) return `${nf1.format(b / 1e6)} Мбит/с`;
  if (b >= 1e3) return `${nf0.format(b / 1e3)} кбит/с`;
  return `${nf0.format(b)} бит/с`;
}
export const percent = (v: number | null | undefined) => (v == null ? "—" : `${v >= 10 ? nf0.format(v) : nf1.format(v)} %`);
export const ratio = (used: number, total: number) => (total > 0 ? (100 * used) / total : 0);
export const celsius = (v: number | null | undefined) => (v == null ? "—" : `${nf0.format(v)} °C`);

export function uptime(sec: number | null | undefined): string {
  if (!sec) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
}
export function ago(iso?: string | number | null): string {
  if (!iso) return "—";
  const t = typeof iso === "number" ? iso * 1000 : Date.parse(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return `${Math.round(s / 86400)} д назад`;
}
export function dateTime(sec: number | null | undefined): string {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export type Tone = "ok" | "warn" | "bad" | "idle";
export const loadTone = (p: number): Tone => (p >= 90 ? "bad" : p >= 75 ? "warn" : "ok");
export const tempTone = (c: number | null | undefined, warn = 75, bad = 88): Tone => (c == null ? "idle" : c >= bad ? "bad" : c >= warn ? "warn" : "ok");

const CHIPS: Record<string, string> = {
  coretemp: "Процессор", k10temp: "Процессор", zenpower: "Процессор", cpu_thermal: "Процессор",
  nvme: "NVMe", drivetemp: "Диск", acpitz: "Плата (ACPI)", spd5118: "Память", jc42: "Память",
  amdgpu: "Видеокарта", i915: "Видеокарта", nct6775: "Плата", it87: "Плата", iwlwifi: "Wi‑Fi",
};
export function chipName(chip: string): string {
  if (chip.startsWith("r8169") || chip.startsWith("r8125") || chip.startsWith("igc") || chip.startsWith("e1000")) return "Сетевая карта";
  if (chip.startsWith("iwlwifi")) return "Wi‑Fi";
  return CHIPS[chip] || chip;
}
export function sensorLabel(t: PveTemp): string {
  const l = t.label;
  if (t.chip === "disk") return l;
  if (l === t.chip || /^temp\d+$/.test(l)) return chipName(t.chip);
  if (l === "Tctl" || l === "Tdie") return "Процессор (кристалл)";
  if (l.startsWith("Package")) return "Процессор (корпус)";
  if (l.startsWith("Core ")) return `Ядро ${l.slice(5)}`;
  if (l === "Composite") return `${chipName(t.chip)} · общий`;
  if (l.startsWith("Sensor ")) return `${chipName(t.chip)} · датчик ${l.slice(7)}`;
  return `${chipName(t.chip)} · ${l}`;
}

export function cpuShort(model?: string): string {
  if (!model) return "";
  return model.replace(/\((R|TM)\)/g, "").replace(/\s+(\d+-Core|Processor|CPU)\b.*$/i, "").replace(/\s+/g, " ").trim();
}
export function platformName(hw: PveHardware | null): string {
  if (!hw) return "";
  return [hw.vendor, hw.product].filter(Boolean).join(" ") || hw.board || "Мини-ПК";
}
export const running = (c: PveCurrent | null) => (c?.guests || []).filter((g) => !g.template && g.status === "running").length;
export const guestsTotal = (c: PveCurrent | null) => (c?.guests || []).filter((g) => !g.template).length;
/** Root/local storage usage: the storage everyone means by «диск хоста». */
export function mainStorage(c: PveCurrent | null) {
  const list = (c?.storage || []).filter((s) => s.active && s.total > 0);
  return list.find((s) => s.name === "local") || list.sort((a, b) => b.total - a.total)[0] || null;
}
