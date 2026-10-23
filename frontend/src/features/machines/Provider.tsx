import type { ReactNode } from "react";
import type { Host } from "../../platform/sdk";
import type { Computer } from "../pc/model";
import { PcProvider } from "../pc/context";
import { usePve } from "../pve/context";

/** Both sources use the same privacy control, including container port tooltips. */
export function MachineComputers({ children, ...props }: { host: Host; computers: Computer[]; machinePages?: boolean; children: ReactNode }) {
  const pve = usePve();
  return <PcProvider {...props} privacy={[pve.hide, pve.setHide]}>{children}</PcProvider>;
}
