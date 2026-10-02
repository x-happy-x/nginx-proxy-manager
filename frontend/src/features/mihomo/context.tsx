import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { core, mihomo, openStream, type CoreConfig, type CoreDevice, type CoreStatus, type MConfigs } from "./api";
import { errText } from "../../lib/format";
import { historyStore, logStore } from "./stores";

export type TrafficPoint = { t: number; up: number; down: number };
export type LogFn = (title: string, message: string, level?: "info" | "success" | "warning" | "error") => void;

type Ctx = {
  status: CoreStatus | null;
  statusError: string;
  refreshStatus: () => Promise<void>;
  configs: MConfigs | null;
  refreshConfigs: () => Promise<void>;
  setMode: (mode: string) => Promise<void>;
  traffic: TrafficPoint[];
  live: boolean;
  devices: CoreDevice[];
  deviceName: (ip: string) => string;
  refreshDevices: () => Promise<void>;
  log: LogFn;
  /** Config editor state lives here so a draft survives page switches. */
  cfg: CoreConfig | null;
  setCfg: (c: CoreConfig | null) => void;
  draft: Record<string, unknown> | null;
  setDraft: (d: Record<string, unknown> | null) => void;
  configDirty: boolean;
  /** Runs an action, records it in the operations center and rethrows nothing. */
  act: (title: string, action: () => Promise<unknown>, success?: string) => Promise<boolean>;
};

const MihomoContext = createContext<Ctx | null>(null);

export function useMihomo(): Ctx {
  const ctx = useContext(MihomoContext);
  if (!ctx) throw new Error("useMihomo outside MihomoProvider");
  return ctx;
}

const TRAFFIC_POINTS = 180;

export function MihomoProvider({ children, log, active, onDirtyChange }: { children: ReactNode; log: LogFn; active: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [configs, setConfigs] = useState<MConfigs | null>(null);
  const [traffic, setTraffic] = useState<TrafficPoint[]>([]);
  const [live, setLive] = useState(false);
  const [devices, setDevices] = useState<CoreDevice[]>([]);
  const [cfg, setCfg] = useState<CoreConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const configDirty = useMemo(() => !!cfg && !!draft && JSON.stringify(cfg.sections) !== JSON.stringify(draft), [cfg, draft]);
  useEffect(() => onDirtyChange?.(configDirty), [configDirty, onDirtyChange]);
  const logRef = useRef(log);
  logRef.current = log;

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await core.status());
      setStatusError("");
    } catch (err) {
      setStatusError(errText(err));
    }
  }, []);

  const refreshConfigs = useCallback(async () => {
    try {
      setConfigs(await mihomo.configs());
    } catch {
      setConfigs(null);
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const res = await core.devices();
      setDevices(res.devices || []);
    } catch {
      /* names are a convenience; IPs still show */
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshStatus();
    }, 20000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  const running = !!status?.controller_ok;

  useEffect(() => {
    if (!running) return;
    void refreshConfigs();
    void refreshDevices();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshDevices();
    }, 60000);
    return () => clearInterval(timer);
  }, [running, refreshConfigs, refreshDevices]);

  // Like zashboard: the core log and the connection history fill while the console is open.
  useEffect(() => {
    if (!running || !active) return;
    logStore.start();
    historyStore.start();
    return () => {
      logStore.stop();
      historyStore.stop();
    };
  }, [running, active]);

  // One /traffic stream for the whole app: the top bar and the Traffic page share it.
  useEffect(() => {
    if (!running || !active) {
      setLive(false);
      return;
    }
    return openStream<{ up: number; down: number }>(
      "/traffic",
      (d) => setTraffic((prev) => [...prev.slice(-(TRAFFIC_POINTS - 1)), { t: Date.now(), up: d.up, down: d.down }]),
      setLive,
    );
  }, [running, active]);

  const names = useMemo(() => new Map(devices.map((d) => [d.ip, d.name])), [devices]);
  const deviceName = useCallback((ip: string) => names.get(ip) || "", [names]);

  const act = useCallback(async (title: string, action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      logRef.current(title, success || "Готово", "success");
      return true;
    } catch (err) {
      logRef.current(title, errText(err), "error");
      return false;
    }
  }, []);

  const setMode = useCallback(
    async (mode: string) => {
      const ok = await act("Режим mihomo", () => mihomo.patchConfigs({ mode }), `Режим: ${MODE_LABEL[mode] || mode}`);
      if (ok) await refreshConfigs();
    },
    [act, refreshConfigs],
  );

  const value: Ctx = {
    status,
    statusError,
    refreshStatus,
    configs,
    refreshConfigs,
    setMode,
    traffic,
    live,
    devices,
    deviceName,
    refreshDevices,
    log,
    act,
    cfg,
    setCfg,
    draft,
    setDraft,
    configDirty,
  };
  return <MihomoContext.Provider value={value}>{children}</MihomoContext.Provider>;
}

export const MODE_LABEL: Record<string, string> = { rule: "Правила", global: "Глобальный", direct: "Напрямую" };
