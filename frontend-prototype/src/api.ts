import type { CertItem, DnsHostItem, NdnsPayload, NginxStatus, RouteFilesPayload, RoutesDocument } from "./types";

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return data;
}

export async function fetchRoutes(): Promise<RoutesDocument> {
  return parseJson<RoutesDocument>(await fetch("/api/routes"));
}

export async function fetchNginxStatus(): Promise<{ ok: boolean; status: NginxStatus }> {
  return parseJson<{ ok: boolean; status: NginxStatus }>(await fetch("/api/nginx/status"));
}

export async function fetchRouteFiles(): Promise<RouteFilesPayload & { ok: boolean }> {
  return parseJson<RouteFilesPayload & { ok: boolean }>(await fetch("/api/routes/files"));
}

export async function fetchCerts(): Promise<{ ok: boolean; items: CertItem[] }> {
  return parseJson<{ ok: boolean; items: CertItem[] }>(await fetch("/api/cert/list"));
}

export async function fetchDnsHosts(): Promise<{ ok: boolean; items: DnsHostItem[] }> {
  return parseJson<{ ok: boolean; items: DnsHostItem[] }>(await fetch("/api/ip-hosts"));
}

export async function fetchNdns(): Promise<{ ok: boolean; data: NdnsPayload }> {
  return parseJson<{ ok: boolean; data: NdnsPayload }>(await fetch("/api/ndns/http"));
}

export async function fetchUiBind(): Promise<{ ok: boolean; host: string; port: number }> {
  return parseJson<{ ok: boolean; host: string; port: number }>(await fetch("/api/ui/bind"));
}

export async function fetchLogs(type: "access" | "error", filter: string, limit: number): Promise<{ ok: boolean; lines: string[] }> {
  const q = new URLSearchParams({ type, filter, limit: String(limit) });
  return parseJson<{ ok: boolean; lines: string[] }>(await fetch(`/api/nginx/logs?${q.toString()}`));
}
