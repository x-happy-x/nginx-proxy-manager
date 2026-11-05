// Isolated browser fixture. Never connects to a router, VPS, DNS or ACME.
let routes = {
  schema_version: "2.1", globals: { ssl_mode: "local-ca", listen_ips: ["192.0.2.2"], ports: { http: 80, https: 443, http_extra: [], https_extra: [] }, ui: { host: "127.0.0.1", port: 8080 }, stub: { enabled: true, root: "/tmp/stub" }, acme: {} },
  apps: [{ id: "demo", name: "Домашняя медиатека", upstream: { address: "192.0.2.20", port: 8092, scheme: "http" } }],
  hosts: [{ host: "media.crubs.crazedns.ru", kind: "public", app_id: "demo", access_public: false, dns: { publish: ["local"], local_record_ip: "192.0.2.2" }, tls: { cert_policy: "keenetic", cert_ref: "auto", san: [] }, endpoints: [{ name: "web", listen: { protocol: "https", port: 443 }, behavior: {} }, { name: "ndns", listen: { protocol: "http", port: 24001 }, behavior: { ndns_profile: "ndns_proxy" } }] }], certs: [],
};
const servers = [{ server: { id: "cdn6", name: "VPS cdn6", address: "203.0.113.79", port: 22, user: "root", fingerprint: "SHA256:preview-fingerprint", socks: "127.0.0.1:7891" }, status: { state: "online", reconnects: 2, domains: [{ host: "media.cdn6.ru", port: 24002 }], metrics: { host: "vdska", load1: 0.12, cores: 2, memory_total: 2147483648, memory_used: 420000000, disk_total: 21474836480, disk_used: 6400000000, uptime: 172800 } } }];
export function fakePublicProxy(req, res) {
  const path = req.url.split("?")[0];
  if (!path.startsWith("/api/routes") && !["/api/nginx/status", "/api/nginx/configs", "/api/ca/status", "/api/cert/list", "/api/ip-hosts", "/api/ndns/http", "/api/nginx/logs", "/api/nginx/route-logs"].includes(path)) return false;
  const send = value => res.end(JSON.stringify(value));
  if (path === "/api/routes/public/servers") { send({ ok: true, items: servers.map(s => ({ ...s, status: { ...s.status, checked_at: new Date().toISOString() } })) }); return true; }
  if (path === "/api/routes" && req.method === "GET") { send(routes); return true; }
  if (path === "/api/routes" && req.method === "POST") { let b = ""; req.on("data", c => b += c); req.on("end", () => { routes = JSON.parse(b); send({ ok: true }); }); return true; }
  if (path === "/api/routes/public/inspect") { req.resume(); req.on("end", () => send({ ok: true, fingerprint: "SHA256:preview-fingerprint" })); return true; }
  if (path.startsWith("/api/routes/public/")) { req.resume(); req.on("end", () => { res.writeHead(409); send({ ok: false, error: "В изолированном превью серверы не изменяются" }); }); return true; }
  if (path === "/api/nginx/status") { send({ running: true, pid: "123", pids: ["123"], version: "nginx fixture", config_files: [], listeners: [], parsed_listeners: [], rss_kb: 8192 }); return true; }
  if (path === "/api/ndns/http") { send({ ok: true, http: { port: 80, sslPort: 443 }, proxies: [] }); return true; }
  if (path === "/api/routes/files") { send({ ok: true, items: ["routes.yml"], active: "routes.yml" }); return true; }
  send({ ok: true, items: [], lines: [], installed: true, entries: [] }); return true;
}
