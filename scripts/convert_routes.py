#!/usr/bin/env python3
import argparse
import re
from pathlib import Path

import yaml


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data):
        return True


def slug(value):
    text = re.sub(r"[^a-zA-Z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return text or "app"


def is_public_host(host):
    h = str(host or "").strip().lower()
    if not h:
        return False
    return not (h.endswith(".local") or h.endswith(".lan") or h.endswith(".home.arpa"))


def normalize_ws_proxy(ws):
    ws = ws or {}
    return {
        "enabled": bool(ws.get("enabled", False)),
        "path": ws.get("path", "/connections") or "/connections",
        "rewrite_to_wss": bool(ws.get("rewrite_to_wss", False)),
        "rewrite_from": ws.get("rewrite_from", "") or "",
    }


def cert_policy_from_mode(mode):
    m = str(mode or "").strip().lower()
    if m == "off":
        return "off"
    if m == "acme":
        return "auto_acme"
    if m == "self-signed":
        return "self_signed"
    if m == "local-ca":
        return "auto_local_ca"
    return "auto_local_ca"


def convert_services_to_v21(old_cfg):
    services = old_cfg.get("services", [])
    global_ssl_mode = old_cfg.get("ssl_mode", "local-ca")
    listen_ips = old_cfg.get("listen_ips", [])
    ports = old_cfg.get("ports", {"http": 80, "https": 443, "http_extra": [], "https_extra": []})
    ui = old_cfg.get("ui", {"host": "0.0.0.0", "port": 8080})
    stub = old_cfg.get("stub", {"enabled": True, "root": "/opt/var/www/stub"})
    email = old_cfg.get("email", "")

    result = {
        "schema_version": 2.1,
        "globals": {
            "listen_ips": listen_ips,
            "ports": {
                "http": int(ports.get("http", 80) or 80),
                "https": int(ports.get("https", 443) or 443),
                "http_extra": ports.get("http_extra", []) or [],
                "https_extra": ports.get("https_extra", []) or [],
            },
            "ui": {
                "host": ui.get("host", "0.0.0.0") or "0.0.0.0",
                "port": int(ui.get("port", 8080) or 8080),
            },
            "stub": {
                "enabled": bool(stub.get("enabled", True)),
                "root": stub.get("root", "/opt/var/www/stub") or "/opt/var/www/stub",
            },
            "acme": {"email": email or ""},
        },
        "apps": [],
        "hosts": [],
    }

    app_ids = set()
    for idx, svc in enumerate(services, start=1):
        hosts = svc.get("hosts", []) or []
        upstream = svc.get("upstream", {}) or {}
        ws_proxy = normalize_ws_proxy(svc.get("ws_proxy"))
        app_name_base = hosts[0] if hosts else upstream.get("address", f"app-{idx}")
        app_id = f"app-{slug(app_name_base)}"
        if app_id in app_ids:
            app_id = f"{app_id}-{idx}"
        app_ids.add(app_id)

        app = {
            "id": app_id,
            "name": app_name_base,
            "upstream": {
                "address": upstream.get("address", ""),
                "port": int(upstream.get("port", 80) or 80),
                "scheme": upstream.get("scheme", "http") or "http",
                "verify_upstream_ssl": bool(upstream.get("verify_upstream_ssl", False)),
            },
            "ws_proxy": ws_proxy,
        }
        result["apps"].append(app)

        service_mode = (svc.get("ssl_mode") or "").strip().lower()
        if not service_mode:
            service_mode = str(global_ssl_mode or "local-ca").strip().lower()
        host_mode_map = svc.get("host_ssl_mode", {}) or {}
        service_san = svc.get("san", []) or []
        service_ndns = svc.get("ndns", {}) or {}
        add_local_dns = bool(svc.get("add_to_local_dns", False))

        for host_idx, host in enumerate(hosts):
            host_ssl_mode = str(host_mode_map.get(host, service_mode)).strip().lower()
            policy = cert_policy_from_mode(host_ssl_mode)

            dns_publish = []
            if add_local_dns:
                dns_publish.append("local")

            host_entry = {
                "host": host,
                "kind": "public" if is_public_host(host) else "private",
                "app_id": app_id,
                "dns": {
                    "publish": dns_publish,
                    "local_record_ip": "auto",
                },
                "tls": {
                    "cert_policy": policy,
                    "cert_ref": "none" if policy == "off" else "auto",
                    "san": list(service_san),
                },
                "endpoints": [
                    {
                        "name": "web",
                        "listen": {
                            "protocol": "http" if policy == "off" else "https",
                            "port": int(ports.get("http", 80) or 80) if policy == "off" else int(ports.get("https", 443) or 443),
                        },
                        "behavior": {
                            "redirect": "off" if policy == "off" else "https",
                        },
                    }
                ],
            }

            ndns_enabled = bool(service_ndns.get("enabled", False))
            if ndns_enabled and host_idx == 0:
                ndns_port_raw = service_ndns.get("port", "")
                ndns_port = "auto_random"
                try:
                    ndns_port_int = int(ndns_port_raw)
                    if 1 <= ndns_port_int <= 65535:
                        ndns_port = ndns_port_int
                except (TypeError, ValueError):
                    pass
                ndns_name = (service_ndns.get("name") or host.split(".", 1)[0]).strip()
                ndns_endpoint = {
                    "name": "ndns",
                    "listen": {
                        "protocol": "http",
                        "port": ndns_port,
                    },
                    "behavior": {
                        "ndns_profile": "ndns_proxy",
                        "ndns_name": ndns_name,
                        "ndns_domain": service_ndns.get("domain", "ndns") or "ndns",
                        "ndns_security_level": service_ndns.get("security_level", "public") or "public",
                        "ndns_ssl_redirect": bool(service_ndns.get("ssl_redirect", True)),
                        "ndns_target_ip": service_ndns.get("target", "auto") or "auto",
                    },
                }
                host_entry["endpoints"].append(ndns_endpoint)
                if "public" not in host_entry["dns"]["publish"]:
                    host_entry["dns"]["publish"].append("public")

            result["hosts"].append(host_entry)

    return result


def main():
    parser = argparse.ArgumentParser(description="Convert legacy routes.yml services schema to homenet routes schema (v2.1).")
    parser.add_argument("--input", required=True, help="Path to legacy routes.yml")
    parser.add_argument("--output", required=True, help="Path to output routes.yml")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    with input_path.open("r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}

    if "services" not in cfg:
        raise SystemExit("Input does not look like legacy schema: missing 'services'.")

    converted = convert_services_to_v21(cfg)

    with output_path.open("w", encoding="utf-8") as f:
        yaml.dump(converted, f, Dumper=NoAliasDumper, sort_keys=False, default_flow_style=False, allow_unicode=False)

    print(f"Converted: {input_path} -> {output_path}")
    print(f"Apps: {len(converted.get('apps', []))}, Hosts: {len(converted.get('hosts', []))}")


if __name__ == "__main__":
    main()
