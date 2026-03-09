import type { ReactNode } from "react";
import { Chips } from "@x-happy-x/ui-kit";

type Option<T extends string> = {
  value: T;
  label: ReactNode;
};

type Props<T extends string> = {
  value: T;
  options: Array<Option<T>>;
  onChange: (next: T) => void;
  disabled?: boolean;
};

export function RadioChips<T extends string>({ value, options, onChange, disabled = false }: Props<T>) {
  const optionsForUiKit = options.map((opt) => ({ value: opt.value, label: opt.label })) as Array<{ value: string; label: ReactNode }>;
  return (
    <div role="radiogroup" aria-disabled={disabled}>
      <Chips
        options={optionsForUiKit}
        value={value}
        onChange={(next) => {
          if (disabled) return;
          onChange(next as T);
        }}
        className="ui-chip-group"
      />
    </div>
  );
}
