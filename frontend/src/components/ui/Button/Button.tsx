import type { ButtonHTMLAttributes, ReactNode } from "react";
import { UiIcon, type IconName } from "../UiIcon";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "accent" | "ghost";
  children: ReactNode;
  compact?: boolean;
  iconName?: IconName;
};

export function Button({
  variant = "default",
  compact = false,
  className = "",
  children,
  iconName,
  ...rest
}: Props) {
  const cls = [
    "ui-btn",
    `ui-btn--${variant}`,
    compact ? "ui-btn--compact" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} {...rest}>
      {iconName ? <UiIcon name={iconName} /> : null}
      {children}
    </button>
  );
}
