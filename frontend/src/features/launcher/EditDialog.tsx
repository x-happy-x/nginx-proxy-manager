import { useEffect, useState } from "react";
import { fetchLauncher, saveLauncher } from "../../api";
import { defaultLauncher, type LauncherItem } from "./model";

// NPM-87: change an app's title, description and repository from its card.
// Titles of routed apps come from the route (routes.yml), of links and system
// cards from launcher.json; every change here is stored in launcher.json.

export function EditDialog({ item, onClose, onSaved }: { item: LauncherItem; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [about, setAbout] = useState(item.about || "");
  const [repo, setRepo] = useState(item.repo || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (!title.trim()) return setError("Название не может быть пустым");
    if (repo.trim() && !/^https?:\/\/\S+$/i.test(repo.trim())) return setError("Адрес репозитория — вида https://…");
    setBusy(true);
    setError("");
    try {
      const cfg = (await fetchLauncher()) || defaultLauncher();
      cfg.apps ||= {};
      const patch = { title: title.trim(), description: about.trim() || undefined, repo: repo.trim() || undefined };
      if (item.key.startsWith("link:")) {
        const link = cfg.links.find((l) => "link:" + l.id === item.key);
        if (!link) throw new Error("ссылка уже удалена");
        Object.assign(link, patch);
      } else {
        const id = item.key.startsWith("app:") ? item.key.slice(4) : item.key;
        cfg.apps[id] = { ...cfg.apps[id], ...patch };
      }
      await saveLauncher(cfg);
      onSaved();
    } catch (e) {
      setError(`Не сохранилось: ${e instanceof Error ? e.message : e}`);
      setBusy(false);
    }
  };

  const source = item.source === "routes" ? "Название по умолчанию — из маршрута в «Прокси и домены»." : item.source === "system" ? "Карточка программы на роутере." : "Ссылка из лаунчера.";
  return (
    <div className="hp-modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="hp-dialog hp-edit" role="dialog" aria-modal="true" aria-label={`Изменить ${item.title}`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <header>
          <div>
            <strong>Изменить карточку</strong>
            <small>{source}</small>
          </div>
          <span className="hp-grow" />
          <button type="button" className="hp-btn is-quiet" aria-label="Закрыть" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="hp-edit-body">
          <label>
            Название
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={80} />
          </label>
          <label>
            Описание
            <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={2} maxLength={200} placeholder="Что это за приложение" />
          </label>
          <label>
            Git-репозиторий
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://git.example/owner/repo" className="hp-mono" />
          </label>
          {error ? <p className="hp-error" role="alert">{error}</p> : null}
        </div>
        <footer className="hp-edit-foot">
          <button type="button" className="hp-btn is-quiet" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="hp-btn is-primary" disabled={busy}>
            {busy ? "Сохраняю…" : "Сохранить"}
          </button>
        </footer>
      </form>
    </div>
  );
}
