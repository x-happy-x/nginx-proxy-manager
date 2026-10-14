import * as React from "react";
import { createRoot } from "react-dom/client";
import { request, type Host, type Manifest } from "./sdk";

export const navigate = (page: string) => { location.hash = `/${page}`; };
export const moduleBase = (m: Manifest) => `/integrations/${encodeURIComponent(m.id)}/${encodeURIComponent(m.version)}/`;

// The same narrow host for a module's pages and its own widgets: API calls stay
// inside /api/integrations/<id>, so Core's allowlist applies to both.
export function moduleHost(m: Manifest, notify: (text: string) => void): Host {
  return {
    protocol: 1, React, createRoot, navigate, notify, shellNav: true,
    api: (path, init) => {
      if (!path.startsWith("/") || path.includes("..") || path.includes("\\") || path.includes("%")) return Promise.reject(new Error("Недопустимый путь API"));
      return request(`/api/integrations/${m.id}${path}`, init);
    },
  };
}
