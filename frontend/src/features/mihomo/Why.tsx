import { useEffect, useMemo, useState } from "react";
import { analyzeTarget, type Analysis, type ProbePath, type ProbeStep } from "../../api";
import { PageHeader } from "../../navigation";
import { errText } from "../../lib/format";
import { core, mihomo, type MProxy } from "./api";
import { StepIcon } from "../network/shared";

/*
 * VPN → «Почему не открывается» (NPM-48): one address, the way a device's
 * request goes — rule, group, node, DNS, connection, TLS, the site's answer —
 * with the first broken step, the reason in plain words and the other nodes
 * of the same group tried with the same address.
 */

const RECENT_KEY = "homenet.vpn.whyRecent";

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

/** What a broken step means, for a person. */
const VERDICT: Record<string, { title: string; text: string }> = {
  ok: { title: "Открывается", text: "Запрос проходит до конца и сайт отвечает." },
  dns: { title: "Адрес не находится", text: "DNS не вернул адрес сайта. Проверьте, что имя написано верно, или сайт мог переехать." },
  ip: { title: "Узел или сайт не отвечает вовсе", text: "Соединение молчит до тайм-аута. Так выглядит отсев по IP: фильтр не пропускает этот адрес. Узлы на том же сервере, скорее всего, тоже не помогут — пробуйте узел на другом сервере." },
  sni: { title: "Соединение сбрасывают по имени сайта", text: "Тот же адрес отвечает на другое имя, а на это — сброс. Это фильтр по SNI. Нужен путь через узел, а не напрямую." },
  tls: { title: "Не получается защищённое соединение", text: "TLS-рукопожатие не прошло: соединение обрывается или подменяется сертификат." },
  stub: { title: "Вместо сайта — заглушка", text: "Сайт отвечает страницей-заглушкой провайдера или блокировки." },
  throttle: { title: "Сайт открывается, но данные замирают", text: "Первые килобайты проходят, потом поток останавливается. Так ТСПУ замедляет зарубежные хостинги." },
  http: { title: "Сайт ответил ошибкой", text: "Путь работает, но сам сайт вернул ошибку." },
  error: { title: "Не удалось проверить", text: "Проверка не прошла до конца." },
};

function firstFail(p?: ProbePath): ProbeStep | undefined {
  return p?.steps.find((s) => s.status === "fail");
}

export function Why({ onNodes }: { onNodes: () => void }) {
  const [target, setTarget] = useState(() => {
    const m = location.hash.match(/^#\/why\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  });
  const [res, setRes] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [suggest, setSuggest] = useState<string[]>([]);
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [alts, setAlts] = useState<Record<string, number> | null>(null);
  const [altBusy, setAltBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void core
      .services()
      .then((r) => setSuggest(r.services.filter((s) => s.url).map((s) => new URL(s.url!).hostname)))
      .catch(() => undefined);
    if (target) void run(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (value = target) => {
    const host = value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host || busy) return;
    setTarget(host);
    setBusy(true);
    setErr("");
    setAlts(null);
    setMsg("");
    try {
      const [a, p] = await Promise.all([analyzeTarget(host, ["mihomo", "direct"]), mihomo.allProxies()]);
      setRes(a);
      setProxies(p.proxies);
      const next = [host, ...recent.filter((x) => x !== host)].slice(0, 6);
      setRecent(next);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* a remembered list is a convenience */
      }
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const via = res?.paths.find((p) => p.id === "mihomo");
  const direct = res?.paths.find((p) => p.id === "direct");
  const chain = via?.chain || [];
  const fail = firstFail(via);
  const verdict = VERDICT[via?.verdict || ""] || { title: via?.summary || "—", text: "" };
  // the group that picks the node: the last one above the node
  const pickGroup = useMemo(() => {
    for (let i = chain.length - 2; i >= 0; i--) if ((proxies[chain[i]]?.all?.length || 0) > 1) return chain[i];
    return "";
  }, [chain, proxies]);
  const node = chain[chain.length - 1] || "";
  const fixed = pickGroup ? proxies[pickGroup]?.fixed : "";

  const tryOthers = async () => {
    if (!res || !pickGroup) return;
    setAltBusy(true);
    setMsg("");
    try {
      setAlts(await mihomo.groupDelay(pickGroup, `https://${res.host}/`, 6000));
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setAltBusy(false);
    }
  };
  const pin = async (name: string) => {
    if (!pickGroup) return;
    try {
      await mihomo.select(pickGroup, name);
      setMsg(`«${pickGroup}» теперь идёт через ${name}. Закрепление снимется само, если узел перестанет отвечать.`);
      void run(target);
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const unpin = async () => {
    try {
      await mihomo.unfix(pickGroup);
      setMsg(`«${pickGroup}» снова выбирает узел сама.`);
      void run(target);
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const steps: Array<{ label: string; value: string; status: "ok" | "fail" | "warn" | "skip"; note?: string }> = via
    ? [
        { label: "Правило", value: via.rule || "—", status: via.rule ? "ok" : "skip" },
        { label: "Группа и узел", value: chain.length ? chain.map((n) => (n === "DIRECT" ? "напрямую" : n)).join(" → ") : "—", status: chain.length ? "ok" : "skip", note: fixed ? "закреплён вручную" : undefined },
        ...via.steps.map((s) => ({ label: s.title, value: s.detail || (s.status === "skip" ? "не дошли" : s.ms ? `${Math.round(s.ms)} мс` : ""), status: s.status })),
      ]
    : [];
  const altRows = alts
    ? Object.entries(alts)
        .map(([name, ms]) => ({ name, ms }))
        .sort((a, b) => (a.ms > 0 ? a.ms : 1e9) - (b.ms > 0 ? b.ms : 1e9))
    : [];

  return (
    <div className="stack vn">
      <PageHeader page="why" />
      <form
        className="vw-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label htmlFor="why-host" className="sr-only">
          Адрес сайта или сервиса
        </label>
        <input id="why-host" className="mono" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="keycloak.example.org или youtube.com" autoComplete="off" spellCheck={false} />
        <button className="btn btn-primary" disabled={busy || !target.trim()}>
          {busy ? "Проверяю…" : "Проверить"}
        </button>
        <div className="vn-chips">
          {[...new Set([...recent, ...suggest])].slice(0, 10).map((h) => (
            <button key={h} type="button" className="vn-chip" onClick={() => void run(h)}>
              {h}
            </button>
          ))}
        </div>
      </form>
      {err ? <p className="vn-err">{err}</p> : null}
      {busy && !res ? <p className="mh-muted">Проверяю через mihomo и напрямую, это 5–15 секунд…</p> : null}

      {res && via ? (
        <div className="vw-grid">
          <section className="vw-steps" aria-label="Путь запроса">
            {steps.map((s, i) => (
              <div key={i} className={`vw-step${s === steps.find((x) => x.status === "fail") ? " is-fail" : ""}${s.status === "skip" ? " is-skip" : ""}`}>
                <span className="vw-no">{i + 1}</span>
                <span className="vw-label">{s.label}</span>
                <span className="vw-value">
                  {s.value}
                  {s.note ? <em> · {s.note}</em> : null}
                </span>
                <StepIcon status={s.status} />
              </div>
            ))}
          </section>
          <section className="vw-side">
            <div className={`vw-verdict ${via.verdict === "ok" ? "vn-ok-soft" : "vn-bad-soft"}`}>
              <b>{verdict.title}</b>
              <span>{verdict.text}</span>
              {fail?.detail ? <small>{fail.title}: {fail.detail}</small> : null}
              {direct ? (
                <small>
                  Напрямую, мимо VPN: {direct.verdict === "ok" ? "открывается" : (VERDICT[direct.verdict]?.title || direct.summary).toLowerCase()}.
                </small>
              ) : null}
            </div>
            {pickGroup ? (
              <div className="vw-alts">
                <div className="vn-section-head">
                  <b>Через другие узлы группы «{pickGroup}»</b>
                  {fixed ? (
                    <button className="btn btn-sm" onClick={() => void unpin()}>
                      Снять закрепление
                    </button>
                  ) : null}
                </div>
                {!alts ? (
                  <button className="btn btn-sm" disabled={altBusy} onClick={() => void tryOthers()}>
                    {altBusy ? `Проверяю ${proxies[pickGroup]?.all?.length || ""} узлов…` : `Проверить ${res.host} через каждый узел`}
                  </button>
                ) : (
                  <div className="vw-alt-list">
                    {altRows.slice(0, 12).map((r) => (
                      <div key={r.name} className="vw-alt">
                        <span className="truncate">
                          {r.name === "DIRECT" ? "Напрямую" : r.name}
                          {r.name === node ? <em> · сейчас</em> : null}
                        </span>
                        <span className={r.ms > 0 ? "vw-ok" : "vw-bad"}>{r.ms > 0 ? `${r.ms} мс` : "не открылся"}</span>
                        {r.ms > 0 && r.name !== node ? (
                          <button className="btn btn-sm" onClick={() => void pin(r.name)}>
                            Пустить через него
                          </button>
                        ) : (
                          <span />
                        )}
                      </div>
                    ))}
                    {altRows.length > 12 ? <small className="mh-muted">и ещё {altRows.length - 12}: открылись {altRows.slice(12).filter((r) => r.ms > 0).length}</small> : null}
                  </div>
                )}
                {msg ? <small>{msg}</small> : null}
              </div>
            ) : null}
            <button className="btn btn-sm" onClick={onNodes}>
              Узлы и группы
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
