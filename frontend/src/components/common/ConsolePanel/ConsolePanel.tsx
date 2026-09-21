import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ConsoleItem } from "../../../types";
import "./ConsolePanel.scss";
import { IconButton } from "../../ui";
import { useI18n } from "../../../i18n";

type Props = {
  items: ConsoleItem[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
};

export function ConsolePanel({ items, open, onToggle, onClear }: Props) {
  const { t } = useI18n();
  const [height, setHeight] = useState(() => {
    if (typeof window === "undefined") {
      return 320;
    }
    const stored = window.localStorage.getItem("console_height");
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) ? Math.max(180, parsed) : 320;
  });
  const resizingRef = useRef(false);

  useEffect(() => {
    window.localStorage.setItem("console_height", String(height));
  }, [height]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!resizingRef.current) return;
      const nextHeight = window.innerHeight - event.clientY;
      const maxHeight = Math.max(260, window.innerHeight - 88);
      setHeight(Math.min(maxHeight, Math.max(180, nextHeight)));
    };
    const stopResize = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.classList.remove("is-console-resizing");
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      document.body.classList.remove("is-console-resizing");
    };
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizingRef.current = true;
    document.body.classList.add("is-console-resizing");
  };

  if (!open) return null;

  return (
    <div className={`console ${open ? "open" : ""}`} style={{ height }}>
      <div className="console-header">
        <div className="console-title">{t("console.title")}</div>
        <div className="console-actions">
          <IconButton iconName="trash" onClick={onClear}>{t("console.clear")}</IconButton>
          <IconButton iconName="close" onClick={onToggle}>{t("console.close")}</IconButton>
        </div>
      </div>
      <div
        className="console-resizer"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("console.title")}
      />
      <div className="console-body">
        {items.length === 0 ? <div className="log-entry"><div className="log-line">{t("console.empty")}</div></div> : null}
        {items.map((item, idx) => (
          <div key={`${item.at}-${idx}`} className="log-entry">
            <div className="log-header">
              <span className="log-title">{item.title}</span>
              <span className="log-time">{item.at}</span>
            </div>
            <div className="log-line">{item.level === "error" ? "[ERROR] " : ""}{item.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
