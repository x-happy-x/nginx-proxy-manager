export type TabKey = "overview" | "servers" | "certs" | "dns" | "logs" | "routing";

export type TabItem = {
  key: TabKey;
  labelKey: "tabs.overview" | "tabs.servers" | "tabs.certs" | "tabs.dns" | "tabs.logs" | "tabs.routing";
  icon: "overview" | "server" | "cert" | "dns" | "logs" | "refresh";
};

export const TABS: TabItem[] = [
  { key: "overview", labelKey: "tabs.overview", icon: "overview" },
  { key: "servers", labelKey: "tabs.servers", icon: "server" },
  { key: "certs", labelKey: "tabs.certs", icon: "cert" },
  { key: "dns", labelKey: "tabs.dns", icon: "dns" },
  { key: "logs", labelKey: "tabs.logs", icon: "logs" },
  { key: "routing", labelKey: "tabs.routing", icon: "refresh" },
];
