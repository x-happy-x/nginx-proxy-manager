import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  fetchDmsApps,
  fetchDnsHosts,
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
import type {
  CertItem,
  ConfigItem,
  ConsoleItem,
  DmsApp,
  NdnsProxy,
  NginxStatus,
  RouteLogItem,
  RoutesDocument,
  SslMode,
} from "./types";
import { pageFromHash, type PageKey } from "./navigation";
import { Icon } from "./components/ui/Icon";
import { Alert } from "./components/ui/controls";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import {
  ApplyDialog,
  ChangesBar,
  OperationsDrawer,
  Sidebar,
  Toasts,
  Topbar,
  type ApplyState,
  type CheckState,
  type Toast,
} from "./components/shell";
import { CaDialog, ConfigEditorDialog } from "./components/dialogs";
import { Dashboard } from "./pages/Dashboard";
import { Services } from "./pages/Services";
import { Launcher } from "./pages/Launcher";
import { Resources } from "./pages/Resources";
import { Network } from "./pages/Network";
import { RequestLog, type LogMode } from "./pages/RequestLog";
import { Dns, type DnsGrouped } from "./pages/Dns";
import { Certs } from "./pages/Certs";
import { Routing } from "./pages/Routing";
import { System } from "./pages/System";
import { Deployments } from "./pages/Deployments";
import { NginxLogs } from "./pages/NginxLogs";
import { errText } from "./lib/format";

function sanitize(doc: RoutesDocument): RoutesDocument {
  const clone = JSON.parse(JSON.stringify(doc)) as RoutesDocument;
  delete clone._routes_file;
  return clone;
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

type RunOptions = {
  /** Only record in the operations center, no toast on success. */
  quiet?: boolean;
  success?: string;
};

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  const [page, setPage] = useState<PageKey>(() => pageFromHash(window.location.hash));
  const [navOpen, setNavOpen] = useState(false);
  const [doc, setDoc] = useState<RoutesDocument | null>(null);
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
  const [bootError, setBootError] = useState("");

  const [status, setStatus] = useState<NginxStatus | null>(null);
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [routeFiles, setRouteFiles] = useState<string[]>([]);
  const [selectedRouteFile, setSelectedRouteFile] = useState("");
  const [dmsApps, setDmsApps] = useState<DmsApp[]>([]);
  const [dmsServiceVersion, setDmsServiceVersion] = useState("");

  const [caInstalled, setCaInstalled] = useState(false);
  const [certs, setCerts] = useState<CertItem[]>([]);
  const [dnsItems, setDnsItems] = useState<DnsGrouped[]>([]);
  const [savedDnsItems, setSavedDnsItems] = useState<DnsGrouped[]>([]);
  const [ndnsPorts, setNdnsPorts] = useState<{ http: number | null; https: number | null }>({ http: null, https: null });
  const [ndnsItems, setNdnsItems] = useState<NdnsProxy[]>([]);
  const [savedNdnsItems, setSavedNdnsItems] = useState<NdnsProxy[]>([]);

  const [logsType, setLogsType] = useState<"access" | "error">("access");
  const [logsFilter, setLogsFilter] = useState("");
  const [logsLimit, setLogsLimit] = useState(200);
  const [logLines, setLogLines] = useState<string[]>([]);

  const [routeMode, setRouteMode] = useState<LogMode>("all");
  const [routeFilter, setRouteFilter] = useState("");
  const [routeLimit, setRouteLimit] = useState(200);
  const [routeItems, setRouteItems] = useState<RouteLogItem[]>([]);

  const [opsOpen, setOpsOpen] = useState(false);
  const [operations, setOperations] = useState<ConsoleItem[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const [config, setConfig] = useState<{ id: string; title: string; path: string; editable: boolean; content: string } | null>(null);
  const [caOpen, setCaOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [checkState, setCheckState] = useState<CheckState>("idle");
  const [checkOutput, setCheckOutput] = useState("");
  const [applyState, setApplyState] = useState<ApplyState>("idle");
  const [applyOutput, setApplyOutput] = useState("");
  const [discard, setDiscard] = useState<"doc" | "dns" | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("homenet-theme", theme);
    } catch {
      /* storage may be unavailable */
    }
  }, [theme]);

  useEffect(() => {
    const onHashChange = () => {
      setPage(pageFromHash(window.location.hash));
      setNavOpen(false);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) window.history.replaceState(null, "", `#/${page}`);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const docDirty = useMemo(() => !!doc && JSON.stringify(sanitize(doc)) !== baseline, [baseline, doc]);
  const dnsDirty = useMemo(
    () =>
      JSON.stringify(normalizeDnsItems(dnsItems)) !== JSON.stringify(normalizeDnsItems(savedDnsItems)) ||
      JSON.stringify(normalizeNdnsItems(ndnsItems)) !== JSON.stringify(normalizeNdnsItems(savedNdnsItems)),
    [dnsItems, savedDnsItems, ndnsItems, savedNdnsItems],
  );

  const navigate = (next: PageKey) => {
    setPage(next);
    setNavOpen(false);
    const hash = `#/${next}`;
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    window.scrollTo({ top: 0 });
  };

  const notify = useCallback((toast: Omit<Toast, "id">) => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev.filter((item) => item.title !== toast.title || item.tone !== toast.tone), { ...toast, id }]);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((prev) => prev.filter((item) => item.id !== id)), []);

  const log = (title: string, message: string, level: ConsoleItem["level"] = "info") => {
    setOperations((prev) =>
      [{ at: new Date().toLocaleTimeString("ru-RU"), level, title, message }, ...prev].slice(0, 300),
    );
    if (level === "error") notify({ tone: "error", title, message });
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
      Array.from(grouped.entries()).map(([host, addresses]) => ({ host, addresses: Array.from(addresses) })),
    );
    const nextNdns = normalizeNdnsItems(ndns.data?.proxies || []);
    setDnsItems(nextDns);
    setSavedDnsItems(nextDns);
    setNdnsItems(nextNdns);
    setSavedNdnsItems(nextNdns);
    setNdnsPorts({ http: ndns.data?.http?.port ?? null, https: ndns.data?.http?.sslPort ?? null });
  };

  const loadNginxLogs = async (type = logsType, limit = logsLimit) => {
    const data = await fetchLogs(type, logsFilter, limit);
    setLogLines(data.lines || []);
  };

  const loadRouteLogItems = async () => {
    const data =
      routeMode === "errors"
        ? await fetchRouteErrors(routeFilter, routeLimit)
        : await fetchRouteLogs(routeFilter, routeLimit, routeMode === "all" ? "" : routeMode);
    // The API returns the newest records in file order; show the latest first.
    setRouteItems([...(data.items || [])].reverse());
  };

  const boot = async () => {
    setBusy(true);
    setBootError("");
    try {
      await loadRoutesDoc();
      await Promise.allSettled([
        loadOverview().catch((error) => log("Состояние nginx", errText(error), "error")),
        loadDms().catch((error) => log("Развёртывания", errText(error), "error")),
        loadCertPart().catch((error) => log("Сертификаты", errText(error), "error")),
        loadDnsNdns().catch((error) => log("DNS / KeenDNS", errText(error), "error")),
        loadNginxLogs().catch((error) => log("Логи nginx", errText(error), "error")),
        loadRouteLogItems().catch((error) => log("Журнал запросов", errText(error), "error")),
      ]);
      log("Подключение", "Данные интерфейса загружены");
    } catch (error) {
      setBootError(errText(error));
      log("Подключение", errText(error), "error");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void boot();
  }, []);

  const run = async (title: string, job: () => Promise<void>, options: RunOptions = {}) => {
    setBusy(true);
    try {
      await job();
      log(title, options.success || "Выполнено");
      if (!options.quiet) notify({ tone: "success", title, message: options.success });
      return true;
    } catch (error) {
      log(title, errText(error), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (doc) void run("Журнал запросов", loadRouteLogItems, { quiet: true });
  }, [routeMode, routeLimit]);

  useEffect(() => {
    if (doc) void run("Логи nginx", () => loadNginxLogs(logsType, logsLimit), { quiet: true });
  }, [logsType, logsLimit]);

  useEffect(() => {
    if (!docDirty && !dnsDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [docDirty, dnsDirty]);

  const guardDoc = (): RoutesDocument => {
    if (!doc) throw new Error("Маршруты не загружены");
    return doc;
  };

  const resetChecks = () => {
    setCheckState("idle");
    setCheckOutput("");
    setApplyState("idle");
    setApplyOutput("");
  };

  const saveDraft = async () => {
    const ok = await run(
      "Черновик сохранён",
      async () => {
        await saveRoutes(sanitize(guardDoc()));
        // Use the server's normalized document, including allocated external ports.
        await loadRoutesDoc();
        resetChecks();
      },
      { quiet: true, success: "routes.yml обновлён" },
    );
    if (ok && !applyOpen) {
      notify({
        tone: "success",
        title: "Черновик сохранён",
        message: "Прокси ещё работает со старой конфигурацией.",
        action: {
          label: "Проверить и применить",
          onClick: () => setApplyOpen(true),
        },
      });
    }
  };

  const saveDns = async () => {
    await run(
      "DNS / KeenDNS записаны",
      async () => {
        const currentDns = normalizeDnsItems(dnsItems);
        const prevDns = normalizeDnsItems(savedDnsItems);
        const currentNdns = normalizeNdnsItems(ndnsItems);
        const prevNdns = normalizeNdnsItems(savedNdnsItems);

        const prevDnsMap = new Map(prevDns.map((item) => [item.host, new Set(item.addresses)]));
        const nextDnsMap = new Map(currentDns.map((item) => [item.host, new Set(item.addresses)]));
        const dnsHosts = new Set([...prevDnsMap.keys(), ...nextDnsMap.keys()]);
        for (const host of dnsHosts) {
          const oldSet = prevDnsMap.get(host) || new Set<string>();
          const newSet = nextDnsMap.get(host) || new Set<string>();
          for (const addr of oldSet) {
            if (!newSet.has(addr)) {
              const res = await deleteDnsHost(host, addr);
              if (!res.ok) throw new Error(res.output || res.error || `Не удалось удалить ${host}`);
            }
          }
          for (const addr of newSet) {
            if (!oldSet.has(addr)) {
              const res = await addDnsHost(host, addr);
              if (!res.ok) throw new Error(res.output || res.error || `Не удалось добавить ${host}`);
            }
          }
        }

        const prevNdnsMap = new Map(prevNdns.map((item) => [item.name, item]));
        const nextNdnsMap = new Map(currentNdns.map((item) => [item.name, item]));
        for (const name of prevNdnsMap.keys()) {
          if (!nextNdnsMap.has(name)) {
            const res = await deleteNdnsProxy(name);
            if (!res.ok) throw new Error(res.output || res.error || `Не удалось удалить вход ${name}`);
          }
        }
        for (const item of currentNdns) {
          const prev = prevNdnsMap.get(item.name);
          if (prev && JSON.stringify(prev) === JSON.stringify(item)) continue;
          const res = await saveNdnsProxy(item, item.name);
          if (!res.ok) throw new Error(res.output || res.error || `Не удалось сохранить вход ${item.name}`);
        }

        setSavedDnsItems(currentDns);
        setSavedNdnsItems(currentNdns);
      },
      { success: "Изменения записаны на роутер" },
    );
  };

  const confirmDiscard = () => {
    if (discard === "doc" && doc) {
      const restored = JSON.parse(baseline) as RoutesDocument;
      setDoc({ ...restored, _routes_file: doc._routes_file });
      log("Черновик", "Несохранённые изменения отменены");
    }
    if (discard === "dns") {
      setDnsItems(savedDnsItems);
      setNdnsItems(savedNdnsItems);
      log("DNS / KeenDNS", "Несохранённые изменения отменены");
    }
    setDiscard(null);
  };

  const checkConfig = async () => {
    setBusy(true);
    setApplyState("idle");
    setApplyOutput("");
    try {
      const response = await fetch("/api/apply/check", { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || data.output || "Проверка не пройдена");
      setCheckState("passed");
      setCheckOutput(data.output || "Конфигурация проверена. Ошибок не найдено.");
      log("Проверка конфигурации", "Пройдена");
    } catch (error) {
      setCheckState("failed");
      setCheckOutput(errText(error));
      setOperations((prev) =>
        [{ at: new Date().toLocaleTimeString("ru-RU"), level: "error" as const, title: "Проверка конфигурации", message: errText(error) }, ...prev].slice(0, 300),
      );
    } finally {
      setBusy(false);
    }
  };

  const applyCurrent = async () => {
    setBusy(true);
    try {
      const result = await applyRoutes();
      setApplyState("done");
      setApplyOutput(result.output || "Конфигурация применена.");
      log("Конфигурация применена", result.output || "Готово");
      notify({ tone: "success", title: "Конфигурация применена на роутере" });
      await Promise.allSettled([loadOverview(), loadDnsNdns()]);
    } catch (error) {
      setApplyState("failed");
      setApplyOutput(errText(error));
      setOperations((prev) =>
        [{ at: new Date().toLocaleTimeString("ru-RU"), level: "error" as const, title: "Ошибка применения", message: errText(error) }, ...prev].slice(0, 300),
      );
    } finally {
      setBusy(false);
    }
  };

  const openApply = () => {
    if (checkState === "failed" || applyState !== "idle") resetChecks();
    setApplyOpen(true);
  };

  const openConfig = async (id: string, editable: boolean) => {
    await run(
      "Открытие файла",
      async () => {
        const data = await readConfig(id);
        setConfig({
          id,
          title: data.item.title || data.item.id,
          path: data.item.path,
          editable: editable && data.item.editable,
          content: data.content || "",
        });
      },
      { quiet: true },
    );
  };

  // Ctrl/Cmd+S saves the routes draft.
  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (docDirtyRef.current && !busyRef.current) void saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const docDirtyRef = useRef(docDirty);
  docDirtyRef.current = docDirty;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  if (!doc) {
    return (
      <main className="boot">
        <div className="card boot-card">
          <span className="brand-mark">
            <Icon name="route" size={22} strokeWidth={2} />
          </span>
          <h1>HomeNet</h1>
          {bootError ? (
            <>
              <Alert tone="danger" title="Не удалось загрузить конфигурацию">
                {bootError}
              </Alert>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void boot()}>
                <Icon name="refresh" />
                Повторить
              </button>
            </>
          ) : (
            <p className="button-row">
              <span className="spinner" /> Загружаем конфигурацию прокси…
            </p>
          )}
        </div>
      </main>
    );
  }

  const setSslMode = (value: SslMode) => setDoc({ ...doc, globals: { ...doc.globals, ssl_mode: value } });
  const setAcmeEmail = (value: string) =>
    setDoc({ ...doc, globals: { ...doc.globals, acme: { ...doc.globals.acme, email: value } } });

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <Sidebar
        active={page}
        onNavigate={navigate}
        onClose={() => setNavOpen(false)}
        status={status}
        counts={{ servers: doc.apps.length }}
        unsaved={{ servers: docDirty, advanced: docDirty, certs: docDirty, dns: dnsDirty }}
      />
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <div className="main">
        <Topbar
          page={page}
          status={status}
          theme={theme}
          onTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          onMenu={() => setNavOpen(true)}
          navOpen={navOpen}
          operations={operations}
          onOperations={() => setOpsOpen(true)}
          onApply={openApply}
          busy={busy}
        />
        <main className="page" id="main">
          {page === "overview" ? <Dashboard doc={doc} status={status} onNavigate={navigate} /> : null}
          {page === "apps" ? <Launcher doc={doc} /> : null}
          {page === "resources" ? <Resources /> : null}
          {page === "network" ? <Network /> : null}
          {page === "servers" ? (
            <Services doc={doc} busy={busy} onChange={setDoc} onAdvanced={() => navigate("advanced")} />
          ) : null}
          {page === "logs" ? (
            <RequestLog
              items={routeItems}
              filter={routeFilter}
              onFilter={setRouteFilter}
              mode={routeMode}
              onMode={setRouteMode}
              limit={routeLimit}
              onLimit={setRouteLimit}
              busy={busy}
              onRefresh={() => void run("Журнал запросов", loadRouteLogItems, { quiet: true })}
            />
          ) : null}
          {page === "dns" ? (
            <Dns
              busy={busy}
              dnsItems={dnsItems}
              ndnsPorts={ndnsPorts}
              ndnsItems={ndnsItems}
              onRefresh={() => {
                if (dnsDirty) setDiscard("dns");
                else void run("DNS / KeenDNS", loadDnsNdns, { quiet: true });
              }}
              onSaveDnsHost={(host, addresses) =>
                setDnsItems((prev) =>
                  normalizeDnsItems(prev.map((item) => (item.host === host ? { ...item, addresses } : item))),
                )
              }
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
                  const index = next.findIndex((current) => current.name === oldName);
                  if (index >= 0) {
                    next[index] = item;
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
          {page === "certs" ? (
            <Certs
              busy={busy}
              sslMode={doc.globals.ssl_mode}
              acmeEmail={doc.globals.acme.email}
              caInstalled={caInstalled}
              certs={certs}
              onSslMode={setSslMode}
              onAcmeEmail={setAcmeEmail}
              onOpenCaModal={() => setCaOpen(true)}
              onDownloadCa={() => {
                window.location.href = "/api/ca/download";
              }}
              onRefreshCerts={() => void run("Сертификаты", loadCertPart, { quiet: true })}
              onDeleteCert={(host) =>
                void run(
                  "Сертификат удалён",
                  async () => {
                    const res = await deleteCert(host);
                    if (!res.ok) throw new Error(res.output || res.error || "Не удалось удалить");
                    await loadCertPart();
                  },
                  { success: host },
                )
              }
              onTestCert={(host) =>
                void run("Проверка сертификата", async () => {
                  const res = await testCert(host, 443);
                  if (!res.ok) throw new Error(res.output || res.error || "Проверка не пройдена");
                  log("Проверка сертификата", res.output || "OK");
                }, { success: host })
              }
              onDownloadCert={(host, kind) => {
                window.location.href = `/api/cert/download?host=${encodeURIComponent(host)}&kind=${kind}`;
              }}
              onIssueCa={() =>
                void run("Сертификаты выпущены", async () => {
                  const res = await issueCa(true);
                  if (!res.ok) throw new Error(res.output || res.error || "Не удалось выпустить");
                  log("Выпуск сертификатов", res.output || "Готово");
                  await loadCertPart();
                })
              }
            />
          ) : null}
          {page === "advanced" ? (
            <Routing
              doc={doc}
              busy={busy}
              onChange={setDoc}
              onApplyStub={() =>
                void run("Заглушка применена", async () => {
                  const payload = sanitize(guardDoc());
                  const saveRes = await saveRoutes(payload);
                  if (!saveRes.ok) throw new Error(saveRes.error || "Не удалось сохранить");
                  const res = await applyStub(payload);
                  if (!res.ok) throw new Error(res.output || res.error || "Не удалось применить заглушку");
                  await loadRoutesDoc();
                })
              }
              onUploadStub={(content) =>
                void run("Страница заглушки загружена", async () => {
                  const res = await uploadStub(content);
                  if (!res.ok) throw new Error(res.output || res.error || "Не удалось загрузить");
                })
              }
              onRestartUi={() =>
                void run("Интерфейс перезапускается", async () => {
                  const res = await restartUi();
                  if (!res.ok) throw new Error(res.output || res.error || "Не удалось перезапустить");
                })
              }
            />
          ) : null}
          {page === "system" ? (
            <System
              busy={busy}
              doc={doc}
              status={status}
              configs={configs}
              certs={certs}
              dnsCount={dnsItems.length}
              ndnsCount={ndnsItems.length}
              routeFiles={routeFiles}
              activeRouteFile={doc._routes_file || ""}
              selectedRouteFile={selectedRouteFile}
              onSelectedRouteFileChange={setSelectedRouteFile}
              onRefresh={() => void run("Состояние системы", loadOverview, { quiet: true })}
              onUseRouteFile={() =>
                void run("Файл маршрутов выбран", async () => {
                  const res = await selectRouteFile(selectedRouteFile);
                  if (!res.ok) throw new Error(res.error || "Не удалось выбрать файл");
                  await loadRoutesDoc();
                  await loadOverview();
                }, { success: selectedRouteFile })
              }
              onBackupRouteFile={() =>
                void run("Резервная копия создана", async () => {
                  const res = await backupRouteFile();
                  if (!res.ok) throw new Error(res.output || res.error || "Не удалось создать копию");
                  log("Резервная копия", res.path || res.output || "Готово");
                })
              }
              onOpenConfig={(id, editable) => void openConfig(id, editable)}
            />
          ) : null}
          {page === "dms" ? (
            <Deployments
              busy={busy}
              items={dmsApps}
              serviceVersion={dmsServiceVersion}
              onRefresh={() => void run("Развёртывания", loadDms, { quiet: true })}
            />
          ) : null}
          {page === "routing" ? (
            <NginxLogs
              busy={busy}
              type={logsType}
              filter={logsFilter}
              limit={logsLimit}
              lines={logLines}
              onType={setLogsType}
              onFilter={setLogsFilter}
              onLimit={setLogsLimit}
              onRefresh={() => void run("Логи nginx", () => loadNginxLogs(), { quiet: true })}
            />
          ) : null}
        </main>
        <ChangesBar
          docDirty={docDirty}
          dnsDirty={dnsDirty}
          busy={busy}
          onSaveDoc={() => void saveDraft()}
          onDiscardDoc={() => setDiscard("doc")}
          onSaveDns={() => void saveDns()}
          onDiscardDns={() => setDiscard("dns")}
        />
        <footer className="app-footer">
          <span>HomeNet Proxy Manager · локальная сеть</span>
          <span>Сохранение черновика не перезапускает прокси</span>
        </footer>
      </div>

      <Toasts items={toasts} onDismiss={dismissToast} />
      <OperationsDrawer open={opsOpen} items={operations} onClose={() => setOpsOpen(false)} onClear={() => setOperations([])} />
      <ApplyDialog
        open={applyOpen}
        busy={busy}
        docDirty={docDirty}
        apps={doc.apps.length}
        hosts={doc.hosts.length}
        checkState={checkState}
        checkOutput={checkOutput}
        applyState={applyState}
        applyOutput={applyOutput}
        onClose={() => setApplyOpen(false)}
        onSave={() => void saveDraft()}
        onCheck={() => void checkConfig()}
        onApply={() => void applyCurrent()}
      />
      <ConfigEditorDialog
        open={!!config}
        title={config?.title || ""}
        path={config?.path || ""}
        editable={!!config?.editable}
        content={config?.content || ""}
        busy={busy}
        onClose={() => setConfig(null)}
        onChange={(content) => setConfig((current) => (current ? { ...current, content } : current))}
        onSave={() =>
          void run("Файл сохранён", async () => {
            if (!config) return;
            const res = await writeConfig(config.id, config.content);
            if (!res.ok) throw new Error(res.error || res.output || "Не удалось сохранить");
            setConfig(null);
            await loadOverview();
          }, { success: config?.path })
        }
      />
      <CaDialog
        open={caOpen}
        busy={busy}
        onClose={() => setCaOpen(false)}
        onUpload={(cert, key) =>
          void run("Центр сертификации загружен", async () => {
            const res = await uploadCa(cert, key);
            if (!res.ok) throw new Error(res.output || res.error || "Не удалось загрузить");
            setCaOpen(false);
            await loadCertPart();
          })
        }
        onGenerate={(subject) =>
          void run("Центр сертификации создан", async () => {
            const res = await generateCa(subject);
            if (!res.ok) throw new Error(res.output || res.error || "Не удалось создать");
            setCaOpen(false);
            await loadCertPart();
          })
        }
      />
      <ConfirmDialog
        open={!!discard}
        title={discard === "dns" ? "Отменить изменения DNS / KeenDNS?" : "Отменить изменения черновика?"}
        confirmLabel="Отменить изменения"
        onClose={() => setDiscard(null)}
        onConfirm={() => {
          const scope = discard;
          confirmDiscard();
          if (scope === "dns" && page === "dns") void run("DNS / KeenDNS", loadDnsNdns, { quiet: true });
        }}
      >
        {discard === "dns"
          ? "Несохранённые правки DNS-записей и входов KeenDNS будут потеряны, данные перечитаются с роутера."
          : "Все правки после последнего сохранения routes.yml будут потеряны."}
      </ConfirmDialog>
    </div>
  );
}
