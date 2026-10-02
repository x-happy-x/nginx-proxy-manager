import { useEffect, type ReactNode } from "react";
import type { ConsoleItem, NginxStatus } from "../types";
import { SECTIONS, SECTION_EXTRAS, pageItem, sectionOf, sectionPages, type PageKey, type SectionKey } from "../navigation";
import { Icon } from "./ui/Icon";
import { Modal } from "./ui/Modal";
import { EmptyState } from "./ui/controls";
import { count, nginxVersion } from "../lib/format";

/* ---------- Sidebar ---------- */

// Five sections; the sub line under each is a live one-line summary (NPM-30).
export function Sidebar({
  active,
  onNavigate,
  onClose,
  summaries,
  warnings,
  unsaved,
  status,
  onPortal,
}: {
  active: PageKey;
  onNavigate: (page: PageKey) => void;
  onClose: () => void;
  summaries: Partial<Record<SectionKey, string>>;
  warnings: Partial<Record<SectionKey, boolean>>;
  unsaved: Partial<Record<PageKey, boolean>>;
  status: NginxStatus | null;
  /** Back to the portal (apps and access), when the console is opened from it. */
  onPortal?: () => void;
}) {
  const current = sectionOf(active).id;
  return (
    <aside className="sidebar" aria-label="Навигация">
      <div className="sidebar-head">
        <a className="brand" href="#/overview" onClick={() => onNavigate("overview")}>
          <span className="brand-mark">
            <Icon name="route" size={17} strokeWidth={2} />
          </span>
          <span className="brand-name">
            <strong>HomeNet</strong>
            <small>Управление роутером</small>
          </span>
        </a>
        <button type="button" className="btn btn-ghost btn-icon btn-sm sidebar-close" aria-label="Закрыть меню" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <nav className="nav nav-sections">
        {SECTIONS.map((section) => {
          const first = sectionPages(section.id)[0].id;
          const dirty = sectionPages(section.id).some((p) => unsaved[p.id]);
          return (
            <a
              key={section.id}
              href={`#/${first}`}
              className="nav-section"
              aria-current={section.id === current ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(first);
              }}
            >
              <span className="nav-section-icon">
                <Icon name={section.icon} size={18} />
              </span>
              <span className="nav-section-text">
                <span className="nav-section-title">{section.title}</span>
                <span className="nav-section-sub">{summaries[section.id] || section.description}</span>
              </span>
              {dirty ? <i className="unsaved" title="Есть несохранённые изменения" /> : warnings[section.id] ? <i className="nav-warn" title="Требует внимания" /> : null}
            </a>
          );
        })}
      </nav>
      {onPortal ? (
        <nav className="nav nav-sections nav-portal" aria-label="Портал">
          <a
            href="#"
            className="nav-section"
            onClick={(event) => {
              event.preventDefault();
              onPortal();
            }}
          >
            <span className="nav-section-icon">
              <Icon name="apps" size={18} />
            </span>
            <span className="nav-section-text">
              <span className="nav-section-title">Приложения и доступы</span>
              <span className="nav-section-sub">портал HomeNet</span>
            </span>
          </a>
        </nav>
      ) : null}
      <div className="sidebar-foot">
        <div className="node-card">
          <span className={`dot ${status ? (status.running ? "success" : "danger") : ""}`} />
          <strong>Keenetic</strong>
          <small>
            {status
              ? status.running
                ? `Прокси работает${nginxVersion(status.version) ? ` · ${nginxVersion(status.version)}` : ""}`
                : "nginx остановлен"
              : "Нет данных о прокси"}
          </small>
        </div>
      </div>
    </aside>
  );
}

/* ---------- Section tabs ---------- */

export function SectionTabs({
  page,
  onNavigate,
  onOperations,
  unsaved,
}: {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  onOperations: () => void;
  unsaved: Partial<Record<PageKey, boolean>>;
}) {
  const section = sectionOf(page);
  const pages = sectionPages(section.id);
  const extras = SECTION_EXTRAS[section.id] || [];
  if (pages.length + extras.length < 2) return null;
  return (
    <>
    <nav className="section-tabs" aria-label={`Вкладки раздела «${section.title}»`}>
      {pages.map((p) => (
        <a
          key={p.id}
          href={`#/${p.id}`}
          className="section-tab"
          aria-current={p.id === page ? "page" : undefined}
          onClick={(event) => {
            event.preventDefault();
            onNavigate(p.id);
          }}
        >
          {p.tab}
          {unsaved[p.id] ? <i className="unsaved" title="Есть несохранённые изменения" /> : null}
        </a>
      ))}
      {extras.map((x) =>
        x.href ? (
          <a key={x.label} href={x.href} className="section-tab">
            {x.label}
          </a>
        ) : (
          <button key={x.label} type="button" className="section-tab" onClick={onOperations}>
            {x.label}
          </button>
        ),
      )}
    </nav>
    <label className="section-select">
      <span className="sr-only">Вкладка раздела «{section.title}»</span>
      <select
        value={page}
        onChange={(event) => {
          const v = event.target.value;
          if (v.startsWith("x:")) {
            const x = extras[Number(v.slice(2))];
            if (x.href) window.location.hash = x.href;
            else onOperations();
            return;
          }
          onNavigate(v as PageKey);
        }}
      >
        {pages.map((p) => (
          <option key={p.id} value={p.id}>
            {p.tab}
            {unsaved[p.id] ? " •" : ""}
          </option>
        ))}
        {extras.map((x, i) => (
          <option key={x.label} value={`x:${i}`}>
            {x.label} ↗
          </option>
        ))}
      </select>
    </label>
    </>
  );
}

/* ---------- Top bar ---------- */

export function Topbar({
  page,
  status,
  theme,
  onTheme,
  onMenu,
  navOpen,
  operations,
  onOperations,
  onApply,
  busy,
  extra,
}: {
  extra?: ReactNode;
  page: PageKey;
  status: NginxStatus | null;
  theme: "light" | "dark";
  onTheme: () => void;
  onMenu: () => void;
  navOpen: boolean;
  operations: ConsoleItem[];
  onOperations: () => void;
  onApply: () => void;
  busy: boolean;
}) {
  const current = pageItem(page);
  const section = sectionOf(page);
  const errors = operations.filter((item) => item.level === "error").length;
  const statusText = status ? (status.running ? "Прокси работает" : "Прокси остановлен") : "Нет данных";
  return (
    <header className="topbar">
      <button
        type="button"
        className="btn btn-ghost btn-icon menu-button"
        aria-label="Открыть меню"
        aria-expanded={navOpen}
        onClick={onMenu}
      >
        <Icon name="menu" size={20} />
      </button>
      <div className="crumbs">
        {section.id === "overview" ? (
          <strong>{section.title}</strong>
        ) : (
          <>
            <span className="crumbs-root">{section.title}</span>
            <Icon name="chevronRight" size={14} />
            <strong>{current.tab}</strong>
          </>
        )}
      </div>
      <div className="topbar-actions">
        {extra}
        <span className="proxy-status" title={statusText} aria-label={statusText}>
          <span className={`dot ${status ? (status.running ? "success" : "danger") : ""}`} />
          <span className="label">{statusText}</span>
        </span>
        <span className="topbar-divider" />
        <button
          type="button"
          className="btn btn-ghost btn-icon ops-button"
          aria-label={`Центр операций${operations.length ? `: ${operations.length}` : ""}`}
          title="Центр операций"
          onClick={onOperations}
        >
          <Icon name="inbox" size={18} />
          {operations.length ? (
            <span className={`ops-count${errors ? " has-errors" : ""}`}>
              {errors || Math.min(operations.length, 99)}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
          title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
          onClick={onTheme}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
        </button>
        <button type="button" className="btn btn-primary" onClick={onApply} disabled={busy} title="Проверить и применить конфигурацию">
          <Icon name="bolt" />
          <span className="apply-label">Применить</span>
        </button>
      </div>
    </header>
  );
}

/* ---------- Unsaved changes ---------- */

export function ChangesBar({
  docDirty,
  dnsDirty,
  busy,
  onSaveDoc,
  onDiscardDoc,
  onSaveDns,
  onDiscardDns,
}: {
  docDirty: boolean;
  dnsDirty: boolean;
  busy: boolean;
  onSaveDoc: () => void;
  onDiscardDoc: () => void;
  onSaveDns: () => void;
  onDiscardDns: () => void;
}) {
  if (!docDirty && !dnsDirty) return null;
  return (
    <div className="changes-bar" role="region" aria-label="Несохранённые изменения">
      {docDirty ? (
        <div className="changes-row">
          <Icon name="alert" size={18} />
          <div className="changes-text">
            <strong>Черновик маршрутов изменён</strong>
            <span>Изменения ещё не записаны в routes.yml. Ctrl+S — сохранить.</span>
          </div>
          <div className="button-row">
            <button type="button" className="btn btn-ghost" onClick={onDiscardDoc} disabled={busy}>
              Отменить
            </button>
            <button type="button" className="btn btn-primary" onClick={onSaveDoc} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="save" />}
              Сохранить черновик
            </button>
          </div>
        </div>
      ) : null}
      {dnsDirty ? (
        <div className="changes-row">
          <Icon name="alert" size={18} />
          <div className="changes-text">
            <strong>DNS / KeenDNS изменены</strong>
            <span>Эти изменения записываются прямо на роутер.</span>
          </div>
          <div className="button-row">
            <button type="button" className="btn btn-ghost" onClick={onDiscardDns} disabled={busy}>
              Отменить
            </button>
            <button type="button" className="btn btn-primary" onClick={onSaveDns} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="upload" />}
              Записать на роутер
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Toasts ---------- */

export type Toast = {
  id: number;
  tone: "success" | "error" | "info";
  title: string;
  message?: string;
  action?: { label: string; onClick: () => void };
};

function ToastItem({ item, onDismiss }: { item: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    // Errors stay longer; every message is also kept in the operations center.
    const delay = item.tone === "error" ? 10000 : item.action ? 8000 : 4500;
    const timer = window.setTimeout(() => onDismiss(item.id), delay);
    return () => window.clearTimeout(timer);
  }, [item.id]);
  return (
    <div className={`toast ${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>
      <Icon name={item.tone === "error" ? "error" : item.tone === "success" ? "checkCircle" : "info"} size={18} />
      <div className="toast-body">
        <strong>{item.title}</strong>
        {item.message ? <p title={item.message}>{item.message}</p> : null}
        {item.action ? (
          <button
            type="button"
            className="btn btn-sm toast-action"
            onClick={() => {
              item.action?.onClick();
              onDismiss(item.id);
            }}
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Закрыть уведомление" onClick={() => onDismiss(item.id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.slice(-4).map((item) => (
        <ToastItem key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/* ---------- Operations center ---------- */

export function OperationsDrawer({
  open,
  items,
  onClose,
  onClear,
}: {
  open: boolean;
  items: ConsoleItem[];
  onClose: () => void;
  onClear: () => void;
}) {
  const errors = items.filter((item) => item.level === "error").length;
  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="drawer"
      title="Центр операций"
      description={
        items.length
          ? `${count(items.length, ["операция", "операции", "операций"])} за сеанс, ошибок: ${errors}`
          : "Проверки, сохранения и ответы менеджера за текущий сеанс"
      }
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClear} disabled={!items.length}>
            <Icon name="trash" />
            Очистить
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Закрыть
          </button>
        </>
      }
    >
      {items.length ? (
        <ol className="ops-list">
          {items.map((item, idx) => (
            <li key={`${item.at}-${idx}`} className={item.level === "error" ? "is-error" : ""}>
              <span className="ops-icon">
                <Icon name={item.level === "error" ? "error" : "checkCircle"} size={16} />
              </span>
              <div>
                <div className="ops-head">
                  <strong>{item.title}</strong>
                  <time className="mono">{item.at}</time>
                </div>
                <p className="mono">{item.message}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState icon="inbox" title="Операций пока нет">
          Здесь появятся результаты проверок, сохранений и обновлений.
        </EmptyState>
      )}
    </Modal>
  );
}

/* ---------- Apply flow ---------- */

export type CheckState = "idle" | "passed" | "failed";
export type ApplyState = "idle" | "done" | "failed";

export function ApplyDialog({
  open,
  busy,
  docDirty,
  apps,
  hosts,
  checkState,
  checkOutput,
  applyState,
  applyOutput,
  onClose,
  onSave,
  onCheck,
  onApply,
}: {
  open: boolean;
  busy: boolean;
  docDirty: boolean;
  apps: number;
  hosts: number;
  checkState: CheckState;
  checkOutput: string;
  applyState: ApplyState;
  applyOutput: string;
  onClose: () => void;
  onSave: () => void;
  onCheck: () => void;
  onApply: () => void;
}) {
  const saved = !docDirty;
  const stepClass = (done: boolean, current: boolean, failed = false) =>
    `step${done ? " done" : failed ? " failed" : current ? " current" : ""}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      size="md"
      title="Применение конфигурации"
      description={`Черновик: ${count(apps, ["сервис", "сервиса", "сервисов"])}, ${count(hosts, ["домен", "домена", "доменов"])}.`}
      footer={
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          {applyState === "done" ? "Готово" : "Закрыть"}
        </button>
      }
    >
      <ol className="steps">
        <li className={stepClass(saved, !saved)}>
          <span className="step-marker">{saved ? <Icon name="check" size={14} strokeWidth={2.5} /> : 1}</span>
          <div className="step-content">
            <h3>{saved ? "Черновик сохранён" : "Сохраните черновик"}</h3>
            {saved ? (
              <p>Все изменения записаны в routes.yml.</p>
            ) : (
              <>
                <p>Есть несохранённые изменения — проверка и применение используют сохранённый файл.</p>
                <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={busy}>
                  <Icon name="save" size={14} />
                  Сохранить черновик
                </button>
              </>
            )}
          </div>
        </li>
        <li className={stepClass(checkState === "passed", saved && checkState === "idle", checkState === "failed")}>
          <span className="step-marker">
            {checkState === "passed" ? (
              <Icon name="check" size={14} strokeWidth={2.5} />
            ) : checkState === "failed" ? (
              <Icon name="close" size={14} strokeWidth={2.5} />
            ) : (
              2
            )}
          </span>
          <div className="step-content">
            <h3>Проверка</h3>
            <p>
              Схема, условия интеграций и рендер конфигурации без изменений на роутере. В выводе
              ожидаемо <code>nginx_validated: false</code>: <code>nginx -t</code> выполняется при применении.
            </p>
            {checkOutput ? (
              <pre className={`code-block check-output ${checkState}`}>{checkOutput}</pre>
            ) : null}
            <button
              type="button"
              className={`btn btn-sm${saved && checkState !== "passed" ? " btn-primary" : ""}`}
              onClick={onCheck}
              disabled={busy || !saved}
            >
              {busy && saved && applyState === "idle" && checkState !== "passed" ? <span className="spinner" /> : <Icon name="activity" size={14} />}
              {checkState === "idle" ? "Проверить конфигурацию" : "Проверить ещё раз"}
            </button>
          </div>
        </li>
        <li className={stepClass(applyState === "done", checkState === "passed" && applyState === "idle", applyState === "failed")}>
          <span className="step-marker">
            {applyState === "done" ? (
              <Icon name="check" size={14} strokeWidth={2.5} />
            ) : applyState === "failed" ? (
              <Icon name="close" size={14} strokeWidth={2.5} />
            ) : (
              3
            )}
          </span>
          <div className="step-content">
            <h3>Применение на роутере</h3>
            <p>
              Обновит конфигурацию выделенного nginx, локальные DNS-записи и публичные входы KeenDNS.
              Штатный nginx Keenetic не перезапускается.
            </p>
            {applyOutput ? <pre className={`code-block check-output ${applyState}`}>{applyOutput}</pre> : null}
            {applyState !== "done" ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onApply}
                disabled={busy || !saved || checkState !== "passed"}
              >
                {busy && checkState === "passed" ? <span className="spinner" /> : <Icon name="bolt" size={14} />}
                Применить на роутере
              </button>
            ) : null}
          </div>
        </li>
      </ol>
    </Modal>
  );
}
