import { useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { errText } from "../../lib/format";
import { core, type ProbeResult, type ProbeState, type ServicesReport } from "./api";
import { Pill, hhmm, type Tone } from "./VpnOverview";

/*
 * «Сейчас» → «Связь» (NPM-52): the pages phones and browsers use to tell
 * whether there is internet, straight through the uplink and through mihomo.
 * Straight: which of them the provider lets through (Yandex only — the
 * whitelist); through mihomo: whether the VPN carries the rest.
 */

const COUNTRY: Record<string, string> = { RU: "Россия", LT: "Литва", DE: "Германия", NL: "Нидерланды", FI: "Финляндия", PL: "Польша", SE: "Швеция", US: "США", FR: "Франция", GB: "Великобритания", TR: "Турция", KZ: "Казахстан", AM: "Армения", EE: "Эстония", LV: "Латвия" };
const last = (h: ProbeResult[]) => h[h.length - 1];

function Cell({ h, slow }: { h: ProbeResult[]; slow: number }) {
  const r = last(h);
  const tone: Tone = !r ? "idle" : !r.ok ? "bad" : r.ms > slow ? "warn" : "ok";
  return (
    <span className="cn-cell">
      <span className="cn-cell-top">
        <Pill tone={tone}>{!r ? "—" : r.ok ? `${r.ms} мс` : r.error || "нет"}</Pill>
      </span>
      <span className="vn-bars cn-bars" aria-hidden="true">
        {Array.from({ length: 30 }, (_, i) => h[h.length - 30 + i]).map((x, i) => (
          <i key={i} className={!x ? "" : !x.ok ? "vn-bar-bad" : x.ms > slow ? "vn-bar-warn" : "vn-bar-ok"} title={x ? `${hhmm(x.t)} · ${x.ok ? `${x.ms} мс` : x.error}` : undefined} />
        ))}
      </span>
    </span>
  );
}

export function Connectivity({ report, onReport }: { report: ServicesReport | null; onReport: (r: ServicesReport) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const probes: ProbeState[] = report?.probes || [];
  if (!probes.length) return null;

  const ok = (p: ProbeState, way: "direct" | "mihomo") => !!last(p[way].history)?.ok;
  const checked = probes.some((p) => p.direct.history.length);
  const ru = probes.filter((p) => p.region === "ru");
  const world = probes.filter((p) => p.region === "world" && !p.trace);
  const ruDirect = ru.some((p) => ok(p, "direct"));
  const worldDirect = world.filter((p) => ok(p, "direct")).length;
  const worldVpn = world.filter((p) => ok(p, "mihomo")).length;
  const trace = probes.find((p) => p.trace);

  const verdict: { tone: Tone; title: string; text: string } = !checked
    ? { tone: "idle", title: "Проверка ещё не прошла", text: "Страницы проверяются раз в 2 минуты." }
    : worldDirect > 0
      ? { tone: "ok", title: "Провайдер пропускает всё", text: `Напрямую открываются ${worldDirect} из ${world.length} зарубежных страниц — ограничений нет.` }
      : ruDirect
        ? { tone: "warn", title: "Белые списки", text: "Напрямую открывается только Яндекс, зарубежные страницы — нет. Их несёт VPN." }
        : { tone: "bad", title: "Напрямую ничего не открывается", text: "Даже Яндекс не отвечает: канал провайдера не работает." };
  const vpn: Tone = !checked ? "idle" : worldVpn === world.length ? "ok" : worldVpn > 0 ? "warn" : "bad";

  const check = async () => {
    setBusy(true);
    setErr("");
    try {
      onReport(await core.checkServices("probes"));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="vn-section cn" aria-label="Связь">
      <div className="vn-section-head">
        <h3>
          Связь <span>· страницы, по которым телефоны и браузеры понимают, есть ли интернет</span>
        </h3>
        <div className="vn-chips">
          <button className="vn-chip" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Свернуть" : `Все ${probes.length} страниц`}
          </button>
          <button className="vn-chip" disabled={busy} onClick={() => void check()}>
            <Icon name="refresh" size={13} /> {busy ? "Проверяю…" : "Проверить"}
          </button>
        </div>
      </div>
      {err ? <p className="vn-err">{err}</p> : null}
      <div className="cn-summary">
        <div className={`cn-sum vn-${verdict.tone}-soft`}>
          <i className={`vn-dot vn-${verdict.tone}`} />
          <span>
            <small>Напрямую, без VPN</small>
            <b>{verdict.title}</b>
            <span>{verdict.text}</span>
          </span>
        </div>
        <div className={`cn-sum vn-${vpn}-soft`}>
          <i className={`vn-dot vn-${vpn}`} />
          <span>
            <small>Через VPN, как у устройств</small>
            <b>{!checked ? "—" : `Открываются ${worldVpn} из ${world.length}`}</b>
            <span>{vpn === "ok" ? "Зарубежные страницы проверки связи открываются." : vpn === "warn" ? "Часть страниц не открывается — ниже какие." : checked ? "Зарубежные страницы не открываются и через VPN." : ""}</span>
          </span>
        </div>
        {trace ? (
          <div className="cn-sum">
            <Icon name="globe" size={18} />
            <span>
              <small>Где выход в интернет</small>
              <b>
                {trace.mihomo.loc ? `${COUNTRY[trace.mihomo.loc] || trace.mihomo.loc} через VPN` : "через VPN — не известно"}
              </b>
              <span>
                {trace.direct.loc ? `напрямую — ${COUNTRY[trace.direct.loc] || trace.direct.loc}${trace.direct.ip ? `, ${trace.direct.ip}` : ""}` : "напрямую Cloudflare не ответил"}
                {trace.mihomo.ip ? ` · выход VPN ${trace.mihomo.ip}` : ""}
              </span>
            </span>
          </div>
        ) : null}
      </div>
      {open ? (
        <div className="cn-table" role="table" aria-label="Страницы проверки связи">
          <div className="cn-row cn-head" role="row">
            <span role="columnheader">Страница</span>
            <span role="columnheader">Напрямую</span>
            <span role="columnheader">Через VPN</span>
          </div>
          {probes.map((p) => (
            <div key={p.id} className="cn-row" role="row">
              <span className="cn-name" role="cell">
                <b>
                  {p.name}
                  {p.region === "ru" ? <span className="cn-tag">белый список</span> : null}
                </b>
                <small className="truncate" title={p.url}>
                  {p.what} · {p.url.replace(/^https?:\/\//, "")}
                </small>
                {p.mihomo.path?.length ? <small className="truncate">через VPN: {p.mihomo.path.join(" → ")}</small> : null}
              </span>
              <span role="cell">
                <Cell h={p.direct.history} slow={1500} />
              </span>
              <span role="cell">
                <Cell h={p.mihomo.history} slow={2500} />
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
