import { useEffect, useState } from "react";
import { PageHeader } from "../navigation";
import { EmptyState, Alert } from "../components/ui/controls";
import { dateTime, errText } from "../lib/format";

type Release = { name: string; time: string; committed: boolean; rollback: boolean; current: boolean; staged: boolean };

/** «Система → Выкладки»: HomeNet releases on the router (NPM-30). */
export function Releases() {
  const [items, setItems] = useState<Release[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/system/releases")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
        setItems(d.releases || []);
      })
      .catch((e) => setError(errText(e)));
  }, []);
  return (
    <div className="stack">
      <PageHeader page="releases" />
      {error ? <Alert tone="warning" title="Список выкладок недоступен">{error}</Alert> : null}
      <section className="card card-flush">
        {items?.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Выкладка</th>
                  <th>Время</th>
                  <th>Состояние</th>
                  <th>Откат</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.name}>
                    <td className="cell-primary mono" data-label="">{r.name}</td>
                    <td className="cell-sub" data-label="Время">{dateTime(r.time)}</td>
                    <td data-label="Состояние">
                      {r.current ? <span className="badge badge-success">текущая</span> : r.committed ? <span className="badge">применялась</span> : r.staged ? <span className="badge">только проверка</span> : <span className="badge badge-warning">откачена или прервана</span>}
                    </td>
                    <td className="mono cell-sub" data-label="Откат">{r.rollback ? `sh /opt/etc/homenet/releases/${r.name}/rollback.sh` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !error ? (
          <EmptyState icon="upload" title={items ? "Выкладок нет" : "Загружаю…"} />
        ) : null}
        <div className="card-footer">
          Выкладки делает scripts/deploy-router.py: сначала проверка на отдельном порту, затем замена с автоматическим откатом, если проверки после переключения не прошли. Откат последней выкладки вручную — команда из таблицы в SSH роутера; он возвращает бинарники, интерфейс, маршруты и DNS.
        </div>
      </section>
    </div>
  );
}
