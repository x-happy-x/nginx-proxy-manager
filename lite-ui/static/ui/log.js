window.UI = window.UI || {};

UI.log = {
  current: null,
  autoScroll: true,
};

UI.log.nowString = function () {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date} ${time}`;
};

UI.log.append = function (title, text) {
  const container = UI.qs("#output");
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = `
    <div class="log-header">
      <div class="log-title"># ${title}</div>
      <div class="log-time">${UI.log.nowString()}</div>
    </div>
    <div class="log-line"></div>
  `;
  UI.log.current = entry.querySelector(".log-line");
  UI.log.current.textContent = text || "";
  container.appendChild(entry);
  UI.log.scroll();
};

UI.log.appendLine = function (text) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = text || "Done";
  if (UI.log.current) {
    UI.log.current.appendChild(document.createElement("br"));
    UI.log.current.appendChild(line);
  } else {
    const container = UI.qs("#output");
    container.appendChild(line);
  }
  UI.log.scroll();
};

UI.log.scroll = function () {
  if (!UI.log.autoScroll) {
    return;
  }
  const container = UI.qs("#output");
  container.scrollTop = container.scrollHeight;
};

UI.log.clear = function () {
  UI.qs("#output").innerHTML = "";
  UI.log.current = null;
};

UI.log.openConsole = function () {
  document.body.classList.add("console-open");
};

UI.log.appendError = function (title, text) {
  UI.log.append(title, text);
  UI.log.openConsole();
};

UI.log.errorLine = function (text) {
  UI.log.appendLine(text);
  UI.log.openConsole();
};
