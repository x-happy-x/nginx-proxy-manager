import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { IconName } from "./components/ui/Icon";

/*
 * Five sections (NPM-30): Overview, Services, Network, VPN, System. A section
 * is a sidebar entry; its pages are tabs at the top. Page keys are the
 * addresses (#/proxies, #/dns, …) and stay as they were, so old links work.
 */

export type SectionKey = "overview" | "services" | "network" | "vpn" | "system";

export type PageKey =
  | "overview"
  // services
  | "servers"
  | "stats"
  | "logs"
  | "certs"
  | "advanced"
  | "routing"
  | "dms"
  | "apps"
  // network
  | "network"
  | "scheme"
  | "antenna"
  | "netdns"
  | "analyzer"
  | "scan"
  | "resources"
  | "dns"
  // vpn
  | "vpn"
  | "proxies"
  | "checks"
  | "connections"
  | "traffic"
  | "rules"
  | "corelog"
  | "coreconfig"
  | "core"
  // system
  | "system"
  | "releases";

export type NavItem = {
  id: PageKey;
  section: SectionKey;
  /** Tab label inside the section. */
  tab: string;
  title: string;
  description: string;
  icon: IconName;
};

export type Section = {
  id: SectionKey;
  title: string;
  description: string;
  icon: IconName;
};

export const SECTIONS: Section[] = [
  { id: "overview", title: "Обзор", description: "Сводка всех разделов и то, что требует внимания.", icon: "overview" },
  { id: "services", title: "Сервисы", description: "Сайты и приложения за прокси: домены, доступ, сертификаты, журналы.", icon: "servers" },
  { id: "network", title: "Сеть", description: "Интернет и LTE, устройства, DNS и доступность сайтов.", icon: "network" },
  { id: "vpn", title: "VPN", description: "mihomo: узлы, подписки, правила и трафик.", icon: "shield" },
  { id: "system", title: "Система", description: "Сам HomeNet на роутере: прокси, доступы, выкладки.", icon: "system" },
];

export const NAV: NavItem[] = [
  { id: "overview", section: "overview", tab: "Обзор", title: "Обзор", description: "Что требует внимания и короткая сводка каждого раздела.", icon: "overview" },

  { id: "servers", section: "services", tab: "Сервисы", title: "Сервисы", description: "Приложения и их домены для доступа из дома и извне.", icon: "servers" },
  { id: "stats", section: "services", tab: "Статистика", title: "Статистика запросов", description: "Трафик через прокси, ошибки и задержки по доменам.", icon: "activity" },
  { id: "logs", section: "services", tab: "Запросы", title: "Журнал запросов", description: "Каждый запрос: источник, статус и путь до приложения.", icon: "logs" },
  { id: "certs", section: "services", tab: "Сертификаты", title: "Сертификаты", description: "Политика TLS, локальный центр сертификации и выпущенные сертификаты.", icon: "certs" },
  { id: "advanced", section: "services", tab: "Тонкая настройка", title: "Тонкая настройка", description: "Точные параметры приложений, хостов, портов и сервера-заглушки.", icon: "route" },
  { id: "routing", section: "services", tab: "Журналы nginx", title: "Журналы nginx", description: "Исходные журналы доступа и ошибок выделенного nginx.", icon: "terminal" },
  { id: "dms", section: "services", tab: "Развёртывания", title: "Развёртывания", description: "Сервисы под управлением DMS: релизы, артефакты и домены.", icon: "dms" },
  { id: "apps", section: "services", tab: "Плитки портала", title: "Плитки портала", description: "Как приложения выглядят на портале: устройства, названия, порядок.", icon: "apps" },

  { id: "network", section: "network", tab: "Интернет", title: "Интернет", description: "Основной канал и LTE, задержки и доступность.", icon: "network" },
  { id: "scheme", section: "network", tab: "Схема", title: "Схема сети", description: "Сегменты, устройства и маршруты трафика.", icon: "route" },
  { id: "resources", section: "network", tab: "Устройства", title: "Устройства", description: "Нагрузка роутеров, mesh-узлов и Proxmox.", icon: "activity" },
  { id: "antenna", section: "network", tab: "Антенна", title: "Антенна", description: "Сигнал LTE и наведение антенны.", icon: "network" },
  { id: "dns", section: "network", tab: "DNS и KeenDNS", title: "DNS и KeenDNS", description: "Локальные DNS-записи роутера и публичные входы KeenDNS.", icon: "dns" },
  { id: "netdns", section: "network", tab: "Резолверы", title: "Поиск DNS-резолвера", description: "Какие DNS отвечают напрямую и через mihomo, и как быстро.", icon: "dns" },
  { id: "analyzer", section: "network", tab: "Анализатор", title: "Анализатор", description: "Почему сайт не открывается: напрямую, через mihomo и MikroTik.", icon: "search" },
  { id: "scan", section: "network", tab: "Автопроверка", title: "Автопроверка", description: "Регулярная проверка списка сайтов.", icon: "clock" },

  { id: "vpn", section: "vpn", tab: "Сводка", title: "VPN", description: "Режим сети, рабочие узлы, подписки и трафик.", icon: "shield" },
  { id: "proxies", section: "vpn", tab: "Узлы", title: "Узлы и группы", description: "Выбор узла в группе, проверка задержки, подписки, Tailscale, OLCRTC.", icon: "layers" },
  { id: "checks", section: "vpn", tab: "Подписки", title: "Проверка подписок", description: "Режим сети и рейтинги узлов: без ограничений и при белых списках.", icon: "test" },
  { id: "connections", section: "vpn", tab: "Соединения", title: "Соединения", description: "Живые соединения через mihomo: устройство, правило, цепочка, скорость.", icon: "globe" },
  { id: "traffic", section: "vpn", tab: "Трафик", title: "Трафик", description: "Скорость, учёт за период, топология и история соединений.", icon: "activity" },
  { id: "rules", section: "vpn", tab: "Правила", title: "Правила", description: "Правила ядра со счётчиками срабатываний и наборы правил.", icon: "list" },
  { id: "corelog", section: "vpn", tab: "Журнал", title: "Журнал ядра", description: "Поток журнала mihomo с фильтрами по уровню и типу.", icon: "logs" },
  { id: "coreconfig", section: "vpn", tab: "Настройка", title: "Настройка", description: "Подписки, правила, группы, свои узлы и устройства. Проверка mihomo -t перед применением.", icon: "file" },
  { id: "core", section: "vpn", tab: "Ядро", title: "Ядро mihomo", description: "Режим, TUN, DNS, кеши, гео-базы, обновление и перезапуск ядра.", icon: "bolt" },

  { id: "system", section: "system", tab: "Прокси nginx", title: "Прокси nginx", description: "Процесс выделенного nginx, файл маршрутов и конфигурационные файлы.", icon: "system" },
  { id: "releases", section: "system", tab: "Выкладки", title: "Выкладки", description: "Релизы HomeNet на роутере и как откатить последний.", icon: "upload" },
];

/** Links in a section's tab bar that lead outside the console. */
export const SECTION_EXTRAS: Partial<Record<SectionKey, Array<{ label: string; href?: string; action?: "operations" }>>> = {
  system: [
    { label: "Доступы", href: "#access" },
    { label: "Центр операций", action: "operations" },
  ],
};

export function pageItem(page: PageKey): NavItem {
  return NAV.find((n) => n.id === page) || NAV[0];
}

export function sectionOf(page: PageKey): Section {
  const s = pageItem(page).section;
  return SECTIONS.find((x) => x.id === s) || SECTIONS[0];
}

export function sectionPages(section: SectionKey): NavItem[] {
  return NAV.filter((n) => n.section === section);
}

export function pageFromHash(hash: string): PageKey {
  const raw = hash.replace(/^#\/?/, "").split("/")[0].trim().toLowerCase();
  const page = NAV.find((item) => item.id === raw);
  if (page) return page.id;
  const section = SECTIONS.find((s) => s.id === raw);
  if (section) return sectionPages(section.id)[0].id;
  return "overview";
}

/** Second segment of the address: #/proxies/providers → "providers". */
function subFromHash(): string {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");
  try {
    return decodeURIComponent(parts[1] || "");
  } catch {
    return "";
  }
}

const SUB_EVENT = "homenet:subtab";

/**
 * A page's inner tab kept in the address (NPM-31), so a reload or a shared
 * link opens the same tab. Switching tabs adds a history entry: «Назад»
 * returns to the previous tab.
 */
export function useHashTab<T extends string>(page: PageKey, fallback: T): [T, (next: T) => void] {
  const [sub, setSub] = useState(subFromHash);
  useEffect(() => {
    const sync = () => setSub(subFromHash());
    window.addEventListener("hashchange", sync);
    window.addEventListener(SUB_EVENT, sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener(SUB_EVENT, sync);
    };
  }, []);
  const set = useCallback(
    (next: T) => {
      const hash = next && next !== fallback ? `#/${page}/${encodeURIComponent(next)}` : `#/${page}`;
      if (window.location.hash !== hash) window.history.pushState(null, "", hash);
      window.dispatchEvent(new Event(SUB_EVENT));
    },
    [page, fallback],
  );
  return [((sub || fallback) as T), set];
}

export function PageHeader({
  page,
  actions,
  children,
}: {
  page: PageKey;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const item = pageItem(page);
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{item.title}</h1>
        <p>{children || item.description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
