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

UI.actions.collectState = function () {
  UI.state.email = UI.qs("#email").value.trim();
  UI.state.ssl_mode = UI.qs("#ssl-mode").dataset.value || "acme";
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
  const services = [];
  UI.qsa(".service").forEach((el) => {
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
    services.push({
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
    });
  });
  UI.state.services = services;
};

UI.actions.loadRoutes = async function () {
  const res = await fetch("/api/routes");
  const data = await res.json();
  UI.state.email = data.email || "";
  UI.state.services = (data.services || []).map(UI.actions.normalizeService);
  UI.state.savedServices = JSON.parse(JSON.stringify(UI.state.services));
  UI.state.ssl_mode = data.ssl_mode || "acme";
  UI.state.listen_ips = data.listen_ips || [];
  UI.state.ports = data.ports || { http: 80, https: 443 };
  UI.state.ui = data.ui || { host: "0.0.0.0", port: 8080 };
  UI.state.stub = data.stub || { enabled: true, root: "/opt/var/www/stub" };
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
  UI.actions.renderServices();
};

UI.actions.saveRoutes = async function () {
  UI.actions.collectState();
  await UI.actions.ensureSimpleNdnsPorts();
  await fetch("/api/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(UI.state),
  });
  UI.state.savedServices = JSON.parse(JSON.stringify(UI.state.services));
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
  const res = await fetch("/api/stub/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(UI.state),
  });
  const data = await res.json();
  UI.log.appendLine(data.output || (data.ok ? "OK" : "Failed"));
  if (!data.ok) {
    UI.log.openConsole();
  }
};

UI.actions.loadHosts = async function () {
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
  if (UI.state.services && UI.state.services.length) {
    UI.actions.renderServices();
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
  const httpPort = UI.state.ndnsHttp && UI.state.ndnsHttp.port != null ? UI.state.ndnsHttp.port : "-";
  const sslPort = UI.state.ndnsHttp && UI.state.ndnsHttp.sslPort != null ? UI.state.ndnsHttp.sslPort : "-";
  summary.textContent = `HTTP: ${httpPort} | HTTPS: ${sslPort}`;

  const container = UI.qs("#ndns-cards");
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
  const res = await fetch("/api/cert/list");
  const data = await res.json();
  if (!data.ok) {
    UI.log.appendError("Load certs", data.error || "Failed to load certificates.");
    return;
  }
  UI.state.certItems = data.items || [];
  UI.actions.renderCerts();
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
  const res = await fetch(`/api/nginx/logs?type=${encodeURIComponent(type)}&filter=${encodeURIComponent(filter)}&limit=${encodeURIComponent(limit)}`);
  const data = await res.json();
  const output = UI.qs("#logs-output");
  if (!data.ok) {
    output.textContent = data.error || "Failed to load logs";
    UI.log.openConsole();
    return;
  }
  output.textContent = data.lines.join("\n");
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
  const res = await fetch(url);
  const data = await res.json();
  const body = UI.qs("#route-logs-body");
  if (!data.ok) {
    body.innerHTML = `<tr><td colspan="7">${UI.actions.escapeHtml(data.error || "Failed to load route logs")}</td></tr>`;
    UI.log.openConsole();
    return;
  }
  UI.state.routeLogItems = data.items || [];
  UI.actions.renderRouteLogs();
};

UI.actions.renderRouteLogs = function () {
  const body = UI.qs("#route-logs-body");
  const items = UI.state.routeLogItems || [];
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="7">No records</td></tr>';
    return;
  }
  body.innerHTML = items
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

UI.actions.setRouteLogsMode = function (mode) {
  UI.state.routeLogMode = mode || "all";
  const group = UI.qs("#route-logs-mode");
  group.dataset.value = UI.state.routeLogMode;
  UI.qsa("#route-logs-mode .chip-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === UI.state.routeLogMode);
  });
};

UI.actions.loadStatus = async function () {
  const res = await fetch("/api/nginx/status");
  const data = await res.json();
  if (!data.ok) {
    UI.log.appendError("Nginx status", data.error || "Failed to load status");
    return;
  }
  const s = data.status;
  const container = UI.qs("#nginx-status");
  const listeners = (s.listeners || []).slice(0, 12).join("\n") || "No listeners";
  const configs = (s.config_files || []).slice(0, 12).join("\n") || "No configs";
  const pidList = (s.pids || []).join(", ") || "-";
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
    <div class="status-item">
      <div class="status-label">Listeners</div>
      <pre class="log-panel">${listeners}</pre>
    </div>
    <div class="status-item">
      <div class="status-label">Configs</div>
      <pre class="log-panel">${configs}</pre>
    </div>
  `;
};
