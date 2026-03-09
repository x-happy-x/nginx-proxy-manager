import { TabButton } from "../../ui";
import { useI18n } from "../../../i18n";
import { TABS, type TabKey } from "./tabs";

type Props = {
  active: TabKey;
  onChange: (tab: TabKey) => void;
};

export function MobileDockTabs({ active, onChange }: Props) {
  const { t } = useI18n();

  return (
    <nav className="mobile-tabs">
      {TABS.map((tab) => (
        <TabButton
          key={tab.key}
          active={tab.key === active}
          onClick={() => onChange(tab.key)}
          iconName={tab.icon}
          iconOnly
          title={t(tab.labelKey)}
          aria-label={t(tab.labelKey)}
        >
          {t(tab.labelKey)}
        </TabButton>
      ))}
    </nav>
  );
}
