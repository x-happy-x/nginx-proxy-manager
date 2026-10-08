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
import "./module.css";

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
/**
 * The module's pages as the console's section tabs (NPM-65): pills with the
 * current one marked, a list control on a phone — as before the split.
 */
export function ModuleTabs({ ids, host, page }: { ids: string[]; host: Host; page: string }) {
  const title = (id: string) => (id === "proxy-system" ? "Прокси nginx" : NAV.find((n) => n.id === id)?.tab || id);
  if (ids.length < 2) return null;
  return (
    <>
      <nav className="section-tabs module-tabs" aria-label="Страницы раздела">
        {ids.map((id) => (
          <a
            key={id}
            href={`#/${id}`}
            className="section-tab"
            aria-current={id === page ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              host.navigate(id);
            }}
          >
            {title(id)}
          </a>
        ))}
      </nav>
      <label className="section-select module-tabs">
        <span className="sr-only">Страница раздела</span>
        <select value={ids.includes(page) ? page : ids[0]} onChange={(event) => host.navigate(event.target.value)}>
          {ids.map((id) => (
            <option key={id} value={id}>
              {title(id)}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
