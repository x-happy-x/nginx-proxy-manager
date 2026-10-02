"""NPM-33 prototype: builds the routing block (providers, groups, rules) from a
few settings and splices it into a copy of the live config.yaml.

Usage: python routing_draft.py live-config.yaml draft-config.yaml fragment.yaml
The fragment (no secrets) goes to the repo for review; the draft stays local.
"""
import re
import sys

SETTINGS = {
    # Bypass nodes: traffic on them is limited. "авто" is NOT a bypass marker.
    "bypass": r"(?i)(обход|white|бел(ый|ые)\s*спис|whitelist|4g|lte|мобильн|mobile)",
    "junk": r"(?i)(\[free\]|только tg|бот \+ сайт)",
    "eu": "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE EU GB CH NO IS".split(),
    "ai": "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE EU GB CH NO IS US CA JP KR SG AU KZ".split(),
    "never": "RU BY HK CN MO IR KP".split(),  # not used for direct exits
    "fast_ms": 800,
    "ru_check": "https://habr.com/ru/feed/",
    "headscale_check": "https://headscale.tailnt.ru/health",
    "keycloak_check": "https://keycloak.tailnt.ru/",
    "ai_check": "https://chatgpt.com/cdn-cgi/trace",
}


def flag(cc: str) -> str:
    return "".join(chr(0x1F1E6 + ord(c) - 65) for c in cc)


def flags_re(codes) -> str:
    return "(" + "|".join(flag(c) for c in codes) + ")"


def q(s: str) -> str:
    """YAML single-quoted scalar."""
    return "'" + s.replace("'", "''") + "'"


S = SETTINGS
BYPASS, JUNK = S["bypass"], S["junk"]
EU, AI, NEVER = flags_re(S["eu"]), flags_re(S["ai"]), flags_re(S["never"])
CHECK = "https://www.gstatic.com/generate_204"
CHECK2 = "https://cp.cloudflare.com/generate_204"


def adaptive_block(live: str) -> str:
    """network-key, direct-allowed and direct-global of ROUTER, reused by the AI provider."""
    m = re.search(r"\n      adaptive:\n(.*?)\n        targets:", live, re.S)
    if not m:
        raise SystemExit("ROUTER has no adaptive block")
    keep = []
    for line in m.group(1).split("\n"):
        if re.match(r"\s+(enable|confirmations|concurrency):", line):
            continue
        keep.append(line)
    return "\n".join(keep)


def providers(live: str) -> str:
    direct = adaptive_block(live)
    return f"""  # --- HomeNet: routing (NPM-33) -------------------------------------
  # The same nodes as ROUTER, read from its cache file: ROUTER alone updates
  # the subscription. Names get a prefix so the panels can tell them apart.
  CHAIN:
    type: file
    path: ./proxy-providers/router.yaml
    interval: 3600
    filter: {q(AI)}
    exclude-filter: {q(BYPASS + '|' + JUNK)}
    override:
      additional-prefix: '⛓ '
      # Cascade: reach the server through a bypass node when it is not
      # reachable directly (white lists). Costs bypass traffic.
      dialer-proxy: 'Обходы'
    health-check:
      enable: true
      lazy: true
      url: {CHECK}
      expected-status: '204'
      interval: 600
      timeout: 8000
  AI:
    type: file
    path: ./proxy-providers/router.yaml
    interval: 3600
    filter: {q(AI)}
    exclude-filter: {q(JUNK)}
    override:
      additional-prefix: 'ИИ | '
    health-check:
      enable: true
      lazy: false
      url: {CHECK}
      expected-status: '204'
      interval: 600
      timeout: 5000
      adaptive:
        enable: true
        depends-on: ROUTER
{direct}
        confirmations: 2
        concurrency: 2
        failure-threshold: 3
        recovery-threshold: 2
        targets:
          # Exit country as Cloudflare sees it: the node name may not match.
          # The chatgpt.com page itself is not used: Cloudflare answers 403
          # to a burst of checks from shared exit addresses.
          - url: https://chatgpt.com/cdn-cgi/trace
            expected-status: '200'
            content-type: text/plain
            body-regex: '(?m)^loc=[A-Z]{{2}}$'
            body-not-regex: '(?m)^loc=({'|'.join(S['never'] + ['SY', 'CU', 'VE', 'AF'])})$'
          # The API answers 401 without a key where the service works and
          # 403 unsupported_country where it does not.
          - url: https://api.openai.com/v1/models
            expected-status: '401'
            content-type: application/json
            body-not-regex: '(?i)unsupported_country'
"""


def groups(live: str) -> str:
    ru = re.search(r"  - name: 'RU'\n(.*?)(?=\n  - name:|\n  #)", live, re.S)
    ru_url = re.search(r"\n    url: (.*)", ru.group(1)).group(1) if ru else q(S["ru_check"])
    fast = S["fast_ms"]
    return f"""proxy-groups:
  # ---------------------------------------------------------------
  # HomeNet: routing (NPM-33). Generated; edit in «VPN → Настройка».
  # Base groups look into the subscription. Fallback over ROUTER uses
  # the adaptive admission: in white-list mode only working nodes pass.
  # ---------------------------------------------------------------
  - name: 'Прямые EU'
    type: fallback
    use: ['ROUTER']
    filter: {q(EU)}
    exclude-filter: {q(BYPASS + '|' + JUNK)}
    url: {CHECK}
    interval: 300
  - name: 'Прямые мир'
    type: fallback
    use: ['ROUTER']
    exclude-filter: {q(BYPASS + '|' + JUNK + '|' + NEVER + '|' + EU)}
    url: {CHECK}
    interval: 300
  # Bypass nodes: limited traffic, used when direct ones do not work.
  - name: 'Обходы'
    type: fallback
    use: ['ROUTER']
    filter: {q(BYPASS)}
    exclude-filter: {q(JUNK)}
    url: {CHECK}
    interval: 300
  - name: 'RU'
    type: fallback
    use: ['ROUTER']
    filter: {q(flag('RU'))}
    exclude-filter: {q(BYPASS + '|' + JUNK)}
    # RU nodes are checked by a RU address: gstatic is unreachable from RU.
    url: {ru_url}
    expected-status: '200'
    interval: 300
  - name: 'Каскад'
    type: fallback
    use: ['CHAIN']
    url: {CHECK}
    interval: 600
    timeout: 8000
    lazy: true
  - name: 'Резерв'
    type: select
    use: ['BACKUP']
  # Direct servers while they answer within {fast} ms; bypass ones otherwise.
  # The limit works here, where this group itself tests its members.
  - name: 'Быстрые'
    type: fallback
    proxies: ['Прямые EU', 'Прямые мир', 'Обходы']
    url: {CHECK}
    health-check-urls: [{CHECK2}]
    interval: 300
    timeout: {fast}
    lazy: false
  # If even «Быстрые» fails: any bypass, then the cascade (no delay limit).
  - name: 'AUTO'
    type: fallback
    proxies: ['Быстрые', 'Обходы', 'Каскад']
    url: {CHECK}
    health-check-urls: [{CHECK2}]
    interval: 300
    timeout: 5000
    lazy: false
  # AI: only supported countries ({' '.join(S['ai'])}),
  # checked by the service page through the AI provider.
  - name: 'ИИ прямые'
    type: fallback
    use: ['AI']
    exclude-filter: {q(BYPASS)}
    url: {CHECK}
    interval: 600
  - name: 'ИИ обходы'
    type: fallback
    use: ['AI']
    filter: {q(BYPASS)}
    url: {CHECK}
    interval: 600
  - name: 'ALL'
    type: select
    proxies: ['AUTO', 'Прямые EU', 'Прямые мир', 'Обходы', 'RU', 'Каскад', 'Резерв', DIRECT]
    use: ['ROUTER']
  - name: 'OLCRTC'
    type: select
    use: ['olcrtc']
  - name: 'Tailscale'
    type: select
    proxies:
      - 'TS-TAILNT'
      - REJECT
  # ---------------------------------------------------------------
  # Rule groups. Fallback ones pick automatically; a node picked by
  # hand stays while it passes the checks.
  # ---------------------------------------------------------------
  - name: 'ИИ'
    type: fallback
    proxies: ['ИИ прямые', 'ИИ обходы', 'Каскад']
    url: {CHECK}
    interval: 300
    timeout: 5000
  # RU sites (except white lists): direct, then a RU server, then any.
  # Checked by a RU site outside the white lists.
  - name: 'РФ'
    type: fallback
    proxies: [DIRECT, 'RU', 'AUTO']
    url: {S['ru_check']}
    expected-status: '200-399'
    interval: 300
    timeout: 5000
  # Tailnt sign-in must always work for Tailscale.
  - name: 'Headscale'
    type: fallback
    proxies: [DIRECT, 'RU', 'AUTO']
    url: {S['headscale_check']}
    expected-status: '200'
    interval: 120
    timeout: 5000
    lazy: false
  - name: 'Keycloak'
    type: fallback
    proxies: [DIRECT, 'RU', 'AUTO']
    url: {S['keycloak_check']}
    expected-status: '200-399'
    interval: 120
    timeout: 5000
    lazy: false
  - name: 'Игры'
    type: select
    proxies: [DIRECT, 'RU', 'AUTO', 'Прямые EU', 'ALL', REJECT]
  - name: 'Заблокированные сервисы'
    type: select
    proxies: ['AUTO', 'Прямые EU', 'Прямые мир', 'Обходы', 'Каскад', 'ALL', 'OLCRTC', 'Tailscale', DIRECT, REJECT]
  - name: 'Остальное'
    type: select
    proxies: ['AUTO', DIRECT, 'Прямые EU', 'Прямые мир', 'Обходы', 'ALL', 'OLCRTC', 'Tailscale', REJECT]
  - name: 'Белые списки'
    type: select
    proxies: [DIRECT, 'AUTO', 'Обходы', 'ALL', REJECT]
  - name: 'QUIC'
    type: select
    proxies: [REJECT, DIRECT, 'AUTO']
  - name: 'GLOBAL'
    type: select
    proxies: ['AUTO', 'Прямые EU', 'Прямые мир', 'Обходы', 'Каскад', 'ALL', 'OLCRTC', 'Tailscale', DIRECT, REJECT]
"""


RULES_TAILNT = """  # Tailnt sign-in (headscale, keycloak): own groups with checks (NPM-33).
  - DOMAIN,headscale.tailnt.ru,Headscale
  - DOMAIN,keycloak.tailnt.ru,Keycloak
"""


def splice(live: str) -> str:
    out = live
    # 1. providers: before the top-level "proxies:" key
    i = out.index("\nproxies:\n")
    out = out[:i] + "\n" + providers(live).rstrip("\n") + out[i:]
    # 2. groups: replace the whole proxy-groups section
    a = out.index("\n# =========================\n# ГРУППЫ ПРОКСИ")
    a = out.index("proxy-groups:\n", a)
    b = out.index("\ngeox-url:", a)
    out = out[:a] + groups(live).rstrip("\n") + out[b:]
    # 3. rules
    out = out.replace("  - DOMAIN-SUFFIX,headscale.tailnt.ru,GLOBAL\n", "")
    anchor = "  - GEOIP,private,DIRECT,no-resolve\n"
    assert anchor in out
    out = out.replace(anchor, anchor + RULES_TAILNT, 1)
    return out


def fragment(live: str) -> str:
    return (
        "# HomeNet routing block (NPM-33), generated by the draft script.\n"
        "# Added to proxy-providers (ROUTER, BACKUP and olcrtc stay as they are):\n"
        "proxy-providers:\n"
        + providers(live).replace(adaptive_block(live), "        # network-key, direct-allowed, direct-global: copied from ROUTER")
        + "\n# Replaces the whole proxy-groups section:\n"
        + groups(live)
        + "\n# Rules: 'DOMAIN-SUFFIX,headscale.tailnt.ru,GLOBAL' is removed; after\n# 'GEOIP,private,DIRECT,no-resolve' is added:\nrules:\n"
        + RULES_TAILNT
    )


if __name__ == "__main__":
    live = open(sys.argv[1], encoding="utf-8").read()
    open(sys.argv[2], "w", encoding="utf-8", newline="\n").write(splice(live))
    open(sys.argv[3], "w", encoding="utf-8", newline="\n").write(fragment(live))
    print("ok")
