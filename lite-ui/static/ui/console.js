window.UI = window.UI || {};

UI.console = {};

UI.console.setAutoScroll = function (enabled) {
  UI.log.autoScroll = enabled;
  localStorage.setItem(UI.LOG_SCROLL_KEY, enabled ? "1" : "0");
  const btn = UI.qs("#console-pause");
  btn.dataset.paused = enabled ? "0" : "1";
  const img = btn.querySelector("img");
  img.src = enabled ? "/static/icons/pause.svg" : "/static/icons/play.svg";
  btn.title = enabled ? "Pause autoscroll" : "Resume autoscroll";
  btn.setAttribute("aria-label", btn.title);
};

UI.console.init = function () {
  const consoleEl = UI.qs("#console");
  const resizer = UI.qs("#console-resizer");
  const saved = parseInt(localStorage.getItem(UI.LOG_KEY) || "240", 10);
  consoleEl.style.height = `${saved}px`;
  const autoScrollSaved = localStorage.getItem(UI.LOG_SCROLL_KEY);
  UI.console.setAutoScroll(autoScrollSaved !== "0");

  const open = () => document.body.classList.add("console-open");
  const close = () => document.body.classList.remove("console-open");
  const toggle = () => {
    if (document.body.classList.contains("console-open")) {
      close();
    } else {
      open();
    }
  };
  UI.qs("#console-toggle").addEventListener("click", toggle);
  UI.qs("#console-close").addEventListener("click", close);

  UI.qs("#console-clear").addEventListener("click", () => {
    UI.log.clear();
  });

  UI.qs("#console-pause").addEventListener("click", () => {
    UI.console.setAutoScroll(!UI.log.autoScroll);
  });

  let startY = 0;
  let startHeight = 0;
  const onMove = (e) => {
    const dy = startY - e.clientY;
    const next = Math.min(Math.max(160, startHeight + dy), window.innerHeight * 0.7);
    consoleEl.style.height = `${next}px`;
  };
  const onUp = () => {
    localStorage.setItem(UI.LOG_KEY, String(parseInt(consoleEl.style.height, 10)));
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  resizer.addEventListener("mousedown", (e) => {
    document.body.classList.add("no-select");
    e.preventDefault();
    startY = e.clientY;
    startHeight = consoleEl.getBoundingClientRect().height;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  window.addEventListener("mouseup", () => {
    document.body.classList.remove("no-select");
  });
};
