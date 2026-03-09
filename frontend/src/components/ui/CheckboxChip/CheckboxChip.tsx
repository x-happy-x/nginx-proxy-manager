import type { ReactNode } from "react";
import { Chips } from "@x-happy-x/ui-kit";

type Props = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
};

export function CheckboxChip({ checked, onChange, label, disabled = false }: Props) {
  const value = checked ? "checked" : "unchecked";
  return (
    <div role="checkbox" aria-checked={checked} aria-pressed={checked} aria-disabled={disabled}>
      <Chips
        options={[{ value: "checked", label }]}
        value={value}
        onChange={() => {
          if (disabled) return;
          onChange(!checked);
        }}
        className="ui-chip-group"
      />
    </div>
  );
}
