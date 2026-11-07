import type { RouteHost, RoutesDocument } from "../../types";

export function publicationChannels(doc: RoutesDocument, servers: { id: string; name: string }[]) {
  const channels = new Map(servers.map(s => [`vps:${s.id}`, { id: `vps:${s.id}`, name: s.name, domains: 0 }]));
  for (const h of doc.hosts) for (const ep of h.endpoints || []) {
    if (ep.name === "web") continue;
    const id = h.publication ? `vps:${h.publication.server_id}` : `keendns:${ep.behavior.ndns_profile || "ndns_proxy"}`;
    const item = channels.get(id) || { id, name: h.publication ? h.publication.server_id : "KeenDNS", domains: 0 };
    item.domains++; channels.set(id, item);
  }
  return [...channels.values()];
}

export function setPublicationEnabled(doc: RoutesDocument, channel: string, enabled: boolean): RoutesDocument {
  const disabled = new Set(doc.globals.disabled_publications || []);
  if (enabled) disabled.delete(channel); else disabled.add(channel);
  return { ...doc, globals: { ...doc.globals, disabled_publications: [...disabled] } };
}

export function hasPublicAccess(host: RouteHost, disabled: string[] = []): boolean {
  return (host.endpoints || []).some(ep => ep.name !== "web" && !disabled.includes(host.publication ? `vps:${host.publication.server_id}` : `keendns:${ep.behavior.ndns_profile || "ndns_proxy"}`));
}

export type PublicDomainDraft = { host: string; serverId: string; externalPort: string; originalHost?: string; httpPort?: number; httpsPort?: number };

export function vpsHost(original: RouteHost | undefined, host: string, appId: string, serverId: string, httpPort = original?.publication?.http_port || 80, httpsPort = original?.publication?.https_port || 443): RouteHost {
  const prior = original?.endpoints?.find(e => e.name === "vps");
  return {
    ...original, host, app_id: appId, kind: "public", publication: { server_id: serverId, http_port: httpPort, https_port: httpsPort },
    dns: { publish: ["local"], local_record_ip: original?.dns?.local_record_ip || "auto" }, tls: { cert_policy: "public_vps", cert_ref: "auto", san: [] },
    endpoints: [
      { name: "web", listen: { protocol: "https", port: httpsPort }, behavior: { redirect: "https" } },
      { name: "vps", listen: { protocol: "http", port: prior?.listen.port || "auto_random" }, behavior: { redirect: "off" } },
    ],
  };
}

export function publicDomainDraft(host: RouteHost, suffix: string): PublicDomainDraft {
  return {
    host: host.host, originalHost: host.host,
    httpPort: host.publication?.http_port || 80, httpsPort: host.publication?.https_port || 443,
    serverId: host.publication?.server_id || (host.host.endsWith(`.${suffix}`) ? "" : "manual"),
    externalPort: String(host.endpoints?.find(e => e.behavior.ndns_profile || e.name === "ndns")?.listen.port || "auto_random"),
  };
}
