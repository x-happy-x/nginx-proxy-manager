import type { ButtonHTMLAttributes, ReactNode } from "react";
import { TabButton as UiKitTabButton } from "@x-happy-x/ui-kit";
import { UiIcon, type IconName } from "../UiIcon";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  children: ReactNode;
  iconName?: IconName;
  iconOnly?: boolean;
  tooltip?: string;
};

export function TabButton({ active = false, className = "", children, iconName, iconOnly = false, tooltip, ...rest }: Props) {
  const cls = ["ui-tab-btn", active ? "active" : "", iconOnly ? "icon-only" : "", className].filter(Boolean).join(" ");
  return (
    <UiKitTabButton
      active={active}
      className={cls}
      icon={iconName ? <UiIcon name={iconName} /> : null}
      iconOnly={iconOnly}
      tooltip={tooltip}
      {...rest}
    >
      {children}
    </UiKitTabButton>
  );
}
