import type { ButtonHTMLAttributes, ReactNode } from "react";
import { IconButton as UiKitIconButton } from "@x-happy-x/ui-kit";
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

export function IconButton({ variant = "default", icon, children, className = "", iconName, iconOnly = false, tooltip, ...rest }: Props) {
  const tone = variant === "accent" ? "danger" : "default";
  const cls = ["ui-icon-btn", `ui-icon-btn--${variant}`, iconOnly ? "ui-icon-btn--icon-only" : "", className]
    .filter(Boolean)
    .join(" ");
  const ariaLabel = rest["aria-label"] || (iconOnly ? tooltip : undefined);
  const button = (
    <UiKitIconButton tone={tone} className={cls} {...rest} aria-label={ariaLabel}>
      {iconName ? <UiIcon name={iconName} /> : null}
      {!iconName && icon ? <span className="ui-icon-btn__icon">{icon}</span> : null}
      {children ? <span>{children}</span> : null}
    </UiKitIconButton>
  );
  if (tooltip) {
    return <TooltipAnchor tooltip={tooltip}>{button}</TooltipAnchor>;
  }
  return button;
}
