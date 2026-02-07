window.UI = window.UI || {};

UI.tabs = {};

UI.tabs.setActive = function (tab) {
  UI.qsa(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  UI.qsa(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tab === tab);
  });
  localStorage.setItem(UI.TAB_KEY, tab);
};

UI.tabs.init = function () {
  const saved = localStorage.getItem(UI.TAB_KEY) || "servers";
  UI.tabs.setActive(saved);
  UI.qsa(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => UI.tabs.setActive(btn.dataset.tab));
  });
};

UI.tabs.initSidebar = function () {
  const saved = localStorage.getItem("sidebarCollapsed") === "1";
  document.body.classList.toggle("sidebar-collapsed", saved);
  UI.qs("#sidebar-toggle").addEventListener("click", () => {
    const next = !document.body.classList.contains("sidebar-collapsed");
    document.body.classList.toggle("sidebar-collapsed", next);
    localStorage.setItem("sidebarCollapsed", next ? "1" : "0");
  });
};
