window.UI = window.UI || {};

UI.actions = {};

UI.actions.renderServices = function () {
  const container = UI.qs("#services");
  container.innerHTML = "";

  UI.state.services.forEach((svc, idx) => {
    const el = document.createElement("div");
    const expanded = UI.state.serviceExpanded === idx;
    const saved = UI.state.savedServices[idx] || {};
    const dirty = JSON.stringify(svc) !== JSON.stringify(saved);
    const hosts = svc.hosts.join(", ");
    const upstream = `${svc.upstream.scheme || "http"}://${svc.upstream.address || "-"}:${svc.upstream.port || 80}`;
    const verify = svc.upstream.verify_upstream_ssl ? "active" : "";
    const localDns = svc.add_to_local_dns ? "active" : "";
    el.className = `service ${expanded ? "expanded" : "compact"}`;
    el.innerHTML = `
      <div class="service-compact">
        <div class="service-title">${hosts || "New service"}</div>
        <div class="service-meta">${upstream}</div>
        <div class="service-flags">
          <span class="chip ${verify}">Verify SSL</span>
          <span class="chip ${localDns}">Local DNS</span>
          ${dirty ? '<span class="service-dirty">Modified</span>' : ""}
        </div>
      </div>
      <div class="service-details">
        <div class="row">
          <label>Hosts (comma separated)</label>
          <input class="hosts" type="text" value="${hosts}" />
        </div>
        <div class="row">
          <label>Extra SANs (comma separated)</label>
          <input class="sans" type="text" value="${(svc.san || []).join(", ")}" />
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
            </select>
          </div>
          <div class="chip-group">
            <button class="chip-btn chip-verify ${verify}">Verify SSL</button>
            <button class="chip-btn chip-local ${localDns}">Local DNS</button>
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
    container.appendChild(el);
  });
};

UI.actions.collectState = function () {
  UI.state.email = UI.qs("#email").value.trim();
  UI.state.ssl_mode = UI.qs("#ssl-mode").dataset.value || "acme";
  UI.state.listen_ips = UI.parseHosts(UI.qs("#listen-ips").value);
  UI.state.stub = {
    enabled: UI.qs("#stub-enabled").classList.contains("active"),
    root: (UI.state.stub && UI.state.stub.root) || "/opt/var/www/stub",
  };
  const services = [];
  UI.qsa(".service").forEach((el) => {
    const hosts = UI.parseHosts(UI.qs(".hosts", el).value);
    const san = UI.parseHosts(UI.qs(".sans", el).value);
    const address = UI.qs(".address", el).value.trim();
    const port = parseInt(UI.qs(".port", el).value || "80", 10);
    const scheme = UI.qs(".scheme", el).value;
    const verify = UI.qs(".chip-verify", el).classList.contains("active");
    const addToLocalDns = UI.qs(".chip-local", el).classList.contains("active");
    services.push({
      hosts,
      add_to_local_dns: addToLocalDns,
      san,
      dns_hosts: hosts,
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
  UI.state.services = data.services || [];
  UI.state.savedServices = JSON.parse(JSON.stringify(UI.state.services));
  UI.state.ssl_mode = data.ssl_mode || "acme";
  UI.state.listen_ips = data.listen_ips || [];
  UI.state.stub = data.stub || { enabled: true, root: "/opt/var/www/stub" };
  UI.qs("#email").value = UI.state.email;
  UI.actions.setSslMode(UI.state.ssl_mode);
  UI.qs("#listen-ips").value = UI.state.listen_ips.join(", ");
  const stubToggle = UI.qs("#stub-enabled");
  stubToggle.classList.toggle("active", UI.state.stub.enabled !== false);
  UI.actions.renderServices();
};

UI.actions.saveRoutes = async function () {
  UI.actions.collectState();
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
  const hosts = UI.parseHosts(UI.qs(".hosts", el).value);
  const san = UI.parseHosts(UI.qs(".sans", el).value);
  const address = UI.qs(".address", el).value.trim();
  const port = parseInt(UI.qs(".port", el).value || "80", 10);
  const scheme = UI.qs(".scheme", el).value;
  const verify = UI.qs(".chip-verify", el).classList.contains("active");
  const addToLocalDns = UI.qs(".chip-local", el).classList.contains("active");
  return {
    hosts,
    add_to_local_dns: addToLocalDns,
    san,
    dns_hosts: hosts,
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
