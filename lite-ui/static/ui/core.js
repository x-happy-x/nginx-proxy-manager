window.UI = window.UI || {};

UI.state = {
  email: "",
  services: [],
  serviceExpanded: null,
  caFiles: {},
  savedServices: [],
  dnsItems: [],
  dnsExpanded: null,
  certItems: [],
  certExpanded: null,
  logsType: "access",
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
