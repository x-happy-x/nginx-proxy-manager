import { useCallback, useEffect, useRef, useState } from "react";
import type { Host } from "../../platform/sdk";

export type Container = { id: string; name: string; image: string; state: string; status: string; ports: string };
export type DockerContext = { context: string; available: boolean; error?: string; containers: Container[] };
export type Distro = { name: string; state: "running" | "stopped"; version: number };
export type Snapshot = {
  v: number; ts: number; host: string; os: "windows" | "linux"; arch: string; agent: string; uptime: number;
  cpu: { percent: number | null; cores: number; model: string }; memory: { total: number; used: number; available: number };
  disks: { path: string; total: number; used: number; free: number }[];
  network: { name: string; rx_bytes: number; tx_bytes: number; aggregate?: boolean }[];
  wsl: Distro[]; docker: DockerContext[];
  capabilities: { docker_actions: string[]; wsl_actions: string[]; docker_logs?: boolean }; errors: string[];
};
export type Computer = { id: string; name: string; address: string; online: boolean; error: string; checked_at?: string; last_ok?: string; latency_ms: number; current: Snapshot | null };
export type OverviewData = { hosts: Computer[]; configured: boolean; error?: string };
export type History = { step: number; points: { t: number; cpu: number | null; mem_used: number; mem_total: number; net_rx_bps: number; net_tx_bps: number; network_valid?: boolean; disks?: { path: string; used: number; total: number }[] }[] };
export type ConfigHost = { id: string; name: string; address: string; port: number; user: string; pinned?: boolean };
export type Config = { hosts: ConfigHost[]; public_key: string; key_error?: string };
export type Test = { ok: boolean; error?: string; agent?: string; host?: string; os?: string; latency_ms?: number; pinned?: boolean; fingerprint?: string };
export type Action = "start" | "stop" | "restart" | "terminate";
export type ActionRequest = { host: string; target: "docker"; context: string; id: string; action: Action; confirm?: string } | { host: string; target: "wsl"; name: string; action: Action; confirm?: string };
export type Task = { id: string; host: string; target: "docker" | "wsl"; context?: string; resource_id?: string; name?: string; action: Action; status: "running" | "done" | "error" | "unknown"; message?: string; created_at: string; updated_at: string };

export function usePcPoll<T>(host: Host, path: string | null, seconds: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const pathRef = useRef(path);
  pathRef.current = path;
  const reload = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    try {
      const response = await host.api(path);
      if (!response.ok) throw new Error(`Ошибка запроса (${response.status})`);
      const next = await response.json() as T;
      if (id === seq.current && pathRef.current === path) { setData(next); setError(""); }
    } catch (e) { if (id === seq.current && pathRef.current === path) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (id === seq.current) setLoading(false); }
  }, [host, path]);
  useEffect(() => {
    setData(null); setError(""); setLoading(!!path);
    if (!path) return;
    const tick = () => { if (document.visibilityState !== "hidden") void reload(); };
    tick();
    const timer = window.setInterval(tick, seconds * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { ++seq.current; window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [reload, path, seconds]);
  return { data, error, loading, reload };
}
export const useComputers = (host: Host) => usePcPoll<OverviewData>(host, "/api/pc/overview", 15);
export const usePcHistory = (host: Host, id?: string) => usePcPoll<History>(host, id ? `/api/pc/history?host=${encodeURIComponent(id)}` : null, 60);
export const outdated = (h: Computer) => !h.online || !h.current || Date.now() / 1000 - h.current.ts > 120;
export const contextName = (context: string) => context === "native" ? "Docker на компьютере" : context.startsWith("wsl:") ? `WSL · ${context.slice(4)}` : context;
export const systemName = (h: Computer) => h.current?.os === "windows" ? "Windows" : h.current?.os === "linux" ? "Linux" : "Компьютер";
export const stateName = (state: string) => ({ running: "Работает", stopped: "Остановлен", exited: "Завершён", created: "Создан", paused: "На паузе", restarting: "Перезапускается", removing: "Удаляется", dead: "Ошибка" }[state] || state || "Неизвестно");
export const containersOf = (hosts: Computer[]) => hosts.flatMap((h) => (h.current?.docker || []).flatMap((d) => (d.containers || []).map((c) => ({ h, d, c }))));
