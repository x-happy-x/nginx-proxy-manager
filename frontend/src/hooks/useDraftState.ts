import { useState } from "react";

export function useDraftState<T>(initialValue: T) {
  const [value, setValue] = useState<T>(initialValue);

  const setField = <K extends keyof T>(key: K, next: T[K]) => {
    setValue((prev) => ({ ...prev, [key]: next }));
  };

  const reset = (nextValue?: T) => {
    setValue(nextValue ?? initialValue);
  };

  return {
    value,
    setValue,
    setField,
    reset,
  };
}
