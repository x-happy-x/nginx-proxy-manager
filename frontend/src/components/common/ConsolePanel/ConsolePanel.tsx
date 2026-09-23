import type { ConsoleItem } from "../../../types";
import "./ConsolePanel.scss";
import { IconButton, UiIcon } from "../../ui";
import { useI18n } from "../../../i18n";

type Props = {
  items: ConsoleItem[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
};

export function ConsolePanel({ items, open, onToggle, onClear }: Props) {
  const { t } = useI18n();
  if (!open) return null;
  const errorCount = items.filter((item) => item.level === "error").length;

  return (
    <>
      <button
        className="console-backdrop"
        aria-label={t("console.close")}
        onClick={onToggle}
      />
      <aside
        className="console open"
        role="dialog"
        aria-modal="true"
        aria-label="Центр операций"
      >
        <div className="console-header">
          <div className="console-heading">
            <span className="console-heading-icon"><UiIcon name="console" /></span>
            <div>
              <div className="console-title">Центр операций</div>
              <p>Проверки, сохранения и ответы менеджера за текущий сеанс.</p>
            </div>
          </div>
          <IconButton iconName="close" iconOnly tooltip={t("console.close")} onClick={onToggle} />
        </div>
        <div className="console-summary">
          <div><strong>{items.length}</strong><span>операций</span></div>
          <div className={errorCount ? "has-errors" : ""}><strong>{errorCount}</strong><span>ошибок</span></div>
          <IconButton iconName="trash" onClick={onClear} disabled={items.length === 0}>{t("console.clear")}</IconButton>
        </div>
        <div className="console-body">
          {items.length === 0 ? (
            <div className="console-empty">
              <UiIcon name="console" />
              <strong>Операций пока нет</strong>
              <span>Здесь появятся результаты проверок, сохранений и обновлений.</span>
            </div>
          ) : null}
          {items.map((item, idx) => (
            <article key={`${item.at}-${idx}`} className={`log-entry ${item.level === "error" ? "is-error" : "is-ok"}`}>
              <span className="log-status">{item.level === "error" ? "!" : "✓"}</span>
              <div>
                <div className="log-header">
                  <span className="log-title">{item.title}</span>
                  <time className="log-time">{item.at}</time>
                </div>
                <div className="log-line">{item.message}</div>
              </div>
            </article>
          ))}
        </div>
      </aside>
    </>
  );
}
