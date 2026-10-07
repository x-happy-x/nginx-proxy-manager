import { Component, useEffect, useState, type ReactNode } from "react";
import { NAV } from "../navigation";
import type { Host } from "./sdk";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/layout.css";
import "../styles/pages.css";
import "../styles/resources.css";
import "../styles/network.css";
import "../styles/mihomo.css";
import "../styles/sections.css";

export class ModuleBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <div role="alert">Ошибка интерфейса интеграции: {this.state.error}. Остальные разделы HomeNet доступны.</div> : this.props.children; }
}

export function usePage() {
  const read = () => location.hash.replace(/^#\/?/, "").split("/")[0] || "overview";
  const [page, setPage] = useState(read);
  useEffect(() => { const update = () => setPage(read()); window.addEventListener("hashchange", update); return () => window.removeEventListener("hashchange", update); }, []);
  return page;
}
export function ModuleTabs({ ids, host, page }: { ids: string[]; host: Host; page: string }) {
  return <nav aria-label="Страницы интеграции" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>{ids.map(id => <button type="button" key={id} aria-current={id === page ? "page" : undefined} onClick={() => host.navigate(id)}>{id === "proxy-system" ? "Прокси nginx" : NAV.find(n => n.id === id)?.tab || id}</button>)}</nav>;
}
