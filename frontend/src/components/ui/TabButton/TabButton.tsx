import type { ButtonHTMLAttributes, ReactNode } from "react";
import { UiIcon, type IconName } from "../UiIcon";
type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  children: ReactNode;
  iconName?: IconName;
  iconOnly?: boolean;
  tooltip?: string;
};
export function TabButton({
  active,
  className = "",
  children,
  iconName,
  iconOnly,
  tooltip,
  ...rest
}: Props) {
  return (
    <button
      type="button"
      className={`ui-tab-btn ${active ? "active" : ""} ${iconOnly ? "icon-only" : ""} ${className}`}
      aria-current={active ? "page" : undefined}
      title={tooltip}
      {...rest}
    >
      {iconName ? <UiIcon name={iconName} /> : null}
      <span className="ui-tab-btn__label">{children}</span>
    </button>
  );
}
