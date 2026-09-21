import type { ButtonHTMLAttributes, ReactNode } from "react";
import { UiIcon, type IconName } from "../UiIcon";
import { TooltipAnchor } from "../TooltipAnchor";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "accent" | "ghost";
  icon?: ReactNode;
  children?: ReactNode;
  iconName?: IconName;
  iconOnly?: boolean;
  tooltip?: string;
};

export function IconButton({
  variant = "default",
  icon,
  children,
  className = "",
  iconName,
  iconOnly = false,
  tooltip,
  ...rest
}: Props) {
  const cls = [
    "ui-icon-btn",
    `ui-icon-btn--${variant}`,
    iconOnly ? "ui-icon-btn--icon-only" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const ariaLabel = rest["aria-label"] || (iconOnly ? tooltip : undefined);
  const button = (
    <button type="button" className={cls} {...rest} aria-label={ariaLabel}>
      {iconName ? <UiIcon name={iconName} /> : null}
      {!iconName && icon ? (
        <span className="ui-icon-btn__icon">{icon}</span>
      ) : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
  if (tooltip) {
    return <TooltipAnchor tooltip={tooltip}>{button}</TooltipAnchor>;
  }
  return button;
}
