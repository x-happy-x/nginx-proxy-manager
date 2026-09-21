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
  fetchDmsApps,
  fetchLogs,
  fetchNdns,
  fetchNginxStatus,
  fetchRouteErrors,
  fetchRouteFiles,
  fetchRouteLogs,
  fetchRoutes,
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
import {
  Dashboard,
  Glyph,
  Services,
  RequestLog,
  StatusPill,
} from "./ConsoleView";
import { ModalShell } from "./components/ui";
type TabKey =
  | "overview"
  | "servers"
  | "certs"
  | "dns"
  | "logs"
  | "routing"
  | "advanced"
  | "system"
  | "dms";
import { CaModal } from "./components/modals/CaModal";
import { ConfigEditorModal } from "./components/modals/ConfigEditorModal";
import { CertsTab } from "./components/tabs/CertsTab";
import { DnsTab } from "./components/tabs/DnsTab";
import { DmsTab } from "./components/tabs/DmsTab";
import { LogsTab } from "./components/tabs/LogsTab";
import { OverviewTab } from "./components/tabs/OverviewTab";
import { ServersTab } from "./components/tabs/ServersTab";
import type {
  ConfigItem,
  ConsoleItem,
  DmsApp,
  NdnsProxy,
  NginxStatus,
  RouteLogItem,
  RoutesDocument,
  SslMode,
} from "./types";
import { I18nContext, makeT, type Locale } from "./i18n";
import "./console.css";

const TAB_KEYS: TabKey[] = [
  "overview",
  "dms",
  "servers",
  "certs",
  "dns",
  "logs",
  "routing",
  "advanced",
  "system",
];
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
      addresses: [...(item.addresses || [])]
        .map((addr) => String(addr || "").trim())
        .filter(Boolean)
        .sort(),
    }))
    .filter((item) => item.host)
    .sort((a, b) => a.host.localeCompare(b.host));
}

function normalizeNdnsItems(items: NdnsProxy[]): NdnsProxy[] {
  return [...items]
    .map((item) => {
      const proto: NdnsProxy["upstream"]["proto"] =
        item.upstream?.proto === "https" ? "https" : "http";
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
  const theme = "dark";
  const [locale, setLocale] = useState<Locale>("ru");
  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    tabFromHash(window.location.hash),
  );
  const [doc, setDoc] = useState<RoutesDocument | null>(null);
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<NginxStatus | null>(null);
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [routeFiles, setRouteFiles] = useState<string[]>([]);
  const [selectedRouteFile, setSelectedRouteFile] = useState("");
  const [dmsApps, setDmsApps] = useState<DmsApp[]>([]);
  const [dmsServiceVersion, setDmsServiceVersion] = useState("");

  const [caInstalled, setCaInstalled] = useState(false);
  const [certs, setCerts] = useState<
    Array<{ host: string; has_key: boolean; path: string }>
  >([]);
  const [dnsItems, setDnsItems] = useState<DnsGrouped[]>([]);
  const [savedDnsItems, setSavedDnsItems] = useState<DnsGrouped[]>([]);
  const [ndnsText, setNdnsText] = useState("HTTP: - | HTTPS: -");
  const [ndnsItems, setNdnsItems] = useState<NdnsProxy[]>([]);
  const [savedNdnsItems, setSavedNdnsItems] = useState<NdnsProxy[]>([]);

  const [logsType, setLogsType] = useState<"access" | "error">("access");
  const [logsFilter, setLogsFilter] = useState("");
  const [logsLimit, setLogsLimit] = useState(200);
  const [logLines, setLogLines] = useState<string[]>([]);

  const [routeMode, setRouteMode] = useState<"all" | "4xx" | "5xx" | "errors">(
    "all",
  );
  const [routeFilter, setRouteFilter] = useState("");
  const [routeLimit, setRouteLimit] = useState(200);
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
  const [applyOpen, setApplyOpen] = useState(false);
  const [checkOutput, setCheckOutput] = useState("");
  const [checkPassed, setCheckPassed] = useState(false);
  const [notice, setNotice] = useState<{
    title: string;
    message: string;
    error: boolean;
  } | null>(null);
  const nav: Array<{
    id: TabKey;
    title: string;
    description: string;
    icon: string;
  }> = [
    {
      id: "overview",
      title: "Обзор",
      description: "Трафик, состояние системы и ключевые показатели.",
      icon: "overview",
    },
    {
      id: "servers",
      title: "Сервисы",
      description: "Ваши приложения. Доступ из дома и из любой точки мира.",
      icon: "servers",
    },
    {
      id: "logs",
      title: "Журнал запросов",
      description: "Каждый запрос, его источник и путь до приложения.",
      icon: "logs",
    },
    {
      id: "dns",
      title: "DNS и KeenDNS",
      description: "Локальные DNS-записи и публичные входы роутера.",
      icon: "dns",
    },
    {
      id: "certs",
      title: "Сертификаты",
      description: "TLS, локальный центр сертификации и выпуск сертификатов.",
      icon: "certs",
    },
    {
      id: "advanced",
      title: "Маршрутизация",
      description: "Расширенные настройки хостов, портов и приложений.",
      icon: "advanced",
    },
    {
      id: "system",
      title: "Система",
      description: "Файлы конфигурации и состояние nginx.",
      icon: "advanced",
    },
    {
      id: "dms",
      title: "Развёртывания",
      description: "Установленные приложения и версии релизов.",
      icon: "dms",
    },
    {
      id: "routing",
      title: "Логи nginx",
      description: "Исходные журналы доступа и ошибок.",
      icon: "logs",
    },
  ];
  const currentNav = nav.find((item) => item.id === activeTab) || nav[0];

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("locale", locale);
  }, [locale]);

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
    return (
      JSON.stringify(normalizeDnsItems(dnsItems)) !==
      JSON.stringify(normalizeDnsItems(savedDnsItems))
    );
  }, [dnsItems, savedDnsItems]);
  const ndnsDirty = useMemo(() => {
    return (
      JSON.stringify(normalizeNdnsItems(ndnsItems)) !==
      JSON.stringify(normalizeNdnsItems(savedNdnsItems))
    );
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

  const pushLog = (
    title: string,
    message: string,
    level: ConsoleItem["level"] = "info",
  ) => {
    setConsoleItems((prev) =>
      [
        { at: new Date().toLocaleTimeString(), level, title, message },
        ...prev,
      ].slice(0, 300),
    );
    if (level === "error") setNotice({ title, message, error: true });
  };

  const loadRoutesDoc = async () => {
    const payload = await fetchRoutes();
    setDoc(payload);
    setBaseline(JSON.stringify(sanitize(payload)));
  };

  const loadOverview = async () => {
    const [s, c, rf] = await Promise.all([
      fetchNginxStatus(),
      fetchConfigs(),
      fetchRouteFiles(),
    ]);
    setStatus(s.status);
    setConfigs(c.items || []);
    setRouteFiles(rf.items || []);
    setSelectedRouteFile(rf.active || "");
  };

  const loadDms = async () => {
    const payload = await fetchDmsApps();
    setDmsApps(payload.items || []);
    setDmsServiceVersion(payload.service_version || "");
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
    const nextDns = normalizeDnsItems(
      Array.from(grouped.entries()).map(([host, addresses]) => ({
        host,
        addresses: Array.from(addresses),
      })),
    );
    const nextNdns = normalizeNdnsItems(ndns.data?.proxies || []);
    setDnsItems(nextDns);
    setSavedDnsItems(nextDns);
    setNdnsItems(nextNdns);
    setSavedNdnsItems(nextNdns);
    setNdnsText(
      `HTTP: ${ndns.data?.http?.port ?? "-"} | HTTPS: ${ndns.data?.http?.sslPort ?? "-"}`,
    );
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
      await loadRoutesDoc();
      await Promise.allSettled([
        loadOverview().catch((error) =>
          pushLog("Состояние nginx", errText(error), "error"),
        ),
        loadDms().catch((error) =>
          pushLog("Развёртывания", errText(error), "error"),
        ),
        loadCertPart().catch((error) =>
          pushLog("Сертификаты", errText(error), "error"),
        ),
        loadDnsNdns().catch((error) =>
          pushLog("DNS / KeenDNS", errText(error), "error"),
        ),
      ]);
      await Promise.all([loadNginxLogs(), loadRouteLogItems()]);

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

  useEffect(() => {
    if (doc) void run("Журнал запросов", loadRouteLogItems);
  }, [routeMode, routeLimit]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

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
      setNotice({ title, message: "Операция выполнена.", error: false });
    } catch (error) {
      pushLog(title, errText(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const saveDnsCurrent = async () => {
    await run("Сохранение DNS / KeenDNS", async () => {
      const currentDns = normalizeDnsItems(dnsItems);
      const prevDns = normalizeDnsItems(savedDnsItems);
      const currentNdns = normalizeNdnsItems(ndnsItems);
      const prevNdns = normalizeNdnsItems(savedNdnsItems);

      const prevDnsMap = new Map(
        prevDns.map((item) => [item.host, new Set(item.addresses)]),
      );
      const nextDnsMap = new Map(
        currentDns.map((item) => [item.host, new Set(item.addresses)]),
      );
      const dnsHosts = new Set([...prevDnsMap.keys(), ...nextDnsMap.keys()]);
      for (const host of dnsHosts) {
        const oldSet = prevDnsMap.get(host) || new Set<string>();
        const newSet = nextDnsMap.get(host) || new Set<string>();
        for (const addr of oldSet) {
          if (!newSet.has(addr)) {
            const res = await deleteDnsHost(host, addr);
            if (!res.ok)
              throw new Error(
                res.output || res.error || `dns delete failed for ${host}`,
              );
          }
        }
        for (const addr of newSet) {
          if (!oldSet.has(addr)) {
            const res = await addDnsHost(host, addr);
            if (!res.ok)
              throw new Error(
                res.output || res.error || `dns add failed for ${host}`,
              );
          }
        }
      }

      const prevNdnsMap = new Map(prevNdns.map((item) => [item.name, item]));
      const nextNdnsMap = new Map(currentNdns.map((item) => [item.name, item]));
      for (const name of prevNdnsMap.keys()) {
        if (!nextNdnsMap.has(name)) {
          const res = await deleteNdnsProxy(name);
          if (!res.ok)
            throw new Error(
              res.output || res.error || `ndns delete failed for ${name}`,
            );
        }
      }
      for (const item of currentNdns) {
        const prev = prevNdnsMap.get(item.name);
        if (prev && JSON.stringify(prev) === JSON.stringify(item)) {
          continue;
        }
        const res = await saveNdnsProxy(item, item.name);
        if (!res.ok)
          throw new Error(
            res.output || res.error || `ndns save failed for ${item.name}`,
          );
      }

      setSavedDnsItems(currentDns);
      setSavedNdnsItems(currentNdns);
    });
  };

  const saveCurrent = async () => {
    await run("Сохранение черновика", async () => {
      const current = sanitize(guardDoc());
      await saveRoutes(current);
      // Use the server's normalized document, including allocated external ports.
      await loadRoutesDoc();
      setCheckPassed(false);
      setCheckOutput("");
    });
  };
  const checkConfig = async () => {
    setCheckPassed(false);
    setBusy(true);
    try {
      const response = await fetch("/api/apply/check", { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.ok)
        throw new Error(data.error || data.output || "Проверка не пройдена");
      setCheckPassed(true);
      setCheckOutput(
        data.output || "Конфигурация проверена. Ошибок не найдено.",
      );
    } catch (error) {
      setCheckOutput(errText(error));
    } finally {
      setBusy(false);
    }
  };
  const applyCurrent = async () => {
    setBusy(true);
    try {
      const result = await applyRoutes();
      setCheckOutput(result.output || "Конфигурация применена.");
      setCheckPassed(false);
      setNotice({
        title: "Маршруты применены",
        message: result.output || "Конфигурация применена.",
        error: false,
      });
      await Promise.allSettled([loadOverview(), loadDnsNdns()]);
    } catch (error) {
      setCheckOutput(errText(error));
      setNotice({
        title: "Ошибка применения",
        message: errText(error),
        error: true,
      });
    } finally {
      setBusy(false);
    }
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
    return (
      <main className="boot-screen">
        <div className="brand-mark">
          <Glyph name="servers" size={28} />
        </div>
        <h1>HomeNet</h1>
        <p>
          {busy
            ? "Загружаем конфигурацию прокси…"
            : "Не удалось загрузить конфигурацию"}
        </p>
        {notice && <p role="alert">{notice.message}</p>}
        <button disabled={busy} onClick={() => void boot()}>
          Повторить подключение
        </button>
      </main>
    );
  }

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      <main className="console-app">
        <aside className="sidebar">
          <a
            className="brand"
            href="#/overview"
            onClick={() => setTab("overview")}
          >
            <span className="brand-mark">
              <Glyph name="servers" size={23} />
            </span>
            <span>
              HomeNet<small>PROXY MANAGER</small>
            </span>
          </a>
          <div className="workspace-label">
            <span className="live-dot" /> Домашняя сеть{" "}
            <span className="badge subtle">LOCAL</span>
          </div>
          <div className="nav-label">УПРАВЛЕНИЕ</div>
          <nav aria-label="Основная навигация">
            {nav.map((item, index) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={`${item.id === activeTab ? "active" : ""} ${index === 5 ? "nav-divider" : ""}`}
                aria-current={item.id === activeTab ? "page" : undefined}
                aria-label={item.title}
                title={item.title}
              >
                <Glyph name={item.icon} size={19} />
                <span>{item.title}</span>
                {item.id === "servers" && <small>{doc.apps.length}</small>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="node-icon">
              <Glyph name="servers" />
            </div>
            <div>
              <strong>Keenetic</strong>
              <small>Маршрутизация на роутере</small>
            </div>
            <span className={`node-dot ${status?.running ? "online" : ""}`} />
          </div>
        </aside>
        <div className="main-pane">
          <header className="topbar">
            <div className="breadcrumb">
              Рабочее пространство <span>/</span>{" "}
              <strong>{currentNav.title}</strong>
            </div>
            <StatusPill status={status} />
            <button
              className="icon-plain"
              title="Журнал операций"
              aria-label="Журнал операций"
              onClick={() => setConsoleOpen(!consoleOpen)}
            >
              <Glyph name="logs" size={19} />
            </button>
          </header>
          <div className="page-content">
            <div className="page-heading">
              <div>
                <span className="eyebrow">КОНТРОЛЬ ВАШЕЙ СЕТИ</span>
                <h1>{currentNav.title}</h1>
                <p>{currentNav.description}</p>
              </div>
              <div className="button-group">
                <button
                  onClick={() => void saveCurrent()}
                  disabled={busy || !docDirty}
                >
                  {docDirty ? <span className="unsaved-dot" /> : null}Сохранить
                  черновик
                </button>
                <button
                  className="primary"
                  disabled={busy || docDirty}
                  onClick={() => {
                    setCheckPassed(false);
                    setCheckOutput("");
                    setApplyOpen(true);
                  }}
                >
                  <Glyph name="bolt" size={16} />
                  Применить
                </button>
              </div>
            </div>
            {notice && (
              <div
                role={notice.error ? "alert" : "status"}
                className={`notice ${notice.error ? "error" : "success"}`}
              >
                <div>
                  <strong>{notice.title}</strong>
                  <span>{notice.message}</span>
                </div>
                <button
                  className="icon-plain"
                  aria-label="Закрыть уведомление"
                  onClick={() => setNotice(null)}
                >
                  <Glyph name="close" size={16} />
                </button>
              </div>
            )}
            {docDirty && (
              <div className="draft-notice">
                <span className="unsaved-dot" />
                <span>
                  Есть несохранённые изменения. Сохраните черновик перед
                  проверкой и применением.
                </span>
              </div>
            )}
            {activeTab === "overview" && (
              <Dashboard
                doc={doc}
                status={status}
                onServices={() => setTab("servers")}
                onLogs={() => setTab("logs")}
              />
            )}
            {activeTab === "servers" && (
              <Services
                doc={doc}
                busy={busy}
                onChange={setDoc}
                onAdvanced={() => setTab("advanced")}
              />
            )}
            {activeTab === "logs" && (
              <RequestLog
                items={routeItems}
                filter={routeFilter}
                onFilter={setRouteFilter}
                mode={routeMode}
                onMode={setRouteMode}
                limit={routeLimit}
                onLimit={setRouteLimit}
                busy={busy}
                onRefresh={() => void run("Журнал запросов", loadRouteLogItems)}
              />
            )}
            {activeTab === "system" ? (
              <OverviewTab
                busy={busy}
                doc={doc}
                status={status}
                configs={configs}
                certs={certs}
                dnsItems={dnsItems.flatMap((group) =>
                  group.addresses.map((address) => ({
                    host: group.host,
                    address,
                  })),
                )}
                ndnsText={ndnsText}
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
                    if (!res.ok)
                      throw new Error(res.output || res.error || "failed");
                    pushLog("Backup", res.path || res.output || "done");
                  })
                }
                onOpenConfig={(id, editable) => void openConfig(id, editable)}
              />
            ) : null}

            {activeTab === "advanced" ? (
              <ServersTab
                doc={doc}
                busy={busy}
                dirty={dirty}
                onChange={setDoc}
                onApplyStub={() =>
                  void run("Apply stub", async () => {
                    const payload = sanitize(guardDoc());
                    const saveRes = await saveRoutes(payload);
                    if (!saveRes.ok)
                      throw new Error(saveRes.error || "save failed");
                    const res = await applyStub(payload);
                    if (!res.ok)
                      throw new Error(res.output || res.error || "stub failed");
                  })
                }
                onUploadStub={(content) =>
                  void run("Upload stub", async () => {
                    const res = await uploadStub(content);
                    if (!res.ok)
                      throw new Error(
                        res.output || res.error || "upload failed",
                      );
                  })
                }
                onRestartUi={() =>
                  void run("Restart UI", async () => {
                    const res = await restartUi();
                    if (!res.ok)
                      throw new Error(
                        res.output || res.error || "restart failed",
                      );
                  })
                }
              />
            ) : null}

            {activeTab === "dms" ? (
              <DmsTab
                busy={busy}
                items={dmsApps}
                serviceVersion={dmsServiceVersion}
                onRefresh={() => void run("DMS refresh", loadDms)}
              />
            ) : null}

            {activeTab === "certs" ? (
              <CertsTab
                busy={busy}
                sslMode={doc.globals.ssl_mode}
                acmeEmail={doc.globals.acme.email}
                caInstalled={caInstalled}
                certs={certs}
                onSslMode={(value: SslMode) =>
                  setDoc({
                    ...doc,
                    globals: { ...doc.globals, ssl_mode: value },
                  })
                }
                onAcmeEmail={(value: string) =>
                  setDoc({
                    ...doc,
                    globals: {
                      ...doc.globals,
                      acme: { ...doc.globals.acme, email: value },
                    },
                  })
                }
                onOpenCaModal={() => setCaModalOpen(true)}
                onDownloadCa={() => {
                  window.location.href = "/api/ca/download";
                }}
                onRefreshCerts={() => void run("Refresh certs", loadCertPart)}
                onDeleteCert={(host) =>
                  void run("Delete cert", async () => {
                    const res = await deleteCert(host);
                    if (!res.ok)
                      throw new Error(
                        res.output || res.error || "delete failed",
                      );
                    await loadCertPart();
                  })
                }
                onTestCert={(host) =>
                  void run("Test cert", async () => {
                    const res = await testCert(host, 443);
                    if (!res.ok)
                      throw new Error(res.output || res.error || "test failed");
                    pushLog("Cert test", res.output || "ok");
                  })
                }
                onDownloadCert={(host, kind) => {
                  window.location.href = `/api/cert/download?host=${encodeURIComponent(host)}&kind=${kind}`;
                }}
                onIssueCa={() =>
                  void run("Issue route certs", async () => {
                    const res = await issueCa(true);
                    if (!res.ok)
                      throw new Error(
                        res.output || res.error || "issue failed",
                      );
                    pushLog("Issue", res.output || "done");
                  })
                }
              />
            ) : null}

            {activeTab === "dns" ? (
              <>
                <div className="draft-notice">
                  <span>
                    Изменения в этом разделе записываются непосредственно в
                    роутер кнопкой ниже.
                  </span>
                  <button
                    disabled={busy || (!dnsDirty && !ndnsDirty)}
                    onClick={() => void saveDnsCurrent()}
                  >
                    Сохранить DNS / KeenDNS
                  </button>
                </div>
                <DnsTab
                  busy={busy}
                  dnsItems={dnsItems}
                  ndnsHttpText={ndnsText}
                  ndnsItems={ndnsItems}
                  onRefreshDns={() => void run("Refresh DNS", loadDnsNdns)}
                  onSaveDnsHost={(host, addresses) =>
                    setDnsItems((prev) =>
                      normalizeDnsItems(
                        prev.map((item) =>
                          item.host === host ? { ...item, addresses } : item,
                        ),
                      ),
                    )
                  }
                  onDeleteDnsHost={(host) =>
                    setDnsItems((prev) =>
                      prev.filter((item) => item.host !== host),
                    )
                  }
                  onAddDnsHost={(host, address) =>
                    setDnsItems((prev) => {
                      const nextHost = host.trim();
                      const nextAddress = address.trim();
                      if (!nextHost || !nextAddress) return prev;
                      const existing = prev.find(
                        (item) => item.host === nextHost,
                      );
                      if (!existing)
                        return normalizeDnsItems([
                          ...prev,
                          { host: nextHost, addresses: [nextAddress] },
                        ]);
                      return normalizeDnsItems(
                        prev.map((item) =>
                          item.host === nextHost
                            ? {
                                ...item,
                                addresses: Array.from(
                                  new Set([...item.addresses, nextAddress]),
                                ),
                              }
                            : item,
                        ),
                      );
                    })
                  }
                  onSaveNdns={(item, oldName) =>
                    setNdnsItems((prev) => {
                      const next = [...prev];
                      const byOldName = next.findIndex(
                        (current) => current.name === oldName,
                      );
                      if (byOldName >= 0) {
                        next[byOldName] = item;
                        return normalizeNdnsItems(next);
                      }
                      return normalizeNdnsItems([...next, item]);
                    })
                  }
                  onDeleteNdns={(name) =>
                    setNdnsItems((prev) =>
                      prev.filter((item) => item.name !== name),
                    )
                  }
                  onSuggestPort={async () => {
                    try {
                      const res = await suggestNdnsPort();
                      return res.ok ? res.port : null;
                    } catch {
                      return null;
                    }
                  }}
                />
              </>
            ) : null}

            {activeTab === "routing" ? (
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
          </div>
          <footer className="app-footer">
            <span>HomeNet · Локальная инфраструктура</span>
            <span>Сохранение черновика не перезапускает прокси</span>
          </footer>
        </div>

        <ConsolePanel
          open={consoleOpen}
          items={consoleItems}
          onToggle={() => setConsoleOpen((v) => !v)}
          onClear={() => setConsoleItems([])}
        />

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
              if (!res.ok)
                throw new Error(res.error || res.output || "save failed");
              setConfigModalOpen(false);
              await loadOverview();
            })
          }
        />

        <ModalShell
          open={applyOpen}
          onClose={() => {
            if (!busy) setApplyOpen(false);
          }}
          size="big"
        >
          <div className="modal-heading">
            <div>
              <span className="eyebrow">ПРИМЕНЕНИЕ КОНФИГУРАЦИИ</span>
              <h2>Проверка перед применением</h2>
              <p>
                Сохранённый файл содержит {doc.apps.length} сервисов и{" "}
                {doc.hosts.length} доменов.
              </p>
            </div>
            <button
              disabled={busy}
              className="icon-plain"
              aria-label="Закрыть"
              onClick={() => setApplyOpen(false)}
            >
              <Glyph name="close" />
            </button>
          </div>
          <div className="form-section">
            <p>
              Применение обновит конфигурацию прокси, локальные DNS-записи и
              публичные входы KeenDNS. Сначала проверьте сохранённую
              конфигурацию.
            </p>
            {checkOutput && (
              <pre className={`check-output ${checkPassed ? "valid" : ""}`}>
                {checkOutput}
              </pre>
            )}
          </div>
          <div className="modal-footer">
            <button disabled={busy} onClick={() => setApplyOpen(false)}>
              Закрыть
            </button>
            <button disabled={busy} onClick={() => void checkConfig()}>
              {busy ? "Выполняется…" : "Проверить конфигурацию"}
            </button>
            <button
              className="primary"
              disabled={busy || !checkPassed || docDirty}
              onClick={() => void applyCurrent()}
            >
              Применить на роутере
            </button>
          </div>
        </ModalShell>

        <CaModal
          open={caModalOpen}
          busy={busy}
          onClose={() => setCaModalOpen(false)}
          onUpload={(cert, key) =>
            void run("Upload CA", async () => {
              const res = await uploadCa(cert, key);
              if (!res.ok)
                throw new Error(res.output || res.error || "upload failed");
              setCaModalOpen(false);
              await loadCertPart();
            })
          }
          onGenerate={(subject) =>
            void run("Generate CA", async () => {
              const res = await generateCa(subject);
              if (!res.ok)
                throw new Error(res.output || res.error || "generate failed");
              setCaModalOpen(false);
              await loadCertPart();
            })
          }
        />
      </main>
    </I18nContext.Provider>
  );
}
