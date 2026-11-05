import type { RouteHost } from "../../types";

export type PublicDomainDraft = { host: string; serverId: string; externalPort: string; originalHost?: string };

export function vpsHost(original: RouteHost | undefined, host: string, appId: string, serverId: string): RouteHost {
  const prior = original?.endpoints?.find(e => e.name === "vps");
  return {
    ...original, host, app_id: appId, kind: "public", publication: { server_id: serverId },
    dns: { publish: [], local_record_ip: "auto" }, tls: { cert_policy: "off", cert_ref: "auto", san: [] },
    endpoints: [{ name: "vps", listen: { protocol: "http", port: prior?.listen.port || "auto_random" }, behavior: { redirect: "off" } }],
  };
}

export function publicDomainDraft(host: RouteHost, suffix: string): PublicDomainDraft {
  return {
    host: host.host, originalHost: host.host,
    serverId: host.publication?.server_id || (host.host.endsWith(`.${suffix}`) ? "" : "manual"),
    externalPort: String(host.endpoints?.find(e => e.behavior.ndns_profile || e.name === "ndns")?.listen.port || "auto_random"),
  };
}
