import type * as React from "react";
import type { createRoot } from "react-dom/client";

export type WidgetKind = "stat" | "status" | "list" | "progress" | "series" | "bars" | "custom";
export type WidgetSize = "s" | "m" | "l";
export type HomeMode = "simple" | "pro";
export type WidgetSpec = { id: string; title: string; kind: WidgetKind; sizes: WidgetSize[]; data?: string; refresh?: number; modes: HomeMode[]; default?: Partial<Record<HomeMode, number>>; page?: string };
export type Manifest = {
  schema: 1; id: string; name: string; description: string; version: string; arch: string;
  core_api: 1; ui_api: 1 | 2; package: string;
  ui: { entry: string; css?: string[]; pages: { id: string; title: string; aliases?: string[] }[]; widgets?: WidgetSpec[]; summary?: { attention?: string; tasks?: string } };
};
export type Installed = { manifest: Manifest; enabled: boolean; connection: "unconfigured" | "connected" | "unavailable" };
export type Host = {
  protocol: 1;
  React: typeof React;
  createRoot: typeof createRoot;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  navigate: (page: string) => void;
  notify: (message: string) => void;
  // NPM-65: Core's menu lists the module's sections, so the module hides its own tabs
  shellNav?: boolean;
};
export type WidgetContext = { size: WidgetSize; mode: HomeMode };
// ui_api 2: a module may export its own home widgets next to mount (kind "custom").
export type IntegrationModule = {
  mount: (element: HTMLElement, host: Host) => (() => void) | Promise<() => void>;
  widgets?: Record<string, { mount: (element: HTMLElement, host: Host, ctx: WidgetContext) => (() => void) | Promise<() => void> }>;
};

export async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("X-HomeNet-UI", "1");
  // the access gateway answers an expired session with a redirect to Account;
  // followed by fetch it fails as CORS, so it is caught here and said plainly
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", redirect: "manual" });
  if (response.type === "opaqueredirect") { sessionExpired(); throw new Error("Сессия входа истекла — войдите снова"); }
  if (!response.ok) { const text=await response.text();let detail="";try{detail=JSON.parse(text).error||"";}catch{detail=text.slice(0,500);}throw new Error(response.status === 401 ? "Требуется вход в Account" : detail||`Ошибка запроса (${response.status})`); }
  return response;
}

/** NPM-70: tells Core's shell that the Account session expired (any module may notice first). */
export function sessionExpired() { window.dispatchEvent(new Event("homenet:session-expired")); }
