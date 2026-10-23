import type { Machine } from "./model";
export type HardwarePart = {
  id: string; name: string; kind: string; facts: [string, string][]; status: string;
  source?: string; note?: string; raw?: string; rawId?: string; unknown?: boolean;
  groupOnly?: boolean; problemCode?: number;
};
export type HardwareSlot = { id: string; label: string; slot?: string; bank?: string; state: "empty" | "populated" | "unknown"; size?: number; countOnly?: boolean };
export type HardwareView = {
  name: string; sub: string; description: string; board: string; cpuLines: string[]; cpuSummary: string;
  temp: string | null; memory: string; ram: (string | null)[] | null; slotRecords?: HardwareSlot[];
  memoryIsInstalled?: boolean; gpuInventory?: boolean;
  cpuTemperature?: number | null; cpuCritical?: number; cpuMaximum?: number | null;
  ramCaption?: string; ramType?: string; gpu: string | null; gpuNames?: string[];
  nics: string[]; nicKinds?: string[]; disks: string[]; diskNames?: string[]; diskInfo?: string[]; moreDisks?: number;
  volumes?: { path: string; total: number; used: number }[];
  parts: HardwarePart[]; extras: [string, string, string, string][];
  sensors: { name: string; value: string; source: string }[]; missing: string;
  hidePeripheralUnknown?: boolean; unknownLabel?: string; unknownAddress?: string; unknownBus?: string; unknownCount?: number;
  timestamp?: number; agent?: string; offline?: boolean; deviceCount?: number; source?: string;
};
export function machineFromHardware(id: string, document?: Record<string, unknown> | null, error?: string): HardwareView;
export function hardwareForMachine(machine: Machine): HardwareView;
