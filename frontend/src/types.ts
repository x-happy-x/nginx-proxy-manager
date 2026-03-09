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

export type HostEndpoint = {
  name: string;
  listen: {
    protocol: "http" | "https";
    port: number | "auto_random";
  };
  behavior: {
    redirect?: "https" | "http" | "off";
    ndns_profile?: string;
    ndns_name?: string;
    ndns_domain?: string;
    ndns_security_level?: "public" | "private" | "";
    ndns_ssl_redirect?: boolean;
    ndns_target_ip?: string;
    [key: string]: unknown;
  };
};

export type RouteHost = {
  host: string;
  kind: "private" | "public";
  app_id: string;
  verify_upstream_ssl?: boolean;
  ws_proxy?: {
    enabled: boolean;
    path: string;
    rewrite_to_wss: boolean;
    rewrite_from: string;
  };
  dns?: {
    publish: string[];
    local_record_ip?: string;
  };
  tls?: {
    cert_policy: "auto_local_ca" | "auto_acme" | "self_signed" | "off";
    cert_ref: string;
    san: string[];
  };
  endpoints?: HostEndpoint[];
  [key: string]: unknown;
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
    stub: {
      enabled: boolean;
      root: string;
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

export type ApiOk = { ok: boolean; error?: string; output?: string };

export type NginxStatus = {
  running: boolean;
  pid: string;
  pids: string[];
  version: string;
  config_files: string[];
  listeners: string[];
  parsed_listeners: Array<{ ip: string; port: number; scheme: string; flags: string[]; source: string }>;
  rss_kb: number;
};

export type ConfigItem = {
  id: string;
  title: string;
  path: string;
  type: string;
  editable: boolean;
  exists: boolean;
  size: number;
  mtime: number;
  listens: Array<{ ip: string; port: number }>;
};

export type RouteFilesPayload = {
  active: string;
  dir: string;
  items: string[];
};

export type NdnsProxy = {
  name: string;
  upstream: {
    proto: "http" | "https";
    target: string;
    port: string;
  };
  domain: string;
  sslRedirect: boolean;
  securityLevel: "public" | "private" | "";
};

export type NdnsPayload = {
  http: {
    port: number | null;
    sslPort: number | null;
  };
  domainSuffix: string;
  proxies: NdnsProxy[];
};

export type DnsHostItem = {
  host: string;
  address: string;
};

export type CertItem = {
  host: string;
  has_key: boolean;
  path: string;
};

export type RouteLogItem = {
  time_local?: string;
  host?: string;
  status?: number | string;
  request_method?: string;
  uri?: string;
  upstream_addr?: string;
  request_time_ms?: number | string;
  target_ip?: string;
  listen_endpoint?: string;
  [key: string]: unknown;
};

export type ConsoleItem = {
  at: string;
  level: "info" | "error";
  title: string;
  message: string;
};
