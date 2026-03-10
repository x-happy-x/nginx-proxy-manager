import { useEffect, useMemo, useState } from "react";
import {
  addDnsHost,
  applyRoutes,
  applyStub,
  backupRouteFile,
  deleteCert,
  deleteDnsHost,
  deleteNdnsProxy,
  fetchCaStatus,
  fetchCerts,
  fetchConfigs,
  fetchDnsHosts,
  fetchLogs,
  fetchNdns,
  fetchNginxStatus,
  fetchRouteErrors,
  fetchRouteFiles,
  fetchRouteLogs,
  fetchRoutes,
  fetchUiBind,
  generateCa,
  issueCa,
  readConfig,
  restartUi,
  saveNdnsProxy,
  saveRoutes,
  selectRouteFile,
  suggestNdnsPort,
  testCert,
  uploadCa,
  uploadStub,
  writeConfig,
} from "./api";
import { ConsolePanel } from "./components/common/ConsolePanel";
import { SidebarTabs, type TabKey } from "./components/layout/SidebarTabs";
import { TopBar } from "./components/layout/TopBar";
import { CaModal } from "./components/modals/CaModal";
import { ConfigEditorModal } from "./components/modals/ConfigEditorModal";
import { CertsTab } from "./components/tabs/CertsTab";
import { DnsTab } from "./components/tabs/DnsTab";
import { LogsTab } from "./components/tabs/LogsTab";
import { OverviewTab } from "./components/tabs/OverviewTab";
import { RoutingTab } from "./components/tabs/RoutingTab";
import { ServersTab } from "./components/tabs/ServersTab";
import type {
  ConfigItem,
  ConsoleItem,
  NdnsProxy,
  NginxStatus,
  RouteLogItem,
  RoutesDocument,
  SslMode,
} from "./types";
import { I18nContext, makeT, type Locale } from "./i18n";
import "./styles/app.scss";

const TAB_KEYS: TabKey[] = ["overview", "servers", "certs", "dns", "logs", "routing"];
type DnsGrouped = { host: string; addresses: string[] };

function tabFromHash(hash: string): TabKey {
  const raw = hash.replace(/^#\/?/, "").trim().toLowerCase();
  if (TAB_KEYS.includes(raw as TabKey)) {
    return raw as TabKey;
  }
  return "overview";
}

function sanitize(doc: RoutesDocument): RoutesDocument {
  const clone = JSON.parse(JSON.stringify(doc)) as RoutesDocument;
  delete clone._routes_file;
  return clone;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err || "unknown error");
}

function normalizeDnsItems(items: DnsGrouped[]): DnsGrouped[] {
  return [...items]
    .map((item) => ({
      host: String(item.host || "").trim(),
      addresses: [...(item.addresses || [])].map((addr) => String(addr || "").trim()).filter(Boolean).sort(),
    }))
    .filter((item) => item.host)
    .sort((a, b) => a.host.localeCompare(b.host));
}

function normalizeNdnsItems(items: NdnsProxy[]): NdnsProxy[] {
  return [...items]
    .map((item) => {
      const proto: NdnsProxy["upstream"]["proto"] = item.upstream?.proto === "https" ? "https" : "http";
      return {
        ...item,
        name: String(item.name || "").trim(),
        domain: String(item.domain || "").trim(),
        upstream: {
          proto,
          target: String(item.upstream?.target || "").trim(),
          port: String(item.upstream?.port || "").trim(),
        },
        sslRedirect: !!item.sslRedirect,
        securityLevel: (item.securityLevel || "") as NdnsProxy["securityLevel"],
      };
    })
    .filter((item) => item.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem("theme");
    return stored === "dark" ? "dark" : "light";
  });
  const [locale, setLocale] = useState<Locale>(() => {
    const stored = localStorage.getItem("locale");
    return stored === "en" ? "en" : "ru";
  });
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => localStorage.getItem("nav_collapsed") === "1");
  const [activeTab, setActiveTab] = useState<TabKey>(() => tabFromHash(window.location.hash));
  const [doc, setDoc] = useState<RoutesDocument | null>(null);
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<NginxStatus | null>(null);
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [routeFiles, setRouteFiles] = useState<string[]>([]);
  const [selectedRouteFile, setSelectedRouteFile] = useState("");

  const [caInstalled, setCaInstalled] = useState(false);
  const [certs, setCerts] = useState<Array<{ host: string; has_key: boolean; path: string }>>([]);
  const [dnsItems, setDnsItems] = useState<DnsGrouped[]>([]);
  const [savedDnsItems, setSavedDnsItems] = useState<DnsGrouped[]>([]);
  const [ndnsText, setNdnsText] = useState("HTTP: - | HTTPS: -");
  const [ndnsItems, setNdnsItems] = useState<NdnsProxy[]>([]);
  const [savedNdnsItems, setSavedNdnsItems] = useState<NdnsProxy[]>([]);

  const [logsType, setLogsType] = useState<"access" | "error">("access");
  const [logsFilter, setLogsFilter] = useState("");
  const [logsLimit, setLogsLimit] = useState(200);
  const [logLines, setLogLines] = useState<string[]>([]);

  const [routeMode, setRouteMode] = useState<"all" | "4xx" | "5xx" | "errors">("all");
  const [routeFilter, setRouteFilter] = useState("");
  const [routeLimit, setRouteLimit] = useState(200);
  const [routeSmart, setRouteSmart] = useState({ host: "", targetIp: "", listenEndpoint: "" });
  const [routeItems, setRouteItems] = useState<RouteLogItem[]>([]);

  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleItems, setConsoleItems] = useState<ConsoleItem[]>([]);

  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [configModalTitle, setConfigModalTitle] = useState("");
  const [configModalPath, setConfigModalPath] = useState("");
  const [configModalEditable, setConfigModalEditable] = useState(false);
  const [configModalContent, setConfigModalContent] = useState("");
  const [configModalId, setConfigModalId] = useState("");

  const [caModalOpen, setCaModalOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("locale", locale);
  }, [locale]);

  useEffect(() => {
    localStorage.setItem("nav_collapsed", navCollapsed ? "1" : "0");
  }, [navCollapsed]);

  useEffect(() => {
    const onHashChange = () => {
      setActiveTab(tabFromHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) {
      window.history.replaceState(null, "", `#/${activeTab}`);
    }
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const docDirty = useMemo(() => {
    if (!doc) return false;
    return JSON.stringify(sanitize(doc)) !== baseline;
  }, [baseline, doc]);
  const dnsDirty = useMemo(() => {
    return JSON.stringify(normalizeDnsItems(dnsItems)) !== JSON.stringify(normalizeDnsItems(savedDnsItems));
  }, [dnsItems, savedDnsItems]);
  const ndnsDirty = useMemo(() => {
    return JSON.stringify(normalizeNdnsItems(ndnsItems)) !== JSON.stringify(normalizeNdnsItems(savedNdnsItems));
  }, [ndnsItems, savedNdnsItems]);
  const dirty = docDirty || dnsDirty || ndnsDirty;
  const t = useMemo(() => makeT(locale), [locale]);

  const setTab = (tab: TabKey) => {
    setActiveTab(tab);
    const nextHash = `#/${tab}`;
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, "", nextHash);
    }
  };

  const routeVisibleItems = useMemo(() => {
    return routeItems.filter((item) => {
      const hostOk = !routeSmart.host || String(item.host || "").includes(routeSmart.host);
      const targetOk = !routeSmart.targetIp || String(item.target_ip || "").includes(routeSmart.targetIp);
      const listenOk = !routeSmart.listenEndpoint || String(item.listen_endpoint || "").includes(routeSmart.listenEndpoint);
      return hostOk && targetOk && listenOk;
    });
  }, [routeItems, routeSmart]);

  const pushLog = (title: string, message: string, level: ConsoleItem["level"] = "info") => {
    setConsoleItems((prev) => [{ at: new Date().toLocaleTimeString(), level, title, message }, ...prev].slice(0, 300));
  };

  const loadRoutesDoc = async () => {
    const payload = await fetchRoutes();
    setDoc(payload);
    setBaseline(JSON.stringify(sanitize(payload)));
  };

  const loadOverview = async () => {
    const [s, c, rf] = await Promise.all([fetchNginxStatus(), fetchConfigs(), fetchRouteFiles()]);
    setStatus(s.status);
    setConfigs(c.items || []);
    setRouteFiles(rf.items || []);
    setSelectedRouteFile(rf.active || "");
  };

  const loadCertPart = async () => {
    const [ca, list] = await Promise.all([fetchCaStatus(), fetchCerts()]);
    setCaInstalled(!!ca.installed);
    setCerts(list.items || []);
  };

  const loadDnsNdns = async () => {
    const [dns, ndns] = await Promise.all([fetchDnsHosts(), fetchNdns()]);
    const grouped = new Map<string, Set<string>>();
    (dns.items || []).forEach((item) => {
      if (!grouped.has(item.host)) grouped.set(item.host, new Set());
      grouped.get(item.host)?.add(item.address);
    });
    const nextDns = normalizeDnsItems(Array.from(grouped.entries()).map(([host, addresses]) => ({ host, addresses: Array.from(addresses) })));
    const nextNdns = normalizeNdnsItems(ndns.data?.proxies || []);
    setDnsItems(nextDns);
    setSavedDnsItems(nextDns);
    setNdnsItems(nextNdns);
    setSavedNdnsItems(nextNdns);
    setNdnsText(`HTTP: ${ndns.data?.http?.port ?? "-"} | HTTPS: ${ndns.data?.http?.sslPort ?? "-"}`);
  };

  const loadNginxLogs = async () => {
    const data = await fetchLogs(logsType, logsFilter, logsLimit);
    setLogLines(data.lines || []);
  };

  const loadRouteLogItems = async () => {
    if (routeMode === "errors") {
      const data = await fetchRouteErrors(routeFilter, routeLimit);
      setRouteItems(data.items || []);
      return;
    }
    const statusGroup = routeMode === "all" ? "" : routeMode;
    const data = await fetchRouteLogs(routeFilter, routeLimit, statusGroup);
    setRouteItems(data.items || []);
  };

  const boot = async () => {
    setBusy(true);
    try {
      await Promise.all([loadRoutesDoc(), loadOverview(), loadCertPart(), loadDnsNdns()]);
      await Promise.all([loadNginxLogs(), loadRouteLogItems()]);
      const bind = await fetchUiBind();
      setDoc((prev) => (prev ? { ...prev, globals: { ...prev.globals, ui: { host: bind.host, port: bind.port } } } : prev));
      pushLog("Boot", "UI data loaded");
    } catch (error) {
      pushLog("Boot", errText(error), "error");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void boot();
  }, []);

  const guardDoc = (): RoutesDocument => {
    if (!doc) {
      throw new Error("routes not loaded");
    }
    return doc;
  };

  const run = async (title: string, job: () => Promise<void>) => {
    setBusy(true);
    try {
      await job();
      pushLog(title, "OK");
    } catch (error) {
      pushLog(title, errText(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const saveCurrent = async () => {
    await run("Save", async () => {
      const current = sanitize(guardDoc());
      const currentDns = normalizeDnsItems(dnsItems);
      const prevDns = normalizeDnsItems(savedDnsItems);
      const currentNdns = normalizeNdnsItems(ndnsItems);
      const prevNdns = normalizeNdnsItems(savedNdnsItems);

      const routesRes = await saveRoutes(current);
      if (!routesRes.ok) throw new Error(routesRes.error || routesRes.output || "save failed");

      const prevDnsMap = new Map(prevDns.map((item) => [item.host, new Set(item.addresses)]));
      const nextDnsMap = new Map(currentDns.map((item) => [item.host, new Set(item.addresses)]));
      const dnsHosts = new Set([...prevDnsMap.keys(), ...nextDnsMap.keys()]);
      for (const host of dnsHosts) {
        const oldSet = prevDnsMap.get(host) || new Set<string>();
        const newSet = nextDnsMap.get(host) || new Set<string>();
        for (const addr of oldSet) {
          if (!newSet.has(addr)) {
            const res = await deleteDnsHost(host, addr);
            if (!res.ok) throw new Error(res.output || res.error || `dns delete failed for ${host}`);
          }
        }
        for (const addr of newSet) {
          if (!oldSet.has(addr)) {
            const res = await addDnsHost(host, addr);
            if (!res.ok) throw new Error(res.output || res.error || `dns add failed for ${host}`);
          }
        }
      }

      const prevNdnsMap = new Map(prevNdns.map((item) => [item.name, item]));
      const nextNdnsMap = new Map(currentNdns.map((item) => [item.name, item]));
      for (const name of prevNdnsMap.keys()) {
        if (!nextNdnsMap.has(name)) {
          const res = await deleteNdnsProxy(name);
          if (!res.ok) throw new Error(res.output || res.error || `ndns delete failed for ${name}`);
        }
      }
      for (const item of currentNdns) {
        const prev = prevNdnsMap.get(item.name);
        if (prev && JSON.stringify(prev) === JSON.stringify(item)) {
          continue;
        }
        const res = await saveNdnsProxy(item, item.name);
        if (!res.ok) throw new Error(res.output || res.error || `ndns save failed for ${item.name}`);
      }

      setBaseline(JSON.stringify(current));
      setSavedDnsItems(currentDns);
      setSavedNdnsItems(currentNdns);

      const applyRes = await applyRoutes();
      if (!applyRes.ok) throw new Error(applyRes.output || applyRes.error || "apply failed");
      pushLog("Apply output", applyRes.output || "-");
    });
  };

  const openConfig = async (id: string, editable: boolean) => {
    await run("Open config", async () => {
      const data = await readConfig(id);
      setConfigModalId(id);
      setConfigModalTitle(data.item.title || data.item.id);
      setConfigModalPath(data.item.path);
      setConfigModalEditable(editable && data.item.editable);
      setConfigModalContent(data.content || "");
      setConfigModalOpen(true);
    });
  };

  if (!doc) {
    return <main className="app-root"><p className="muted">{t("app.loading")}</p></main>;
  }

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      <main className="app-root">
        <section className="app-shell">
          <TopBar
            dirty={dirty}
            busy={busy}
            isDarkTheme={theme === "dark"}
            consoleOpen={consoleOpen}
            onReload={() => void boot()}
            onSave={() => void saveCurrent()}
            onToggleTheme={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
            onToggleConsole={() => setConsoleOpen((v) => !v)}
          />

          <section className={["workspace", navCollapsed ? "workspace--nav-collapsed" : ""].filter(Boolean).join(" ")}>
            <SidebarTabs active={activeTab} onChange={setTab} collapsed={navCollapsed} onToggleCollapse={() => setNavCollapsed((prev) => !prev)} />

            <div className="content">
          {activeTab === "overview" ? (
            <OverviewTab
              busy={busy}
              status={status}
              configs={configs}
              routeFiles={routeFiles}
              activeRouteFile={doc._routes_file || ""}
              selectedRouteFile={selectedRouteFile}
              onSelectedRouteFileChange={setSelectedRouteFile}
              onRefresh={() => void run("Overview refresh", loadOverview)}
              onUseRouteFile={() =>
                void run("Use route file", async () => {
                  const res = await selectRouteFile(selectedRouteFile);
                  if (!res.ok) throw new Error(res.error || "failed");
                  await loadRoutesDoc();
                  await loadOverview();
                })
              }
              onBackupRouteFile={() =>
                void run("Backup route file", async () => {
                  const res = await backupRouteFile();
                  if (!res.ok) throw new Error(res.output || res.error || "failed");
                  pushLog("Backup", res.path || res.output || "done");
                })
              }
              onOpenConfig={(id, editable) => void openConfig(id, editable)}
            />
          ) : null}

          {activeTab === "servers" ? (
            <ServersTab
              doc={doc}
              busy={busy}
              dirty={dirty}
              onChange={setDoc}
              onApplyStub={() =>
                void run("Apply stub", async () => {
                  const payload = sanitize(guardDoc());
                  const saveRes = await saveRoutes(payload);
                  if (!saveRes.ok) throw new Error(saveRes.error || "save failed");
                  const res = await applyStub(payload);
                  if (!res.ok) throw new Error(res.output || res.error || "stub failed");
                })
              }
              onUploadStub={(content) =>
                void run("Upload stub", async () => {
                  const res = await uploadStub(content);
                  if (!res.ok) throw new Error(res.output || res.error || "upload failed");
                })
              }
              onRestartUi={() =>
                void run("Restart UI", async () => {
                  const res = await restartUi();
                  if (!res.ok) throw new Error(res.output || res.error || "restart failed");
                })
              }
            />
          ) : null}

          {activeTab === "certs" ? (
            <CertsTab
              busy={busy}
              sslMode={doc.globals.ssl_mode}
              acmeEmail={doc.globals.acme.email}
              caInstalled={caInstalled}
              certs={certs}
              onSslMode={(value: SslMode) => setDoc({ ...doc, globals: { ...doc.globals, ssl_mode: value } })}
              onAcmeEmail={(value: string) => setDoc({ ...doc, globals: { ...doc.globals, acme: { ...doc.globals.acme, email: value } } })}
              onOpenCaModal={() => setCaModalOpen(true)}
              onDownloadCa={() => {
                window.location.href = "/api/ca/download";
              }}
              onRefreshCerts={() => void run("Refresh certs", loadCertPart)}
              onDeleteCert={(host) =>
                void run("Delete cert", async () => {
                  const res = await deleteCert(host);
                  if (!res.ok) throw new Error(res.output || res.error || "delete failed");
                  await loadCertPart();
                })
              }
              onTestCert={(host) =>
                void run("Test cert", async () => {
                  const res = await testCert(host, 443);
                  if (!res.ok) throw new Error(res.output || res.error || "test failed");
                  pushLog("Cert test", res.output || "ok");
                })
              }
              onDownloadCert={(host, kind) => {
                window.location.href = `/api/cert/download?host=${encodeURIComponent(host)}&kind=${kind}`;
              }}
              onIssueCa={() =>
                void run("Issue route certs", async () => {
                  const res = await issueCa(true);
                  if (!res.ok) throw new Error(res.output || res.error || "issue failed");
                  pushLog("Issue", res.output || "done");
                })
              }
            />
          ) : null}

          {activeTab === "dns" ? (
            <DnsTab
              busy={busy}
              dnsItems={dnsItems}
              ndnsHttpText={ndnsText}
              ndnsItems={ndnsItems}
              onRefreshDns={() => void run("Refresh DNS", loadDnsNdns)}
              onSaveDnsHost={(host, addresses) => setDnsItems((prev) => normalizeDnsItems(prev.map((item) => (item.host === host ? { ...item, addresses } : item))))}
              onDeleteDnsHost={(host) => setDnsItems((prev) => prev.filter((item) => item.host !== host))}
              onAddDnsHost={(host, address) =>
                setDnsItems((prev) => {
                  const nextHost = host.trim();
                  const nextAddress = address.trim();
                  if (!nextHost || !nextAddress) return prev;
                  const existing = prev.find((item) => item.host === nextHost);
                  if (!existing) return normalizeDnsItems([...prev, { host: nextHost, addresses: [nextAddress] }]);
                  return normalizeDnsItems(
                    prev.map((item) =>
                      item.host === nextHost
                        ? { ...item, addresses: Array.from(new Set([...item.addresses, nextAddress])) }
                        : item,
                    ),
                  );
                })
              }
              onSaveNdns={(item, oldName) =>
                setNdnsItems((prev) => {
                  const next = [...prev];
                  const byOldName = next.findIndex((current) => current.name === oldName);
                  if (byOldName >= 0) {
                    next[byOldName] = item;
                    return normalizeNdnsItems(next);
                  }
                  return normalizeNdnsItems([...next, item]);
                })
              }
              onDeleteNdns={(name) => setNdnsItems((prev) => prev.filter((item) => item.name !== name))}
              onSuggestPort={async () => {
                try {
                  const res = await suggestNdnsPort();
                  return res.ok ? res.port : null;
                } catch {
                  return null;
                }
              }}
            />
          ) : null}

          {activeTab === "logs" ? (
            <LogsTab
              busy={busy}
              type={logsType}
              filter={logsFilter}
              limit={logsLimit}
              lines={logLines}
              onType={setLogsType}
              onFilter={setLogsFilter}
              onLimit={setLogsLimit}
              onRefresh={() => void run("Refresh logs", loadNginxLogs)}
            />
          ) : null}

          {activeTab === "routing" ? (
            <RoutingTab
              busy={busy}
              mode={routeMode}
              filter={routeFilter}
              limit={routeLimit}
              smart={routeSmart}
              items={routeVisibleItems}
              onMode={setRouteMode}
              onFilter={setRouteFilter}
              onLimit={setRouteLimit}
              onSmart={(patch) => setRouteSmart((prev) => ({ ...prev, ...patch }))}
              onRefresh={() => void run("Refresh route logs", loadRouteLogItems)}
            />
          ) : null}
            </div>
          </section>
        </section>

        <ConsolePanel open={consoleOpen} items={consoleItems} onToggle={() => setConsoleOpen((v) => !v)} onClear={() => setConsoleItems([])} />

        <ConfigEditorModal
          open={configModalOpen}
          title={configModalTitle}
          path={configModalPath}
          editable={configModalEditable}
          content={configModalContent}
          busy={busy}
          onClose={() => setConfigModalOpen(false)}
          onChange={setConfigModalContent}
          onSave={() =>
            void run("Save config", async () => {
              const res = await writeConfig(configModalId, configModalContent);
              if (!res.ok) throw new Error(res.error || res.output || "save failed");
              setConfigModalOpen(false);
              await loadOverview();
            })
          }
        />

        <CaModal
          open={caModalOpen}
          busy={busy}
          onClose={() => setCaModalOpen(false)}
          onUpload={(cert, key) =>
            void run("Upload CA", async () => {
              const res = await uploadCa(cert, key);
              if (!res.ok) throw new Error(res.output || res.error || "upload failed");
              setCaModalOpen(false);
              await loadCertPart();
            })
          }
          onGenerate={(subject) =>
            void run("Generate CA", async () => {
              const res = await generateCa(subject);
              if (!res.ok) throw new Error(res.output || res.error || "generate failed");
              setCaModalOpen(false);
              await loadCertPart();
            })
          }
        />
      </main>
    </I18nContext.Provider>
  );
}
