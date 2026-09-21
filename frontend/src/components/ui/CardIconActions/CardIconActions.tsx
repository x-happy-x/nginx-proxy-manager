import type { IconName } from "../UiIcon";
import { IconButton } from "../IconButton";
type ActionItem = {
  key?: string;
  iconName: IconName;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "accent" | "ghost";
};
export function CardIconActions({
  actions,
  className = "",
}: {
  actions: ActionItem[];
  className?: string;
}) {
  return (
    <div className={`card-icon-actions ${className}`}>
      {actions.map((action, index) => (
        <IconButton key={action.key || index} iconOnly {...action} />
      ))}
    </div>
  );
}
