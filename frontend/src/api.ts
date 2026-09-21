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
