import { useCallback, useEffect, useState } from "react";
import { fetchNetwork, fetchTopology, type Analysis, type NetworkPayload, type Topology } from "../api";
import { Icon } from "../components/ui/Icon";
import { Alert, Segmented } from "../components/ui/controls";
import { NetworkAnalyzer } from "../features/network/Analyzer";
import { Antenna } from "../features/network/Antenna";
import { AutoScan } from "../features/network/AutoScan";
import { DnsFinder } from "../features/network/DnsFinder";
import { NetworkOverview } from "../features/network/Overview";
import { NetworkScheme } from "../features/network/Scheme";
import { PageHeader } from "../navigation";
import { errText } from "../lib/format";

export type NetTab = "overview" | "scheme" | "antenna" | "dns" | "analyzer" | "scan";
type Tab = NetTab;

// Tabs are section tabs of «Сеть» now (NPM-30): the console passes the page.
const PAGE_OF: Record<Tab, "network" | "scheme" | "antenna" | "netdns" | "analyzer" | "scan"> = { overview: "network", scheme: "scheme", antenna: "antenna", dns: "netdns", analyzer: "analyzer", scan: "scan" };
type Period = "60" | "360" | "1440";
const TAB_KEY = "homenet.network.tab";
const TABS: Array<[Tab, string]> = [
  ["overview", "Обзор"],
  ["scheme", "Схема"],
  ["antenna", "Антенна"],
  ["dns", "DNS"],
  ["analyzer", "Анализатор"],
  ["scan", "Автопроверка"],
];

function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY) as Tab | null;
    return v && TABS.some(([id]) => id === v) ? v : "overview";
  } catch {
    return "overview";
  }
}

export function Network({ analyze, tab: forced, onTab }: { analyze?: string; tab?: Tab; onTab?: (t: Tab) => void } = {}) {
  const [tabState, setTabState] = useState<Tab>(() => (analyze ? "analyzer" : readTab()));
  const tab = forced ?? tabState;
  const [period, setPeriod] = useState<Period>("60");
  const [data, setData] = useState<NetworkPayload | null>(null);
  const [topo, setTopo] = useState<Topology | null>(null);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState(0);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);

  const setTab = (next: Tab) => {
    if (onTab) {
      onTab(next);
      return;
    }
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* per-browser preference */
    }
  };

  const load = useCallback(async () => {
    try {
      setData(await fetchNetwork(Number(period)));
      setUpdated(Date.now());
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, [period]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (tab !== "scheme") return;
    const pull = () => fetchTopology().then(setTopo).catch((err) => setError(errText(err)));
    void pull();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void pull();
    }, 30000);
    return () => clearInterval(timer);
  }, [tab]);

  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ago = updated ? Math.max(0, Math.round((Date.now() - updated) / 1000)) : null;
  const down = data?.availability.filter((a) => a.group === "summary" && a.valid && !a.ok) || [];

  return (
    <>
      <PageHeader
        page={PAGE_OF[tab]}
        actions={
          <>
            <span className="res-live" title="Данные обновляются каждые 10 секунд">
              <span className={`res-live-dot${error ? " is-off" : ""}`} />
              {error ? "нет связи" : ago == null ? "загрузка…" : ago < 3 ? "сейчас" : `${ago} с назад`}
            </span>
            {tab === "overview" ? (
              <Segmented<Period>
                label="Период"
                value={period}
                onChange={setPeriod}
                options={[
                  { value: "60", label: "1 час" },
                  { value: "360", label: "6 часов" },
                  { value: "1440", label: "24 часа" },
                ]}
              />
            ) : null}
          </>
        }
      />
      {error ? <Alert tone="danger" title="Нет данных от менеджера">{error}</Alert> : null}
      <div className="res">
        {forced ? null : (
        <div className="res-tabs" role="tablist" aria-label="Раздел сети">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`res-tab${tab === id ? " is-active" : ""}`} onClick={() => setTab(id)}>
              {label}
              {id === "overview" && down.length ? (
                <span className="res-tab-alert" title={down.map((d) => d.name).join(", ")}>
                  <Icon name="alert" size={13} />
                  <span className="sr-only">есть сбои</span>
                </span>
              ) : null}
              {id === "analyzer" && analysis ? <span className="badge net-inline-badge">{analysis.host}</span> : null}
            </button>
          ))}
        </div>
        )}
        {tab === "overview" ? data ? <NetworkOverview data={data} onAntenna={() => setTab("antenna")} /> : <div className="launcher-loading">Собираю данные…</div> : null}
        {tab === "scheme" ? <NetworkScheme topo={topo} net={data} /> : null}
        {tab === "antenna" ? <Antenna /> : null}
        {tab === "dns" ? <DnsFinder /> : null}
        {tab === "analyzer" ? <NetworkAnalyzer result={analysis} onResult={setAnalysis} initialTarget={analyze} /> : null}
        {tab === "scan" ? (
          <AutoScan
            onOpen={(a) => {
              setAnalysis(a);
              setTab("analyzer");
            }}
          />
        ) : null}
      </div>
    </>
  );
}
