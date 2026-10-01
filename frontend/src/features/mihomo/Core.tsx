import { useState } from "react";
import { PageHeader } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Alert, Segmented, Switch } from "../../components/ui/controls";
import { errText } from "../../lib/format";
import { mihomo } from "./api";
import { MODE_LABEL, useMihomo } from "./context";

type Danger = "restart" | "upgrade" | "tun" | null;

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mh-setrow">
      <div>
        <strong>{title}</strong>
        {hint ? <span className="cell-sub">{hint}</span> : null}
      </div>
      <div className="mh-setrow-control">{children}</div>
    </div>
  );
}

export function Core({ onConfig }: { onConfig: () => void }) {
  const { status, configs, refreshConfigs, refreshStatus, setMode, act } = useMihomo();
  const [danger, setDanger] = useState<Danger>(null);
  const [channel, setChannel] = useState<"release" | "alpha">("release");
  const [dnsName, setDnsName] = useState("youtube.com");
  const [dnsType, setDnsType] = useState("A");
  const [dnsAnswer, setDnsAnswer] = useState<string>("");
  const [busy, setBusy] = useState("");

  const patch = async (title: string, body: Record<string, unknown>, done: string) => {
    if (await act(title, () => mihomo.patchConfigs(body), done)) await refreshConfigs();
  };
  const run = async (id: string, title: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    await act(title, fn, done);
    setBusy("");
  };

  const query = async () => {
    setBusy("dns");
    try {
      const r = await mihomo.dnsQuery(dnsName.trim(), dnsType);
      setDnsAnswer(r.Answer?.length ? r.Answer.map((a) => `${a.data}  (TTL ${a.TTL})`).join("\n") : `Нет ответа, код ${r.Status}`);
    } catch (err) {
      setDnsAnswer(errText(err));
    }
    setBusy("");
  };

  const tunOn = !!configs?.tun?.enable;

  return (
    <div className="stack">
      <PageHeader
        page="core"
        actions={
          <span className="badge badge-mono" title={status?.binary}>
            {status?.version || "версия неизвестна"}
            {status?.fork ? " · форк x-happy-x" : ""}
          </span>
        }
      />
      {status && !status.fork ? (
        <Alert tone="info" title="Работает не форк x-happy-x/mihomo">
          Адаптивная проверка подписок и OLCRTC есть только в форке. Кнопка «Обновить ядро» ставит релиз форка.
        </Alert>
      ) : null}
      <div className="grid-2 mh-grid-even">
        <div className="stack">
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Режим и сеть</h2>
              <span className="cell-sub">меняется на лету, до перезапуска ядра</span>
            </div>
            <div className="card-body stack">
              <Row title="Режим" hint="Как ядро выбирает маршрут">
                <Segmented<string> label="Режим" value={configs?.mode || "rule"} onChange={(v) => void setMode(v)} options={Object.entries(MODE_LABEL).map(([value, label]) => ({ value, label }))} />
              </Row>
              <Row title="TUN" hint={`Перехват всего трафика роутера · стек ${configs?.tun?.stack || "—"}`}>
                <Switch checked={tunOn} onChange={() => setDanger("tun")} label={tunOn ? "включён" : "выключен"} />
              </Row>
              <Row title="Стек TUN">
                <Segmented<string> label="Стек TUN" value={configs?.tun?.stack?.toLowerCase() || "mixed"} onChange={(v) => void patch("TUN", { tun: { stack: v } }, `Стек ${v}`)} options={["system", "gvisor", "mixed"].map((s) => ({ value: s, label: s }))} />
              </Row>
              <Switch checked={!!configs?.["allow-lan"]} onChange={(v) => void patch("Разрешить LAN", { "allow-lan": v }, v ? "Включено" : "Выключено")} label="Разрешить LAN" hint="Подключения к портам mihomo из локальной сети" />
              <Switch checked={!!configs?.ipv6} onChange={(v) => void patch("IPv6", { ipv6: v }, v ? "Включён" : "Выключен")} label="IPv6" />
              <Row title="Журнал">
                <select value={configs?.["log-level"] || "info"} onChange={(e) => void patch("Уровень журнала", { "log-level": e.target.value }, e.target.value)}>
                  {["silent", "error", "warning", "info", "debug"].map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </Row>
              <Row title="Порты" hint="mixed · socks · http · redir · tproxy">
                <span className="mono">
                  {[configs?.["mixed-port"], configs?.["socks-port"], configs?.port, configs?.["redir-port"], configs?.["tproxy-port"]].map((p) => p || "—").join(" · ")}
                </span>
              </Row>
              <p className="cell-sub">
                Чтобы изменения пережили перезапуск, задайте их в{" "}
                <button type="button" className="btn btn-ghost btn-sm" onClick={onConfig}>
                  «Конфигурация → DNS и TUN»
                </button>
              </p>
            </div>
          </section>
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">DNS</h2>
            </div>
            <div className="card-body stack">
              <form
                className="mh-rule-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void query();
                }}
              >
                <input aria-label="Домен" className="mono" value={dnsName} onChange={(e) => setDnsName(e.target.value)} />
                <select aria-label="Тип записи" value={dnsType} onChange={(e) => setDnsType(e.target.value)}>
                  {["A", "AAAA", "CNAME", "TXT", "MX"].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <button type="submit" className="btn" disabled={busy === "dns" || !dnsName.trim()}>
                  {busy === "dns" ? <span className="spinner" /> : <Icon name="search" />}
                  Спросить ядро
                </button>
              </form>
              {dnsAnswer ? <pre className="code-block">{dnsAnswer}</pre> : null}
              <div className="button-row">
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void run("fdns", "Кеш DNS", mihomo.flushDNS, "Сброшен")}>
                  Сбросить кеш DNS
                </button>
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void run("ffake", "fake-ip", mihomo.flushFakeIP, "Сброшен")}>
                  Сбросить fake-ip
                </button>
              </div>
              <p className="cell-sub">Подробная проверка резолверов — «Сеть → DNS».</p>
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Конфигурация</h2>
            </div>
            <div className="card-body stack">
              <Row title="Перечитать config.yaml" hint="Применить файл, изменённый вне HomeNet">
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void run("reload", "config.yaml", mihomo.reload, "Перечитан").then(refreshConfigs)}>
                  {busy === "reload" ? <span className="spinner" /> : <Icon name="refresh" />}
                  Перечитать
                </button>
              </Row>
              <Row title="Гео-базы" hint="GeoIP, GeoSite, MMDB">
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void run("geo", "Гео-базы", mihomo.updateGeo, "Обновлены")}>
                  {busy === "geo" ? <span className="spinner" /> : <Icon name="download" />}
                  Обновить
                </button>
              </Row>
              <Row title="Веса smart-групп" hint="Сбросить накопленную статистику">
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void run("smart", "smart-группы", mihomo.flushSmart, "Сброшено")}>
                  Сбросить
                </button>
              </Row>
            </div>
          </section>
          <section className="card mh-danger-card">
            <div className="card-header">
              <h2 className="card-title">Ядро</h2>
              <span className="cell-sub">рвёт текущие соединения</span>
            </div>
            <div className="card-body stack">
              <Row title="Обновить ядро" hint="Встроенный загрузчик форка: оба канала ведут на релизы x-happy-x/mihomo">
                <Segmented<"release" | "alpha"> label="Канал" value={channel} onChange={setChannel} options={[{ value: "release", label: "release" }, { value: "alpha", label: "alpha" }]} />
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setDanger("upgrade")}>
                  Обновить
                </button>
              </Row>
              <Row title="Перезапустить ядро" hint="Несколько секунд без интернета через прокси">
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setDanger("restart")}>
                  Перезапустить
                </button>
              </Row>
              <dl className="kv">
                <div>
                  <dt>Бинарник</dt>
                  <dd className="mono">{status?.binary}</dd>
                </div>
                <div>
                  <dt>Конфиг</dt>
                  <dd className="mono">{status?.config}</dd>
                </div>
                <div>
                  <dt>Контроллер</dt>
                  <dd className="mono">{status?.controller}</dd>
                </div>
                <div>
                  <dt>Процессор</dt>
                  <dd className="mono">
                    {status?.arch} · {status?.asset}
                  </dd>
                </div>
                <div>
                  <dt>XKeen</dt>
                  <dd>{status?.xkeen ? "установлен" : "не найден"}</dd>
                </div>
              </dl>
            </div>
          </section>
        </div>
      </div>
      <ConfirmDialog
        open={!!danger}
        tone={danger === "restart" ? "danger" : "primary"}
        title={danger === "restart" ? "Перезапустить mihomo?" : danger === "upgrade" ? `Обновить ядро (${channel})?` : tunOn ? "Выключить TUN?" : "Включить TUN?"}
        confirmLabel={danger === "restart" ? "Перезапустить" : danger === "upgrade" ? "Обновить" : tunOn ? "Выключить" : "Включить"}
        onClose={() => setDanger(null)}
        onConfirm={() => {
          const d = danger;
          setDanger(null);
          if (d === "restart") void act("Ядро mihomo", mihomo.restart, "Перезапуск запущен").then(() => window.setTimeout(() => void refreshStatus(), 4000));
          if (d === "upgrade") void act("Обновление ядра", () => mihomo.upgrade(channel), "Обновление запущено; ядро перезапустится").then(() => window.setTimeout(() => void refreshStatus(), 8000));
          if (d === "tun") void patch("TUN", { tun: { enable: !tunOn } }, tunOn ? "Выключен" : "Включен");
        }}
      >
        {danger === "tun"
          ? "Смена TUN перестраивает маршруты роутера: соединения через прокси на несколько секунд прервутся. Если трафик перехватывает XKeen, TUN обычно не нужен."
          : danger === "upgrade"
            ? "Ядро скачает свежий релиз форка, проверит его и перезапустится. Связь через прокси пропадёт на время перезапуска."
            : "Все соединения через mihomo оборвутся; приложения переподключатся после запуска ядра."}
      </ConfirmDialog>
    </div>
  );
}
