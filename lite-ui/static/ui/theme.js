window.UI = window.UI || {};

UI.theme = {};

UI.theme.set = function (theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
};

UI.theme.init = function () {
  const saved = localStorage.getItem("theme") || "light";
  UI.theme.set(saved);
  const toggle = UI.qs("#theme-toggle");
  toggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    UI.theme.set(next);
  });
};
