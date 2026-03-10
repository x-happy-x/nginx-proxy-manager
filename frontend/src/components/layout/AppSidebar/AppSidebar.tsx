import "./AppSidebar.scss";
import { Button, IconButton, TabButton } from "../../ui";
import { useI18n } from "../../../i18n";
import { LanguageMenu } from "../TopBar/LanguageMenu";
import { TABS, type TabKey } from "../SidebarTabs/tabs";

type Props = {
  active: TabKey;
  dirty: boolean;
  busy: boolean;
  isDarkTheme: boolean;
  consoleOpen: boolean;
  onChange: (tab: TabKey) => void;
  onReload: () => void;
  onSave: () => void;
  onToggleTheme: () => void;
  onToggleConsole: () => void;
};

export function AppSidebar({ active, dirty, busy, isDarkTheme, consoleOpen, onChange, onReload, onSave, onToggleTheme, onToggleConsole }: Props) {
  const { locale, setLocale, t } = useI18n();

  return (
    <aside className="app-sidebar">
      <div className="app-sidebar__main">
        <div className="app-sidebar__brand">
          <span className="app-sidebar__eyebrow">Legacy UI</span>
          <div className="app-sidebar__title-row">
            <strong>{t("top.title")}</strong>
            {dirty ? <span className="chip-token chip-token--warning">{t("common.unsaved")}</span> : <span className="chip-token chip-token--soft">live</span>}
          </div>
          <p>Новая левая панель заменила старые верхнюю и боковую панели в основном интерфейсе.</p>
        </div>

        <nav className="app-sidebar__nav" aria-label="Primary">
          {TABS.map((tab) => (
            <TabButton
              key={tab.key}
              active={tab.key === active}
              onClick={() => onChange(tab.key)}
              iconName={tab.icon}
              className="app-sidebar__tab"
              title={t(tab.labelKey)}
              aria-label={t(tab.labelKey)}
            >
              {t(tab.labelKey)}
            </TabButton>
          ))}
        </nav>
      </div>

      <div className="app-sidebar__footer">
        <div className="app-sidebar__toolbar">
          <LanguageMenu locale={locale} onChange={setLocale} title={t("top.language")} ruLabel={t("lang.ru")} enLabel={t("lang.en")} />
          <IconButton iconName="console" iconOnly tooltip={t("top.console")} title={t("top.console")} onClick={onToggleConsole} aria-pressed={consoleOpen} />
          <IconButton iconName="theme" iconOnly tooltip={t("top.theme")} title={t("top.theme")} onClick={onToggleTheme} aria-pressed={isDarkTheme} />
          <IconButton iconName="refresh" iconOnly tooltip={t("top.reload")} title={t("top.reload")} onClick={onReload} disabled={busy} />
        </div>

        <Button variant="accent" iconName="save" onClick={onSave} disabled={busy || !dirty} className="app-sidebar__save">
          {t("top.save")}
        </Button>
      </div>
    </aside>
  );
}
