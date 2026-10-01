import React from "react";
import { createRoot } from "react-dom/client";
import App from "./Portal";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/pages.css";
import "./styles/launcher.css";
import "./styles/resources.css";
import "./styles/network.css";
import "./styles/mihomo.css";

// index.html sets the theme before first paint; this covers a missing or stale attribute.
if (!document.documentElement.dataset.theme) {
  document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
