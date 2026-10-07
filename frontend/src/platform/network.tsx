import { Network, type NetTab } from "../pages/Network";
import { Resources } from "../pages/Resources";
import { ModuleBoundary, ModuleTabs, usePage } from "./module-base";
import type { Host } from "./sdk";

const tabs: Record<string, NetTab> = { network: "overview", scheme: "scheme", antenna: "antenna", netdns: "dns", analyzer: "analyzer", scan: "scan" };
function NetworkModule({ host }: { host: Host }) {
  const page = usePage();
  return <><ModuleTabs ids={[...Object.keys(tabs), "resources"]} page={page} host={host} />{page === "resources" ? <Resources /> : <Network tab={tabs[page] || "overview"} onTab={tab => host.navigate(Object.keys(tabs).find(k => tabs[k] === tab) || "network")} />}</>;
}
export function mount(element: HTMLElement, host: Host) {
  if (host.protocol !== 1) throw new Error("Несовместимая версия HomeNet");
  const root = host.createRoot(element);
  root.render(<ModuleBoundary><NetworkModule host={host} /></ModuleBoundary>);
  return () => root.unmount();
}
