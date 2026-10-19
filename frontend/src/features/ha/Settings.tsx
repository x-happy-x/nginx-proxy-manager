import { useEffect, useState } from "react";
import type { Host } from "../../platform/sdk";
import { Dot, Empty, Section } from "../pve/parts";
import type { HaConfig, HaTest } from "./model";

// NPM-76: address and long-lived token of the dedicated HA user. The token stays on the
// router (HA_DIR/config.json); this page can replace it but never reads it back.

export function Settings({ host, onSaved }: { host: Host; onSaved: () => void }) {
  const [cfg, setCfg] = useState<HaConfig | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [test, setTest] = useState<(HaTest & { busy?: boolean }) | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const c = (await (await host.api("/api/ha/config")).json()) as HaConfig;
      setCfg(c); setUrl(c.url || ""); setToken("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); }, []);
  const body = () => JSON.stringify({ url: url.trim(), token: token.trim() });
  const check = async () => {
    setTest({ ok: false, busy: true });
    try {
      setTest((await (await host.api("/api/ha/config/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: body() })).json()) as HaTest);
    } catch (e) { setTest({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      await host.api("/api/ha/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: body() });
      host.notify("Настройки сохранены — данные обновятся в течение минуты");
      await load();
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (!cfg) return error ? <Empty title="Настройки недоступны">{error}</Empty> : <div className="pve-skeleton" />;
  const dirty = url.trim() !== cfg.url || token.trim() !== "";
  const canSend = url.trim() !== "" && (token.trim() !== "" || cfg.token_set);
  const tone = test?.busy ? "idle" : test ? (test.ok ? (test.devices ? "ok" : "warn") : "bad") : "idle";
  return (
    <div className="pve-page">
      <Section title="Подключение к Home Assistant" hint="HomeNet раз в минуту читает состояние HA по REST API. Изменения применяются без перезапуска."
        actions={<>
          <button type="button" className="pve-btn" onClick={() => void check()} disabled={!canSend || test?.busy}>Проверить</button>
          <button type="button" className="pve-btn primary" onClick={() => void save()} disabled={!canSend || !dirty || busy}>{busy ? "Сохраняю…" : "Сохранить"}</button>
        </>}>
        {error || cfg.error ? <div className="pve-health bad" role="alert"><span className="pve-health-dot" aria-hidden="true" />{error || cfg.error}</div> : null}
        <div className="card pve-cfg">
          <div className="pve-cfg-row">
            <div className="pve-cfg-fields ha-cfg-fields">
              <label><span>Адрес</span><input value={url} placeholder="http://192.168.99.12:8123" className="pve-mono" inputMode="url" autoComplete="off"
                onChange={(e) => { setUrl(e.target.value); setTest(null); }} /></label>
              <label><span>Токен</span><input value={token} type="password" autoComplete="new-password" className="pve-mono"
                placeholder={cfg.token_set ? "задан — оставьте пустым, чтобы не менять" : "долгосрочный токен доступа"}
                onChange={(e) => { setToken(e.target.value); setTest(null); }} /></label>
            </div>
            <div className="pve-cfg-status">
              <Dot tone={tone} />
              <span className="pve-cfg-note">
                {test?.busy ? "Проверяю…"
                  : test ? (test.ok
                    ? `Home Assistant ${test.version}${test.location ? ` «${test.location}»` : ""} · ${test.latency_ms} мс · ${test.devices ? `устройств: ${test.device_count}` : `без сопоставления с устройствами: ${test.devices_error}`}`
                    : test.error)
                  : cfg.token_set ? "Токен сохранён на роутере" : "Токен не задан"}
              </span>
            </div>
          </div>
        </div>
        {dirty ? <p className="pve-muted pve-small">Есть несохранённые изменения.</p> : null}
      </Section>

      <Section title="Как получить токен" hint="Токен хранится только на роутере и в интерфейс не возвращается.">
        <div className="card pve-howto">
          <ol>
            <li><b>Отдельный пользователь.</b> В HA: «Настройки» → «Люди» → «Добавить человека», включите «Может входить в систему», имя например <span className="pve-mono">homenet</span>. Чтобы считать по устройствам, а не по сущностям, дайте ему права администратора: список устройств HA отдаёт только администраторам.</li>
            <li><b>Токен.</b> Войдите этим пользователем, откройте профиль → «Безопасность» → «Долгосрочные токены доступа» → «Создать токен».</li>
            <li><b>Сюда.</b> Вставьте адрес и токен, нажмите «Проверить», затем «Сохранить».</li>
          </ol>
          <p className="pve-muted pve-small">HomeNet только читает: <span className="pve-mono">/api/config</span>, <span className="pve-mono">/api/states</span> и раз в 10 минут шаблон со списком устройств.</p>
        </div>
      </Section>
    </div>
  );
}
