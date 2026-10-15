import { MihomoProvider } from "../features/mihomo/context";
import { CoreGate } from "../features/mihomo/shared";
import { VpnOverview } from "../features/mihomo/VpnOverview";
import { VpnHome } from "../features/mihomo/board/VpnHome";
import { ServersPage } from "../features/mihomo/board/ServersPage";
import { VpnStats } from "../features/mihomo/board/VpnStats";
import { SectionPage } from "../features/mihomo/board/Sections";
import { VpnServices } from "../features/mihomo/VpnServices";
import { VpnRoute } from "../features/mihomo/VpnRoute";
import { Proxies } from "../features/mihomo/Proxies";
import { Torrents } from "../features/mihomo/Torrents";
import { Connections } from "../features/mihomo/Connections";
import { Rules } from "../features/mihomo/Rules";
import { Traffic } from "../features/mihomo/Traffic";
import { CoreLogs } from "../features/mihomo/CoreLogs";
import { Config } from "../features/mihomo/Config";
import { Core } from "../features/mihomo/Core";
import { Why } from "../features/mihomo/Why";
import { ModuleBoundary, ModuleTabs, usePage } from "./module-base";
import type { Host } from "./sdk";

function VPNModule({ host }: { host: Host }) {
  const raw = usePage();
  const page = raw === "tailscale" || raw === "olcrtc" ? "subs" : raw;
  const navigate = host.navigate;
  const config = () => navigate("coreconfig");
  const pages: Record<string, React.ReactNode> = {
    vpn: <VpnHome onNavigate={navigate} />, vservers: <ServersPage navigate={navigate} />, vstats: <VpnStats />, vnow: <VpnOverview onNavigate={navigate} />, vpnsvc: <VpnServices onNavigate={navigate} />,
    vroute: <VpnRoute onNavigate={navigate} />, subs: <ServersPage navigate={navigate} initial={raw === "olcrtc" ? "olcrtc" : raw === "tailscale" ? "Tailscale" : ""} />, proxies: <Proxies />,
    torrents: <Torrents />, checks: <ServersPage navigate={navigate} />,
    connections: <Connections onAnalyze={() => navigate("why")} />, rules: <Rules onEdit={config} />,
    traffic: <Traffic />, corelog: <CoreLogs />, coreconfig: <Config />, core: <Core onConfig={config} />,
    why: <Why onNodes={() => navigate("proxies")} />,
  };
  return <MihomoProvider active log={(title, body) => host.notify(`${title}: ${body}`)}><ModuleTabs ids={Object.keys(pages)} host={host} page={page} /><CoreGate><SectionPage page={pages[page] ? page : "vpn"} navigate={navigate}>{pages[page] || pages.vpn}</SectionPage></CoreGate></MihomoProvider>;
}
export function mount(element: HTMLElement, host: Host) {
  if (host.protocol !== 1) throw new Error("Несовместимая версия HomeNet");
  const root = host.createRoot(element);
  root.render(<ModuleBoundary><VPNModule host={host} /></ModuleBoundary>);
  return () => root.unmount();
}
