import { NAV } from "../navigation";
import type { HomeMode, Installed } from "./sdk";

// Two-level menu of the redesign (NPM-65, canvas «HomeNet — редизайн», page
// «Переработка»): Core's own menu, or — inside a module — the module's sections.
// «Просто» shows a module's everyday sections; «Подробно» all of them.

type Group = { title?: string; pages: string[] };
type Plan = { simple: string[]; pro: Group[] };

// First-party modules get the order of the mockups; any other module lists its
// manifest pages as they are.
const PLANS: Record<string, Plan> = {
  vpn: {
    simple: ["vpn", "vstats", "vpnsvc", "why"],
    pro: [
      { pages: ["vpn", "vservers", "checks", "vstats", "vroute", "subs", "vpnsvc", "traffic", "corelog"] },
      { title: "Разбор и настройка", pages: ["why", "proxies", "connections", "rules", "torrents", "vnow", "coreconfig", "core"] },
    ],
  },
  proxy: {
    simple: ["servers", "certs"],
    pro: [
      { pages: ["servers", "stats", "logs", "certs"] },
      { title: "Настройка", pages: ["dns", "advanced", "routing", "proxy-system"] },
    ],
  },
  network: {
    simple: ["network", "antenna"],
    pro: [
      { pages: ["network", "scheme", "resources", "antenna"] },
      { title: "Диагностика", pages: ["analyzer", "netdns", "scan"] },
    ],
  },
};
const TITLES: Record<string, string> = { vpn: "Обзор", vservers: "Серверы", proxies: "Узлы и группы", vnow: "Прежняя сводка", vstats: "Статистика", vroute: "Маршруты", corelog: "Журнал", why: "Почему не открывается", "proxy-system": "Прокси nginx" };
const SHORT: Record<string, string> = { vpn: "VPN", proxy: "Прокси", network: "Связь" };

export const pageTitle = (id: string, item?: Installed) =>
  TITLES[id] || NAV.find(n => n.id === id)?.tab || item?.manifest.ui.pages.find(p => p.id === id)?.title || id;
export const moduleShort = (item: Installed) => SHORT[item.manifest.id] || item.manifest.name;

function sections(item: Installed, mode: HomeMode): Group[] {
  const own = new Set(item.manifest.ui.pages.map(p => p.id));
  const plan = PLANS[item.manifest.id];
  if (!plan) return [{ pages: item.manifest.ui.pages.map(p => p.id) }];
  const keep = (pages: string[]) => pages.filter(p => own.has(p));
  if (mode === "simple") return [{ pages: keep(plan.simple) }];
  const listed = new Set(plan.pro.flatMap(g => g.pages));
  const rest = item.manifest.ui.pages.map(p => p.id).filter(p => !listed.has(p));
  const groups = plan.pro.map(g => ({ ...g, pages: keep(g.pages) }));
  if (rest.length) groups.push({ title: "Ещё", pages: rest });
  return groups.filter(g => g.pages.length);
}

export function Sidebar({ page, module, active, installedCount, mode, setMode, theme, setTheme, login, attention, onPortal }: {
  page: string; module?: Installed; active: Installed[]; installedCount: number; mode: HomeMode; setMode: (m: HomeMode) => void;
  theme: string; setTheme: (t: string) => void; login: string; attention: Record<string, number>; onPortal: () => void;
}) {
  // aliases (olcrtc, tailscale) light up the page they belong to
  const current = module?.manifest.ui.pages.find(p => p.id === page || p.aliases?.includes(page))?.id || page;
  const link = (id: string, title: string, extra?: React.ReactNode) =>
    <a key={id} href={`#/${id}`} className={current === id ? "active" : ""} aria-current={current === id ? "page" : undefined}><span className="hn-nav-title">{title}</span>{extra}</a>;
  return <aside className="hn-sidebar" aria-label="Меню HomeNet">
    <a className="hn-brand" href="#/overview"><span className="hn-logo" aria-hidden="true">H</span><span>HomeNet</span></a>
    {module ? <nav aria-label={`Разделы: ${module.manifest.name}`}>
      <a className="hn-back" href="#/overview">← HomeNet</a>
      <div className="hn-module-title">{module.manifest.name}</div>
      {sections(module, mode).map((g, i) => <div className="hn-nav-group" key={i}>
        {g.title && <div className="hn-nav-label">{g.title}</div>}
        {g.pages.map(id => link(id, pageTitle(id, module)))}
      </div>)}
      {mode === "simple" && <button type="button" className="hn-more" onClick={() => setMode("pro")}>Все разделы — режим «Подробно»</button>}
    </nav> : <nav aria-label="Разделы HomeNet">
      {link("overview", "Главная")}
      {active.length > 0 && <div className="hn-nav-label">Интеграции</div>}
      {active.map(i => link(i.manifest.ui.pages[0]?.id || "integrations", i.manifest.name,
        attention[i.manifest.id] ? <span className="hn-count" title="Требует внимания">{attention[i.manifest.id]}</span> : undefined))}
      <div className="hn-nav-label">HomeNet</div>
      {link("integrations", "Интеграции", <span className="hn-count hn-count-muted">{installedCount}</span>)}
      {link("system", "Система")}
    </nav>}
    <div className="hn-sidebar-bottom">
      <div className="hn-seg" role="group" aria-label="Режим">
        {(["simple", "pro"] as HomeMode[]).map(m => <button type="button" key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "simple" ? "Просто" : "Подробно"}</button>)}
      </div>
      <div className="hn-account">
        <span className="hn-login" title={login}>{login || "Администратор"}</span>
        <button type="button" className="hn-icon-btn" aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "◐"}</button>
        <button type="button" className="hn-icon-btn" aria-label="Приложения" title="Приложения" onClick={onPortal}>▦</button>
      </div>
    </div>
  </aside>;
}
