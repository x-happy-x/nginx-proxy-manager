import type { ReactNode } from "react";
type Props = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
};
export function CheckboxChip({ checked, onChange, label, disabled }: Props) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      className={`ui-chip ${checked ? "active" : ""}`}
      onClick={() => onChange(!checked)}
    >
      {checked ? "✓ " : ""}
      {label}
    </button>
  );
}
