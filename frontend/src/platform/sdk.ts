import type * as React from "react";
import type { createRoot } from "react-dom/client";

export type Manifest = {
  schema: 1; id: string; name: string; description: string; version: string; arch: string;
  core_api: 1; ui_api: 1; package: string;
  ui: { entry: string; css?: string[]; pages: { id: string; title: string; aliases?: string[] }[] };
};
export type Installed = { manifest: Manifest; enabled: boolean; connection: "unconfigured" | "connected" | "unavailable" };
export type Host = {
  protocol: 1;
  React: typeof React;
  createRoot: typeof createRoot;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  navigate: (page: string) => void;
  notify: (message: string) => void;
};
export type IntegrationModule = { mount: (element: HTMLElement, host: Host) => (() => void) | Promise<() => void> };

export async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("X-HomeNet-UI", "1");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) { const text=await response.text();let detail="";try{detail=JSON.parse(text).error||"";}catch{detail=text.slice(0,500);}throw new Error(response.status === 401 ? "Требуется вход в Account" : detail||`Ошибка запроса (${response.status})`); }
  return response;
}
