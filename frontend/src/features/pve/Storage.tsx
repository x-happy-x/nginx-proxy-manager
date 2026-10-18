import { bytes, dateTime, loadTone, percent, rate, ratio, type PveHost } from "./model";
import { Bar, Empty, Pill, Section } from "./parts";

const TYPES: Record<string, string> = { dir: "каталог", lvmthin: "LVM-thin", lvm: "LVM", zfspool: "ZFS", nfs: "NFS", cifs: "SMB", pbs: "Proxmox Backup", rbd: "Ceph RBD", cephfs: "CephFS" };
const CONTENT: Record<string, string> = { images: "диски ВМ", rootdir: "контейнеры", vztmpl: "шаблоны", iso: "ISO", backup: "бэкапы", import: "импорт", snippets: "сниппеты" };

function HostStorage({ h }: { h: PveHost }) {
  const c = h.current;
  if (!c) return <Empty title="Нет данных">{h.error}</Empty>;
  const backups = c.backups.slice(0, 6);
  return (
    <div className="pve-storage-grid">
      <div className="card pve-list">
        <div className="pve-card-head"><h3>Хранилища</h3><span className="pve-muted pve-small">{c.storage.length}</span></div>
        {c.storage.map((s) => {
          const p = ratio(s.used, s.total);
          return (
            <div className="pve-store" key={s.name}>
              <div className="pve-store-head">
                <strong>{s.name}</strong>
                <span className="pve-muted">{TYPES[s.type] || s.type}{s.shared ? " · общее" : ""}</span>
                {!s.active ? <Pill tone={s.enabled ? "bad" : "idle"}>{s.enabled ? "недоступно" : "выключено"}</Pill> : <b className={`tone-text-${loadTone(p)}`}>{percent(p)}</b>}
              </div>
              {s.active && s.total ? <Bar value={p} tone={loadTone(p)} marks={[90]} /> : null}
              <div className="pve-store-foot">
                <span>{s.active && s.total ? `${bytes(s.used)} из ${bytes(s.total, 0)} · свободно ${bytes(s.total - s.used)}` : "—"}</span>
                <span className="pve-muted">{s.content.split(",").filter(Boolean).map((x) => CONTENT[x] || x).join(", ")}</span>
              </div>
            </div>
          );
        })}
        {c.zfs.map((z) => (
          <div className="pve-store" key={`zfs-${z.name}`}>
            <div className="pve-store-head">
              <strong>{z.name}</strong><span className="pve-muted">ZFS-пул · фрагментация {z.frag ?? "—"} %</span>
              <Pill tone={z.health === "ONLINE" ? "ok" : "bad"}>{z.health}</Pill>
            </div>
            <Bar value={z.cap} tone={loadTone(z.cap)} marks={[80]} />
            <div className="pve-store-foot"><span>{bytes(z.alloc)} из {bytes(z.size, 0)}</span></div>
          </div>
        ))}
      </div>
      <div className="pve-side">
        <div className="card pve-list">
          <div className="pve-card-head"><h3>Диски сейчас</h3></div>
          {c.io.length ? c.io.map((d) => (
            <div className="pve-io" key={d.dev}>
              <span className="pve-mono">{d.dev}</span>
              <span>R {rate(d.r)}</span>
              <span>W {rate(d.w)}</span>
              <span className="pve-io-util"><Bar value={d.util} tone={loadTone(d.util)} thin /><small>{percent(d.util)} занят</small></span>
            </div>
          )) : <p className="pve-muted pve-small">Нет данных</p>}
        </div>
        <div className="card pve-list">
          <div className="pve-card-head"><h3>Резервные копии</h3><span className="pve-muted pve-small">vzdump</span></div>
          {backups.length ? backups.map((b, i) => (
            <div className="pve-backup" key={`${b.id}-${b.start}-${i}`}>
              <Pill tone={b.status === "OK" ? "ok" : b.status === "running" ? "accent" : "bad"}>{b.status === "OK" ? "успешно" : b.status === "running" ? "идёт" : "ошибка"}</Pill>
              <span>{b.id ? `машина ${b.id}` : "все машины"}</span>
              <span className="pve-muted">{dateTime(b.end || b.start)}</span>
              {b.status !== "OK" && b.status !== "running" ? <small className="tone-text-bad">{b.status}</small> : null}
            </div>
          )) : <p className="pve-muted pve-small">Заданий резервного копирования не было.</p>}
        </div>
      </div>
    </div>
  );
}

export function Storage({ hosts }: { hosts: PveHost[] }) {
  if (!hosts.length) return <Empty title="Хосты не настроены" />;
  return (
    <div className="pve-page">
      {hosts.map((h) => (
        <Section key={h.id} title={h.name} hint={h.address}>
          <HostStorage h={h} />
        </Section>
      ))}
    </div>
  );
}
