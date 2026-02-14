window.UI = window.UI || {};

UI.actions = {};

UI.actions.escapeHtml = function (value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

UI.actions.cloneJson = function (value) {
  return JSON.parse(JSON.stringify(value));
};

UI.actions.equalJson = function (a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
};

UI.actions.badgeClass = function (type, value) {
  const v = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `value-chip vc-${type}-${v}`;
};

UI.actions.badge = function (type, value, text) {
  return `<span class="${UI.actions.badgeClass(type, value)}">${UI.actions.escapeHtml(text || value)}</span>`;
};

UI.actions.skeletonCards = function (count = 3) {
  return Array.from({ length: count })
    .map(
      () => `
      <div class="sk-card">
        <div class="sk-line w-60"></div>
        <div class="sk-line w-90"></div>
        <div class="sk-line w-40"></div>
      </div>`
    )
    .join("");
};

UI.actions.skeletonChips = function (count = 6) {
  return Array.from({ length: count })
    .map(() => '<span class="sk-chip"></span>')
    .join("");
};

UI.actions.skeletonTableRows = function (rows = 6, cols = 7) {
  return Array.from({ length: rows })
    .map(
      () =>
        `<tr>${Array.from({ length: cols })
          .map(() => '<td><div class="sk-line w-90"></div></td>')
          .join("")}</tr>`
    )
    .join("");
};

UI.actions.parseHostSslModes = function (value) {
  const out = {};
  String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const parts = line.split("=");
      if (parts.length !== 2) {
        return;
      }
      const host = parts[0].trim();
      const mode = parts[1].trim().toLowerCase();
      if (!host) {
        return;
      }
      if (!["acme", "local-ca", "self-signed", "off"].includes(mode)) {
        return;
      }
      out[host] = mode;
    });
  return out;
};

UI.actions.hostSslModesToText = function (map) {
  if (!map || typeof map !== "object") {
    return "";
  }
  return Object.keys(map)
    .sort()
    .map((host) => `${host}=${map[host]}`)
    .join("\n");
};

UI.actions.normalizeService = function (svc) {
  const source = svc || {};
  const upstream = source.upstream || {};
  const wsProxy = source.ws_proxy || {};
  const ndns = source.ndns || {};
  return {
    hosts: Array.isArray(source.hosts) ? source.hosts : [],
    san: Array.isArray(source.san) ? source.san : [],
    ssl_mode: source.ssl_mode || "",
    host_ssl_mode: source.host_ssl_mode || {},
    add_to_local_dns: !!source.add_to_local_dns,
    dns_hosts: Array.isArray(source.dns_hosts) ? source.dns_hosts : (Array.isArray(source.hosts) ? source.hosts : []),
    ws_proxy: {
      enabled: !!wsProxy.enabled,
      path: wsProxy.path || "/connections",
      rewrite_to_wss: !!wsProxy.rewrite_to_wss,
      rewrite_from: wsProxy.rewrite_from || "",
    },
    ndns: {
      enabled: !!ndns.enabled,
      name: ndns.name || "",
      domain: ndns.domain || "ndns",
      target: ndns.target || "",
      port: ndns.port || "",
      proto: ndns.proto || "",
      security_level: ndns.security_level || "public",
      ssl_redirect: ndns.ssl_redirect !== false,
      simple_mode: ndns.simple_mode !== false,
    },
    upstream: {
      address: upstream.address || "",
      port: upstream.port || 80,
      scheme: upstream.scheme || "http",
      verify_upstream_ssl: !!upstream.verify_upstream_ssl,
    },
  };
};

UI.actions.policyToMode = function (policy) {
  const p = String(policy || "").trim().toLowerCase();
  if (p === "off") return "off";
  if (p === "auto_acme") return "acme";
  if (p === "self_signed") return "self-signed";
  return "local-ca";
};

UI.actions.modeToPolicy = function (mode) {
  const m = String(mode || "").trim().toLowerCase();
  if (m === "off") return "off";
  if (m === "acme") return "auto_acme";
  if (m === "self-signed") return "self_signed";
  return "auto_local_ca";
};

UI.actions.isPublicHost = function (host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return false;
  return !(h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa"));
};

UI.actions.schemaToUiState = function (schema) {
  const globals = (schema && schema.globals) || {};
  const apps = Array.isArray(schema.apps) ? schema.apps : [];
  const hosts = Array.isArray(schema.hosts) ? schema.hosts : [];
  const appMap = new Map();
  apps.forEach((app) => {
    if (app && app.id) appMap.set(app.id, app);
  });
  const groups = new Map();
  hosts.forEach((hostItem) => {
    const appId = hostItem && hostItem.app_id;
    if (!appId || !appMap.has(appId)) return;
    if (!groups.has(appId)) groups.set(appId, []);
    groups.get(appId).push(hostItem);
  });
  const services = [];
  groups.forEach((hostItems, appId) => {
    const app = appMap.get(appId) || {};
    const upstream = app.upstream || {};
    const wsProxy = app.ws_proxy || {};
    const hostsList = hostItems.map((it) => it.host).filter(Boolean);
    const hostSslMode = {};
    hostItems.forEach((it) => {
      const policy = (((it || {}).tls || {}).cert_policy) || "auto_local_ca";
      hostSslMode[it.host] = UI.actions.policyToMode(policy);
    });
    const modeSet = new Set(Object.values(hostSslMode));
    const svcSslMode = modeSet.size === 1 ? Array.from(modeSet)[0] : "";
    const ndnsHost = hostItems.find((it) =>
      Array.isArray(it.endpoints) && it.endpoints.some((ep) => ((ep || {}).behavior || {}).ndns_profile || String((ep || {}).name || "").toLowerCase() === "ndns")
    );
    let ndns = { enabled: false, name: "", domain: "ndns", target: "", port: "", proto: "", security_level: "public", ssl_redirect: true, simple_mode: true };
    if (ndnsHost) {
      const ep = (ndnsHost.endpoints || []).find((x) => ((x || {}).behavior || {}).ndns_profile || String((x || {}).name || "").toLowerCase() === "ndns");
      if (ep) {
        const listen = ep.listen || {};
        const behavior = ep.behavior || {};
        ndns = {
          enabled: true,
          name: behavior.ndns_name || "",
          domain: behavior.ndns_domain || "ndns",
          target: behavior.ndns_target_ip || "",
          port: String(listen.port || ""),
          proto: listen.protocol || "http",
          security_level: behavior.ndns_security_level || "public",
          ssl_redirect: behavior.ndns_ssl_redirect !== false,
          simple_mode: false,
        };
      }
    }
    const addToLocalDns = hostItems.some((it) => {
      const publish = (((it || {}).dns || {}).publish) || [];
      return Array.isArray(publish) && publish.includes("local");
    });
    const san = (((hostItems[0] || {}).tls || {}).san) || [];
    services.push(
      UI.actions.normalizeService({
        hosts: hostsList,
        ssl_mode: svcSslMode,
        host_ssl_mode: hostSslMode,
        add_to_local_dns: addToLocalDns,
        san: Array.isArray(san) ? san : [],
        dns_hosts: hostsList,
        ws_proxy: wsProxy,
        ndns,
        upstream: {
          address: upstream.address || "",
          port: upstream.port || 80,
          scheme: upstream.scheme || "http",
          verify_upstream_ssl: !!upstream.verify_upstream_ssl,
        },
      })
    );
  });
  const ports = (globals.ports || {});
  const ui = (globals.ui || {});
  const acme = (globals.acme || {});
  return {
    schema_version: 2.1,
    globals,
    email: acme.email || "",
    ssl_mode: globals.ssl_mode || "local-ca",
    listen_ips: globals.listen_ips || [],
    ports: {
      http: ports.http || 80,
      https: ports.https || 443,
      http_extra: ports.http_extra || [],
      https_extra: ports.https_extra || [],
    },
    ui: {
      host: ui.host || "0.0.0.0",
      port: ui.port || 8080,
    },
    stub: globals.stub || { enabled: true, root: "/opt/var/www/stub" },
    services,
  };
};

UI.actions.uiStateToSchema = function () {
  const services = Array.isArray(UI.state.services) ? UI.state.services : [];
  const usedIds = new Set();
  const apps = [];
  const hosts = [];
  const makeId = (value, idx) => {
    const base = String(value || `app-${idx}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `app-${idx}`;
    let id = `app-${base}`;
    let n = 2;
    while (usedIds.has(id)) {
      id = `app-${base}-${n}`;
      n += 1;
    }
    usedIds.add(id);
    return id;
  };
  services.forEach((svc, idx) => {
    const appId = makeId((svc.hosts && svc.hosts[0]) || `app-${idx + 1}`, idx + 1);
    apps.push({
      id: appId,
      name: (svc.hosts && svc.hosts[0]) || `App ${idx + 1}`,
      upstream: {
        address: ((svc.upstream || {}).address || "").trim(),
        port: parseInt((svc.upstream || {}).port || 80, 10) || 80,
        scheme: (svc.upstream || {}).scheme || "http",
        verify_upstream_ssl: !!((svc.upstream || {}).verify_upstream_ssl),
      },
      ws_proxy: {
        enabled: !!((svc.ws_proxy || {}).enabled),
        path: (svc.ws_proxy || {}).path || "/connections",
        rewrite_to_wss: !!((svc.ws_proxy || {}).rewrite_to_wss),
        rewrite_from: (svc.ws_proxy || {}).rewrite_from || "",
      },
    });
    const hostModeMap = (svc.host_ssl_mode && typeof svc.host_ssl_mode === "object") ? svc.host_ssl_mode : {};
    const svcMode = svc.ssl_mode || UI.state.ssl_mode || "local-ca";
    (svc.hosts || []).forEach((host, hostIdx) => {
      const mode = hostModeMap[host] || svcMode;
      const policy = UI.actions.modeToPolicy(mode);
      const ndns = svc.ndns || {};
      const ndnsEnabled = !!ndns.enabled && hostIdx === 0;
      const endpoints = [
        {
          name: "web",
          listen: {
            protocol: policy === "off" ? "http" : "https",
            port: policy === "off" ? (UI.state.ports.http || 80) : (UI.state.ports.https || 443),
          },
          behavior: {
            redirect: policy === "off" ? "off" : "https",
          },
        },
      ];
      if (ndnsEnabled) {
        endpoints.push({
          name: "ndns",
          listen: {
            protocol: (ndns.proto || "http"),
            port: ndns.port || "auto_random",
          },
          behavior: {
            ndns_profile: "ndns_proxy",
            ndns_name: ndns.name || host.split(".", 1)[0],
            ndns_domain: ndns.domain || "ndns",
            ndns_security_level: ndns.security_level || "public",
            ndns_ssl_redirect: ndns.ssl_redirect !== false,
            ndns_target_ip: ndns.target || "auto",
          },
        });
      }
      const publish = [];
      if (svc.add_to_local_dns) publish.push("local");
      if (ndnsEnabled) publish.push("public");
      hosts.push({
        host,
        kind: UI.actions.isPublicHost(host) ? "public" : "private",
        app_id: appId,
        dns: { publish, local_record_ip: "auto" },
        tls: { cert_policy: policy, cert_ref: policy === "off" ? "none" : "auto", san: svc.san || [] },
        endpoints,
      });
    });
  });
  return {
    schema_version: 2.1,
    globals: {
      ssl_mode: UI.state.ssl_mode || "local-ca",
      listen_ips: UI.state.listen_ips || [],
      ports: UI.state.ports || { http: 80, https: 443, http_extra: [], https_extra: [] },
      ui: UI.state.ui || { host: "0.0.0.0", port: 8080 },
      stub: UI.state.stub || { enabled: true, root: "/opt/var/www/stub" },
      acme: { email: UI.state.email || "" },
    },
    apps,
    hosts,
    certs: [],
  };
};

UI.actions.ndnsPreviewHost = function (name) {
  const value = String(name || "").trim();
  const suffix = String(UI.state.ndnsDomainSuffix || "").trim();
  if (!value) {
    return "";
  }
  if (!suffix) {
    return value;
  }
  return `${value}.${suffix}`;
};

UI.actions.suggestNdnsPort = async function () {
  const res = await fetch("/api/ndns/port-suggest");
  const data = await res.json();
  if (!data.ok || !data.port) {
    return null;
  }
  return parseInt(data.port, 10) || null;
};

UI.actions.renderServices = function () {
  const container = UI.qs("#services");
  container.innerHTML = "";

  UI.state.services.forEach((svc, idx) => {
    const el = document.createElement("div");
    const expanded = UI.state.serviceExpanded === idx;
    const saved = UI.state.savedServices[idx] || {};
    const dirty = JSON.stringify(svc) !== JSON.stringify(saved);
    const hosts = svc.hosts.join(", ");
    const hostRows = (svc.hosts || [])
      .map(
        (host) => `
          <div class="host-row">
            <input class="host-item" type="text" value="${UI.actions.escapeHtml(host)}" />
            <button class="chip-btn host-open">Open</button>
            <button class="chip-btn host-remove">Remove</button>
          </div>
        `
      )
      .join("");
    const upstream = `${svc.upstream.scheme || "http"}://${svc.upstream.address || "-"}:${svc.upstream.port || 80}`;
    const sslMode = svc.ssl_mode || "inherit";
    const verify = svc.upstream.verify_upstream_ssl ? "active" : "";
    const localDns = svc.add_to_local_dns ? "active" : "";
    const wsProxy = svc.ws_proxy || {};
    const wsEnabled = wsProxy.enabled ? "active" : "";
    const wsRewrite = wsProxy.rewrite_to_wss ? "active" : "";
    const ndnsCfg = svc.ndns || {};
    const ndnsEnabled = ndnsCfg.enabled ? "active" : "";
    const ndnsName = UI.actions.escapeHtml(ndnsCfg.name || "");
    const ndnsDomain = UI.actions.escapeHtml(ndnsCfg.domain || "ndns");
    const ndnsTarget = UI.actions.escapeHtml(ndnsCfg.target || "");
    const ndnsPort = UI.actions.escapeHtml(ndnsCfg.port || "");
    const ndnsProto = UI.actions.escapeHtml(ndnsCfg.proto || "");
    const ndnsSecurity = UI.actions.escapeHtml(ndnsCfg.security_level || "public");
    const ndnsSslRedirect = ndnsCfg.ssl_redirect !== false;
    const ndnsSimple = ndnsCfg.simple_mode !== false;
    const ndnsSimpleClass = ndnsSimple ? "active" : "";
    const ndnsAdvancedClass = ndnsSimple ? "" : "active";
    const ndnsPreview = UI.actions.ndnsPreviewHost(ndnsCfg.name || "");
    const hostSslModesText = UI.actions.hostSslModesToText(svc.host_ssl_mode || {});
    el.className = `service ${expanded ? "expanded" : "compact"}`;
    el.innerHTML = `
      <div class="service-compact">
        <div class="service-title">${hosts || "New service"}</div>
        <div class="service-meta">${upstream} | ssl: ${sslMode}</div>
        <div class="service-flags">
          <span class="chip ${verify}">Verify SSL</span>
          <span class="chip ${localDns}">Local DNS</span>
          <span class="chip ${wsEnabled}">WS Proxy</span>
          <span class="chip ${ndnsEnabled}">NDNS</span>
          ${dirty ? '<span class="service-dirty">Modified</span>' : ""}
        </div>
      </div>
      <div class="service-details">
        <div class="row">
          <label>Hosts</label>
          <div class="hosts-list">
            ${hostRows || '<div class="host-row"><input class="host-item" type="text" value="" /><button class="chip-btn host-open">Open</button><button class="chip-btn host-remove">Remove</button></div>'}
          </div>
          <div class="chip-group">
            <button class="chip-btn host-add">Add host</button>
          </div>
        </div>
        <div class="row">
          <label>Extra SANs (comma separated)</label>
          <input class="sans" type="text" value="${(svc.san || []).join(", ")}" />
        </div>
        <div class="row cols">
          <div>
            <label>SSL Mode (service default)</label>
            <select class="svc-ssl-mode">
              <option value=""${(svc.ssl_mode || "") === "" ? " selected" : ""}>inherit global</option>
              <option value="acme"${svc.ssl_mode === "acme" ? " selected" : ""}>acme</option>
              <option value="local-ca"${svc.ssl_mode === "local-ca" ? " selected" : ""}>local-ca</option>
              <option value="self-signed"${svc.ssl_mode === "self-signed" ? " selected" : ""}>self-signed</option>
              <option value="off"${svc.ssl_mode === "off" ? " selected" : ""}>off</option>
            </select>
          </div>
          <div>
            <label>Host SSL Overrides (host=mode)</label>
            <textarea class="host-ssl-mode" rows="3" placeholder="zashboard.local=off&#10;vless.sub.local=local-ca">${UI.actions.escapeHtml(hostSslModesText)}</textarea>
          </div>
        </div>
        <div class="row cols">
          <div>
            <label>Upstream Address</label>
            <input class="address" type="text" value="${svc.upstream.address || ""}" />
          </div>
          <div>
            <label>Port</label>
            <input class="port" type="number" value="${svc.upstream.port || 80}" />
          </div>
          <div>
            <label>Scheme</label>
            <select class="scheme">
              <option value="http"${svc.upstream.scheme === "http" ? " selected" : ""}>http</option>
              <option value="https"${svc.upstream.scheme === "https" ? " selected" : ""}>https</option>
              <option value="auto"${svc.upstream.scheme === "auto" ? " selected" : ""}>auto ($scheme)</option>
            </select>
          </div>
          <div class="chip-group">
            <button class="chip-btn chip-verify ${verify}">Verify SSL</button>
            <button class="chip-btn chip-local ${localDns}">Local DNS</button>
          </div>
        </div>
        <div class="row cols">
          <div>
            <label>WebSocket Path</label>
            <input class="ws-path" type="text" value="${UI.actions.escapeHtml(wsProxy.path || "/connections")}" />
          </div>
          <div>
            <label>Rewrite From (optional)</label>
            <input class="ws-from" type="text" value="${UI.actions.escapeHtml(wsProxy.rewrite_from || "")}" placeholder="ws://192.168.1.1:9090" />
          </div>
          <div class="chip-group">
            <button class="chip-btn chip-ws-enabled ${wsEnabled}">WS Proxy</button>
            <button class="chip-btn chip-ws-rewrite ${wsRewrite}">Rewrite ws->wss</button>
          </div>
        </div>
        <div class="row">
          <label>NDNS Access</label>
          <div class="chip-group">
            <button class="chip-btn chip-ndns-enabled ${ndnsEnabled}">Enable NDNS for this service</button>
            <button class="chip-btn chip-ndns-mode-simple ${ndnsSimpleClass}">Simple</button>
            <button class="chip-btn chip-ndns-mode-advanced ${ndnsAdvancedClass}">Advanced</button>
          </div>
        </div>
        <div class="row ndns-simple ${ndnsSimple ? "" : "hidden"}">
          <div>
            <label>NDNS Name</label>
            <input class="ndns-name ndns-simple-name" type="text" value="${ndnsName}" placeholder="vpn" />
          </div>
          <div class="summary ndns-preview">${UI.actions.escapeHtml(ndnsPreview ? `${ndnsPreview}` : "Domain preview will appear here")}</div>
        </div>
        <div class="row cols service-ndns-fields ${ndnsSimple ? "hidden" : ""}">
          <div>
            <label>NDNS Name</label>
            <input class="ndns-name" type="text" value="${ndnsName}" placeholder="vpn" />
          </div>
          <div>
            <label>Domain</label>
            <input class="ndns-domain" type="text" value="${ndnsDomain}" placeholder="ndns" />
          </div>
          <div>
            <label>Target (default nginx listen IP)</label>
            <input class="ndns-target" type="text" value="${ndnsTarget}" placeholder="${UI.actions.escapeHtml((UI.state.listen_ips && UI.state.listen_ips[0]) || "")}" />
          </div>
          <div>
            <label>Port</label>
            <input class="ndns-port" type="number" value="${ndnsPort}" placeholder="${UI.actions.escapeHtml(String(svc.upstream.port || 80))}" />
          </div>
          <div>
            <label>Proto</label>
            <select class="ndns-proto">
              <option value=""${ndnsProto === "" ? " selected" : ""}>inherit upstream</option>
              <option value="http"${ndnsProto === "http" ? " selected" : ""}>http</option>
              <option value="https"${ndnsProto === "https" ? " selected" : ""}>https</option>
            </select>
          </div>
          <div>
            <label>Security</label>
            <select class="ndns-security">
              <option value="public"${ndnsSecurity === "public" ? " selected" : ""}>public</option>
              <option value="private"${ndnsSecurity === "private" ? " selected" : ""}>private</option>
              <option value=""${ndnsSecurity === "" ? " selected" : ""}>(none)</option>
            </select>
          </div>
          <div class="chip-group">
            <button class="chip-btn chip-ndns-ssl ${ndnsSslRedirect ? "active" : ""}">SSL redirect</button>
          </div>
          <div class="chip-group">
            <button class="chip-btn chip-ndns-random-port">Random Port</button>
            <button class="chip-btn chip-ndns-apply">Apply NDNS</button>
            <button class="chip-btn chip-ndns-delete">Delete NDNS</button>
          </div>
        </div>
        <div class="row actions">
          <button class="icon-btn ghost remove" title="Remove service" aria-label="Remove service">
            <img src="/static/icons/trash.svg" alt="" />
          </button>
        </div>
      </div>
    `;
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      if (UI.state.serviceExpanded !== null && UI.state.serviceExpanded !== idx) {
        const prev = UI.qsa(".service")[UI.state.serviceExpanded];
        if (prev) {
          UI.state.services[UI.state.serviceExpanded] = UI.actions.syncServiceFromDom(prev);
        }
      }
      if (UI.state.serviceExpanded !== idx) {
        UI.state.serviceExpanded = idx;
        UI.actions.renderServices();
      }
    });
    el.querySelector(".remove").addEventListener("click", (event) => {
      event.stopPropagation();
      UI.state.services.splice(idx, 1);
      UI.state.serviceExpanded = null;
      UI.actions.renderServices();
    });
    el.querySelector(".chip-verify").addEventListener("click", (event) => {
      event.stopPropagation();
      event.currentTarget.classList.toggle("active");
    });
    el.querySelector(".chip-local").addEventListener("click", (event) => {
      event.stopPropagation();
      event.currentTarget.classList.toggle("active");
    });
    el.querySelector(".chip-ws-enabled").addEventListener("click", (event) => {
      event.stopPropagation();
      event.currentTarget.classList.toggle("active");
    });
    el.querySelector(".chip-ws-rewrite").addEventListener("click", (event) => {
      event.stopPropagation();
      event.currentTarget.classList.toggle("active");
    });
    el.querySelector(".chip-ndns-enabled").addEventListener("click", (event) => {
      event.stopPropagation();
      event.currentTarget.classList.toggle("active");
    });
    const setNdnsMode = (simple) => {
      el.querySelector(".chip-ndns-mode-simple").classList.toggle("active", simple);
      el.querySelector(".chip-ndns-mode-advanced").classList.toggle("active", !simple);
      el.querySelector(".ndns-simple").classList.toggle("hidden", !simple);
      el.querySelector(".service-ndns-fields").classList.toggle("hidden", simple);
    };
    el.querySelector(".chip-ndns-mode-simple").addEventListener("click", (event) => {
      event.stopPropagation();
      setNdnsMode(true);
    });
    el.querySelector(".chip-ndns-mode-advanced").addEventListener("click", (event) => {
      event.stopPropagation();
      setNdnsMode(false);
    });
    const setNdnsName = (value) => {
      const clean = String(value || "").trim();
      const preview = UI.actions.ndnsPreviewHost(clean);
      UI.qs(".ndns-preview", el).textContent = preview || "Domain preview will appear here";
      UI.qsa(".ndns-name", el).forEach((input) => {
        if (input.value !== clean) {
          input.value = clean;
        }
      });
    };
    UI.qsa(".ndns-name", el).forEach((input) => {
      input.addEventListener("input", (event) => {
        event.stopPropagation();
        setNdnsName(event.currentTarget.value);
      });
      input.addEventListener("click", (event) => event.stopPropagation());
    });
    setNdnsName(ndnsCfg.name || "");
    el.querySelector(".chip-ndns-ssl").addEventListener("click", (event) => {
      event.stopPropagation();
      event.currentTarget.classList.toggle("active");
    });
    el.querySelector(".chip-ndns-random-port").addEventListener("click", async (event) => {
      event.stopPropagation();
      const port = await UI.actions.suggestNdnsPort();
      if (!port) {
        UI.log.appendError("NDNS", "Failed to suggest NDNS port");
        return;
      }
      UI.qs(".ndns-port", el).value = String(port);
    });
    el.querySelector(".chip-ndns-apply").addEventListener("click", async (event) => {
      event.stopPropagation();
      let snapshot = UI.actions.syncServiceFromDom(el);
      if (snapshot.ndns && snapshot.ndns.simple_mode && !String(snapshot.ndns.port || "").trim()) {
        const port = await UI.actions.suggestNdnsPort();
        if (port) {
          UI.qs(".ndns-port", el).value = String(port);
          snapshot.ndns.port = String(port);
        }
      }
      const payload = UI.actions.buildNdnsPayload(snapshot);
      if (!payload || !payload.name) {
        UI.log.appendError("NDNS", "Set NDNS name/target/port first");
        return;
      }
      const res = await fetch("/api/ndns/proxy/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: payload, old_name: "" }),
      });
      const result = await res.json();
      UI.log.appendLine(result.output || (result.ok ? "NDNS proxy saved" : "NDNS save failed"));
      if (!result.ok) {
        UI.log.openConsole();
      }
      await UI.actions.loadNdns();
    });
    el.querySelector(".chip-ndns-delete").addEventListener("click", async (event) => {
      event.stopPropagation();
      const name = UI.qs(".ndns-name", el).value.trim();
      if (!name) {
        UI.log.appendError("NDNS", "NDNS name is required for delete");
        return;
      }
      const res = await fetch("/api/ndns/proxy/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await res.json();
      UI.log.appendLine(result.output || (result.ok ? "NDNS proxy deleted" : "NDNS delete failed"));
      if (!result.ok) {
        UI.log.openConsole();
      }
      await UI.actions.loadNdns();
    });
    el.querySelectorAll(".host-open").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const row = btn.closest(".host-row");
        const host = UI.qs(".host-item", row).value.trim();
        if (!host) {
          return;
        }
        const url = `https://${host}/`;
        window.open(url, "_blank", "noopener,noreferrer");
      });
    });
    el.querySelectorAll(".host-remove").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const rows = UI.qsa(".host-row", el);
        if (rows.length <= 1) {
          UI.qs(".host-item", rows[0]).value = "";
          return;
        }
        btn.closest(".host-row").remove();
      });
    });
    el.querySelector(".host-add").addEventListener("click", (event) => {
      event.stopPropagation();
      const list = UI.qs(".hosts-list", el);
      const row = document.createElement("div");
      row.className = "host-row";
      row.innerHTML = `
        <input class="host-item" type="text" value="" />
        <button class="chip-btn host-open">Open</button>
        <button class="chip-btn host-remove">Remove</button>
      `;
      row.querySelector(".host-open").addEventListener("click", (e) => {
        e.stopPropagation();
        const host = UI.qs(".host-item", row).value.trim();
        if (host) {
          window.open(`https://${host}/`, "_blank", "noopener,noreferrer");
        }
      });
      row.querySelector(".host-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        row.remove();
      });
      list.appendChild(row);
    });
    container.appendChild(el);
  });
};

UI.actions.buildNdnsPayload = function (service) {
  const svc = UI.actions.normalizeService(service);
  const ndns = svc.ndns || {};
  const host = (svc.hosts && svc.hosts[0]) || "";
  const fallbackName = host ? host.split(".", 1)[0] : "";
  const name = (ndns.name || fallbackName || "").trim();
  const simple = ndns.simple_mode !== false;
  const target = (ndns.target || ((UI.state.listen_ips && UI.state.listen_ips[0]) || "") || svc.upstream.address || "").trim();
  const rawPort = String(ndns.port || svc.upstream.port || "").trim();
  const parsedPort = parseInt(rawPort, 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : null;
  const proto = (ndns.proto || "http").toLowerCase();
  if (!name || !target || !port) {
    return null;
  }
  return {
    name,
    upstream: {
      target,
      port: String(port),
      proto: proto === "https" ? "https" : "http",
    },
    domain: (simple ? "ndns" : (ndns.domain || "ndns")).trim(),
    securityLevel: (simple ? "public" : (ndns.security_level || "public")).trim(),
    sslRedirect: simple ? true : ndns.ssl_redirect !== false,
  };
};

UI.actions.renderAppsEditor = function () {
  const root = UI.qs("#apps-list");
  if (!root) return;
  const apps = Array.isArray(UI.state.appsV21) ? UI.state.appsV21 : [];
  root.innerHTML = "";
  const chip = (cls, value, label, active) =>
    `<button class="chip-btn ${cls} ${active ? "active" : ""}" data-value="${UI.actions.escapeHtml(value)}">${UI.actions.escapeHtml(label)}</button>`;
  apps.forEach((app, idx) => {
    const up = app.upstream || {};
    const ws = app.ws_proxy || {};
    const saved = UI.state.savedAppsV21[idx];
    const dirty = !saved || !UI.actions.equalJson(app, saved);
    const card = document.createElement("div");
    const editing = UI.state.appEditIndex === idx;
    card.className = `editor-card ${editing ? "editing" : ""} ${dirty ? "is-dirty" : ""}`;
    card.innerHTML = `
      <div class="editor-head">
        <strong>${UI.actions.escapeHtml(app.name || app.id || `App ${idx + 1}`)}</strong>
        <div class="editor-actions">
          <span class="service-dirty editor-dirty ${dirty ? "" : "hidden"}">Unsaved</span>
          <button class="icon-btn ghost app-edit" title="${editing ? "Close" : "Edit"}" aria-label="${editing ? "Close" : "Edit"}">
            <img src="/static/icons/${editing ? "close" : "console"}.svg" alt="" />
          </button>
          <button class="icon-btn ghost app-remove" title="Remove" aria-label="Remove">
            <img src="/static/icons/trash.svg" alt="" />
          </button>
        </div>
      </div>
      <div class="editor-summary">
        <div><span class="mono">${UI.actions.escapeHtml(app.id || "")}</span></div>
        <div>${UI.actions.escapeHtml((up.scheme || "http") + "://" + (up.address || "-") + ":" + String(up.port || 80))}</div>
        <div class="summary-chips">
          ${UI.actions.badge("scheme", up.scheme || "http", up.scheme || "http")}
          ${UI.actions.badge("ws", ws.enabled ? "on" : "off", `ws ${ws.enabled ? "on" : "off"}`)}
          ${UI.actions.badge("verify", up.verify_upstream_ssl ? "on" : "off", `verify ${up.verify_upstream_ssl ? "on" : "off"}`)}
        </div>
      </div>
      <div class="editor-details">
      <div class="row cols">
        <div><label>App ID</label><input class="app-id" type="text" value="${UI.actions.escapeHtml(app.id || "")}" /></div>
        <div><label>Name</label><input class="app-name" type="text" value="${UI.actions.escapeHtml(app.name || "")}" /></div>
        <div><label>Upstream Address</label><input class="app-address" type="text" value="${UI.actions.escapeHtml(up.address || "")}" /></div>
        <div><label>Upstream Port</label><input class="app-port" type="number" value="${UI.actions.escapeHtml(String(up.port || 80))}" /></div>
      </div>
      <div class="row cols">
        <div>
          <label>Scheme</label>
          <div class="chip-group app-scheme" data-value="${UI.actions.escapeHtml(up.scheme || "http")}">
            ${chip("scheme-opt", "http", "http", (up.scheme || "http") === "http")}
            ${chip("scheme-opt", "https", "https", (up.scheme || "http") === "https")}
          </div>
        </div>
        <div>
          <label>Verify Upstream SSL</label>
          <div class="chip-group app-verify" data-value="${up.verify_upstream_ssl ? "true" : "false"}">
            ${chip("verify-opt", "false", "off", !up.verify_upstream_ssl)}
            ${chip("verify-opt", "true", "on", !!up.verify_upstream_ssl)}
          </div>
        </div>
        <div>
          <label>WS Proxy</label>
          <div class="chip-group app-ws-enabled" data-value="${ws.enabled ? "true" : "false"}">
            ${chip("ws-opt", "false", "off", !ws.enabled)}
            ${chip("ws-opt", "true", "on", !!ws.enabled)}
          </div>
        </div>
        <div class="app-ws-path-wrap"><label>WS Path</label><input class="app-ws-path" type="text" value="${UI.actions.escapeHtml(ws.path || "/connections")}" /></div>
      </div>
      <div class="row cols app-ws-rewrite-wrap">
        <div class="app-ws-rewrite-toggle-wrap">
          <label>WS Rewrite To WSS</label>
          <div class="chip-group app-ws-rewrite" data-value="${ws.rewrite_to_wss ? "true" : "false"}">
            ${chip("wsrw-opt", "false", "off", !ws.rewrite_to_wss)}
            ${chip("wsrw-opt", "true", "on", !!ws.rewrite_to_wss)}
          </div>
        </div>
        <div class="app-ws-from-wrap"><label>WS Rewrite From</label><input class="app-ws-from" type="text" value="${UI.actions.escapeHtml(ws.rewrite_from || "")}" /></div>
      </div>
      <div class="row actions">
        <button class="icon-btn app-save" title="Save" aria-label="Save">
          <img src="/static/icons/save.svg" alt="" />
        </button>
        <button class="icon-btn ghost app-cancel" title="Cancel" aria-label="Cancel">
          <img src="/static/icons/close.svg" alt="" />
        </button>
      </div>
      </div>
    `;
    const bindSingleChip = (groupSel, btnSel) => {
      const group = card.querySelector(groupSel);
      card.querySelectorAll(btnSel).forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const value = btn.dataset.value;
          group.dataset.value = value;
          card.querySelectorAll(btnSel).forEach((b) => b.classList.toggle("active", b === btn));
          UI.actions.updateAppCardUi(card, idx);
        });
      });
    };
    bindSingleChip(".app-scheme", ".scheme-opt");
    bindSingleChip(".app-verify", ".verify-opt");
    bindSingleChip(".app-ws-enabled", ".ws-opt");
    bindSingleChip(".app-ws-rewrite", ".wsrw-opt");
    UI.actions.updateAppCardUi(card, idx);
    const bindDirtyInputs = () => {
      UI.qsa("input", card).forEach((el) => {
        el.addEventListener("input", () => UI.actions.updateAppCardUi(card, idx));
      });
    };
    bindDirtyInputs();
    card.querySelector(".app-edit").addEventListener("click", () => {
      UI.state.appEditIndex = editing ? null : idx;
      UI.actions.renderAppsEditor();
    });
    card.querySelector(".app-save").addEventListener("click", () => {
      UI.state.appsV21[idx] = UI.actions.readAppFromCard(card);
      UI.state.appEditIndex = null;
      UI.actions.renderAppsEditor();
      UI.actions.renderHostsEditor();
    });
    card.querySelector(".app-cancel").addEventListener("click", () => {
      UI.state.appEditIndex = null;
      UI.actions.renderAppsEditor();
    });
    card.querySelector(".app-remove").addEventListener("click", () => {
      UI.state.appsV21.splice(idx, 1);
      UI.actions.renderAppsEditor();
      UI.actions.renderHostsEditor();
    });
    root.appendChild(card);
  });
};

UI.actions.readAppFromCard = function (card) {
  return {
    id: card.querySelector(".app-id").value.trim(),
    name: card.querySelector(".app-name").value.trim(),
    upstream: {
      address: card.querySelector(".app-address").value.trim(),
      port: parseInt(card.querySelector(".app-port").value || "80", 10) || 80,
      scheme: card.querySelector(".app-scheme").dataset.value || "http",
      verify_upstream_ssl: (card.querySelector(".app-verify").dataset.value || "false") === "true",
    },
    ws_proxy: {
      enabled: (card.querySelector(".app-ws-enabled").dataset.value || "false") === "true",
      path: card.querySelector(".app-ws-path").value.trim() || "/connections",
      rewrite_to_wss: (card.querySelector(".app-ws-rewrite").dataset.value || "false") === "true",
      rewrite_from: card.querySelector(".app-ws-from").value.trim(),
    },
  };
};

UI.actions.updateAppCardUi = function (card, idx) {
  const wsEnabled = (card.querySelector(".app-ws-enabled").dataset.value || "false") === "true";
  const wsRewrite = (card.querySelector(".app-ws-rewrite").dataset.value || "false") === "true";
  const wsPathWrap = card.querySelector(".app-ws-path-wrap");
  const wsRewriteWrap = card.querySelector(".app-ws-rewrite-wrap");
  const wsFromWrap = card.querySelector(".app-ws-from-wrap");
  if (wsPathWrap) wsPathWrap.classList.toggle("hidden", !wsEnabled);
  if (wsRewriteWrap) wsRewriteWrap.classList.toggle("hidden", !wsEnabled);
  if (wsFromWrap) wsFromWrap.classList.toggle("hidden", !wsEnabled || !wsRewrite);

  const draft = UI.actions.readAppFromCard(card);
  const saved = UI.state.savedAppsV21[idx];
  const dirty = !saved || !UI.actions.equalJson(draft, saved);
  card.classList.toggle("is-dirty", dirty);
  const dirtyBadge = card.querySelector(".editor-dirty");
  if (dirtyBadge) dirtyBadge.classList.toggle("hidden", !dirty);
};

UI.actions.renderHostsEditor = function () {
  const root = UI.qs("#hosts-list");
  if (!root) return;
  const hosts = Array.isArray(UI.state.hostsV21) ? UI.state.hostsV21 : [];
  const appOptions = (UI.state.appsV21 || []).map((a) => ({ id: a.id || "", name: a.name || a.id || "" }));
  root.innerHTML = "";
  const chip = (cls, value, label, active) =>
    `<button class="chip-btn ${cls} ${active ? "active" : ""}" data-value="${UI.actions.escapeHtml(value)}">${UI.actions.escapeHtml(label)}</button>`;
  hosts.forEach((host, idx) => {
    const dns = host.dns || {};
    const tls = host.tls || {};
    const endpoints = Array.isArray(host.endpoints) ? host.endpoints : [];
    const web = endpoints.find((ep) => (ep.name || "").toLowerCase() === "web") || {};
    const webRedirect = ((web.behavior || {}).redirect || "https");
    const webScheme = ((web.listen || {}).protocol) || ((tls.cert_policy || "auto_local_ca") === "off" ? "http" : "https");
    const ndns = endpoints.find((ep) => ((ep.name || "").toLowerCase() === "ndns") || (((ep.behavior || {}).ndns_profile))) || null;
    const ndnsEnabled = !!ndns;
    const ndnsBehavior = (ndns && ndns.behavior) || {};
    const ndnsListen = (ndns && ndns.listen) || {};
    const hostName = String(host.host || "");
    const previewName = String(ndnsBehavior.ndns_name || (hostName ? hostName.split(".", 1)[0] : ""));
    const previewSuffix = UI.state.ndnsDomainSuffix || "";
    const preview = previewName ? `${previewName}${previewSuffix ? `.${previewSuffix}` : ""}` : "";
    const publish = Array.isArray(dns.publish) ? dns.publish : [];
    const localDns = publish.includes("local");
    const appButtons = appOptions
      .map(
        (opt) =>
          `<button class="chip-btn app-opt ${opt.id === host.app_id ? "active" : ""}" data-value="${UI.actions.escapeHtml(opt.id)}">${UI.actions.escapeHtml(opt.name || opt.id)}</button>`
      )
      .join("");
    const card = document.createElement("div");
    const editing = UI.state.hostEditIndex === idx;
    const saved = UI.state.savedHostsV21[idx];
    const dirty = !saved || !UI.actions.equalJson(host, saved);
    card.className = `editor-card ${editing ? "editing" : ""} ${dirty ? "is-dirty" : ""}`;
    card.innerHTML = `
      <div class="editor-head">
        <strong>${UI.actions.escapeHtml(host.host || `Host ${idx + 1}`)}</strong>
        <div class="editor-actions">
          <span class="service-dirty editor-dirty ${dirty ? "" : "hidden"}">Unsaved</span>
          <button class="icon-btn ghost host-edit" title="${editing ? "Close" : "Edit"}" aria-label="${editing ? "Close" : "Edit"}">
            <img src="/static/icons/${editing ? "close" : "console"}.svg" alt="" />
          </button>
          <button class="icon-btn ghost host-entry-remove" title="Remove" aria-label="Remove">
            <img src="/static/icons/trash.svg" alt="" />
          </button>
        </div>
      </div>
      <div class="editor-summary">
        <div>
          <a class="summary-link" href="${UI.actions.escapeHtml(`${webScheme}://${host.host || ""}/`)}" target="_blank" rel="noopener noreferrer">${UI.actions.escapeHtml(host.host || "")}</a>
          <span class="mono"> -> ${UI.actions.escapeHtml(host.app_id || "")}</span>
        </div>
        <div class="summary-chips">
          ${UI.actions.badge("kind", host.kind || "private", host.kind || "private")}
          ${UI.actions.badge("tls", tls.cert_policy || "auto_local_ca", tls.cert_policy || "auto_local_ca")}
          ${UI.actions.badge("redirect", webRedirect, `redirect ${webRedirect}`)}
          ${UI.actions.badge("ndns", ndnsEnabled ? "on" : "off", `ndns ${ndnsEnabled ? "on" : "off"}`)}
        </div>
        <div>${UI.actions.escapeHtml(preview || "ndns: off")}</div>
      </div>
      <div class="editor-details">
      <div class="row cols">
        <div><label>Host</label><input class="host-name" type="text" value="${UI.actions.escapeHtml(host.host || "")}" /></div>
        <div>
          <label>Kind</label>
          <div class="chip-group host-kind" data-value="${UI.actions.escapeHtml(host.kind || "private")}">
            ${chip("kind-opt", "private", "private", (host.kind || "private") === "private")}
            ${chip("kind-opt", "public", "public", (host.kind || "private") === "public")}
          </div>
        </div>
        <div>
          <label>App</label>
          <div class="chip-group multi host-app-id" data-value="${UI.actions.escapeHtml(host.app_id || "")}">${appButtons}</div>
        </div>
        <div>
          <label>TLS Policy</label>
          <div class="chip-group host-cert-policy" data-value="${UI.actions.escapeHtml(tls.cert_policy || "auto_local_ca")}">
            ${chip("cert-opt", "auto_local_ca", "local-ca", (tls.cert_policy || "auto_local_ca") === "auto_local_ca")}
            ${chip("cert-opt", "auto_acme", "acme", (tls.cert_policy || "") === "auto_acme")}
            ${chip("cert-opt", "self_signed", "self-signed", (tls.cert_policy || "") === "self_signed")}
            ${chip("cert-opt", "off", "off", (tls.cert_policy || "") === "off")}
          </div>
        </div>
      </div>
      <div class="row cols">
        <div>
          <label>Redirect</label>
          <div class="chip-group host-redirect" data-value="${UI.actions.escapeHtml(webRedirect)}">
            ${chip("redir-opt", "https", "https", webRedirect === "https")}
            ${chip("redir-opt", "http", "http", webRedirect === "http")}
            ${chip("redir-opt", "off", "off", webRedirect === "off")}
          </div>
        </div>
        <div>
          <label>Local DNS</label>
          <div class="chip-group host-local-dns" data-value="${localDns ? "true" : "false"}">
            ${chip("ldns-opt", "true", "on", localDns)}
            ${chip("ldns-opt", "false", "off", !localDns)}
          </div>
        </div>
        <div class="host-local-ip-wrap">
          <label>Local Record IP</label>
          <input class="host-local-record-ip" type="text" value="${UI.actions.escapeHtml(dns.local_record_ip || "auto")}" />
        </div>
        <div>
          <label>NDNS</label>
          <div class="chip-group host-ndns-enabled" data-value="${ndnsEnabled ? "true" : "false"}">
            ${chip("ndns-opt", "false", "off", !ndnsEnabled)}
            ${chip("ndns-opt", "true", "on", ndnsEnabled)}
          </div>
        </div>
        <div class="host-ndns-name-wrap"><label>NDNS Name</label><input class="host-ndns-name" type="text" value="${UI.actions.escapeHtml(previewName)}" /></div>
      </div>
      <div class="row cols host-cert-extra-row">
        <div class="host-san-wrap"><label>SAN (comma separated)</label><input class="host-san" type="text" value="${UI.actions.escapeHtml((Array.isArray(tls.san) ? tls.san : []).join(", "))}" /></div>
        <div class="host-cert-ref-wrap"><label>Cert Ref</label><input class="host-cert-ref" type="text" value="${UI.actions.escapeHtml(tls.cert_ref || ((tls.cert_policy || "") === "off" ? "none" : "auto"))}" /></div>
        <div class="host-ndns-port-wrap"><label>NDNS Port</label><input class="host-ndns-port" type="text" value="${UI.actions.escapeHtml(String(ndnsListen.port || "auto_random"))}" /></div>
        <div class="host-ndns-proto-wrap"><label>NDNS Protocol</label>
          <div class="chip-group host-ndns-proto" data-value="${UI.actions.escapeHtml(ndnsListen.protocol || "http")}">
            ${chip("nproto-opt", "http", "http", (ndnsListen.protocol || "http") === "http")}
            ${chip("nproto-opt", "https", "https", (ndnsListen.protocol || "http") === "https")}
          </div>
        </div>
      </div>
      <div class="row cols host-ndns-fields">
        <div><label>NDNS Profile</label>
          <div class="chip-group host-ndns-profile" data-value="${UI.actions.escapeHtml(ndnsBehavior.ndns_profile || "ndns_proxy")}">
            ${chip("np-opt", "direct", "direct", (ndnsBehavior.ndns_profile || "ndns_proxy") === "direct")}
            ${chip("np-opt", "ndns_proxy", "ndns_proxy", (ndnsBehavior.ndns_profile || "ndns_proxy") === "ndns_proxy")}
            ${chip("np-opt", "tunnel", "tunnel", (ndnsBehavior.ndns_profile || "ndns_proxy") === "tunnel")}
          </div>
        </div>
        <div><label>NDNS Security</label>
          <div class="chip-group host-ndns-security" data-value="${UI.actions.escapeHtml(ndnsBehavior.ndns_security_level || "public")}">
            ${chip("ns-opt", "public", "public", (ndnsBehavior.ndns_security_level || "public") === "public")}
            ${chip("ns-opt", "private", "private", (ndnsBehavior.ndns_security_level || "public") === "private")}
          </div>
        </div>
        <div><label>NDNS Target</label><input class="host-ndns-target" type="text" value="${UI.actions.escapeHtml(ndnsBehavior.ndns_target_ip || "auto")}" /></div>
      </div>
      <div class="row cols host-ndns-fields">
        <div><label>NDNS Domain</label><input class="host-ndns-domain" type="text" value="${UI.actions.escapeHtml(ndnsBehavior.ndns_domain || "ndns")}" /></div>
        <div><label>NDNS SSL Redirect</label>
          <div class="chip-group host-ndns-ssl" data-value="${ndnsBehavior.ndns_ssl_redirect === false ? "false" : "true"}">
            ${chip("nssl-opt", "true", "on", ndnsBehavior.ndns_ssl_redirect !== false)}
            ${chip("nssl-opt", "false", "off", ndnsBehavior.ndns_ssl_redirect === false)}
          </div>
        </div>
        <div class="host-preview">${UI.actions.escapeHtml(preview || "preview: -")}</div>
        <div class="chip-group">
          <button class="icon-btn ghost host-open" title="Open host" aria-label="Open host">
            <img src="/static/icons/test.svg" alt="" />
          </button>
        </div>
      </div>
      <div class="row actions">
        <button class="icon-btn host-save" title="Save" aria-label="Save">
          <img src="/static/icons/save.svg" alt="" />
        </button>
        <button class="icon-btn ghost host-cancel" title="Cancel" aria-label="Cancel">
          <img src="/static/icons/close.svg" alt="" />
        </button>
      </div>
      </div>
    `;
    const bindSingleChip = (groupSel, btnSel) => {
      const group = card.querySelector(groupSel);
      card.querySelectorAll(btnSel).forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const value = btn.dataset.value;
          group.dataset.value = value;
          card.querySelectorAll(btnSel).forEach((b) => b.classList.toggle("active", b === btn));
          UI.actions.updateHostCardUi(card, idx);
        });
      });
    };
    bindSingleChip(".host-kind", ".kind-opt");
    bindSingleChip(".host-cert-policy", ".cert-opt");
    bindSingleChip(".host-redirect", ".redir-opt");
    bindSingleChip(".host-local-dns", ".ldns-opt");
    bindSingleChip(".host-ndns-enabled", ".ndns-opt");
    bindSingleChip(".host-ndns-profile", ".np-opt");
    bindSingleChip(".host-ndns-security", ".ns-opt");
    bindSingleChip(".host-ndns-ssl", ".nssl-opt");
    bindSingleChip(".host-ndns-proto", ".nproto-opt");
    bindSingleChip(".host-app-id", ".app-opt");
    UI.actions.updateHostCardUi(card, idx);
    UI.qsa("input", card).forEach((el) => {
      el.addEventListener("input", () => UI.actions.updateHostCardUi(card, idx));
    });
    card.querySelector(".host-edit").addEventListener("click", () => {
      UI.state.hostEditIndex = editing ? null : idx;
      UI.actions.renderHostsEditor();
    });
    card.querySelector(".host-save").addEventListener("click", () => {
      UI.state.hostsV21[idx] = UI.actions.readHostFromCard(card);
      UI.state.hostEditIndex = null;
      UI.actions.renderHostsEditor();
    });
    card.querySelector(".host-cancel").addEventListener("click", () => {
      UI.state.hostEditIndex = null;
      UI.actions.renderHostsEditor();
    });
    card.querySelector(".host-entry-remove").addEventListener("click", () => {
      UI.state.hostsV21.splice(idx, 1);
      UI.actions.renderHostsEditor();
    });
    card.querySelector(".host-open").addEventListener("click", () => {
      const h = card.querySelector(".host-name").value.trim();
      if (h) window.open(`https://${h}/`, "_blank", "noopener,noreferrer");
    });
    root.appendChild(card);
  });
};

UI.actions.readHostFromCard = function (card) {
  const ndnsEnabledNow = (card.querySelector(".host-ndns-enabled").dataset.value || "false") === "true";
  const ndnsPortRaw = card.querySelector(".host-ndns-port").value.trim();
  const ndnsPort = /^\d+$/.test(ndnsPortRaw) ? parseInt(ndnsPortRaw, 10) : "auto_random";
  const certPolicy = card.querySelector(".host-cert-policy").dataset.value || "auto_local_ca";
  const endpoints = [
    {
      name: "web",
      listen: {
        protocol: certPolicy === "off" ? "http" : "https",
        port: certPolicy === "off" ? (UI.state.ports.http || 80) : (UI.state.ports.https || 443),
      },
      behavior: { redirect: card.querySelector(".host-redirect").dataset.value || "https" },
    },
  ];
  if (ndnsEnabledNow) {
    endpoints.push({
      name: "ndns",
      listen: { protocol: card.querySelector(".host-ndns-proto").dataset.value || "http", port: ndnsPort },
      behavior: {
        ndns_profile: card.querySelector(".host-ndns-profile").dataset.value || "ndns_proxy",
        ndns_name: card.querySelector(".host-ndns-name").value.trim(),
        ndns_domain: card.querySelector(".host-ndns-domain").value.trim() || "ndns",
        ndns_security_level: card.querySelector(".host-ndns-security").dataset.value || "public",
        ndns_ssl_redirect: (card.querySelector(".host-ndns-ssl").dataset.value || "true") === "true",
        ndns_target_ip: card.querySelector(".host-ndns-target").value.trim() || "auto",
      },
    });
  }
  const publish = [];
  if ((card.querySelector(".host-local-dns").dataset.value || "false") === "true") publish.push("local");
  if (ndnsEnabledNow) publish.push("public");
  const san = UI.parseHosts(card.querySelector(".host-san").value);
  const certRefInput = card.querySelector(".host-cert-ref").value.trim();
  return {
    host: card.querySelector(".host-name").value.trim(),
    kind: card.querySelector(".host-kind").dataset.value || "private",
    app_id: card.querySelector(".host-app-id").dataset.value || "",
    dns: { publish, local_record_ip: card.querySelector(".host-local-record-ip").value.trim() || "auto" },
    tls: {
      cert_policy: certPolicy,
      cert_ref: certRefInput || (certPolicy === "off" ? "none" : "auto"),
      san,
    },
    endpoints,
  };
};

UI.actions.updateHostCardUi = function (card, idx) {
  const localDns = (card.querySelector(".host-local-dns").dataset.value || "false") === "true";
  const ndnsEnabled = (card.querySelector(".host-ndns-enabled").dataset.value || "false") === "true";
  const certPolicy = card.querySelector(".host-cert-policy").dataset.value || "auto_local_ca";
  const ndnsName = card.querySelector(".host-ndns-name").value.trim();
  const suffix = (UI.state.ndnsDomainSuffix || "").trim();
  const preview = ndnsName ? `${ndnsName}${suffix ? `.${suffix}` : ""}` : "preview: -";

  card.querySelector(".host-preview").textContent = preview;
  const localIpWrap = card.querySelector(".host-local-ip-wrap");
  if (localIpWrap) localIpWrap.classList.toggle("hidden", !localDns);
  card.querySelectorAll(".host-ndns-fields").forEach((row) => row.classList.toggle("hidden", !ndnsEnabled));
  card.querySelector(".host-ndns-name-wrap").classList.toggle("hidden", !ndnsEnabled);
  card.querySelector(".host-ndns-port-wrap").classList.toggle("hidden", !ndnsEnabled);
  card.querySelector(".host-ndns-proto-wrap").classList.toggle("hidden", !ndnsEnabled);
  card.querySelector(".host-cert-ref-wrap").classList.toggle("hidden", certPolicy === "off");
  card.querySelector(".host-san-wrap").classList.toggle("hidden", certPolicy === "off");

  const draft = UI.actions.readHostFromCard(card);
  const saved = UI.state.savedHostsV21[idx];
  const dirty = !saved || !UI.actions.equalJson(draft, saved);
  card.classList.toggle("is-dirty", dirty);
  const dirtyBadge = card.querySelector(".editor-dirty");
  if (dirtyBadge) dirtyBadge.classList.toggle("hidden", !dirty);
};

UI.actions.collectEditorsV21 = function () {
  UI.qsa("#apps-list .editor-card").forEach((card, idx) => {
    if (UI.state.appsV21[idx]) {
      UI.state.appsV21[idx] = UI.actions.readAppFromCard(card);
    }
  });
  UI.qsa("#hosts-list .editor-card").forEach((card, idx) => {
    if (UI.state.hostsV21[idx]) {
      UI.state.hostsV21[idx] = UI.actions.readHostFromCard(card);
    }
  });
};

UI.actions.buildSchemaPayloadV21 = function () {
  return {
    schema_version: 2.1,
    globals: {
      ssl_mode: UI.state.ssl_mode || "local-ca",
      listen_ips: UI.state.listen_ips || [],
      ports: UI.state.ports || { http: 80, https: 443, http_extra: [], https_extra: [] },
      ui: UI.state.ui || { host: "0.0.0.0", port: 8080 },
      stub: UI.state.stub || { enabled: true, root: "/opt/var/www/stub" },
      acme: { email: UI.state.email || "" },
    },
    apps: UI.state.appsV21 || [],
    hosts: UI.state.hostsV21 || [],
    certs: [],
  };
};

UI.actions.openAddEntityDialog = function (type) {
  UI.state.addDialogType = type === "host" ? "host" : "app";
  const modal = UI.qs("#add-entity-dialog");
  if (!modal) return;
  const isApp = UI.state.addDialogType === "app";
  UI.qs("#add-entity-title").textContent = isApp ? "Add App" : "Add Host";
  UI.qs("#add-app-fields").classList.toggle("hidden", !isApp);
  UI.qs("#add-host-fields").classList.toggle("hidden", isApp);
  const kindGroup = UI.qs("#new-host-kind");
  if (kindGroup) {
    kindGroup.innerHTML = `
      <button class="chip-btn active" data-value="private">private</button>
      <button class="chip-btn" data-value="public">public</button>
    `;
    kindGroup.dataset.value = "private";
    UI.qsa(".chip-btn", kindGroup).forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        kindGroup.dataset.value = btn.dataset.value;
        UI.qsa(".chip-btn", kindGroup).forEach((b) => b.classList.toggle("active", b === btn));
      });
    });
  }
  const appSel = UI.qs("#new-host-app");
  if (appSel) {
    const apps = UI.state.appsV21 || [];
    const first = apps[0] && apps[0].id ? apps[0].id : "";
    appSel.dataset.value = first;
    appSel.innerHTML = apps
      .map(
        (a, i) =>
          `<button class="chip-btn ${i === 0 ? "active" : ""}" data-value="${UI.actions.escapeHtml(a.id || "")}">${UI.actions.escapeHtml(a.name || a.id || "")}</button>`
      )
      .join("");
    UI.qsa(".chip-btn", appSel).forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        appSel.dataset.value = btn.dataset.value || "";
        UI.qsa(".chip-btn", appSel).forEach((b) => b.classList.toggle("active", b === btn));
      });
    });
  }
  modal.classList.add("active");
};

UI.actions.closeAddEntityDialog = function () {
  const modal = UI.qs("#add-entity-dialog");
  if (modal) modal.classList.remove("active");
};

UI.actions.submitAddEntityDialog = async function () {
  const isApp = UI.state.addDialogType !== "host";
  if (isApp) {
    const idRaw = UI.qs("#new-app-id").value.trim();
    const name = UI.qs("#new-app-name").value.trim();
    const id =
      idRaw ||
      `app-${String(name || "app")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "app"}`;
    UI.state.appsV21.push({
      id,
      name: name || id,
      upstream: {
        address: UI.qs("#new-app-address").value.trim(),
        port: parseInt(UI.qs("#new-app-port").value || "80", 10) || 80,
        scheme: "http",
        verify_upstream_ssl: false,
      },
      ws_proxy: { enabled: false, path: "/connections", rewrite_to_wss: false, rewrite_from: "" },
    });
    UI.actions.renderAppsEditor();
    UI.actions.renderHostsEditor();
    UI.actions.closeAddEntityDialog();
    return;
  }
  const host = UI.qs("#new-host-name").value.trim();
  if (!host) return;
  const kind = (UI.qs("#new-host-kind").dataset.value || "private").trim();
  const appId = (UI.qs("#new-host-app").dataset.value || "").trim();
  const webPort = parseInt(UI.qs("#new-host-port").value || "443", 10) || 443;
  UI.state.hostsV21.push({
    host,
    kind,
    app_id: appId,
    dns: { publish: ["local"], local_record_ip: "auto" },
    tls: { cert_policy: "auto_local_ca", cert_ref: "auto", san: [] },
    endpoints: [{ name: "web", listen: { protocol: "https", port: webPort }, behavior: { redirect: "https" } }],
  });
  UI.actions.renderHostsEditor();
  UI.actions.closeAddEntityDialog();
};

UI.actions.collectState = function () {
  UI.state.email = UI.qs("#email").value.trim();
  UI.state.ssl_mode = UI.qs("#ssl-mode").dataset.value || "local-ca";
  UI.state.listen_ips = UI.parseHosts(UI.qs("#listen-ips").value);
  UI.state.ports = {
    http: parseInt(UI.qs("#nginx-http-port").value || "80", 10),
    https: parseInt(UI.qs("#nginx-https-port").value || "443", 10),
    http_extra: UI.parsePorts(UI.qs("#nginx-http-extra").value),
    https_extra: UI.parsePorts(UI.qs("#nginx-https-extra").value),
  };
  UI.state.ui = {
    host: UI.qs("#ui-host").value.trim() || "0.0.0.0",
    port: parseInt(UI.qs("#ui-port").value || "8080", 10),
  };
  UI.state.stub = {
    enabled: UI.qs("#stub-enabled").classList.contains("active"),
    root: (UI.state.stub && UI.state.stub.root) || "/opt/var/www/stub",
  };
  UI.actions.collectEditorsV21();
};

UI.actions.loadRoutes = async function () {
  const appsRoot = UI.qs("#apps-list");
  const hostsRoot = UI.qs("#hosts-list");
  if (appsRoot) appsRoot.innerHTML = UI.actions.skeletonCards(3);
  if (hostsRoot) hostsRoot.innerHTML = UI.actions.skeletonCards(4);
  try {
    const res = await fetch("/api/routes");
    const data = await res.json();
    if (String(data.schema_version) !== "2.1") {
      UI.log.appendError("Load routes", "Expected schema_version 2.1");
      return;
    }
    const globals = data.globals || {};
    UI.state.email = ((globals.acme || {}).email) || "";
    UI.state.ssl_mode = globals.ssl_mode || "local-ca";
    UI.state.listen_ips = globals.listen_ips || [];
    UI.state.ports = globals.ports || { http: 80, https: 443, http_extra: [], https_extra: [] };
    UI.state.ui = globals.ui || { host: "0.0.0.0", port: 8080 };
    UI.state.stub = globals.stub || { enabled: true, root: "/opt/var/www/stub" };
    UI.state.appsV21 = Array.isArray(data.apps) ? data.apps : [];
    UI.state.hostsV21 = Array.isArray(data.hosts) ? data.hosts : [];
    UI.state.savedAppsV21 = UI.actions.cloneJson(UI.state.appsV21);
    UI.state.savedHostsV21 = UI.actions.cloneJson(UI.state.hostsV21);
    UI.qs("#email").value = UI.state.email;
    UI.actions.setSslMode(UI.state.ssl_mode);
    UI.qs("#listen-ips").value = UI.state.listen_ips.join(", ");
    UI.qs("#nginx-http-port").value = UI.state.ports.http || 80;
    UI.qs("#nginx-https-port").value = UI.state.ports.https || 443;
    UI.qs("#nginx-http-extra").value = (UI.state.ports.http_extra || []).join(", ");
    UI.qs("#nginx-https-extra").value = (UI.state.ports.https_extra || []).join(", ");
    UI.qs("#ui-host").value = UI.state.ui.host || "0.0.0.0";
    UI.qs("#ui-port").value = UI.state.ui.port || 8080;
    const stubToggle = UI.qs("#stub-enabled");
    stubToggle.classList.toggle("active", UI.state.stub.enabled !== false);
    UI.actions.renderAppsEditor();
    UI.actions.renderHostsEditor();
  } catch (e) {
    UI.log.appendError("Load routes", e.message || "Failed to load routes");
  }
};

UI.actions.saveRoutes = async function () {
  UI.actions.collectState();
  const payload = UI.actions.buildSchemaPayloadV21();
  await fetch("/api/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  UI.state.savedAppsV21 = UI.actions.cloneJson(UI.state.appsV21);
  UI.state.savedHostsV21 = UI.actions.cloneJson(UI.state.hostsV21);
  UI.actions.renderAppsEditor();
  UI.actions.renderHostsEditor();
};

UI.actions.applyRoutes = async function () {
  UI.log.append("Apply config", "Applying...");
  const res = await fetch("/api/apply", { method: "POST" });
  const data = await res.json();
  UI.log.appendLine(data.output || (data.ok ? "OK" : "Failed"));
  if (!data.ok) {
    UI.log.openConsole();
  }
};

UI.actions.applyStub = async function () {
  UI.actions.collectState();
  await UI.actions.saveRoutes();
  UI.log.append("Apply stub", "Applying stub...");
  const payload = UI.actions.buildSchemaPayloadV21();
  const res = await fetch("/api/stub/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  UI.log.appendLine(data.output || (data.ok ? "OK" : "Failed"));
  if (!data.ok) {
    UI.log.openConsole();
  }
};

UI.actions.loadHosts = async function () {
  const container = UI.qs("#dns-cards");
  if (container) container.innerHTML = UI.actions.skeletonCards(3);
  try {
    const res = await fetch("/api/ip-hosts");
    const data = await res.json();
    if (!data.ok) {
      UI.log.appendError("Load DNS hosts", data.error || "Failed to load hosts.");
      return;
    }
    const grouped = {};
    data.items.forEach((item) => {
      if (!grouped[item.host]) {
        grouped[item.host] = new Set();
      }
      grouped[item.host].add(item.address);
    });
    UI.state.dnsItems = Object.keys(grouped)
      .sort()
      .map((host) => ({ host, addresses: Array.from(grouped[host]) }));
    UI.state.dnsExpanded = null;
    UI.actions.renderDns();
  } catch (e) {
    UI.log.appendError("Load DNS hosts", e.message || "Failed to load hosts.");
  }
};

UI.actions.renderDns = function () {
  const container = UI.qs("#dns-cards");
  container.innerHTML = "";
  UI.state.dnsItems.forEach((item, idx) => {
    const expanded = UI.state.dnsExpanded === idx;
    const card = document.createElement("div");
    card.className = `dns-card ${expanded ? "expanded" : "compact"}`;
    card.innerHTML = `
      <div class="dns-compact">
        <div class="dns-header">${item.host}</div>
        <div class="dns-addresses">
          ${item.addresses.map((addr) => `<span class="chip">${addr}</span>`).join("")}
        </div>
      </div>
      <div class="dns-details">
        ${item.addresses
          .map(
            (addr) => `
          <div class="dns-address-row">
            <input class="dns-address" type="text" value="${addr}" />
            <button class="icon-btn ghost dns-remove" title="Remove" aria-label="Remove">
              <img src="/static/icons/trash.svg" alt="" />
            </button>
          </div>
        `
          )
          .join("")}
        <div class="dns-address-row">
          <input class="dns-address-new" type="text" placeholder="New address" />
          <button class="icon-btn dns-add" title="Add" aria-label="Add">
            <img src="/static/icons/plus.svg" alt="" />
          </button>
        </div>
        <div class="row actions">
          <button class="chip-btn dns-save">Save</button>
          <button class="chip-btn dns-delete">Delete Host</button>
        </div>
      </div>
    `;
    card.addEventListener("click", (event) => {
      event.stopPropagation();
      if (UI.state.dnsExpanded !== idx) {
        UI.state.dnsExpanded = idx;
        UI.actions.renderDns();
      }
    });
    card.querySelectorAll(".dns-remove").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        btn.closest(".dns-address-row").remove();
      });
    });
    card.querySelector(".dns-add").addEventListener("click", (event) => {
      event.stopPropagation();
      const input = card.querySelector(".dns-address-new");
      const value = input.value.trim();
      if (!value) {
        return;
      }
      const row = document.createElement("div");
      row.className = "dns-address-row";
      row.innerHTML = `
        <input class="dns-address" type="text" value="${value}" />
        <button class="icon-btn ghost dns-remove" title="Remove" aria-label="Remove">
          <img src="/static/icons/trash.svg" alt="" />
        </button>
      `;
      row.querySelector(".dns-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        row.remove();
      });
      card.querySelector(".dns-details").insertBefore(row, card.querySelector(".dns-address-row"));
      input.value = "";
    });
    card.querySelector(".dns-save").addEventListener("click", async (event) => {
      event.stopPropagation();
      const addresses = UI.qsa(".dns-address", card).map((el) => el.value.trim()).filter(Boolean);
      if (!addresses.length) {
        return;
      }
      const host = item.host;
      await fetch("/api/ip-hosts/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, address: addresses[0] }),
      });
      for (const addr of addresses) {
        await fetch("/api/ip-hosts/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host, address: addr }),
        });
      }
      await UI.actions.loadHosts();
    });
    card.querySelector(".dns-delete").addEventListener("click", async (event) => {
      event.stopPropagation();
      await fetch("/api/ip-hosts/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: item.host, address: item.addresses[0] || "" }),
      });
      await UI.actions.loadHosts();
    });
    container.appendChild(card);
  });
};

UI.actions.loadNdns = async function () {
  const res = await fetch("/api/ndns/http");
  const data = await res.json();
  if (!data.ok) {
    UI.log.appendError("Load NDNS", data.error || "Failed to load NDNS settings.");
    return;
  }
  const payload = data.data || {};
  UI.state.ndnsHttp = payload.http || { port: null, sslPort: null };
  UI.state.ndnsDomainSuffix = payload.domainSuffix || "";
  UI.state.ndnsItems = payload.proxies || [];
  UI.state.ndnsExpanded = null;
  UI.actions.renderNdns();
  if (UI.state.hostsV21 && UI.state.hostsV21.length) {
    UI.actions.renderHostsEditor();
  }
};

UI.actions.ensureSimpleNdnsPorts = async function () {
  const reserved = new Set();
  UI.state.services.forEach((svc) => {
    const ndns = (svc && svc.ndns) || {};
    const port = parseInt(ndns.port || "", 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      reserved.add(port);
    }
  });
  for (const svc of UI.state.services) {
    const ndns = (svc && svc.ndns) || {};
    if (!ndns.enabled || ndns.simple_mode === false) {
      continue;
    }
    const current = parseInt(ndns.port || "", 10);
    if (Number.isInteger(current) && current > 0 && current <= 65535) {
      continue;
    }
    let selected = null;
    for (let i = 0; i < 20; i += 1) {
      const candidate = await UI.actions.suggestNdnsPort();
      if (candidate && !reserved.has(candidate)) {
        selected = candidate;
        break;
      }
    }
    if (!selected) {
      UI.log.appendError("NDNS", "Failed to allocate free NDNS port");
      continue;
    }
    ndns.port = String(selected);
    reserved.add(selected);
  }
};

UI.actions.renderNdns = function () {
  const summary = UI.qs("#ndns-http-summary");
  const container = UI.qs("#ndns-cards");
  if (!summary || !container) {
    return;
  }
  const httpPort = UI.state.ndnsHttp && UI.state.ndnsHttp.port != null ? UI.state.ndnsHttp.port : "-";
  const sslPort = UI.state.ndnsHttp && UI.state.ndnsHttp.sslPort != null ? UI.state.ndnsHttp.sslPort : "-";
  summary.textContent = `HTTP: ${httpPort} | HTTPS: ${sslPort}`;
  container.innerHTML = "";
  UI.state.ndnsItems.forEach((item, idx) => {
    const expanded = UI.state.ndnsExpanded === idx;
    const card = document.createElement("div");
    card.className = `dns-card ${expanded ? "expanded" : "compact"}`;
    const name = UI.actions.escapeHtml(item.name || "");
    const proto = UI.actions.escapeHtml(item.upstream && item.upstream.proto ? item.upstream.proto : "http");
    const target = UI.actions.escapeHtml(item.upstream && item.upstream.target ? item.upstream.target : "");
    const port = UI.actions.escapeHtml(item.upstream && item.upstream.port ? item.upstream.port : "");
    const domain = UI.actions.escapeHtml(item.domain || "");
    const security = UI.actions.escapeHtml(item.securityLevel || "");
    const sslRedirect = !!item.sslRedirect;
    card.innerHTML = `
      <div class="dns-compact">
        <div class="dns-header">${name || "proxy"}</div>
        <div class="dns-addresses">
          <span class="chip">${proto}://${target}:${port}</span>
          <span class="chip">${domain || "no-domain"}</span>
          <span class="chip ${sslRedirect ? "active" : ""}">ssl redirect</span>
          <span class="chip">${security || "no-security"}</span>
        </div>
      </div>
      <div class="dns-details">
        <div class="row cols ndns-fields">
          <div>
            <label>Name</label>
            <input class="ndns-name" type="text" value="${name}" />
          </div>
          <div>
            <label>Target</label>
            <input class="ndns-target" type="text" value="${target}" />
          </div>
          <div>
            <label>Port</label>
            <input class="ndns-port" type="number" value="${port}" />
          </div>
          <div>
            <label>Proto</label>
            <select class="ndns-proto">
              <option value="http"${proto === "http" ? " selected" : ""}>http</option>
              <option value="https"${proto === "https" ? " selected" : ""}>https</option>
            </select>
          </div>
          <div>
            <label>Domain</label>
            <input class="ndns-domain" type="text" value="${domain}" />
          </div>
          <div>
            <label>Security</label>
            <select class="ndns-security">
              <option value="public"${security === "public" ? " selected" : ""}>public</option>
              <option value="private"${security === "private" ? " selected" : ""}>private</option>
              <option value=""${security === "" ? " selected" : ""}>(none)</option>
            </select>
          </div>
          <div class="chip-group">
            <button class="chip-btn ndns-ssl ${sslRedirect ? "active" : ""}">SSL redirect</button>
          </div>
        </div>
        <div class="row actions">
          <button class="chip-btn ndns-save">Save</button>
          <button class="chip-btn ndns-delete">Delete</button>
        </div>
      </div>
    `;
    card.addEventListener("click", (event) => {
      event.stopPropagation();
      if (UI.state.ndnsExpanded !== idx) {
        UI.state.ndnsExpanded = idx;
        UI.actions.renderNdns();
      }
    });
    card.querySelector(".ndns-ssl").addEventListener("click", (event) => {
      event.stopPropagation();
      event.currentTarget.classList.toggle("active");
    });
    card.querySelector(".ndns-save").addEventListener("click", async (event) => {
      event.stopPropagation();
      const oldName = item.name || "";
      const payload = {
        name: UI.qs(".ndns-name", card).value.trim(),
        upstream: {
          target: UI.qs(".ndns-target", card).value.trim(),
          port: UI.qs(".ndns-port", card).value.trim(),
          proto: UI.qs(".ndns-proto", card).value,
        },
        domain: UI.qs(".ndns-domain", card).value.trim(),
        securityLevel: UI.qs(".ndns-security", card).value,
        sslRedirect: UI.qs(".ndns-ssl", card).classList.contains("active"),
      };
      const res = await fetch("/api/ndns/proxy/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: payload, old_name: oldName }),
      });
      const result = await res.json();
      UI.log.appendLine(result.output || (result.ok ? "NDNS proxy saved" : "NDNS save failed"));
      if (!result.ok) {
        UI.log.openConsole();
      }
      await UI.actions.loadNdns();
    });
    card.querySelector(".ndns-delete").addEventListener("click", async (event) => {
      event.stopPropagation();
      const res = await fetch("/api/ndns/proxy/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: item.name || "" }),
      });
      const result = await res.json();
      UI.log.appendLine(result.output || (result.ok ? "NDNS proxy deleted" : "NDNS delete failed"));
      if (!result.ok) {
        UI.log.openConsole();
      }
      await UI.actions.loadNdns();
    });
    container.appendChild(card);
  });
};

UI.actions.addNdns = async function () {
  const payload = {
    name: UI.qs("#ndns-name").value.trim(),
    upstream: {
      target: UI.qs("#ndns-target").value.trim(),
      port: UI.qs("#ndns-port").value.trim(),
      proto: UI.qs("#ndns-proto").value,
    },
    domain: UI.qs("#ndns-domain").value.trim(),
    securityLevel: UI.qs("#ndns-security").value,
    sslRedirect: UI.qs("#ndns-ssl-redirect").classList.contains("active"),
  };
  if (!payload.name) {
    return;
  }
  const res = await fetch("/api/ndns/proxy/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item: payload, old_name: "" }),
  });
  const result = await res.json();
  UI.log.appendLine(result.output || (result.ok ? "NDNS proxy added" : "NDNS add failed"));
  if (!result.ok) {
    UI.log.openConsole();
    return;
  }
  UI.qs("#ndns-name").value = "";
  UI.qs("#ndns-target").value = "";
  UI.qs("#ndns-port").value = "";
  await UI.actions.loadNdns();
};

UI.actions.addHost = async function () {
  const host = UI.qs("#host-name").value.trim();
  const address = UI.qs("#host-address").value.trim();
  if (!host || !address) {
    return;
  }
  await fetch("/api/ip-hosts/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host, address }),
  });
  UI.qs("#host-name").value = "";
  UI.qs("#host-address").value = "";
  await UI.actions.loadHosts();
};

UI.actions.readFileAsText = function (input) {
  return new Promise((resolve, reject) => {
    if (!input || !input.files || !input.files[0]) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(input.files[0]);
  });
};

UI.actions.uploadStubFile = async function (file) {
  if (!file) {
    return;
  }
  UI.log.append("Upload stub", `Uploading ${file.name}...`);
  const content = await file.text();
  const res = await fetch("/api/stub/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, content }),
  });
  const data = await res.json();
  UI.log.appendLine(data.output || (data.ok ? "OK" : "Failed"));
  if (!data.ok) {
    UI.log.openConsole();
  }
};

UI.actions.loadCaStatus = async function () {
  const res = await fetch("/api/ca/status");
  const data = await res.json();
  const el = UI.qs("#ca-status");
  const icon = UI.qs("#ca-status-icon");
  if (data.installed) {
    el.querySelector(".status-text").textContent = "CA installed";
    icon.src = "/static/icons/file.svg";
  } else {
    el.querySelector(".status-text").textContent = "CA not installed";
    icon.src = "/static/icons/file-off.svg";
  }
};

UI.actions.uploadCa = async function () {
  const certFile = UI.state.caFiles.cert || UI.qs("#ca-cert").files[0];
  const keyFile = UI.state.caFiles.key || UI.qs("#ca-key").files[0];
  const certPem = certFile ? await certFile.text() : "";
  const keyPem = keyFile ? await keyFile.text() : "";
  UI.log.append("Save CA", "Saving CA...");
  const res = await fetch("/api/ca/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cert_pem: certPem, key_pem: keyPem }),
  });
  const data = await res.json();
  UI.log.appendLine(data.output || (data.ok ? "OK" : "Failed"));
  if (!data.ok) {
    UI.log.openConsole();
  }
  await UI.actions.loadCaStatus();
};

UI.actions.generateCa = async function () {
  UI.log.append("Generate CA", "Generating CA...");
  const subject = {
    C: UI.qs("#ca-c").value.trim(),
    ST: UI.qs("#ca-st").value.trim(),
    L: UI.qs("#ca-l").value.trim(),
    O: UI.qs("#ca-o").value.trim(),
    CN: UI.qs("#ca-cn").value.trim(),
  };
  const res = await fetch("/api/ca/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject }),
  });
  const data = await res.json();
  UI.log.appendLine(data.output || (data.ok ? "OK" : "Failed"));
  if (!data.ok) {
    UI.log.openConsole();
  }
  await UI.actions.loadCaStatus();
};

UI.actions.downloadFile = async function (url, filename) {
  const res = await fetch(url);
  if (!res.ok) {
    UI.log.appendError("Download", "Download failed");
    return;
  }
  const blob = await res.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
};

UI.actions.downloadCa = async function () {
  await UI.actions.downloadFile("/api/ca/download", "local-ca.crt");
};

UI.actions.restartUiBind = async function () {
  UI.actions.collectState();
  await UI.actions.saveRoutes();
  UI.log.append("Restart UI", "Scheduling UI restart...");
  const res = await fetch("/api/ui/restart", { method: "POST" });
  const data = await res.json();
  UI.log.appendLine(data.output || (data.ok ? "UI restart scheduled" : "UI restart failed"));
  if (!data.ok) {
    UI.log.openConsole();
    return;
  }
  const host = UI.state.ui.host || "0.0.0.0";
  const port = UI.state.ui.port || 8080;
  UI.log.appendLine(`Reconnect to: http://${host}:${port}`);
};

UI.actions.loadCerts = async function () {
  const container = UI.qs("#cert-cards");
  if (container) container.innerHTML = UI.actions.skeletonCards(3);
  try {
    const res = await fetch("/api/cert/list");
    const data = await res.json();
    if (!data.ok) {
      UI.log.appendError("Load certs", data.error || "Failed to load certificates.");
      return;
    }
    UI.state.certItems = data.items || [];
    UI.actions.renderCerts();
  } catch (e) {
    UI.log.appendError("Load certs", e.message || "Failed to load certificates.");
  }
};

UI.actions.renderCerts = function () {
  const container = UI.qs("#cert-cards");
  container.innerHTML = "";
  UI.state.certItems.forEach((item, idx) => {
    const expanded = UI.state.certExpanded === idx;
    const card = document.createElement("div");
    card.className = `dns-card cert-card ${expanded ? "expanded" : "compact"}`;
    card.innerHTML = `
      <div class="dns-compact">
        <div class="dns-header">${item.host}</div>
        <div class="dns-addresses">
          <span class="chip">CRT</span>
          <span class="chip ${item.has_key ? "active" : ""}">${item.has_key ? "KEY" : "No KEY"}</span>
        </div>
      </div>
      <div class="dns-details">
        <div class="summary">Path: ${item.path}</div>
        <div class="row actions">
          <button class="icon-btn cert-test" title="Test" aria-label="Test">
            <img src="/static/icons/test.svg" alt="" />
          </button>
          <button class="icon-btn cert-download" title="Download CRT" aria-label="Download CRT">
            <img src="/static/icons/download.svg" alt="" />
          </button>
          <button class="icon-btn cert-key" title="Download KEY" aria-label="Download KEY">
            <img src="/static/icons/key.svg" alt="" />
          </button>
          <button class="icon-btn ghost cert-delete" title="Delete" aria-label="Delete">
            <img src="/static/icons/trash.svg" alt="" />
          </button>
        </div>
      </div>
    `;
    card.addEventListener("click", (event) => {
      event.stopPropagation();
      UI.state.certExpanded = idx;
      UI.actions.renderCerts();
    });
    card.querySelector(".cert-download").addEventListener("click", async (event) => {
      event.stopPropagation();
      await UI.actions.downloadFile(`/api/cert/download?host=${encodeURIComponent(item.host)}&kind=crt`, `${item.host}.crt`);
    });
    card.querySelector(".cert-key").addEventListener("click", async (event) => {
      event.stopPropagation();
      await UI.actions.downloadFile(`/api/cert/download?host=${encodeURIComponent(item.host)}&kind=key`, `${item.host}.key`);
    });
    card.querySelector(".cert-test").addEventListener("click", async (event) => {
      event.stopPropagation();
      await UI.actions.testCert(item.host, 443);
    });
    card.querySelector(".cert-delete").addEventListener("click", async (event) => {
      event.stopPropagation();
      await fetch("/api/cert/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: item.host }),
      });
      await UI.actions.loadCerts();
    });
    container.appendChild(card);
  });
};

UI.actions.testCert = async function (host, port = 443) {
  if (!host) {
    return;
  }
  UI.log.append(`Test cert ${host}:${port}`, "Testing certificate...");
  const res = await fetch("/api/cert/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host, port }),
  });
  const data = await res.json();
  UI.log.appendLine(data.output || (data.ok ? "OK" : "Failed"));
  if (!data.ok) {
    UI.log.openConsole();
  }
};

UI.actions.syncServiceFromDom = function (el) {
  const hosts = UI.qsa(".host-item", el).map((node) => node.value.trim()).filter(Boolean);
  const san = UI.parseHosts(UI.qs(".sans", el).value);
  const address = UI.qs(".address", el).value.trim();
  const port = parseInt(UI.qs(".port", el).value || "80", 10);
  const scheme = UI.qs(".scheme", el).value;
  const svcSslMode = UI.qs(".svc-ssl-mode", el).value || "";
  const hostSslMode = UI.actions.parseHostSslModes(UI.qs(".host-ssl-mode", el).value);
  const verify = UI.qs(".chip-verify", el).classList.contains("active");
  const addToLocalDns = UI.qs(".chip-local", el).classList.contains("active");
  const wsEnabled = UI.qs(".chip-ws-enabled", el).classList.contains("active");
  const wsRewrite = UI.qs(".chip-ws-rewrite", el).classList.contains("active");
  const wsPath = UI.qs(".ws-path", el).value.trim() || "/connections";
  const wsFrom = UI.qs(".ws-from", el).value.trim();
  const ndnsEnabled = UI.qs(".chip-ndns-enabled", el).classList.contains("active");
  const ndnsSimple = UI.qs(".chip-ndns-mode-simple", el).classList.contains("active");
  const ndnsSsl = UI.qs(".chip-ndns-ssl", el).classList.contains("active");
  return {
    hosts,
    ssl_mode: svcSslMode,
    host_ssl_mode: hostSslMode,
    add_to_local_dns: addToLocalDns,
    san,
    dns_hosts: hosts,
    ws_proxy: {
      enabled: wsEnabled,
      path: wsPath,
      rewrite_to_wss: wsRewrite,
      rewrite_from: wsFrom,
    },
    ndns: {
      enabled: ndnsEnabled,
      name: UI.qs(".ndns-name", el).value.trim(),
      domain: UI.qs(".ndns-domain", el).value.trim(),
      target: UI.qs(".ndns-target", el).value.trim(),
      port: UI.qs(".ndns-port", el).value.trim(),
      proto: UI.qs(".ndns-proto", el).value,
      security_level: UI.qs(".ndns-security", el).value,
      ssl_redirect: ndnsSsl,
      simple_mode: ndnsSimple,
    },
    upstream: {
      address,
      port,
      scheme,
      verify_upstream_ssl: verify,
    },
  };
};

UI.actions.setSslMode = function (mode) {
  const group = UI.qs("#ssl-mode");
  group.dataset.value = mode;
  UI.qsa("#ssl-mode .chip-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === mode);
  });
  UI.qs("#acme-email").style.display = mode === "acme" ? "block" : "none";
  UI.qs("#local-ca-summary").style.display = mode === "local-ca" ? "block" : "none";
};

UI.actions.setLogsType = function (type) {
  const group = UI.qs("#logs-type");
  group.dataset.value = type;
  UI.qsa("#logs-type .chip-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === type);
  });
};

UI.actions.loadLogs = async function () {
  const type = UI.qs("#logs-type").dataset.value || "access";
  const filter = UI.qs("#logs-filter").value.trim();
  const limit = UI.qs("#logs-limit").value || "200";
  const output = UI.qs("#logs-output");
  output.innerHTML = `<div class="sk-card"><div class="sk-line w-90"></div><div class="sk-line w-80"></div><div class="sk-line w-70"></div></div>`;
  try {
    const res = await fetch(`/api/nginx/logs?type=${encodeURIComponent(type)}&filter=${encodeURIComponent(filter)}&limit=${encodeURIComponent(limit)}`);
    const data = await res.json();
    if (!data.ok) {
      output.textContent = data.error || "Failed to load logs";
      UI.log.openConsole();
      return;
    }
    output.textContent = data.lines.join("\n");
  } catch (e) {
    output.textContent = e.message || "Failed to load logs";
  }
};

UI.actions.loadRouteLogs = async function () {
  const filter = UI.qs("#route-logs-filter").value.trim();
  const limit = UI.qs("#route-logs-limit").value || "200";
  const mode = UI.state.routeLogMode || "all";
  let url = `/api/nginx/route-logs?filter=${encodeURIComponent(filter)}&limit=${encodeURIComponent(limit)}`;
  if (mode === "4xx" || mode === "5xx") {
    url += `&status_group=${encodeURIComponent(mode)}`;
  } else if (mode === "errors") {
    url = `/api/nginx/route-logs/errors?filter=${encodeURIComponent(filter)}&limit=${encodeURIComponent(limit)}`;
  }
  const body = UI.qs("#route-logs-body");
  body.innerHTML = UI.actions.skeletonTableRows(5, 7);
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) {
      body.innerHTML = `<tr><td colspan="7">${UI.actions.escapeHtml(data.error || "Failed to load route logs")}</td></tr>`;
      UI.log.openConsole();
      return;
    }
    UI.state.routeLogItems = data.items || [];
    UI.state.routeFilters.host = UI.qs("#route-filter-host")?.value.trim() || "";
    UI.state.routeFilters.targetIp = UI.qs("#route-filter-target-ip")?.value.trim() || "";
    UI.state.routeFilters.listenEndpoint = UI.qs("#route-filter-listen-endpoint")?.value.trim() || "";
    UI.actions.renderRouteLogs();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7">${UI.actions.escapeHtml(e.message || "Failed to load route logs")}</td></tr>`;
  }
};

UI.actions.extractTargetIp = function (item) {
  const raw = String(item.upstream_addr || item.proxy_host || "").trim();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const idx = raw.indexOf("]");
    return idx > 0 ? raw.slice(1, idx) : raw;
  }
  const pos = raw.lastIndexOf(":");
  if (pos > 0) return raw.slice(0, pos);
  return raw;
};

UI.actions.extractListenEndpoint = function (item) {
  const addr = String(item.server_addr || "").trim();
  const port = String(item.server_port || "").trim();
  if (addr && port) return `${addr}:${port}`;
  return addr || "";
};

UI.actions.renderRouteLogs = function () {
  const body = UI.qs("#route-logs-body");
  const items = UI.state.routeLogItems || [];
  const fHost = String((UI.state.routeFilters || {}).host || "").toLowerCase();
  const fTarget = String((UI.state.routeFilters || {}).targetIp || "").toLowerCase();
  const fListen = String((UI.state.routeFilters || {}).listenEndpoint || "").toLowerCase();
  const filtered = items.filter((it) => {
    if (fHost && !String(it.host || "").toLowerCase().includes(fHost)) return false;
    const targetIp = UI.actions.extractTargetIp(it).toLowerCase();
    if (fTarget && !targetIp.includes(fTarget)) return false;
    const listen = UI.actions.extractListenEndpoint(it).toLowerCase();
    if (fListen && !listen.includes(fListen)) return false;
    return true;
  });
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="7">No records</td></tr>';
    return;
  }
  body.innerHTML = filtered
    .map((it) => {
      const status = parseInt(it.status || "0", 10);
      const statusClass = status >= 500 ? "st-5xx" : status >= 400 ? "st-4xx" : "st-ok";
      const requestTimeMs = Math.round((parseFloat(it.request_time || "0") || 0) * 1000);
      return `<tr>
        <td>${UI.actions.escapeHtml(it.time || "")}</td>
        <td>${UI.actions.escapeHtml(it.host || "")}</td>
        <td><span class="route-status ${statusClass}">${UI.actions.escapeHtml(it.status || "")}</span></td>
        <td>${UI.actions.escapeHtml(it.method || "")}</td>
        <td class="mono">${UI.actions.escapeHtml(it.uri || "")}</td>
        <td class="mono">${UI.actions.escapeHtml(it.upstream_addr || it.proxy_host || "")}</td>
        <td>${requestTimeMs}</td>
      </tr>`;
    })
    .join("");
};

UI.actions.toggleRouteFilter = function (key) {
  UI.state.routeFilterOpen[key] = !UI.state.routeFilterOpen[key];
  UI.actions.renderRouteFilterToggles();
};

UI.actions.renderRouteFilterToggles = function () {
  const map = {
    host: { btn: '#route-filters-toggle [data-filter-key="host"]', wrap: "#route-filter-host-wrap" },
    targetIp: { btn: '#route-filters-toggle [data-filter-key="targetIp"]', wrap: "#route-filter-target-wrap" },
    listenEndpoint: { btn: '#route-filters-toggle [data-filter-key="listenEndpoint"]', wrap: "#route-filter-listen-wrap" },
  };
  Object.keys(map).forEach((key) => {
    const open = !!UI.state.routeFilterOpen[key];
    const btn = UI.qs(map[key].btn);
    const wrap = UI.qs(map[key].wrap);
    if (btn) btn.classList.toggle("active", open);
    if (wrap) wrap.classList.toggle("open", open);
  });
};

UI.actions.setRouteLogsMode = function (mode) {
  UI.state.routeLogMode = mode || "all";
  const group = UI.qs("#route-logs-mode");
  group.dataset.value = UI.state.routeLogMode;
  UI.qsa("#route-logs-mode .chip-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === UI.state.routeLogMode);
  });
};

UI.actions.loadStatus = async function () {
  const container = UI.qs("#nginx-status");
  const listenRoot = UI.qs("#nginx-listen-cards");
  if (container) container.innerHTML = UI.actions.skeletonCards(4);
  if (listenRoot) listenRoot.innerHTML = UI.actions.skeletonChips(8);
  try {
    const res = await fetch("/api/nginx/status");
    const data = await res.json();
    if (!data.ok) {
      UI.log.appendError("Nginx status", data.error || "Failed to load status");
      return;
    }
    const s = data.status;
  const pidList = (s.pids || []).join(", ") || "-";
  const parsed = Array.isArray(s.parsed_listeners) ? s.parsed_listeners : [];
  const compactListen = [];
  const seen = new Set();
  parsed.forEach((it) => {
    const key = `${it.scheme || "http"}|${it.ip || "*"}|${it.port || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    compactListen.push(it);
  });
  container.innerHTML = `
    <div class="status-item">
      <div class="status-label">Running</div>
      <div class="status-value">${s.running ? "yes" : "no"}</div>
    </div>
    <div class="status-item">
      <div class="status-label">PID(s)</div>
      <div class="status-value">${pidList}</div>
    </div>
    <div class="status-item">
      <div class="status-label">Version</div>
      <div class="status-value">${s.version || "-"}</div>
    </div>
    <div class="status-item">
      <div class="status-label">RSS (KB)</div>
      <div class="status-value">${s.rss_kb || 0}</div>
    </div>
  `;
  if (listenRoot) {
    if (!compactListen.length) {
      listenRoot.innerHTML = '<span class="value-chip vc-kind-private">No parsed listen entries</span>';
    } else {
      listenRoot.innerHTML = compactListen
        .map((it) => {
          const label = `${it.scheme || "http"}://${it.ip || "*"}:${it.port || "-"}`;
          const cls = (it.scheme || "http") === "https" ? "vc-scheme-https" : "vc-scheme-http";
          return `<span class="value-chip ${cls}" title="${UI.actions.escapeHtml(it.source || "")}">${UI.actions.escapeHtml(label)}</span>`;
        })
        .join("");
    }
  }
  } catch (e) {
    UI.log.appendError("Nginx status", e.message || "Failed to load status");
  }
};

UI.actions.loadOverviewConfigs = async function () {
  const root = UI.qs("#overview-configs");
  if (root) root.innerHTML = UI.actions.skeletonCards(4);
  try {
    const res = await fetch("/api/nginx/configs");
    const data = await res.json();
    if (!data.ok) {
      UI.log.appendError("Configs", data.error || "Failed to load configs");
      return;
    }
    UI.state.overviewConfigs = Array.isArray(data.items) ? data.items : [];
    UI.actions.renderOverviewConfigs();
  } catch (e) {
    UI.log.appendError("Configs", e.message || "Failed to load configs");
  }
};

UI.actions.loadRouteFiles = async function () {
  const select = UI.qs("#routes-file-select");
  const activeEl = UI.qs("#routes-file-active");
  if (select) select.innerHTML = '<option>Loading...</option>';
  if (activeEl) activeEl.textContent = "Active: loading...";
  try {
    const res = await fetch("/api/routes/files");
    const data = await res.json();
    if (!data.ok) {
      UI.log.appendError("Routes files", data.error || "Failed to load routes files");
      return;
    }
  if (!select || !activeEl) return;
  const items = Array.isArray(data.items) ? data.items : [];
  select.innerHTML = items.map((p) => `<option value="${UI.actions.escapeHtml(p)}">${UI.actions.escapeHtml(p)}</option>`).join("");
  if (data.active) select.value = data.active;
  activeEl.textContent = `Active: ${data.active || "-"}`;
  } catch (e) {
    UI.log.appendError("Routes files", e.message || "Failed to load routes files");
  }
};

UI.actions.selectRouteFile = async function () {
  const select = UI.qs("#routes-file-select");
  if (!select) return;
  const path = select.value;
  if (!path) return;
  const res = await fetch("/api/routes/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = await res.json();
  if (!data.ok) {
    UI.log.appendError("Routes file", data.error || "Failed to select routes file");
    return;
  }
  UI.log.append("Routes file", `Active file: ${data.path}`);
  await UI.actions.loadRouteFiles();
  await UI.actions.loadRoutes();
  await UI.actions.loadOverviewConfigs();
};

UI.actions.backupRouteFile = async function () {
  const res = await fetch("/api/routes/backup", { method: "POST" });
  const data = await res.json();
  if (!data.ok) {
    UI.log.appendError("Routes backup", data.output || data.error || "Backup failed");
    return;
  }
  UI.log.append("Routes backup", data.path || data.output || "backup created");
  await UI.actions.loadRouteFiles();
};

UI.actions.renderOverviewConfigs = function () {
  const root = UI.qs("#overview-configs");
  if (!root) return;
  const items = UI.state.overviewConfigs || [];
  root.innerHTML = "";
  items.forEach((cfg) => {
    const card = document.createElement("div");
    card.className = "editor-card";
    const listens = Array.isArray(cfg.listens) ? cfg.listens : [];
    const listenPreview = listens.slice(0, 4).map((it) => `${it.ip || "*"}:${it.port}`).join(" | ");
    card.innerHTML = `
      <div class="editor-head">
        <strong>${UI.actions.escapeHtml(cfg.title || cfg.id || "Config")}</strong>
        <div class="editor-actions">
          <button class="icon-btn ghost cfg-open" title="Open config" aria-label="Open config">
            <img src="/static/icons/file.svg" alt="" />
          </button>
          <button class="icon-btn ghost cfg-edit ${cfg.editable === false ? "hidden" : ""}" title="Edit config" aria-label="Edit config">
            <img src="/static/icons/key.svg" alt="" />
          </button>
        </div>
      </div>
      <div class="editor-summary">
        <div class="mono">${UI.actions.escapeHtml(cfg.path || "")}</div>
        <div class="summary-chips">
          ${UI.actions.badge("kind", cfg.type || "file", cfg.type || "file")}
          ${UI.actions.badge("verify", cfg.exists ? "on" : "off", cfg.exists ? "exists" : "missing")}
          ${UI.actions.badge("redirect", "size", `${cfg.size || 0} B`)}
        </div>
        <div>${UI.actions.escapeHtml(listenPreview || "no listen directives")}</div>
      </div>
    `;
    card.querySelector(".cfg-open").addEventListener("click", () => {
      UI.actions.openConfigEditor(cfg.id, false);
    });
    const editBtn = card.querySelector(".cfg-edit");
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        UI.actions.openConfigEditor(cfg.id, true);
      });
    }
    root.appendChild(card);
  });
};

UI.actions.openConfigEditor = async function (id, editable) {
  const res = await fetch(`/api/nginx/config/read?id=${encodeURIComponent(id)}`);
  const data = await res.json();
  if (!data.ok) {
    UI.log.appendError("Config open", data.error || "Failed to read config");
    return;
  }
  UI.state.currentConfigId = id;
  UI.qs("#config-editor-title").textContent = `${data.item.title} (${editable ? "edit" : "read"})`;
  UI.qs("#config-editor-path").textContent = data.item.path || "";
  const textarea = UI.qs("#config-editor-content");
  textarea.value = data.content || "";
  textarea.readOnly = !editable;
  UI.qs("#config-editor-save").classList.toggle("hidden", !editable);
  UI.qs("#config-editor-dialog").classList.add("active");
};

UI.actions.closeConfigEditor = function () {
  UI.qs("#config-editor-dialog").classList.remove("active");
  UI.state.currentConfigId = "";
};

UI.actions.saveConfigEditor = async function () {
  const configId = UI.state.currentConfigId;
  if (!configId) return;
  const content = UI.qs("#config-editor-content").value;
  const res = await fetch("/api/nginx/config/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: configId, content }),
  });
  const data = await res.json();
  if (!data.ok) {
    UI.log.appendError("Config save", data.error || "Save failed");
    return;
  }
  UI.log.append("Config save", data.output || "saved");
  await UI.actions.loadOverviewConfigs();
};
