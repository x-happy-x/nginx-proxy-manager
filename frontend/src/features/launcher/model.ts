import type { LauncherConfig, LauncherDevice } from "../../api";
import type { RoutesDocument, RouteHost } from "../../types";
import { getWebEndpoint } from "../servers/lib/utils";

export const OTHER_DEVICE = "other";

// Devices of this home network as the router sees them; editable in the UI.
export function defaultLauncher(): LauncherConfig {
  return {
    devices: [
      { id: "router", name: "Роутер", kind: "router", note: "Netcraze Ultra · 192.168.1.1", addresses: ["192.168.1.1", "192.168.1.2", "192.168.99.1", "192.168.99.2", "127.0.0.1", "localhost"] },
      { id: "home-server", name: "Домашний сервер", kind: "server", note: "Proxmox ps2 · 192.168.99.20", addresses: ["192.168.99.20", "192.168.99.21"] },
      { id: "ps1", name: "Сервер ps1", kind: "server", note: "Proxmox ps1 · 192.168.99.10", addresses: ["192.168.99.10", "192.168.99.11", "192.168.99.12", "192.168.99.13"] },
      { id: "pc-x", name: "PC-X", kind: "pc", note: "192.168.1.10", addresses: ["192.168.1.10"] },
      { id: "pc-a", name: "PC-A", kind: "pc", note: "192.168.1.20", addresses: ["192.168.1.20"] },
    ],
    links: [
      { id: "keenetic", title: "Веб-интерфейс роутера", url: "http://192.168.1.1/", device: "router", description: "Настройки Netcraze", art: "router" },
      { id: "jetkvm", title: "JetKVM", url: "http://192.168.99.11/", device: "ps1", description: "KVM-доступ к серверу", art: "kvm" },
      { id: "tracker", title: "Задачи", url: "https://task.crubs.crazedns.ru/", device: "home-server", description: "Трекер задач", art: "tracker" },
    ],
    apps: {},
    order: [],
  };
}

export type LauncherItem = {
  key: string;
  source: "routes" | "manual";
  title: string;
  description: string;
  device: string;
  art?: string;
  hints: string[];
  primary: string;
  local?: string;
  public?: string;
  direct?: string;
  probe?: string;
  hidden: boolean;
};

function hostURL(host: RouteHost) {
  const web = getWebEndpoint(host);
  const https = web?.listen.protocol === "https";
  const port = typeof web?.listen.port === "number" ? web.listen.port : https ? 443 : 80;
  const std = (https && port === 443) || (!https && port === 80);
  return `${https ? "https" : "http"}://${host.host}${std ? "" : ":" + port}/`;
}

export function deviceFor(address: string, devices: LauncherDevice[]) {
  const needle = address.trim().toLowerCase();
  return devices.find((d) => d.addresses.some((a) => a.trim().toLowerCase() === needle))?.id || OTHER_DEVICE;
}

// probeTarget turns a URL into host:port for the router-side reachability check.
export function probeTarget(url: string) {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.hostname}:${port}`;
  } catch {
    return undefined;
  }
}

export function buildItems(doc: RoutesDocument | null, cfg: LauncherConfig, links: Record<string,{ip_url?:string;domain_url?:string}> = {}, hostname = window.location.hostname): LauncherItem[] {
  const byIP = hostname.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || !hostname.includes(".");
  const items: LauncherItem[] = [];
  const hosts = doc?.hosts || [];
  for (const app of doc?.apps || []) {
    const override = cfg.apps[app.id] || {};
    const own = hosts.filter((h) => h.app_id === app.id);
    const local = own.find((h) => h.kind === "private");
    const pub = own.find((h) => h.kind === "public");
    const up = app.upstream;
    const loopback = up.address === "127.0.0.1" || up.address === "localhost";
    const direct = links[app.id]?.ip_url || (loopback ? undefined : `${up.scheme}://${up.address}:${up.port}/`);
    const localURL = local ? hostURL(local) : undefined;
    const publicURL = links[app.id]?.domain_url || (pub ? hostURL(pub) : undefined);
    items.push({
      key: "app:" + app.id,
      source: "routes",
      title: override.title || app.name || app.id,
      description: override.description || [local?.host, pub?.host].filter(Boolean).join(" · ") || `${up.address}:${up.port}`,
      device: override.device || deviceFor(up.address, cfg.devices),
      art: override.art,
      hints: [app.id, app.name, ...own.map((h) => h.host)],
      primary: (byIP ? direct || publicURL : publicURL || direct) || "#",
      local: localURL,
      public: publicURL,
      direct,
      probe: `${up.address}:${up.port}`,
      hidden: !!override.hidden,
    });
  }
  for (const link of cfg.links) {
    items.push({
      key: "link:" + link.id,
      source: "manual",
      title: link.title,
      description: link.description || link.url.replace(/^https?:\/\//, "").replace(/\/$/, ""),
      device: cfg.devices.some((d) => d.id === link.device) ? link.device : OTHER_DEVICE,
      art: link.art,
      hints: [link.id, link.title, link.url],
      primary: (byIP ? links["link:"+link.id]?.ip_url : links["link:"+link.id]?.domain_url) || link.url,
      probe: probeTarget(link.url),
      hidden: false,
    });
  }
  const order = new Map((cfg.order || []).map((key, i) => [key, i]));
  return items.sort((a, b) => {
    const x = order.get(a.key) ?? 1e6;
    const y = order.get(b.key) ?? 1e6;
    return x !== y ? x - y : a.title.localeCompare(b.title, "ru");
  });
}

export function slug(text: string) {
  const base = text.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-|-$/g, "");
  return (base || "link") + "-" + Math.random().toString(36).slice(2, 6);
}
