import { useEffect, useMemo, useState } from "react";
import { fetchCerts, fetchDnsHosts, fetchLogs, fetchNdns, fetchNginxStatus, fetchRouteFiles, fetchRoutes, fetchUiBind } from "./api";
import type { CertItem, DnsHostItem, NginxStatus, RoutesDocument } from "./types";

type ThemeMode = "light" | "dark";

type DashboardState = {
  doc: RoutesDocument | null;
  status: NginxStatus | null;
  routeFile: string;
  uiBind: { host: string; port: number } | null;
  certs: CertItem[];
  dns: DnsHostItem[];
  ndnsText: string;
  logs: string[];
};

function formatListener(listener: { ip: string; port: number; scheme: string }) {
  return `${listener.scheme.toUpperCase()} ${listener.ip}:${listener.port}`;
}

function runtimeTone(running: boolean) {
  return running ? "ok" : "danger";
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => (localStorage.getItem("prototype_theme") === "light" ? "light" : "dark"));
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [state, setState] = useState<DashboardState>({
    doc: null,
    status: null,
    routeFile: "",
    uiBind: null,
    certs: [],
    dns: [],
    ndnsText: "-",
    logs: [],
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("prototype_theme", theme);
  }, [theme]);

  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const [doc, statusRes, routeFiles, bind, certs, dns, ndns, logs] = await Promise.all([
        fetchRoutes(),
        fetchNginxStatus(),
        fetchRouteFiles(),
        fetchUiBind(),
        fetchCerts(),
        fetchDnsHosts(),
        fetchNdns(),
        fetchLogs("access", "", 10),
      ]);
      setState({
        doc,
        status: statusRes.status,
        routeFile: routeFiles.active || routeFiles.items?.[0] || "",
        uiBind: { host: bind.host, port: bind.port },
        certs: certs.items || [],
        dns: dns.items || [],
        ndnsText: `HTTP ${ndns.data.http.port ?? "-"} / HTTPS ${ndns.data.http.sslPort ?? "-"}`,
        logs: logs.lines || [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const hero = useMemo(() => {
    const doc = state.doc;
    const status = state.status;
    return [
      {
        label: "Runtime",
        value: status?.running ? "Running" : "Stopped",
        meta: status?.version || "No version",
        tone: runtimeTone(!!status?.running),
      },
      {
        label: "Published Routes",
        value: String(doc?.hosts.length || 0),
        meta: `${doc?.apps.length || 0} apps`,
        tone: "neutral",
      },
      {
        label: "UI Bind",
        value: state.uiBind ? `${state.uiBind.host}:${state.uiBind.port}` : "Unknown",
        meta: state.routeFile || "routes.yml",
        tone: "accent",
      },
      {
        label: "Certificates",
        value: String(state.certs.length),
        meta: doc?.globals.ssl_mode || "off",
        tone: "neutral",
      },
    ];
  }, [state]);

  const spotlightApps = (state.doc?.apps || []).slice(0, 6);
  const spotlightHosts = (state.doc?.hosts || []).slice(0, 6);
  const listeners = state.status?.parsed_listeners || [];
  const dnsByHost = Array.from(
    state.dns.reduce((map, item) => {
      const current = map.get(item.host) || [];
      current.push(item.address);
      map.set(item.host, current);
      return map;
    }, new Map<string, string[]>()),
  ).slice(0, 6);

  return (
    <div className="prototype-shell">
      <header className="prototype-topbar">
        <div className="prototype-brand">
          <span className="prototype-brand__eyebrow">Prototype UI</span>
          <h1>Nginx Manager</h1>
          <p>Новый визуальный концепт поверх текущего API, без изменения существующего фронта.</p>
        </div>
        <div className="prototype-actions">
          <button className="prototype-button prototype-button--ghost" onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button className="prototype-button prototype-button--accent" onClick={() => void load()} disabled={busy}>
            {busy ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>

      <main className="prototype-main">
        <section className="prototype-hero">
          {hero.map((item) => (
            <article key={item.label} className={`hero-card tone-${item.tone}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.meta}</small>
            </article>
          ))}
        </section>

        {error ? <section className="prototype-banner">{error}</section> : null}

        <section className="prototype-grid">
          <article className="prototype-panel prototype-panel--primary">
            <div className="panel-head">
              <div>
                <span className="eyebrow">Live topology</span>
                <h2>Apps and hosts</h2>
              </div>
              <span className="badge">{state.doc?.globals.listen_ips.join(", ") || "no listen ips"}</span>
            </div>
            <div className="duo-list">
              <div className="mini-list">
                <h3>Applications</h3>
                {spotlightApps.map((app) => (
                  <div key={app.id} className="mini-row">
                    <div>
                      <strong>{app.name}</strong>
                      <span>{app.id}</span>
                    </div>
                    <code>{app.upstream.scheme}://{app.upstream.address}:{app.upstream.port}</code>
                  </div>
                ))}
                {!spotlightApps.length ? <p className="empty-state">No apps found.</p> : null}
              </div>
              <div className="mini-list">
                <h3>Published hosts</h3>
                {spotlightHosts.map((host) => (
                  <div key={host.host} className="mini-row">
                    <div>
                      <strong>{host.host}</strong>
                      <span>{host.kind}</span>
                    </div>
                    <code>{host.app_id}</code>
                  </div>
                ))}
                {!spotlightHosts.length ? <p className="empty-state">No hosts found.</p> : null}
              </div>
            </div>
          </article>

          <article className="prototype-panel">
            <div className="panel-head">
              <div>
                <span className="eyebrow">Routing</span>
                <h2>Listeners</h2>
              </div>
              <span className="badge">{state.status?.rss_kb ? `${state.status.rss_kb} KB RSS` : "runtime idle"}</span>
            </div>
            <div className="listener-grid">
              {listeners.slice(0, 8).map((listener) => (
                <div key={`${listener.ip}-${listener.port}-${listener.scheme}`} className="listener-pill">
                  {formatListener(listener)}
                </div>
              ))}
              {!listeners.length ? <p className="empty-state">No listeners reported.</p> : null}
            </div>
          </article>

          <article className="prototype-panel">
            <div className="panel-head">
              <div>
                <span className="eyebrow">Security</span>
                <h2>Certificates</h2>
              </div>
              <span className="badge">{state.doc?.globals.acme.email || "ACME email missing"}</span>
            </div>
            <div className="stack-list">
              {state.certs.slice(0, 6).map((cert) => (
                <div key={cert.host} className="stack-row">
                  <strong>{cert.host}</strong>
                  <span>{cert.has_key ? "crt + key" : "crt only"}</span>
                </div>
              ))}
              {!state.certs.length ? <p className="empty-state">No certificates issued.</p> : null}
            </div>
          </article>

          <article className="prototype-panel">
            <div className="panel-head">
              <div>
                <span className="eyebrow">Network</span>
                <h2>DNS / NDNS</h2>
              </div>
              <span className="badge">{state.ndnsText}</span>
            </div>
            <div className="stack-list">
              {dnsByHost.map(([host, addresses]) => (
                <div key={host} className="stack-row">
                  <strong>{host}</strong>
                  <span>{addresses.join(", ")}</span>
                </div>
              ))}
              {!dnsByHost.length ? <p className="empty-state">No DNS records published.</p> : null}
            </div>
          </article>

          <article className="prototype-panel prototype-panel--logs">
            <div className="panel-head">
              <div>
                <span className="eyebrow">Observability</span>
                <h2>Recent access log</h2>
              </div>
              <span className="badge">last 10 lines</span>
            </div>
            <pre className="log-window">{state.logs.join("\n") || "No logs available."}</pre>
          </article>
        </section>
      </main>
    </div>
  );
}
