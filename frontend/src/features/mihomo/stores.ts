import { useSyncExternalStore } from "react";
import { openStream } from "./api";

/*
 * Long-lived collector, like zashboard's: the core log keeps filling while the
 * console is open, not only while its page is on screen. Traffic history is
 * recorded on the router instead (/api/core/traffic).
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
