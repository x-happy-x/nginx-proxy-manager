window.UI = window.UI || {};

UI.state = {
  email: "",
  services: [],
  serviceExpanded: null,
  ports: { http: 80, https: 443, http_extra: [], https_extra: [] },
  ui: { host: "0.0.0.0", port: 8080 },
  caFiles: {},
  savedServices: [],
  dnsItems: [],
  dnsExpanded: null,
  ndnsHttp: { port: null, sslPort: null },
  ndnsDomainSuffix: "",
  ndnsItems: [],
  ndnsExpanded: null,
  certItems: [],
  certExpanded: null,
  logsType: "access",
  routeLogMode: "all",
  routeLogItems: [],
  status: {}
};
UI.LOG_KEY = "consoleHeight";
UI.LOG_SCROLL_KEY = "consoleAutoScroll";
UI.TAB_KEY = "activeTab";

UI.qs = function (sel, root = document) {
  return root.querySelector(sel);
};

UI.qsa = function (sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
};

UI.parseHosts = function (value) {
  return value
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
};

UI.parsePorts = function (value) {
  return String(value || "")
    .split(",")
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => Number.isInteger(v) && v > 0 && v <= 65535);
};
