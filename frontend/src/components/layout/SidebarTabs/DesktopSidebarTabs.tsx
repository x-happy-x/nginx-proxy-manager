import { Button, TabButton } from "../../ui";
import { useI18n } from "../../../i18n";
import { TABS, type TabKey } from "./tabs";

type Props = {
  active: TabKey;
  onChange: (tab: TabKey) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
};

export function DesktopSidebarTabs({ active, onChange, collapsed, onToggleCollapse }: Props) {
  const { t } = useI18n();
  const collapseTitle = collapsed ? t("nav.expand") : t("nav.collapse");

  return (
    <aside className={["sidebar-tabs", collapsed ? "is-collapsed" : ""].filter(Boolean).join(" ")}>
      <Button
        className="sidebar-tabs__toggle"
        variant="ghost"
        compact
        iconName="menu"
        onClick={onToggleCollapse}
        title={collapseTitle}
        aria-label={collapseTitle}
        aria-pressed={collapsed}
      >
        {collapseTitle}
      </Button>
      {TABS.map((tab) => (
        <TabButton
          key={tab.key}
          active={tab.key === active}
          onClick={() => onChange(tab.key)}
          iconName={tab.icon}
          iconOnly={collapsed}
          tooltip={collapsed ? t(tab.labelKey) : undefined}
          title={t(tab.labelKey)}
          aria-label={t(tab.labelKey)}
        >
          {t(tab.labelKey)}
        </TabButton>
      ))}
    </aside>
  );
}
