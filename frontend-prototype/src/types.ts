export type SslMode = "acme" | "local-ca" | "self-signed" | "off";

export type AppUpstream = {
  address: string;
  port: number;
  scheme: "http" | "https";
};

export type RouteApp = {
  id: string;
  name: string;
  upstream: AppUpstream;
  ui?: {
    icon_data_url?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type RouteHost = {
  host: string;
  kind: "private" | "public";
  app_id: string;
  tls?: {
    cert_policy: "auto_local_ca" | "auto_acme" | "self_signed" | "off";
  };
  endpoints?: Array<{
    name: string;
    listen: {
      protocol: "http" | "https";
      port: number | "auto_random";
    };
  }>;
};

export type RoutesDocument = {
  schema_version: 2.1;
  globals: {
    ssl_mode: SslMode;
    listen_ips: string[];
    ports: {
      http: number;
      https: number;
      http_extra: number[];
      https_extra: number[];
    };
    ui: {
      host: string;
      port: number;
    };
    acme: {
      email: string;
    };
  };
  apps: RouteApp[];
  hosts: RouteHost[];
  certs: Record<string, unknown>[];
  _routes_file?: string;
};

export type NginxStatus = {
  running: boolean;
  version: string;
  listeners: string[];
  parsed_listeners: Array<{ ip: string; port: number; scheme: string; flags: string[]; source: string }>;
  rss_kb: number;
};

export type RouteFilesPayload = {
  active: string;
  dir: string;
  items: string[];
};

export type CertItem = {
  host: string;
  has_key: boolean;
  path: string;
};

export type DnsHostItem = {
  host: string;
  address: string;
};

export type NdnsPayload = {
  http: {
    port: number | null;
    sslPort: number | null;
  };
  domainSuffix: string;
  proxies: Array<{
    name: string;
    upstream: {
      proto: "http" | "https";
      target: string;
      port: string;
    };
    domain: string;
    sslRedirect: boolean;
    securityLevel: "public" | "private" | "";
  }>;
};
