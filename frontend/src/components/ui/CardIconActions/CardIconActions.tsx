import { CardIconActions as UiKitCardIconActions } from "@x-happy-x/ui-kit";
import type { IconName } from "../UiIcon";
import { UiIcon } from "../UiIcon";

type ActionItem = {
  key?: string;
  iconName: IconName;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "accent" | "ghost";
};

type Props = {
  actions: ActionItem[];
  className?: string;
};

export function CardIconActions({ actions, className = "" }: Props) {
  return (
    <UiKitCardIconActions
      className={["card-icon-actions", className].filter(Boolean).join(" ")}
      actions={actions.map((action, idx) => ({
        key: action.key || `${action.iconName}-${idx}`,
        icon: <UiIcon name={action.iconName} />,
        tooltip: action.tooltip,
        onClick: action.onClick,
        disabled: action.disabled,
        tone: action.variant === "accent" ? "danger" : "default",
      }))}
    />
  );
}
