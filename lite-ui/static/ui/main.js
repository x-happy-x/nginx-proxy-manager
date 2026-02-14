window.UI = window.UI || {};

UI.main = {};

UI.main.init = function () {
  UI.qs("#add-service").addEventListener("click", () => {
    UI.state.services.push({
      hosts: [],
      san: [],
      ssl_mode: "",
      host_ssl_mode: {},
      add_to_local_dns: false,
      ws_proxy: { enabled: false, path: "/connections", rewrite_to_wss: false, rewrite_from: "" },
      ndns: { enabled: false, name: "", domain: "ndns", target: "", port: "", proto: "", security_level: "public", ssl_redirect: true, simple_mode: true },
      upstream: { address: "", port: 80, scheme: "http", verify_upstream_ssl: false },
    });
    UI.state.serviceExpanded = UI.state.services.length - 1;
    UI.actions.renderServices();
  });

  UI.qs("#save-btn").addEventListener("click", async () => {
    await UI.actions.saveRoutes();
    UI.log.append("Save config", "Saved");
  });

  UI.qs("#apply-btn").addEventListener("click", async () => {
    await UI.actions.saveRoutes();
    await UI.actions.applyRoutes();
  });

  UI.qs("#apply-stub").addEventListener("click", async () => {
    await UI.actions.applyStub();
  });

  UI.qs("#restart-ui-bind").addEventListener("click", async () => {
    await UI.actions.restartUiBind();
  });

  const stubToggle = UI.qs("#stub-enabled");
  stubToggle.addEventListener("click", (e) => {
    e.preventDefault();
    stubToggle.classList.toggle("active");
  });

  const stubUpload = UI.qs("#stub-upload");
  const stubFile = UI.qs("#stub-file");
  const stubFileName = UI.qs("#stub-file-name");
  const updateStubName = (name) => {
    stubFileName.textContent = name || "No file selected";
  };
  stubUpload.addEventListener("click", () => stubFile.click());
  stubFile.addEventListener("change", async () => {
    const file = stubFile.files[0];
    updateStubName(file ? file.name : "");
    await UI.actions.uploadStubFile(file);
  });
  ["dragenter", "dragover"].forEach((evt) => {
    stubUpload.addEventListener(evt, (e) => {
      e.preventDefault();
      stubUpload.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    stubUpload.addEventListener(evt, (e) => {
      e.preventDefault();
      stubUpload.classList.remove("dragover");
    });
  });
  stubUpload.addEventListener("drop", async (e) => {
    const file = e.dataTransfer.files[0];
    updateStubName(file ? file.name : "");
    await UI.actions.uploadStubFile(file);
  });

  const bindUpload = (rootId, inputId, nameId, key) => {
    const root = UI.qs(rootId);
    const input = UI.qs(inputId);
    const name = UI.qs(nameId);
    const updateName = (file) => {
      name.textContent = file ? file.name : "No file selected";
    };
    root.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files[0];
      UI.state.caFiles[key] = file;
      updateName(file);
    });
    ["dragenter", "dragover"].forEach((evt) => {
      root.addEventListener(evt, (e) => {
        e.preventDefault();
        root.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((evt) => {
      root.addEventListener(evt, (e) => {
        e.preventDefault();
        root.classList.remove("dragover");
      });
    });
    root.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files[0];
      UI.state.caFiles[key] = file;
      updateName(file);
    });
  };

  bindUpload("#ca-cert-upload", "#ca-cert", "#ca-cert-name", "cert");
  bindUpload("#ca-key-upload", "#ca-key", "#ca-key-name", "key");

  document.addEventListener("click", (event) => {
    if (UI.state.serviceExpanded === null) {
      return;
    }
    if (!event.target.closest(".service")) {
      const expanded = UI.qsa(".service")[UI.state.serviceExpanded];
      if (expanded) {
        UI.state.services[UI.state.serviceExpanded] = UI.actions.syncServiceFromDom(expanded);
      }
      UI.state.serviceExpanded = null;
      UI.actions.renderServices();
    }
  });

  UI.qs("#add-host").addEventListener("click", async () => {
    await UI.actions.addHost();
  });

  UI.qs("#refresh-hosts").addEventListener("click", async () => {
    await UI.actions.loadHosts();
  });

  UI.qs("#refresh-ndns").addEventListener("click", async () => {
    await UI.actions.loadNdns();
  });

  UI.qs("#add-ndns").addEventListener("click", async () => {
    await UI.actions.addNdns();
  });

  const ndnsSslRedirect = UI.qs("#ndns-ssl-redirect");
  ndnsSslRedirect.addEventListener("click", (e) => {
    e.preventDefault();
    ndnsSslRedirect.classList.toggle("active");
  });

  UI.qs("#logs-refresh").addEventListener("click", async () => {
    await UI.actions.loadLogs();
  });

  UI.qsa("#logs-type .chip-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      UI.actions.setLogsType(btn.dataset.value);
      UI.actions.loadLogs();
    });
  });

  UI.qs("#logs-filter").addEventListener("change", () => {
    UI.actions.loadLogs();
  });

  UI.qs("#logs-limit").addEventListener("change", () => {
    UI.actions.loadLogs();
  });

  UI.qs("#route-logs-refresh").addEventListener("click", async () => {
    await UI.actions.loadRouteLogs();
  });

  UI.qs("#route-logs-filter").addEventListener("change", () => {
    UI.actions.loadRouteLogs();
  });

  UI.qs("#route-logs-limit").addEventListener("change", () => {
    UI.actions.loadRouteLogs();
  });

  UI.qsa("#route-logs-mode .chip-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      UI.actions.setRouteLogsMode(btn.dataset.value);
      UI.actions.loadRouteLogs();
    });
  });

  UI.qs("#status-refresh").addEventListener("click", async () => {
    await UI.actions.loadStatus();
  });

  UI.qs("#ca-upload").addEventListener("click", async () => {
    await UI.actions.uploadCa();
  });

  UI.qs("#ca-generate").addEventListener("click", async () => {
    await UI.actions.generateCa();
  });

  UI.qs("#ca-download").addEventListener("click", async () => {
    await UI.actions.downloadCa();
  });

  UI.qs("#ca-manage").addEventListener("click", () => {
    UI.qs("#ca-dialog").classList.add("active");
  });

  UI.qs("#ca-close").addEventListener("click", () => {
    UI.qs("#ca-dialog").classList.remove("active");
  });

  UI.qs("#ca-dialog .modal-backdrop").addEventListener("click", () => {
    UI.qs("#ca-dialog").classList.remove("active");
  });

  UI.qsa(".modal-tabs .chip-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      UI.qsa(".modal-tabs .chip-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      UI.qsa(".modal-pane").forEach((pane) => {
        pane.classList.toggle("active", pane.dataset.tab === tab);
      });
    });
  });

  UI.qsa("#ssl-mode .chip-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      UI.actions.setSslMode(btn.dataset.value);
    });
  });

  UI.actions.loadRoutes().catch(() => {
    UI.log.appendError("Load routes", "Failed to load routes.");
  });

  UI.actions.loadHosts().catch(() => {
    UI.log.appendError("Load DNS hosts", "Failed to load hosts.");
  });

  UI.actions.loadNdns().catch(() => {
    UI.log.appendError("Load NDNS", "Failed to load NDNS settings.");
  });

  UI.actions.loadCerts().catch(() => {
    UI.log.appendError("Load certs", "Failed to load certificates.");
  });

  UI.actions.loadCaStatus().catch(() => {
    UI.log.appendError("Load CA status", "Failed to load CA status.");
  });

  UI.actions.setLogsType("access");
  UI.actions.setRouteLogsMode("all");
  UI.actions.loadLogs();
  UI.actions.loadRouteLogs();

  UI.actions.loadStatus();

  UI.tabs.init();
  UI.tabs.initSidebar();
  UI.theme.init();
  UI.console.init();
};

document.addEventListener("DOMContentLoaded", UI.main.init);
