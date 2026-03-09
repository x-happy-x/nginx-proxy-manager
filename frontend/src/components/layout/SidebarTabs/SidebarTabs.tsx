import "./SidebarTabs.scss";
import { DesktopSidebarTabs } from "./DesktopSidebarTabs";
import { MobileDockTabs } from "./MobileDockTabs";
import type { TabKey } from "./tabs";

type Props = {
  active: TabKey;
  onChange: (tab: TabKey) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
};

export function SidebarTabs({ active, onChange, collapsed, onToggleCollapse }: Props) {
  return (
    <>
      <DesktopSidebarTabs active={active} onChange={onChange} collapsed={collapsed} onToggleCollapse={onToggleCollapse} />
      <MobileDockTabs active={active} onChange={onChange} />
    </>
  );
}
