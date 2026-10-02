import { useState, type ReactNode } from "react";
import { Icon } from "../../components/ui/Icon";
import { Segmented } from "../../components/ui/controls";
import { Delay, delayTone } from "./shared";

/*
 * Nodes as small tiles, the way zashboard shows them (NPM-31). One component
 * for group nodes, provider nodes, Tailscale exit nodes and devices; three
 * densities picked by the viewer and remembered per browser.
 */

export type NodeView = "cards" | "compact" | "list";
const VIEW_KEY = "homenet.mihomo.nodeView";

function readView(): NodeView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "compact" || v === "list" ? v : "cards";
  } catch {
    return "cards";
  }
}

export function useNodeView(): [NodeView, (v: NodeView) => void] {
  const [view, setView] = useState<NodeView>(readView);
  const set = (v: NodeView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* per-browser preference */
    }
  };
  return [view, set];
}

export function NodeViewSwitch({ value, onChange }: { value: NodeView; onChange: (v: NodeView) => void }) {
  return (
    <Segmented<NodeView>
      label="Вид узлов"
      value={value}
      onChange={onChange}
      options={[
        { value: "cards", label: "Карточки" },
        { value: "compact", label: "Компактно" },
        { value: "list", label: "Список" },
      ]}
    />
  );
}

export type Tile = {
  key: string;
  name: string;
  /** Small line under the name: protocol, OS, address. */
  meta?: string;
  /** Measured delay; omitted when the tile shows `status` instead. */
  delay?: number | null;
  testing?: boolean;
  status?: ReactNode;
  active?: boolean;
  dead?: boolean;
  title?: string;
  onSelect?: () => void;
  onTest?: () => void;
};

export function NodeTiles({ items, view, empty = "Нет узлов под фильтр.", disabled }: { items: Tile[]; view: NodeView; empty?: string; disabled?: boolean }) {
  if (!items.length) return <p className="mh-muted mh-tiles-empty">{empty}</p>;
  return (
    <div className={`mh-tiles is-${view}`}>
      {items.map((t) => {
        const right =
          t.status !== undefined ? (
            <span className="mh-tile-status">{t.status}</span>
          ) : t.onTest ? (
            <button type="button" className="mh-tile-delay" onClick={t.onTest} title="Проверить задержку">
              <Delay value={t.delay ?? null} testing={t.testing} short />
            </button>
          ) : (
            <span className="mh-tile-delay">
              <Delay value={t.delay ?? null} testing={t.testing} short />
            </span>
          );
        const body = (
          <>
            <span className="mh-tile-name">{t.name}</span>
            {t.meta && view !== "compact" ? <span className="mh-tile-meta">{t.meta}</span> : null}
          </>
        );
        return (
          <div key={t.key} className={`mh-tile${t.active ? " is-active" : ""}${t.dead ? " is-dead" : ""}`} title={t.title || t.name}>
            {t.onSelect ? (
              <button type="button" className="mh-tile-main" aria-pressed={!!t.active} disabled={disabled} onClick={t.onSelect}>
                {body}
              </button>
            ) : (
              <span className="mh-tile-main">{body}</span>
            )}
            {right}
          </div>
        );
      })}
    </div>
  );
}

export type Dot = { key: string; tone: "good" | "warn" | "bad" | "none"; title: string };

export function dotOfDelay(key: string, name: string, d: number | null): Dot {
  return { key, tone: delayTone(d), title: `${name}: ${d == null ? "не проверялся" : d <= 0 ? "нет ответа" : `${d} мс`}` };
}

/** Collapsed view: one square per node, the whole strip toggles the list. */
export function HealthDots({ dots, open, onToggle, label }: { dots: Dot[]; open: boolean; onToggle: () => void; label: string }) {
  const MAX = 400;
  return (
    <button type="button" className="mh-health" aria-expanded={open} aria-label={open ? "Свернуть" : `Показать: ${label}`} onClick={onToggle}>
      {dots.slice(0, MAX).map((d) => (
        <i key={d.key} className={`is-${d.tone}`} title={d.title} />
      ))}
      {dots.length > MAX ? <span className="mh-muted">+{dots.length - MAX}</span> : null}
      <span className="mh-health-toggle">
        {open ? "Свернуть" : label}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      </span>
    </button>
  );
}
