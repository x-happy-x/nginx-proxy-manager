import { useSyncExternalStore } from "react";
import { openStream, type MConnection } from "./api";

/*
 * Long-lived collectors, like zashboard's: the core log and the connection
 * history keep filling while the console is open, not only while their page
 * is on screen. Both live in this browser tab; the history is also kept in
 * localStorage so it survives a reload.
 */

type Listener = () => void;

function emitter() {
  const listeners = new Set<Listener>();
  return {
    on(l: Listener) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    emit() {
      listeners.forEach((l) => l());
    },
  };
}

/* ---------- core log ---------- */

export type LogLevel = "debug" | "info" | "warning" | "error" | "silent";
export type LogLine = { seq: number; time: string; type: string; payload: string; kind: string };

const logEvents = emitter();
let logLines: LogLine[] = [];
let logSeq = 0;
let logLevel: LogLevel = "info";
let logLimit = 2000;
let logPaused = false;
let logLive = false;
let stopLog: (() => void) | null = null;
type LogSnapshot = { lines: LogLine[]; level: LogLevel; limit: number; paused: boolean; live: boolean };
let logSnapshot: LogSnapshot = { lines: logLines, level: logLevel, limit: logLimit, paused: logPaused, live: logLive };

function logChanged() {
  logSnapshot = { lines: logLines, level: logLevel, limit: logLimit, paused: logPaused, live: logLive };
  logEvents.emit();
}

// First word of a mihomo log line: [TCP], [UDP], [DNS], Health, ...
function kindOf(payload: string) {
  const m = payload.match(/^\[([A-Za-z]+)\]/);
  if (m) return m[1].toUpperCase();
  const word = payload.split(/[\s,:]/)[0] || "";
  return word.length > 1 && word.length < 24 ? word : "прочее";
}

let pending: LogLine[] = [];
let flushTimer = 0;

export const logStore = {
  start() {
    if (stopLog) return;
    stopLog = openStream<{ type: string; payload: string }>(
      `/logs?level=${logLevel}`,
      (d) => {
        if (logPaused) return;
        pending.push({ seq: ++logSeq, time: new Date().toLocaleTimeString("ru-RU"), type: d.type, payload: d.payload, kind: kindOf(d.payload) });
        // Debug streams hundreds of lines a second: batch the renders.
        if (!flushTimer)
          flushTimer = window.setTimeout(() => {
            flushTimer = 0;
            logLines = [...pending.reverse(), ...logLines].slice(0, logLimit);
            pending = [];
            logChanged();
          }, 300);
      },
      (open) => {
        logLive = open;
        logChanged();
      },
    );
  },
  stop() {
    stopLog?.();
    stopLog = null;
    logLive = false;
    logChanged();
  },
  setLevel(level: LogLevel) {
    logLevel = level;
    this.stop();
    this.start();
  },
  setLimit(limit: number) {
    logLimit = limit;
    logLines = logLines.slice(0, limit);
    logChanged();
  },
  setPaused(p: boolean) {
    logPaused = p;
    logChanged();
  },
  clear() {
    logLines = [];
    logChanged();
  },
};

export function useLogs() {
  return useSyncExternalStore(logEvents.on, () => logSnapshot);
}

/* ---------- connection history ---------- */

export type HistoryBy = "host" | "source" | "process" | "outbound" | "group";
export type HistoryRow = { key: string; count: number; up: number; down: number; last: number };
type HistoryData = Record<HistoryBy, Record<string, HistoryRow>> & { since: number };

const HISTORY_KEY = "homenet.mihomo.history.v1";
const HISTORY_CAP = 600;
const histEvents = emitter();

function emptyHistory(): HistoryData {
  return { host: {}, source: {}, process: {}, outbound: {}, group: {}, since: Date.now() };
}

function loadHistory(): HistoryData {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "null");
    if (raw && raw.host) return raw;
  } catch {
    /* fresh start */
  }
  return emptyHistory();
}

let history = loadHistory();
let histSnapshot = history;
let stopHist: (() => void) | null = null;
let prev = new Map<string, MConnection>();
let saveTimer = 0;

// Registrable-ish domain: the last two labels, three for short second levels (co.uk, com.ru).
export function siteOf(host: string) {
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return host || "—";
  const parts = host.toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2];
  const take = sld.length <= 3 && ["co", "com", "net", "org", "gov", "ac", "msk", "spb"].includes(sld) ? 3 : 2;
  return parts.slice(-take).join(".");
}

function add(by: HistoryBy, key: string, c: MConnection) {
  if (!key) return;
  const row = history[by][key] || { key, count: 0, up: 0, down: 0, last: 0 };
  row.count++;
  row.up += c.upload;
  row.down += c.download;
  row.last = Date.now();
  history[by][key] = row;
  const rows = Object.values(history[by]);
  if (rows.length > HISTORY_CAP) {
    rows.sort((a, b) => a.last - b.last);
    rows.slice(0, rows.length - HISTORY_CAP).forEach((r) => delete history[by][r.key]);
  }
}

function record(c: MConnection) {
  add("host", siteOf(c.metadata.host || c.metadata.sniffHost || c.metadata.destinationIP), c);
  add("source", c.metadata.sourceIP, c);
  add("process", c.metadata.process || "", c);
  add("outbound", c.chains[0] || "", c);
  add("group", c.chains[c.chains.length - 1] || "", c);
}

function persist() {
  histSnapshot = { ...history };
  histEvents.emit();
  if (saveTimer) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* storage full or blocked: the in-memory history still works */
    }
  }, 10000);
}

export const historyStore = {
  start() {
    if (stopHist) return;
    stopHist = openStream<{ connections: MConnection[] | null }>("/connections?interval=2000", (d) => {
      const next = new Map((d.connections || []).map((c) => [c.id, c]));
      let changed = false;
      prev.forEach((c, id) => {
        if (!next.has(id)) {
          record(c);
          changed = true;
        }
      });
      prev = next;
      if (changed) persist();
    });
  },
  stop() {
    stopHist?.();
    stopHist = null;
  },
  clear() {
    history = emptyHistory();
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
    persist();
  },
};

export function useHistory() {
  return useSyncExternalStore(histEvents.on, () => histSnapshot);
}
