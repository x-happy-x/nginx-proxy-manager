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
  return (
    <div className={`console ${open ? "open" : ""}`}>
      <div className="console-header">
        <div className="console-title">{t("console.title")}</div>
        <div className="console-actions">
          <IconButton iconName="trash" onClick={onClear}>{t("console.clear")}</IconButton>
          <IconButton iconName="close" onClick={onToggle}>{t("console.close")}</IconButton>
        </div>
      </div>
      <div className="console-resizer" />
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
