import ProxyApp from "./ProxyApp";
import type { Host } from "./sdk";
import { ModuleBoundary } from "./module-base";
export function mount(element: HTMLElement, host: Host) {
  if (host.protocol !== 1) throw new Error("Несовместимая версия HomeNet");
  const root = host.createRoot(element);
  root.render(<ModuleBoundary><ProxyApp host={host} /></ModuleBoundary>);
  return () => root.unmount();
}
