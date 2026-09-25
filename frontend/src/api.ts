import type {
  ApiOk,
  CertItem,
  ConfigItem,
  DmsApp,
  DnsHostItem,
  NdnsPayload,
  NdnsProxy,
  NginxStatus,
  RouteFilesPayload,
  RouteLogItem,
  RoutesDocument,
} from "./types";

async function parseJson<T>(res: Response): Promise<T> {
  const body = await res.text();
  let data: T;
  try {
    data = JSON.parse(body) as T;
  } catch {
    throw new Error(
      `HTTP ${res.status}: ${body.slice(0, 240) || "Пустой ответ сервера"}`,
    );
  }
  const result = data as { ok?: boolean; error?: string; output?: string };
  if (!res.ok || result.ok === false) {
    throw new Error(result.error || result.output || `HTTP ${res.status}`);
  }
  return data;
}

export type ProxyStats = {
  window_seconds: number;
  from: string;
  to: string;
  total_requests: number;
  errors_4xx: number;
  errors_5xx: number;
  error_rate: number;
  bytes_sent: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  p95_approximate?: boolean;
  requests_per_minute: number;
  traffic: { local: number; external: number; unknown: number };
  status_codes: Record<string, number>;
  series: Array<{
    time: string;
    requests: number;
    errors: number;
    bytes_sent: number;
    avg_latency_ms: number;
  }>;
  hosts: Array<{
    host: string;
    requests: number;
    errors: number;
    bytes_sent: number;
    avg_latency_ms: number;
  }>;
  sample: {
    scanned_lines: number;
    malformed_lines: number;
    truncated: boolean;
    max_bytes: number;
    source?: string;
    coverage_from?: string;
    resolution_seconds?: number;
    backlog_bytes?: number;
    gaps?: Array<{ at: string; reason: string }>;
    persisted?: boolean;
    persistence_error?: string;
    p95_approximate?: boolean;
  };
};
export async function fetchStats(
  window: string,
  host = "",
  traffic = "",
): Promise<{ ok: boolean; stats: ProxyStats }> {
  return parseJson(
    await fetch(
      `/api/nginx/stats?${new URLSearchParams({ window, host, traffic })}`,
    ),
  );
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseJson<T>(res);
}

export type LauncherDevice = { id: string; name: string; kind: string; note?: string; addresses: string[] };
export type LauncherLink = { id: string; title: string; url: string; device: string; description?: string; art?: string };
export type LauncherAppOverride = { title?: string; device?: string; description?: string; art?: string; hidden?: boolean };
export type LauncherConfig = {
  devices: LauncherDevice[];
  links: LauncherLink[];
  apps: Record<string, LauncherAppOverride>;
  order?: string[];
};

export async function fetchLauncher(): Promise<LauncherConfig | null> {
  return (await parseJson<{ ok: boolean; config: LauncherConfig | null }>(await fetch("/api/launcher"))).config;
}

export async function saveLauncher(config: LauncherConfig): Promise<ApiOk> {
  return postJson<ApiOk>("/api/launcher", config);
}

export async function fetchLauncherStatus(targets: string[]): Promise<Record<string, { ok: boolean; ms: number }>> {
  const query = targets.map((t) => "t=" + encodeURIComponent(t)).join("&");
  return (await parseJson<{ ok: boolean; status: Record<string, { ok: boolean; ms: number }> }>(await fetch("/api/launcher/status?" + query))).status;
}

export type AppUsage = { cpu: number; rss: number };
export type AppGroupUsage = { id: string; name: string; kind: "app" | "system"; cpu: number; rss: number; procs: number; pids: number[]; ports: number[] };
export type ResourceSample = { t: number; cpu: number; mem: number; swap: number; temp: number; rx: number; tx: number; conns: number; apps: Record<string, AppUsage> };
export type MikrotikSample = { t: number; cpu: number; mem: number; rx: number; tx: number; rsrp: number; sinr: number };
export type SystemSnapshot = {
  time: string;
  hostname: string;
  cores: number;
  uptime_sec: number;
  load: [number, number, number];
  cpu: number;
  mem_total: number;
  mem_used: number;
  mem_cache: number;
  swap_total: number;
  swap_used: number;
  temps: Array<{ name: string; temp: number }>;
  temp_max: number;
  disks: Array<{ path: string; total: number; free: number }>;
  conns: number;
  conns_max: number;
  interfaces: Array<{ name: string; rx_bytes: number; tx_bytes: number; rx_bps: number; tx_bps: number; wan?: boolean }>;
  apps: AppGroupUsage[];
  top: Array<{ pid: number; name: string; group: string; cpu: number; rss: number }>;
  processes: number;
};
export type MikrotikState = {
  error?: string;
  online?: boolean;
  internet_ok?: boolean;
  whitelist_ok?: boolean;
  signal?: { status?: string; operator?: string; band?: string; rssi?: number; rsrp?: number; rsrq?: number; sinr?: number; cqi?: number; quality?: number };
  system?: {
    board: string;
    version: string;
    architecture: string;
    uptime_seconds: number;
    cpu_load: number;
    cpu_count: number;
    memory_total: number;
    memory_free: number;
    disk_total: number;
    disk_free: number;
    sensors: Array<{ name: string; value: number; unit: string }>;
    interfaces: Array<{ name: string; type: string; running: boolean; rx_bps: number; tx_bps: number }>;
  };
};
export type MeshNode = {
  cid: string;
  name: string;
  model: string;
  ip: string;
  mode: string;
  firmware: string;
  firmware_next?: string;
  update_available: boolean;
  internet: boolean;
  clients: number;
  cpu: number;
  mem_used: number;
  mem_total: number;
  uptime_sec: number;
  uplink: string;
  uplink_wifi: boolean;
  rssi?: number;
  txrate?: number;
  ports: Array<{ label: string; link: boolean; speed?: number }>;
};
export type MeshSample = { t: number; cpu: number; mem: number };
export type PveNode = {
  node: string;
  online: boolean;
  cpu: number;
  cores: number;
  cpu_model?: string;
  mem_used: number;
  mem_total: number;
  swap_used: number;
  swap_total: number;
  root_used: number;
  root_total: number;
  load: [number, number, number];
  uptime_sec: number;
  pve_version?: string;
  kernel?: string;
};
export type PveGuest = {
  id: string;
  vmid: number;
  name: string;
  type: "qemu" | "lxc";
  node: string;
  status: string;
  template?: boolean;
  cpu: number;
  cores: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
  net_in_bps: number;
  net_out_bps: number;
  uptime_sec: number;
};
export type PveState = {
  error?: string;
  url?: string;
  nodes: PveNode[];
  guests: PveGuest[];
  storage: Array<{ name: string; node: string; type: string; used: number; total: number; active: boolean }>;
};
export type PveSample = { t: number; nodes: Record<string, { cpu: number; mem: number }>; guests: Record<string, number> };
export type ResourcesPayload = {
  now: SystemSnapshot;
  history: ResourceSample[];
  mikrotik: MikrotikState;
  mikrotik_history: MikrotikSample[];
  mesh: { nodes: MeshNode[]; error?: string };
  mesh_history: Record<string, MeshSample[]>;
  proxmox: PveState | null;
  proxmox_history: PveSample[];
  interval_sec: number;
};

export async function fetchResources(since = 0): Promise<ResourcesPayload> {
  return parseJson<ResourcesPayload>(await fetch("/api/resources?since=" + since));
}

export async function fetchRoutes(): Promise<RoutesDocument> {
  return parseJson<RoutesDocument>(await fetch("/api/routes"));
}

export async function saveRoutes(payload: RoutesDocument): Promise<ApiOk> {
  return postJson<ApiOk>("/api/routes", payload);
}

export async function applyRoutes(): Promise<ApiOk> {
  return postJson<ApiOk>("/api/apply");
}

export async function applyStub(payload: RoutesDocument): Promise<ApiOk> {
  return postJson<ApiOk>("/api/stub/apply", payload);
}

export async function uploadStub(content: string): Promise<ApiOk> {
  return postJson<ApiOk>("/api/stub/upload", { content });
}

export async function fetchRouteFiles(): Promise<
  RouteFilesPayload & { ok: boolean }
> {
  return parseJson<RouteFilesPayload & { ok: boolean }>(
    await fetch("/api/routes/files"),
  );
}

export async function selectRouteFile(path: string): Promise<ApiOk> {
  return postJson<ApiOk>("/api/routes/select", { path });
}

export async function backupRouteFile(): Promise<ApiOk & { path?: string }> {
  return postJson<ApiOk & { path?: string }>("/api/routes/backup");
}

export async function fetchNginxStatus(): Promise<{
  ok: boolean;
  status: NginxStatus;
}> {
  return parseJson<{ ok: boolean; status: NginxStatus }>(
    await fetch("/api/nginx/status"),
  );
}

export async function fetchDmsApps(): Promise<{
  ok: boolean;
  items: DmsApp[];
  service_version: string;
}> {
  return parseJson<{ ok: boolean; items: DmsApp[]; service_version: string }>(
    await fetch("/api/dms/apps"),
  );
}

export async function fetchConfigs(): Promise<{
  ok: boolean;
  items: ConfigItem[];
}> {
  return parseJson<{ ok: boolean; items: ConfigItem[] }>(
    await fetch("/api/nginx/configs"),
  );
}

export async function readConfig(
  id: string,
): Promise<{ ok: boolean; content: string; item: ConfigItem }> {
  return parseJson<{ ok: boolean; content: string; item: ConfigItem }>(
    await fetch(`/api/nginx/config/read?id=${encodeURIComponent(id)}`),
  );
}

export async function writeConfig(id: string, content: string): Promise<ApiOk> {
  return postJson<ApiOk>("/api/nginx/config/write", { id, content });
}

export async function fetchLogs(
  type: "access" | "error",
  filter: string,
  limit: number,
): Promise<{ ok: boolean; lines: string[] }> {
  const q = new URLSearchParams({ type, filter, limit: String(limit) });
  return parseJson<{ ok: boolean; lines: string[] }>(
    await fetch(`/api/nginx/logs?${q.toString()}`),
  );
}

export async function fetchRouteLogs(
  filter: string,
  limit: number,
  statusGroup: "" | "4xx" | "5xx",
): Promise<{ ok: boolean; items: RouteLogItem[] }> {
  const q = new URLSearchParams({
    filter,
    limit: String(limit),
    status_group: statusGroup,
  });
  return parseJson<{ ok: boolean; items: RouteLogItem[] }>(
    await fetch(`/api/nginx/route-logs?${q.toString()}`),
  );
}

export async function fetchRouteErrors(
  filter: string,
  limit: number,
): Promise<{ ok: boolean; items: RouteLogItem[] }> {
  const q = new URLSearchParams({ filter, limit: String(limit) });
  return parseJson<{ ok: boolean; items: RouteLogItem[] }>(
    await fetch(`/api/nginx/route-logs/errors?${q.toString()}`),
  );
}

export async function fetchCerts(): Promise<{
  ok: boolean;
  items: CertItem[];
}> {
  return parseJson<{ ok: boolean; items: CertItem[] }>(
    await fetch("/api/cert/list"),
  );
}

export async function deleteCert(host: string): Promise<ApiOk> {
  return postJson<ApiOk>("/api/cert/delete", { host });
}

export async function testCert(host: string, port: number): Promise<ApiOk> {
  return postJson<ApiOk>("/api/cert/test", { host, port });
}

export async function fetchCaStatus(): Promise<{
  ok: boolean;
  installed: boolean;
}> {
  return parseJson<{ ok: boolean; installed: boolean }>(
    await fetch("/api/ca/status"),
  );
}

export async function uploadCa(
  certPem: string,
  keyPem: string,
): Promise<ApiOk> {
  return postJson<ApiOk>("/api/ca/upload", {
    cert_pem: certPem,
    key_pem: keyPem,
  });
}

export async function generateCa(
  subject: Record<string, string>,
): Promise<ApiOk> {
  return postJson<ApiOk>("/api/ca/generate", { subject });
}

export async function issueCa(force = false): Promise<ApiOk> {
  return postJson<ApiOk>(`/api/ca/issue?force=${force ? "1" : "0"}`);
}

export async function fetchDnsHosts(): Promise<{
  ok: boolean;
  items: DnsHostItem[];
}> {
  return parseJson<{ ok: boolean; items: DnsHostItem[] }>(
    await fetch("/api/ip-hosts"),
  );
}

export async function addDnsHost(
  host: string,
  address: string,
): Promise<ApiOk> {
  return postJson<ApiOk>("/api/ip-hosts/add", { host, address });
}

export async function deleteDnsHost(
  host: string,
  address: string,
): Promise<ApiOk> {
  return postJson<ApiOk>("/api/ip-hosts/delete", { host, address });
}

export async function fetchNdns(): Promise<{ ok: boolean; data: NdnsPayload }> {
  return parseJson<{ ok: boolean; data: NdnsPayload }>(
    await fetch("/api/ndns/http"),
  );
}

export async function suggestNdnsPort(): Promise<{
  ok: boolean;
  port: number;
}> {
  return parseJson<{ ok: boolean; port: number }>(
    await fetch("/api/ndns/port-suggest"),
  );
}

export async function saveNdnsProxy(
  item: NdnsProxy,
  oldName = "",
): Promise<ApiOk> {
  return postJson<ApiOk>("/api/ndns/proxy/save", { item, old_name: oldName });
}

export async function deleteNdnsProxy(name: string): Promise<ApiOk> {
  return postJson<ApiOk>("/api/ndns/proxy/delete", { name });
}

export async function restartUi(): Promise<ApiOk> {
  return postJson<ApiOk>("/api/ui/restart");
}

export async function fetchUiBind(): Promise<{
  ok: boolean;
  host: string;
  port: number;
}> {
  return parseJson<{ ok: boolean; host: string; port: number }>(
    await fetch("/api/ui/bind"),
  );
}

// ---------- Network («Сеть») ----------

export type NetTarget = { id: string; name: string; address: string; category: "internet" | "domain" };
export type PingLite = { ok: boolean; ms?: number; loss?: number };
export type PingResult = { sent: number; received: number; loss: number; avg_ms: number; min_ms: number; max_ms: number; ok: boolean; error?: string };
export type NetSample = {
  t: number;
  api: boolean;
  lte?: string;
  rsrp?: number;
  rsrq?: number;
  sinr?: number;
  q?: number;
  mt: Record<string, PingLite>;
  nc: Record<string, PingLite>;
  proxy: PingLite;
  lte_rx: number;
  lte_tx: number;
  wan_rx: number;
  wan_tx: number;
};
export type NetBucket = {
  t: number;
  rsrp: number | null;
  sinr: number | null;
  lte_rx: number;
  lte_tx: number;
  wan_rx: number;
  wan_tx: number;
  proxy_ms: number | null;
  mt: Record<string, number | null>;
  nc: Record<string, number | null>;
  loss: Record<string, number>;
};
export type NetAvailability = {
  id: string;
  name: string;
  group: "summary" | "mikrotik" | "netcraze";
  ok: boolean;
  valid: boolean;
  uptime: number;
  last_change: number;
  buckets: number[];
};
export type NetIncident = { check: string; name: string; start: number; end: number; duration_sec: number };
export type MikrotikFull = MikrotikState & {
  sample_time?: string;
  system?: MikrotikState["system"] & { dns_servers?: string[]; interfaces: Array<{ name: string; type: string; running: boolean; rx_bps: number; tx_bps: number; rx_bytes?: number; tx_bytes?: number }> };
};
export type NetworkPayload = {
  interval_sec: number;
  bucket_sec: number;
  targets: NetTarget[];
  current: NetSample | null;
  details: { mikrotik?: Record<string, PingResult>; netcraze?: Record<string, PingResult>; proxy_error?: string } | null;
  mikrotik: MikrotikFull;
  keenetic: { interfaces: SystemSnapshot["interfaces"] | null };
  series: NetBucket[];
  availability: NetAvailability[];
  incidents: NetIncident[];
};

export async function fetchNetwork(minutes: number, points = 180): Promise<NetworkPayload> {
  return parseJson<NetworkPayload>(await fetch(`/api/network?minutes=${minutes}&points=${points}`));
}

export type StepStatus = "ok" | "fail" | "warn" | "skip";
export type ProbeStep = { id: string; title: string; status: StepStatus; cause?: string; ms?: number; detail?: string };
export type ProbePath = {
  id: "direct" | "mihomo" | "mikrotik";
  title: string;
  verdict: string;
  summary: string;
  fail_at?: string;
  steps: ProbeStep[];
  rule?: string;
  chain?: string[];
};
export type DnsAnswer = { id: string; resolver: string; via: string; ips: string[]; rcode?: string; ms: number; error?: string; verdict: string };
export type Analysis = {
  target: string;
  host: string;
  port: number;
  path: string;
  at: number;
  ms: number;
  ip?: string;
  dns: DnsAnswer[];
  paths: ProbePath[];
  clients: { via: "mihomo" | "ipset" | "unknown"; ipset?: string; rule?: string; chain?: string[]; direct: boolean };
  verdict: "open" | "bypassed" | "blocked" | "down" | "proxy-broken" | "partial";
  summary: string;
  hints: string[];
};

export async function analyzeTarget(target: string, paths: string[]): Promise<Analysis> {
  return (await postJson<{ result: Analysis }>("/api/network/analyze", { target, paths })).result;
}

export type ScanSettings = { enabled: boolean; interval_min: number; paths: string[]; targets: string[] };
export type ScanPreset = { id: string; name: string; description: string; targets: string[] };
export type ScanRow = {
  target: string;
  last: Analysis;
  history: Array<{ at: number; verdict: string; paths: Record<string, string>; changed?: boolean }>;
};
export type ScanPayload = {
  settings: ScanSettings;
  presets: ScanPreset[];
  results: ScanRow[];
  running: boolean;
  progress: string;
  last_run: number;
  next_run: number;
};

export async function fetchScan(): Promise<ScanPayload> {
  return parseJson<ScanPayload>(await fetch("/api/network/scan"));
}

export async function saveScanSettings(settings: ScanSettings): Promise<ScanSettings> {
  return (await postJson<{ settings: ScanSettings }>("/api/network/scan/settings", settings)).settings;
}

export async function runScan(): Promise<void> {
  await postJson<ApiOk>("/api/network/scan/run", {});
}

export type TopoHost = { name: string; ip: string; link: "wifi" | "ethernet"; mesh?: boolean; via_mesh?: boolean; bypass?: boolean };
export type TopoSegment = { id: string; name: string; ip: string; cidr: string; active: number; hosts: TopoHost[]; dns_to_mihomo: boolean };
export type Topology = {
  keenetic: { model: string; firmware: string; wan: { id?: string; name?: string; ip?: string; link?: string }; segments: TopoSegment[]; routes: Array<{ dst: string; via: string }> };
  mesh: MeshNode[];
  xkeen: { deny_mac: number; geo_exclude: number; user_exclude: number; ext_exclude: number };
  mihomo: { error?: string; version?: string; mode?: string; groups?: Array<{ name: string; type: string; now: string; leaf: string; size: number }>; nameservers?: string[] };
  mikrotik: MikrotikFull;
  proxmox?: { ip: string; nodes: string[]; guests_running: number; guests: number };
};

export async function fetchTopology(): Promise<Topology> {
  return parseJson<Topology>(await fetch("/api/network/topology"));
}
