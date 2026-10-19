import type { Host } from "../../platform/sdk";
import { Bar, Dot, Empty, Pill, Section, Stat } from "../pve/parts";
import type { Tone } from "../pve/model";
import { age, backupStale, BATTERY_LOW, plural, type HaAttention, type HaOverview, type HaView } from "./model";

// NPM-76: «Умный дом» — one page with what needs attention and the details behind it.

const sevTone: Record<HaAttention["severity"], Tone> = { critical: "bad", warning: "warn", info: "idle" };

function Attention({ items, host }: { items: HaAttention[]; host: Host }) {
  if (!items.length) return <div className="card ha-ok"><Dot tone="ok" /> Всё в порядке: устройства на связи, батарейки заряжены, резервная копия свежая.</div>;
  return (
    <ul className="card ha-list">
      {items.map((a) => (
        <li key={a.id} className="ha-row">
          <Dot tone={sevTone[a.severity]} />
          <span className="ha-row-main">{a.text}</span>
          {a.since ? <span className="ha-row-side pve-muted">{age(a.since)}</span> : null}
          {a.action?.page === "hasettings" ? (
            <button type="button" className="pve-btn ghost" onClick={() => host.navigate("hasettings")}>Настройка</button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Offline({ v }: { v: HaView }) {
  const unit = v.by_device ? "устройств" : "сущностей";
  if (!v.offline.length && !v.zigbee_down) return null;
  return (
    <Section title="Недоступные" hint={`Не на связи дольше 15 минут. Отключённые в HA ${unit} не учитываются.`}>
      {v.zigbee_down ? (
        <p className="ha-note bad">Мост Zigbee2MQTT не на связи: за ним {v.zigbee_down} {plural(v.zigbee_down, "устройство", "устройства", "устройств")} Zigbee — они вернутся вместе с мостом и здесь по одному не показаны.</p>
      ) : null}
      {v.offline.length ? (
        <ul className="card ha-list">
          {v.offline.map((d, i) => (
            <li key={`${d.name}-${i}`} className="ha-row">
              <Dot tone="warn" />
              <span className="ha-row-main">
                {d.name}
                {d.area ? <span className="pve-muted"> · {d.area}</span> : null}
                {d.zigbee ? <> <Pill tone="idle">Zigbee</Pill></> : null}
              </span>
              <span className="ha-row-side pve-muted">{v.by_device ? `${d.entities} ${plural(d.entities, "сущность", "сущности", "сущностей")} · ` : ""}{age(d.since)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function Batteries({ v }: { v: HaView }) {
  if (!v.batteries.length) return null;
  const low = v.batteries.filter((b) => b.low).length;
  return (
    <Section title="Батарейки" hint={low ? `${low} ниже ${BATTERY_LOW} % — пора менять.` : `Все выше ${BATTERY_LOW} %.`}>
      <ul className="card ha-list ha-batteries">
        {v.batteries.map((b, i) => {
          const tone: Tone = b.low ? (b.level != null && b.level >= 10 ? "warn" : "bad") : "ok";
          return (
            <li key={`${b.name}-${i}`} className="ha-row">
              <span className="ha-row-main">{b.name}{b.area ? <span className="pve-muted"> · {b.area}</span> : null}</span>
              <span className="ha-battery-bar">{b.level != null ? <Bar value={b.level} tone={tone} thin marks={[BATTERY_LOW]} /> : null}</span>
              <span className={`ha-row-side tone-text-${tone}`}>{b.level != null ? `${Math.round(b.level)} %` : b.low ? "разряжена" : "в норме"}</span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Updates({ v }: { v: HaView }) {
  if (!v.updates.length) return null;
  return (
    <Section title="Обновления" hint="Ставятся в самом Home Assistant: «Настройки» → «Обновления».">
      <ul className="card ha-list">
        {v.updates.map((u) => (
          <li key={u.entity} className="ha-row">
            <Dot tone="idle" />
            <span className="ha-row-main">{u.name}</span>
            <span className="ha-row-side pve-mono">{u.installed || "?"} → {u.latest || "?"}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function Overview({ data, host }: { data: HaOverview; host: Host }) {
  const v = data.view;
  if (!v) return <Empty title="Данных ещё нет">{data.error ? `Home Assistant не отвечает: ${data.error}` : "Первый опрос идёт — обновится в течение минуты."}</Empty>;
  const lowBatteries = v.batteries.filter((b) => b.low).length;
  const devicesTone: Tone = v.offline.length || v.zigbee_down ? "warn" : "ok";
  return (
    <div className="pve-page">
      <dl className="pve-host-facts ha-facts">
        <Stat label={v.by_device ? "Устройства на связи" : "Сущности на связи"} tone={devicesTone === "ok" ? undefined : "warn"}
          value={<><b>{v.online}</b> <span className="pve-muted">из {v.total}</span></>}
          sub={v.bridge ? (v.bridge.online ? "мост Zigbee2MQTT на связи" : "мост Zigbee2MQTT не на связи") : undefined} />
        <Stat label="Свет включён" value={v.lights.length ? v.lights.length : "нигде"}
          sub={v.lights.length ? v.lights.slice(0, 3).map((l) => l.name).join(", ") + (v.lights.length > 3 ? "…" : "") : undefined} />
        <Stat label="Батарейки" tone={lowBatteries ? "warn" : undefined} value={lowBatteries ? `${lowBatteries} ниже ${BATTERY_LOW} %` : "в норме"} sub={`${v.batteries.length} ${plural(v.batteries.length, "устройство", "устройства", "устройств")} на батарейках`} />
        <Stat label="Обновления" tone={v.updates.length ? "warn" : undefined} value={v.updates.length || "нет"} />
        <Stat label="Резервная копия" tone={backupStale(v) ? "warn" : undefined}
          value={!v.backup ? "—" : v.backup.last ? `${age(v.backup.last)} назад` : "ни одной"} sub="автоматическая" />
        <Stat label="Сущностей" value={v.entity_count} sub={data.version ? `HA ${data.version}` : undefined} />
      </dl>
      {!v.by_device ? (
        <p className="ha-note">Счёт идёт по сущностям: сопоставить их с устройствами не удалось{data.map_error ? ` (${data.map_error})` : ""}. Для группировки по устройствам пользователю HA нужны права администратора.</p>
      ) : null}
      <Section title="Требует внимания">
        <Attention items={data.attention} host={host} />
      </Section>
      <Offline v={v} />
      <Batteries v={v} />
      <Updates v={v} />
      {v.lights.length ? (
        <Section title="Свет включён">
          <div className="ha-chips">{v.lights.map((l, i) => <Pill key={`${l.name}-${i}`} tone="accent">{l.name}{l.area && l.area !== l.name ? ` · ${l.area}` : ""}</Pill>)}</div>
        </Section>
      ) : null}
    </div>
  );
}
