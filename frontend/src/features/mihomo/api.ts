// Client for the Mihomo bridge (/api/mihomo/* → controller) and HomeNet's own
// core endpoints (/api/core/*). The controller secret never reaches the browser.

export type DelayPoint = { time: string; delay: number };

export type MProxy = {
  name: string;
  type: string;
  now?: string;
  fixed?: string;
  all?: string[];
  history: DelayPoint[];
  extra?: Record<string, { alive: boolean; history: DelayPoint[] }>;
  alive?: boolean;
  udp?: boolean;
  hidden?: boolean;
  icon?: string;
  testUrl?: string;
  "dialer-proxy"?: string;
  "provider-name"?: string;
};

export type AdaptiveProbe = { url: string; ok: boolean; status?: number; bytes: number; ms: number; stage: string; error?: string };
export type NetMode = "normal" | "whitelist" | "offline" | "unknown";
export type AdaptiveNode = {
  name: string;
  stable: boolean;
  successRate: number;
  score: number;
  record: { ok: number; fail: number; avgMs: number; lastMs: number; checks: number; lastOk: string; lastCheck: string };
};
export type AdaptiveResult = { mode: string; at: string; ok: boolean; available?: boolean; consecutiveSuccesses?: number; consecutiveFailures?: number; probes: AdaptiveProbe[] };
export type AdaptiveHealth = {
  mode: NetMode;
  observed: NetMode;
  pending: number;
  checkedAt: string;
  directAllowed: AdaptiveProbe[] | null;
  directGlobal: AdaptiveProbe[] | null;
  rankings: Partial<Record<"normal" | "whitelist", AdaptiveNode[] | null>>;
  results: Record<string, AdaptiveResult>;
  persistenceError?: string;
};

export type MProvider = {
  name: string;
  type: string;
  vehicleType: string;
  updatedAt?: string;
  testUrl?: string;
  proxies: MProxy[];
  subscriptionInfo?: { Download?: number; Upload?: number; Total?: number; Expire?: number };
  adaptive?: AdaptiveHealth;
};

export type MRule = {
  index: number;
  type: string;
  payload: string;
  proxy: string;
  size: number;
  uuid?: string;
  disabled?: boolean;
  extra?: { disabled: boolean; hitAt: string; hitCount: number; missAt: string; missCount: number };
};

export type MRuleProvider = { name: string; behavior: string; format: string; ruleCount: number; type: string; updatedAt: string; vehicleType: string };

export type MConnection = {
  id: string;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  metadata: {
    network: string;
    type: string;
    sourceIP: string;
    sourcePort: string;
    destinationIP: string;
    destinationPort: string;
    destinationGeoIP?: string;
    destinationIPASN?: string;
    host: string;
    sniffHost?: string;
    process?: string;
    processPath?: string;
    inboundName?: string;
    dnsMode?: string;
    remoteDestination?: string;
  };
};

export type MConfigs = {
  mode: string;
  "mode-list"?: string[];
  "log-level": string;
  "allow-lan": boolean;
  ipv6: boolean;
  port: number;
  "socks-port": number;
  "mixed-port": number;
  "redir-port": number;
  "tproxy-port": number;
  tun?: { enable: boolean; stack?: string; device?: string };
};

export type CoreStatus = {
  installed: boolean;
  binary: string;
  config: string;
  config_exists: boolean;
  running: boolean;
  version?: string;
  meta: boolean;
  fork: boolean;
  controller_ok: boolean;
  controller: string;
  error?: string;
  xkeen: boolean;
  arch: string;
  asset: string;
  can_edit: boolean;
};

export type CoreDevice = { ip: string; mac?: string; name: string; hostname?: string; source: "keenetic" | "homenet"; active: boolean; segment?: string };

export type ConfigChange = { section: string; kind: "added" | "removed" | "changed"; item?: string };

export type CoreConfig = {
  path: string;
  target: string;
  sha: string;
  yaml: string;
  sections: Record<string, unknown>;
  backups: Array<{ name: string; size: number; time: string }>;
  can_validate: boolean;
};

export type InstallPlan = {
  asset: string;
  release_base: string;
  binary: string;
  config: string;
  config_exists: boolean;
  init_script?: string;
  xkeen: boolean;
  xkeen_command?: string;
  steps: Array<{ id: string; title: string; note?: string }>;
};

export type InstallState = {
  running: boolean;
  done: boolean;
  ok: boolean;
  step: string;
  version?: string;
  started?: string;
  log: Array<{ time: string; level: string; text: string }>;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...(init?.headers || {}) } : init?.headers,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return text as T;
    }
  }
  const obj = (data || {}) as { ok?: boolean; error?: string; message?: string; detail?: string };
  if (!res.ok || obj.ok === false) {
    const msg = obj.error === "mihomo_unreachable" ? `Контроллер mihomo не отвечает${obj.detail ? `: ${obj.detail}` : ""}` : obj.message || obj.error || `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data as T;
}

const enc = encodeURIComponent;
const m = (path: string) => `/api/mihomo${path}`;
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const mihomo = {
  version: () => call<{ version: string; meta?: boolean }>(m("/version")),
  configs: () => call<MConfigs>(m("/configs")),
  patchConfigs: (patch: Partial<MConfigs> | Record<string, unknown>) => call<unknown>(m("/configs"), json("PATCH", patch)),
  reload: () => call<unknown>(m("/configs?force=true"), json("PUT", { path: "", payload: "" })),
  updateGeo: () => call<unknown>(m("/configs/geo"), json("POST")),
  proxies: () => call<{ proxies: Record<string, MProxy> }>(m("/proxies")),
  /** /proxies plus nodes that live only inside providers (newer cores list them there). */
  allProxies: async () => {
    const [p, pr] = await Promise.all([call<{ proxies: Record<string, MProxy> }>(m("/proxies")), call<{ providers: Record<string, MProvider> }>(m("/providers/proxies"))]);
    const all: Record<string, MProxy> = {};
    Object.values(pr.providers || {}).forEach((prov) => prov.proxies?.forEach((x) => (all[x.name] = x)));
    Object.assign(all, p.proxies || {});
    return { proxies: all, providers: pr.providers || {} };
  },
  select: (group: string, name: string) => call<unknown>(m(`/proxies/${enc(group)}`), json("PUT", { name })),
  unfix: (group: string) => call<unknown>(m(`/proxies/${enc(group)}`), json("DELETE")),
  delay: (name: string, url: string, timeout = 5000) =>
    call<{ delay: number }>(m(`/proxies/${enc(name)}/delay?url=${enc(url)}&timeout=${timeout}`)),
  groupDelay: (group: string, url: string, timeout = 5000) =>
    call<Record<string, number>>(m(`/group/${enc(group)}/delay?url=${enc(url)}&timeout=${timeout}`)),
  providers: () => call<{ providers: Record<string, MProvider> }>(m("/providers/proxies")),
  provider: (name: string) => call<MProvider>(m(`/providers/proxies/${enc(name)}`)),
  updateProvider: (name: string) => call<unknown>(m(`/providers/proxies/${enc(name)}`), json("PUT")),
  healthcheck: (name: string) => call<unknown>(m(`/providers/proxies/${enc(name)}/healthcheck`)),
  rules: () => call<{ rules: MRule[] }>(m("/rules")),
  disableRules: (map: Record<number, boolean>) => call<unknown>(m("/rules/disable"), json("PATCH", map)),
  ruleProviders: () => call<{ providers: Record<string, MRuleProvider> }>(m("/providers/rules")),
  updateRuleProvider: (name: string) => call<unknown>(m(`/providers/rules/${enc(name)}`), json("PUT")),
  closeConnection: (id: string) => call<unknown>(m(`/connections/${enc(id)}`), json("DELETE")),
  closeAll: () => call<unknown>(m("/connections"), json("DELETE")),
  dnsQuery: (name: string, type: string) =>
    call<{ Status: number; Answer?: Array<{ name: string; type: number; TTL: number; data: string }> }>(m(`/dns/query?name=${enc(name)}&type=${enc(type)}`)),
  flushFakeIP: () => call<unknown>(m("/cache/fakeip/flush"), json("POST")),
  flushDNS: () => call<unknown>(m("/cache/dns/flush"), json("POST")),
  flushSmart: () => call<unknown>(m("/cache/smart/flush"), json("POST")),
  restart: () => call<unknown>(m("/restart"), json("POST")),
  upgrade: (channel: "release" | "alpha" | "auto") => call<unknown>(m(channel === "auto" ? "/upgrade" : `/upgrade?channel=${channel}`), json("POST")),
};

export const core = {
  status: () => call<{ status: CoreStatus }>("/api/core/status").then((r) => r.status),
  devices: () => call<{ devices: CoreDevice[]; warning?: string }>("/api/core/devices"),
  saveLabels: (labels: Record<string, string>) => call<unknown>("/api/core/devices", json("POST", { labels })),
  config: () => call<CoreConfig>("/api/core/config"),
  checkConfig: (body: { sha: string; set?: Record<string, unknown>; yaml?: string }) =>
    call<{ valid: boolean; changes: ConfigChange[]; message?: string }>("/api/core/config/check", json("POST", body)),
  applyConfig: (body: { sha: string; set?: Record<string, unknown>; yaml?: string }) =>
    call<{ applied: boolean; changes: ConfigChange[]; backup: string; sha: string; message: string }>("/api/core/config/apply", json("POST", body)),
  installPlan: (xkeen: boolean) => call<{ plan: InstallPlan }>(`/api/core/install/plan${xkeen ? "?xkeen=1" : ""}`).then((r) => r.plan),
  install: (req: { subscription_url: string; provider: string; adaptive: boolean; xkeen: boolean }) =>
    call<{ install: InstallState }>("/api/core/install", json("POST", req)).then((r) => r.install),
  installLog: () => call<{ install: InstallState }>("/api/core/install/log").then((r) => r.install),
};

/** Opens a controller stream through the bridge; reconnects with backoff until closed. */
export function openStream<T>(path: string, onMessage: (data: T) => void, onState?: (open: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  let timer = 0;
  const connect = () => {
    if (closed) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${window.location.host}/api/mihomo${path}`);
    ws.onopen = () => {
      delay = 1000;
      onState?.(true);
    };
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data as string) as T);
      } catch {
        /* partial or non-JSON frame */
      }
    };
    ws.onclose = () => {
      onState?.(false);
      if (closed) return;
      timer = window.setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    };
  };
  connect();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    ws?.close();
  };
}

export const DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204";
