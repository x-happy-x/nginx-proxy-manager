#!/usr/bin/env python3
"""Choose one CrazyDNS route for TCP dialbacks and UDP cloud notifications."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import threading
import time
import urllib.parse
import urllib.request


def decision(state, candidates, healthy, now, fail_after=2, recover_after=3, hold=120):
    """Fail over after confirmed failures; restore higher priority with hysteresis."""
    counters = state.setdefault("counters", {})
    for name in candidates:
        c = counters.setdefault(name, {"ok": 0, "fail": 0})
        c["ok"] = c["ok"] + 1 if healthy.get(name, False) else 0
        c["fail"] = c["fail"] + 1 if not healthy.get(name, False) else 0
    current = state["selected"]
    usable = [n for n in candidates if healthy.get(n) and counters[n]["ok"] >= fail_after]
    if counters[current]["fail"] >= fail_after and usable:
        return usable[0]
    if now - state.get("changed_at", now) >= hold:
        for name in candidates[:candidates.index(current)]:
            if counters[name]["ok"] >= recover_after:
                return name
    return current


class Controller:
    def __init__(self, config):
        self.config = config
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.headers = {"Content-Type": "application/json"}
        secret = config.get("secret", "")
        if secret:
            self.headers["Authorization"] = "Bearer " + secret

    def call(self, path, method="GET", body=None):
        request = urllib.request.Request(
            self.config["controller"].rstrip("/") + path, method=method,
            headers=self.headers, data=None if body is None else json.dumps(body).encode())
        with self.opener.open(request, timeout=self.config["timeout_ms"] / 1000 + 3) as response:
            return json.loads(response.read() or b"{}")

    def probe(self, item):
        name, url = item
        query = urllib.parse.urlencode({"url": url, "timeout": self.config["timeout_ms"],
                                        "expected": "410"})
        try:
            result = self.call("/proxies/" + urllib.parse.quote(name, safe="") + "/delay?" + query)
            return name, url, result.get("delay")
        except Exception:
            # Controller errors can contain credentials; only record availability.
            return name, url, None

    def health(self):
        names, urls = self.config["candidates"], self.config["probe_urls"]
        results = {n: {} for n in names}
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            for name, url, delay in executor.map(self.probe, [(n, u) for n in names for u in urls]):
                results[name][url] = delay
        healthy = {n: sum(v is not None for v in values.values()) >= self.config["quorum"]
                   for n, values in results.items()}
        return healthy, results

    def close_cloud_connections(self):
        count = 0
        for connection in self.call("/connections").get("connections", []):
            meta = connection.get("metadata", {})
            network, port = meta.get("network", "").lower(), str(meta.get("destinationPort"))
            cloud_port = (network == "tcp" and port == "8090") or (network == "udp" and port in {"9", "4044"})
            if (self.config["group"] in connection.get("chains", []) and cloud_port
                    and meta.get("destinationIP") in self.config["cloud_ips"]):
                self.call("/connections/" + urllib.parse.quote(connection["id"], safe=""), "DELETE")
                count += 1
        return count


def fingerprint(groups, name):
    chain = []
    while name and name not in chain and len(chain) < 8:
        chain.append(name)
        name = groups.get(name, {}).get("now")
    return chain


def emit(event, **fields):
    print(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                      "event": event, **fields}, ensure_ascii=False), flush=True)


def cycle(config, controller, state, now=None):
    now = time.time() if now is None else now
    groups = controller.call("/proxies")["proxies"]
    group = groups[config["group"]]
    if group.get("type") != "Selector" or set(group.get("all", [])) != set(config["candidates"]):
        raise RuntimeError("Managed group changed; refusing unrelated configuration")
    actual = group.get("now")
    if actual not in config["candidates"]:
        raise RuntimeError("Unknown current candidate")
    if state.get("selected") != actual:
        state.update(selected=actual, changed_at=now, counters={}, pending_cleanup=True)
    route = fingerprint(groups, actual)
    if state.get("route") != route:
        state.update(udp_last_rx_at=now, udp_counts={})
    healthy, delays = controller.health()
    # HTTP readiness alone cannot detect an uplink that passes TCP but drops
    # UDP cloud notifications. Confirm replies from the real router agent.
    if config.get("udp_timeout_seconds"):
        counts = {}
        for connection in controller.call("/connections").get("connections", []):
            meta = connection.get("metadata", {})
            if (config["group"] in connection.get("chains", [])
                    and meta.get("network", "").lower() == "udp"
                    and str(meta.get("destinationPort")) == "9"
                    and meta.get("destinationIP") in config["cloud_ips"]):
                received = connection.get("download", 0)
                counts[connection["id"]] = received
                if received > state.get("udp_counts", {}).get(connection["id"], 0):
                    state["udp_last_rx_at"] = now
        state["udp_counts"] = counts
        if (now - state.get("changed_at", now) >= config["udp_grace_seconds"]
                and now - state.get("udp_last_rx_at", now) >= config["udp_timeout_seconds"]):
            blocked = state.setdefault("blocked_until", {})
            if now >= blocked.get(actual, 0):
                blocked[actual] = now + config["udp_cooldown_seconds"]
                emit("udp_no_reply", selected=actual)
        for name, until in state.get("blocked_until", {}).items():
            if until > now:
                healthy[name] = False
    selected = decision(state, config["candidates"], healthy, now,
                        config["fail_after"], config["recover_after"], config["return_hold_seconds"])
    if selected != actual:
        controller.call("/proxies/" + urllib.parse.quote(config["group"], safe=""),
                        "PUT", {"name": selected})
        state.update(selected=selected, changed_at=now, pending_cleanup=True,
                     udp_last_rx_at=now, udp_counts={})
        emit("switch", previous=actual, selected=selected)
        groups = controller.call("/proxies")["proxies"]
    route = fingerprint(groups, selected)
    if state.get("route") != route or state.get("pending_cleanup"):
        closed = controller.close_cloud_connections()
        state.update(route=route, pending_cleanup=False)
        emit("route_ready", selected=selected, route=route, closed=closed)
    state.update(checked_at=now, healthy=healthy, delays=delays,
                 degraded=not healthy.get(state["selected"], False))
    return state


def save_state(path, state):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".next")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/opt/etc/homenet/crazedns-failover.json")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--probe", action="store_true", help="Read-only candidate checks")
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    controller = Controller(config)
    if args.probe:
        healthy, delays = controller.health()
        print(json.dumps({"healthy": healthy, "delays": delays}, ensure_ascii=False))
        return
    import fcntl  # Entware/Linux service; read-only --probe also runs on Windows.
    state_path = Path(config["state_file"])
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with state_path.with_suffix(".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            state = {}
        stopped = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stopped.set())
        emit("started", group=config["group"])
        while not stopped.is_set():
            started = time.monotonic()
            try:
                cycle(config, controller, state)
                save_state(state_path, state)
            except Exception as error:
                emit("cycle_failed", error=type(error).__name__)
            if args.once:
                break
            stopped.wait(max(1, config["interval_seconds"] - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
