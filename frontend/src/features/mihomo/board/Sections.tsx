import type { ReactNode } from "react";
import { useHomeMode } from "../../../platform/module-base";
import "./board.css";

/*
 * VPN in seven sections (NPM-71): pages that answer one question share a
 * section; «Серверы» is one page of its own (ServersPage). Each
 * block keeps its own address (#/subs, #/checks, #/vservers…), so a page's
 * inner tabs and old links keep working; the section only adds its header.
 */

export type Block = { id: string; title: string };
export type Section = { id: string; title: string; question: string; blocks: Block[] };

export const SECTIONS: Section[] = [
  { id: "vroute", title: "Маршруты", question: "Куда идёт сайт и почему через этот сервер", blocks: [{ id: "vroute", title: "Маршрутизация" }, { id: "proxies", title: "Группы и узлы" }, { id: "rules", title: "Правила" }] },
  { id: "vpnsvc", title: "Сервисы", question: "Что открывается дома и почему что-то нет", blocks: [{ id: "vpnsvc", title: "Сервисы" }, { id: "why", title: "Почему не открывается" }] },
  { id: "vstats", title: "Статистика", question: "Как сеть работала", blocks: [{ id: "vstats", title: "Графики" }, { id: "traffic", title: "Трафик" }, { id: "vnow", title: "Прежняя сводка" }] },
  { id: "corelog", title: "Журнал", question: "Что происходит прямо сейчас", blocks: [{ id: "corelog", title: "Журнал ядра" }, { id: "connections", title: "Соединения" }] },
  { id: "coreconfig", title: "Настройка", question: "Как всё устроено и где это поменять", blocks: [{ id: "coreconfig", title: "Конфигурация" }, { id: "core", title: "Ядро" }, { id: "torrents", title: "Торренты" }] },
];

export const sectionOf = (page: string) => SECTIONS.find(s => s.blocks.some(b => b.id === page));


export function SectionPage({ page, navigate, children }: { page: string; navigate: (p: string) => void; children: ReactNode }) {
  const section = sectionOf(page);
  const mode = useHomeMode();
  // «Просто» has three short sections in the menu: no section header there
  if (!section || mode === "simple") return <>{children}</>;
  return <div className="vb-section">
    <header className="vb-section-head"><h1>{section.title}</h1><p>{section.question}</p></header>
    {<nav className="vb-subnav" aria-label={`Блоки раздела «${section.title}»`}>{section.blocks.map(b => <a key={b.id} href={`#/${b.id}`} aria-current={b.id === page ? "page" : undefined} onClick={e => { e.preventDefault(); navigate(b.id); }}>{b.title}</a>)}</nav>}
    <div className="vb-section-body">{children}</div>
  </div>;
}
