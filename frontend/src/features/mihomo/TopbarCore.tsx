import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { MODE_LABEL, useMihomo } from "./context";
import { speed } from "./shared";

/** Core mode and live speed in the top bar, visible from every page. */
// Mode and speed belong to the Mihomo section, not to every console page.
const CORE_PAGES = new Set(["vpn", "proxies", "checks", "connections", "rules", "traffic", "corelog", "coreconfig", "core"]);

export function TopbarCore({ page }: { page: string }) {
  const { status, configs, setMode, traffic, live } = useMihomo();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!status?.controller_ok || !CORE_PAGES.has(page)) return null;
  const now = traffic[traffic.length - 1];
  const mode = configs?.mode || "rule";
  return (
    <>
      <div className="mh-mode-menu" ref={ref}>
        <button type="button" className="mh-mode-chip" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Режим mihomo">
          <span className="label">Режим:</span> {MODE_LABEL[mode] || mode}
          <Icon name="chevronDown" size={14} />
        </button>
        {open ? (
          <div className="mh-mode-pop" role="menu">
            {Object.entries(MODE_LABEL).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={mode === id}
                onClick={() => {
                  setOpen(false);
                  if (id !== mode) void setMode(id);
                }}
              >
                {mode === id ? <Icon name="check" size={14} /> : <span className="mh-mode-pad" />}
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <span className={`mh-topspeed${live ? "" : " is-off"}`} title="Скорость через mihomo">
        <span className="up">↑ {speed(now?.up)}</span>
        <span className="down">↓ {speed(now?.down)}</span>
      </span>
      <span className="topbar-divider" />
    </>
  );
}
