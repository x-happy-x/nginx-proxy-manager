import type { ReactNode } from "react";
import type { IconName } from "./components/ui/Icon";

export type PageKey =
  | "overview"
  | "apps"
  | "resources"
  | "network"
  | "servers"
  | "logs"
  | "dns"
  | "certs"
  | "advanced"
  | "system"
  | "dms"
  | "routing"
  | "proxies"
  | "checks"
  | "connections"
  | "rules"
  | "traffic"
  | "corelog"
  | "coreconfig"
  | "core";

export type NavItem = {
  id: PageKey;
  title: string;
  description: string;
  icon: IconName;
  group: "main" | "mihomo" | "network" | "system";
};

export const NAV: NavItem[] = [
  {
    id: "overview",
    title: "Обзор",
    description: "Трафик через прокси, ошибки и состояние системы.",
    icon: "overview",
    group: "main",
  },
  {
    id: "apps",
    title: "Приложения",
    description: "Все сервисы дома — по устройствам, в один клик.",
    icon: "apps",
    group: "main",
  },
  {
    id: "resources",
    title: "Ресурсы",
    description: "Нагрузка роутеров, mesh-узлов и Proxmox: кто сколько потребляет.",
    icon: "activity",
    group: "main",
  },
  {
    id: "servers",
    title: "Сервисы",
    description: "Приложения и их домены для доступа из дома и извне.",
    icon: "servers",
    group: "main",
  },
  {
    id: "logs",
    title: "Журнал запросов",
    description: "Каждый запрос: источник, статус и путь до приложения.",
    icon: "logs",
    group: "main",
  },
  {
    id: "proxies",
    title: "Прокси и группы",
    description: "Выбор узла в группе, проверка задержки, подписки и их трафик.",
    icon: "layers",
    group: "mihomo",
  },
  {
    id: "checks",
    title: "Проверка подписок",
    description: "Режим сети и рейтинги узлов: без ограничений и при белых списках.",
    icon: "test",
    group: "mihomo",
  },
  {
    id: "connections",
    title: "Соединения",
    description: "Живые соединения через mihomo: устройство, правило, цепочка, скорость.",
    icon: "globe",
    group: "mihomo",
  },
  {
    id: "rules",
    title: "Правила",
    description: "Правила ядра со счётчиками срабатываний и наборы правил.",
    icon: "list",
    group: "mihomo",
  },
  {
    id: "traffic",
    title: "Трафик",
    description: "Скорость, память, выходы и устройства в реальном времени.",
    icon: "activity",
    group: "mihomo",
  },
  {
    id: "corelog",
    title: "Журнал ядра",
    description: "Поток журнала mihomo с фильтром по уровню.",
    icon: "logs",
    group: "mihomo",
  },
  {
    id: "coreconfig",
    title: "Конфигурация",
    description: "Подписки, правила, группы, свои узлы и устройства. Проверка mihomo -t перед применением.",
    icon: "file",
    group: "mihomo",
  },
  {
    id: "network",
    title: "Сеть",
    description: "Интернет, LTE и задержки, схема сети, анализ блокировок напрямую и через mihomo.",
    icon: "network",
    group: "network",
  },
  {
    id: "dns",
    title: "DNS и KeenDNS",
    description: "Локальные DNS-записи роутера и публичные входы KeenDNS.",
    icon: "dns",
    group: "network",
  },
  {
    id: "certs",
    title: "Сертификаты",
    description: "Политика TLS, локальный центр сертификации и выпущенные сертификаты.",
    icon: "certs",
    group: "network",
  },
  {
    id: "advanced",
    title: "Маршрутизация",
    description: "Точные параметры приложений, хостов, портов и сервера-заглушки.",
    icon: "route",
    group: "network",
  },
  {
    id: "system",
    title: "Система",
    description: "Процесс nginx, файл маршрутов и конфигурационные файлы.",
    icon: "system",
    group: "system",
  },
  {
    id: "core",
    title: "Ядро mihomo",
    description: "Режим, TUN, DNS, кеши, гео-базы, обновление и перезапуск ядра.",
    icon: "bolt",
    group: "system",
  },
  {
    id: "dms",
    title: "Развёртывания",
    description: "Сервисы под управлением DMS: релизы, артефакты и домены.",
    icon: "dms",
    group: "system",
  },
  {
    id: "routing",
    title: "Логи nginx",
    description: "Исходные журналы доступа и ошибок выделенного nginx.",
    icon: "terminal",
    group: "system",
  },
];

export const NAV_GROUPS: Array<[NavItem["group"], string]> = [
  ["main", "Рабочее пространство"],
  ["mihomo", "Прокси mihomo"],
  ["network", "Сеть и безопасность"],
  ["system", "Система"],
];

export function pageFromHash(hash: string): PageKey {
  const raw = hash.replace(/^#\/?/, "").trim().toLowerCase();
  return (NAV.find((item) => item.id === raw)?.id || "overview") as PageKey;
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
  const item = NAV.find((nav) => nav.id === page) || NAV[0];
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
