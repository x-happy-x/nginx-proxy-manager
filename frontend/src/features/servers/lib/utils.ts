import type { RouteHost } from "../../../types";

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getInitials(value: string) {
  const cleaned = value.trim();
  if (!cleaned) return "??";
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export function getWebEndpoint(host: RouteHost) {
  return (host.endpoints || []).find((ep) => ep.name === "web");
}

export function getNdnsEndpoint(host: RouteHost) {
  return (host.endpoints || []).find((ep) => ep.name === "ndns" || ep.behavior?.ndns_profile);
}

export function updateHost(host: RouteHost, patch: Partial<RouteHost> & { ndnsEnabled?: boolean; redirect?: "https" | "http" | "off" }) {
  const next: RouteHost = { ...host, ...patch };
  const web = getWebEndpoint(next) || {
    name: "web",
    listen: { protocol: "https", port: 443 },
    behavior: { redirect: "https" },
  };
  web.behavior = { ...web.behavior, redirect: patch.redirect || web.behavior.redirect || "https" };

  const ndnsEnabled = patch.ndnsEnabled !== undefined ? patch.ndnsEnabled : !!getNdnsEndpoint(next);
  const ndnsExisting = getNdnsEndpoint(next);
  const ndns =
    ndnsExisting ||
    ({
      name: "ndns",
      listen: { protocol: "http", port: "auto_random" },
      behavior: {
        ndns_profile: "ndns_proxy",
        ndns_name: next.host.split(".", 1)[0],
        ndns_domain: "ndns",
        ndns_security_level: "public",
        ndns_ssl_redirect: true,
        ndns_target_ip: "auto",
      },
    } as const);

  const endpoints = [web, ...(ndnsEnabled ? [ndns] : [])];
  next.endpoints = endpoints as RouteHost["endpoints"];

  if (next.tls && next.tls.cert_policy === "off") {
    web.listen.protocol = "http";
    web.behavior.redirect = "off";
  }

  return next;
}
