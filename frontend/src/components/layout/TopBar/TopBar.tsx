import "./TopBar.scss";
import { IconButton } from "../../ui";
import { useI18n } from "../../../i18n";
import { LanguageMenu } from "./LanguageMenu";

type Props = {
  dirty: boolean;
  busy: boolean;
  isDarkTheme: boolean;
  consoleOpen: boolean;
  onReload: () => void;
  onSave: () => void;
  onToggleTheme: () => void;
  onToggleConsole: () => void;
};

export function TopBar({ dirty, busy, isDarkTheme, consoleOpen, onReload, onSave, onToggleTheme, onToggleConsole }: Props) {
  const { locale, setLocale, t } = useI18n();

  return (
    <header className="topbar">
      <div className="brand">
        <span className="dot" />
        <h1>{t("top.title")}</h1>
      </div>
      <div className="actions">
        <LanguageMenu locale={locale} onChange={setLocale} title={t("top.language")} ruLabel={t("lang.ru")} enLabel={t("lang.en")} />
        <IconButton iconName="console" iconOnly tooltip={t("top.console")} title={t("top.console")} onClick={onToggleConsole} aria-pressed={consoleOpen} />
        <IconButton iconName="theme" iconOnly tooltip={t("top.theme")} title={t("top.theme")} onClick={onToggleTheme} aria-pressed={isDarkTheme} />
        <IconButton iconName="refresh" iconOnly tooltip={t("top.reload")} title={t("top.reload")} onClick={onReload} disabled={busy} />
        {dirty ? <span className="dirty-indicator chip-token chip-token--warning">{t("common.unsaved")}</span> : null}
        <IconButton iconName="save" iconOnly tooltip={t("top.save")} title={t("top.save")} variant="accent" onClick={onSave} disabled={busy || !dirty} />
      </div>
    </header>
  );
}
