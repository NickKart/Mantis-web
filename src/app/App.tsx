// Каркас: боковое меню (как в макете), экраны, поиск ⌘K, профиль, сообщения.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { agentAutostart, agentInfo, type AgentInfo } from "../desktop";
import { friendlyError, resetPassword, signIn, signOut, signUp } from "../cloud/firebase";
import { channelTitle } from "../multi/channel";
import { listRecordings, type RecordingMeta } from "../twin/store";
import { core } from "./core";
import { onboarding } from "./progress";
import {
  IcAB, IcBurger, IcCam, IcClose, IcFunnel, IcLive, IcRec, IcSearch, IcStart, Logo,
} from "./icons";
import { AskHost, Modal, type Screen, Switch, Toasts, go, useCore, useRoute, useTick } from "./ui";
import { Onboarding } from "./screens/Onboarding";
import { Live } from "./screens/Live";
import { Setup } from "./screens/Setup";
import { Analytics } from "./screens/Analytics";
import { Compare } from "./screens/Compare";
import { Records } from "./screens/Records";

const MENU: { screen: Screen; label: string; Icon: typeof IcStart; color: string; step?: number }[] = [
  { screen: "start", label: "Как начать работать", Icon: IcStart, color: "#D97706" },
  { screen: "live", label: "Live", Icon: IcLive, color: "#E5484D", step: 1 },
  { screen: "setup", label: "Настройка камеры", Icon: IcCam, color: "#0891B2", step: 0 },
  { screen: "analytics", label: "Аналитика", Icon: IcFunnel, color: "#2370B4", step: 2 },
  { screen: "compare", label: "Дополнительная аналитика", Icon: IcAB, color: "#7C3AED" },
  { screen: "records", label: "Записи", Icon: IcRec, color: "#0D9488" },
];

export const TITLES: Record<Screen, string> = {
  start: "Как начать работать", live: "Live", setup: "Настройка камеры", analytics: "Аналитика", compare: "Дополнительная аналитика", records: "Записи",
};

export function App() {
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [profile, setProfile] = useState(false);

  useEffect(() => {
    document.title = `Mantis – ${TITLES[route.screen]}`;
    setMenuOpen(false);
    window.scrollTo(0, 0);
  }, [route.screen, route.param]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", k);
    const openProfile = () => setProfile(true);
    window.addEventListener("mantis:profile", openProfile);
    return () => {
      window.removeEventListener("keydown", k);
      window.removeEventListener("mantis:profile", openProfile);
    };
  }, []);

  return (
    <div class="app">
      <Sidebar screen={route.screen} open={menuOpen} onToggle={() => setMenuOpen((v) => !v)} onSearch={() => setPalette(true)} onProfile={() => setProfile(true)} />
      {route.screen === "start" && <Onboarding />}
      {route.screen === "live" && <Live />}
      {route.screen === "setup" && <Setup param={route.param} />}
      {route.screen === "analytics" && <Analytics />}
      {route.screen === "compare" && <Compare param={route.param} />}
      {route.screen === "records" && <Records param={route.param} />}
      {palette && <Palette onClose={() => setPalette(false)} onProfile={() => setProfile(true)} />}
      {profile && <ProfileModal onClose={() => setProfile(false)} />}
      <AskHost />
      <Toasts />
    </div>
  );
}

/** Открыть окно профиля из любого экрана. */
export const openProfile = () => window.dispatchEvent(new Event("mantis:profile"));

// ---------------------------------------------------------------- меню
function Sidebar(p: { screen: Screen; open: boolean; onToggle: () => void; onSearch: () => void; onProfile: () => void }) {
  const c = useCore();
  useTick(5000);
  const ob = onboarding();
  const user = c.account.state.user;
  const email = user?.email ?? "";
  const pointName = c.account.state.profile.name || c.account.state.profile.point;
  const initials = (pointName || email || "?").split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <nav class={`side ${p.open ? "open" : ""}`} aria-label="Основное меню">
      <div class="side-top">
        <Logo />
        <span class="brand">Mantis</span>
        <button class="burger" aria-label={p.open ? "Закрыть меню" : "Открыть меню"} aria-expanded={p.open} onClick={p.onToggle}>
          {p.open ? <IcClose size={20} width={2} /> : <IcBurger size={20} width={2} />}
        </button>
      </div>
      <div class="nav-list">
        {MENU.map((m) => (
          <a key={m.screen} class="nav" href={`#/${m.screen}`} aria-current={p.screen === m.screen ? "page" : undefined}>
            <m.Icon color={p.screen === m.screen && m.screen === "analytics" ? "#2370B4" : m.color} />
            <span class="nav-text">{m.label}</span>
            {m.screen === "live" && c.pilot.running && <span class={`dot-live ${c.pilot.state === "recovering" ? "warn" : ""}`} title="Идёт подсчёт" />}
            {m.step !== undefined && m.step === ob.next && !(m.screen === "live" && c.pilot.running) && <span class="dot-next" aria-label="следующий шаг" />}
          </a>
        ))}
      </div>
      <div class="side-bottom">
        <div class="nav-list">
          <button class="nav" onClick={p.onSearch}>
            <IcSearch />Поиск<span class="kbd">{mac ? "⌘K" : "Ctrl K"}</span>
          </button>
          <button class="nav" onClick={p.onProfile} title={user ? `Профиль · ${email}` : "Войти или зарегистрироваться"}>
            <span class="avatar">{user ? initials : "?"}</span>
            <span class="nav-text">{user ? pointName || email : "Войти"}</span>
          </button>
        </div>
        <SystemBox />
      </div>
    </nav>
  );
}

function SystemBox() {
  const c = useCore();
  useTick(1000);
  const st = c.account.state;
  const det = c.detectorState;
  const fps = c.pilot.running ? c.pilot.fps : 0;
  const detText = det === "ready" ? `Нейросеть · ${c.backendShort}${fps ? ` · ${Math.round(fps)} к/с` : ""}`
    : det === "loading" ? "Нейросеть загружается…" : det === "error" ? "Нейросеть не загрузилась" : "Нейросеть · загрузится при запуске";
  let cloud: string, cloudLed: string;
  if (!st.user) {
    cloud = "Облако · вход не выполнен";
    cloudLed = "off";
  } else if (st.error) {
    cloud = "Облако · нет связи";
    cloudLed = "warn";
  } else if (st.lastSync) {
    const s = Math.max(0, Math.round((Date.now() - st.lastSync.getTime()) / 1000));
    cloud = `Облако · синхр. ${s < 60 ? `${s} с` : s < 3600 ? `${Math.round(s / 60)} мин` : `${Math.round(s / 3600)} ч`} назад`;
    cloudLed = "";
  } else {
    cloud = "Облако · подключено";
    cloudLed = "";
  }
  return (
    <div class="system" title={st.error ?? undefined}>
      <span>Система</span>
      <span class="sys-row"><span class={`led ${det === "ready" ? "" : det === "error" ? "err" : det === "loading" ? "warn" : "off"}`} />{detText}</span>
      <span class="sys-row"><span class={`led ${cloudLed}`} />{cloud}</span>
    </div>
  );
}

// ---------------------------------------------------------------- поиск ⌘K
interface Cmd {
  title: string;
  hint: string;
  run: () => void;
}

function Palette(p: { onClose: () => void; onProfile: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [recs, setRecs] = useState<RecordingMeta[]>([]);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inp.current?.focus();
    void listRecordings().then(setRecs).catch(() => undefined);
  }, []);
  const cmds = useMemo<Cmd[]>(() => {
    const list: Cmd[] = MENU.map((m) => ({ title: m.label, hint: "Раздел", run: () => go(m.screen) }));
    list.push({ title: "Добавить камеру", hint: "Настройка камеры", run: () => go("setup", "new") });
    for (const ch of core.pilot.channels) list.push({ title: `Камера ${channelTitle(ch.config)}`, hint: "Настройка камеры", run: () => go("setup", ch.id) });
    list.push({ title: "План точки", hint: "Настройка камеры", run: () => go("setup", "plan") });
    list.push({ title: "Проверить на видеофайле", hint: "Настройка камеры", run: () => go("setup", "video") });
    if (core.pilot.running) list.push({ title: "Остановить подсчёт", hint: "Live", run: () => void core.stopCounting() });
    else list.push({ title: "Запустить подсчёт", hint: "Live", run: () => { void core.startCounting(); go("live"); } });
    list.push({ title: "Записать фрагмент", hint: "Live", run: () => { core.startRecording(); go("live"); } });
    list.push({ title: "Отчёт PDF", hint: "Аналитика", run: () => { go("analytics"); setTimeout(() => window.print(), 400); } });
    list.push({ title: "Сравнить записи (A/B)", hint: "Дополнительная аналитика", run: () => go("compare", "rec") });
    list.push({ title: "Сравнить периоды", hint: "Дополнительная аналитика", run: () => go("compare", "period") });
    for (const r of recs) list.push({ title: r.name, hint: "Запись", run: () => go("records", r.id) });
    list.push({ title: core.account.state.user ? "Профиль и точка" : "Войти или зарегистрироваться", hint: "Профиль", run: p.onProfile });
    return list;
  }, [recs]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const found = cmds.filter((c) => words.every((w) => `${c.title} ${c.hint}`.toLowerCase().includes(w))).slice(0, 12);
  const run = (c: Cmd | undefined) => {
    if (!c) return;
    p.onClose();
    c.run();
  };
  return (
    <div class="modal-back" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="modal palette" role="dialog" aria-label="Поиск">
        <input ref={inp} value={q} placeholder="Раздел, камера, запись или действие…" aria-label="Поиск"
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") p.onClose();
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(found.length - 1, s + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === "Enter") run(found[sel]);
          }} />
        <ul role="listbox">
          {found.map((c, i) => (
            <li key={c.title + c.hint}>
              <button role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => run(c)}><b>{c.title}</b><span>{c.hint}</span></button>
            </li>
          ))}
          {!found.length && <li class="empty-note" style={{ padding: "12px" }}>Ничего не нашлось</li>}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- профиль
function ProfileModal(p: { onClose: () => void }) {
  const c = useCore();
  const st = c.account.state;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prof, setProf] = useState(st.profile);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [site, setSite] = useState(c.publisher.siteId === "main" ? "" : c.publisher.siteId);
  useEffect(() => void agentInfo().then(setAgent), []);

  const act = async (fn: () => Promise<void>, ok?: string, needPassword = true) => {
    if (!email.includes("@")) return setErr("Введите почту");
    if (needPassword && password.length < 6) return setErr("Пароль – минимум 6 символов");
    setErr(null);
    setBusy(true);
    try {
      await fn();
      if (ok) c.toast(ok);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const numIn = (v: string, d: number) => {
    const x = parseFloat(v.replace(",", "."));
    return isFinite(x) && x >= 0 ? x : d;
  };
  const saveProfile = () => {
    c.account.setProfile({
      ...prof,
      hoursPerDay: Math.min(24, Math.max(1, prof.hoursPerDay)),
      lookToBuy: Math.min(100, prof.lookToBuy),
      enterToBuy: Math.min(100, prof.enterToBuy),
    });
    if ((site.trim() || "main") !== c.publisher.siteId) c.publisher.siteId = site;
    c.toast("Профиль точки сохранён");
    p.onClose();
  };

  return (
    <Modal title={st.user ? "Профиль и точка" : "Вход в Mantis"} onClose={p.onClose} wide={!!st.user}>
      {!st.user && (
        <>
          <p class="lead">Тот же аккаунт, что в приложении для iPhone и Mac. Без входа всё работает, но статистика остаётся только в этом браузере.</p>
          <div class="field"><label for="pf-email">Почта</label>
            <input id="pf-email" class="input" type="email" autoComplete="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} /></div>
          <div class="field"><label for="pf-pass">Пароль</label>
            <input id="pf-pass" class="input" type="password" autoComplete="current-password" value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === "Enter" && void act(() => signIn(email, password))} /></div>
          {err && <p class="error-text">{err}</p>}
          <div class="modal-actions" style={{ justifyContent: "space-between" }}>
            <button class="btn ghost" disabled={busy} onClick={() => void act(() => resetPassword(email), "Письмо для смены пароля отправлено", false)}>Забыли пароль?</button>
            <span style={{ display: "flex", gap: "10px" }}>
              <button class="btn lg" disabled={busy} onClick={() => void act(() => signUp(email, password), "Аккаунт создан")}>Регистрация</button>
              <button class="btn lg primary" disabled={busy} onClick={() => void act(() => signIn(email, password))}>Войти</button>
            </span>
          </div>
        </>
      )}
      {st.user && (
        <>
          <div class="card-head center">
            <span class="s13">Вы вошли как <b>{st.user.email}</b></span>
            <button class="btn right" onClick={async () => {
              if (c.pilot.running) return c.toast("Сначала остановите подсчёт", true);
              await signOut();
              c.toast("Вы вышли. Статистика этого браузера осталась на нём.");
              p.onClose();
            }}>Выйти</button>
          </div>
          <div class="divider" />
          <h3 class="s13" style={{ fontWeight: 600, fontSize: "14px" }}>Точка</h3>
          <div class="form-grid">
            <Field label="Название точки" value={prof.point} onInput={(v) => setProf({ ...prof, point: v })} />
            <Field label="Город" value={prof.city} onInput={(v) => setProf({ ...prof, city: v })} />
            <Field label="Средний чек, ₽" value={String(prof.avgCheck)} onInput={(v) => setProf({ ...prof, avgCheck: numIn(v, prof.avgCheck) })} num />
            <Field label="Часов работы в день" value={String(prof.hoursPerDay)} onInput={(v) => setProf({ ...prof, hoursPerDay: numIn(v, prof.hoursPerDay) })} num />
            <Field label="Из зашедших покупают, %" value={String(prof.enterToBuy)} onInput={(v) => setProf({ ...prof, enterToBuy: numIn(v, prof.enterToBuy) })} num />
            <Field label="Из посмотревших покупают, %" value={String(prof.lookToBuy)} onInput={(v) => setProf({ ...prof, lookToBuy: numIn(v, prof.lookToBuy) })} num />
          </div>
          <div class="divider" />
          <div class="card-head center">
            <div style={{ display: "flex", flexDirection: "column", gap: "2px", flex: "1 1 260px" }}>
              <b style={{ fontSize: "14px", fontWeight: 600 }}>Личный кабинет и план в облаке</b>
              <span class="small muted">Люди на плане и счётчики уходят в личный кабинет раз в секунду. Видео не передаётся.</span>
            </div>
            <Switch on={c.publisher.enabled} label="Передавать в личный кабинет" onChange={(v) => { c.publisher.enabled = v; c.emit(); }} />
          </div>
          <Field label="Код точки (если магазинов несколько – на каждом свой)" value={site} placeholder="main" onInput={setSite} />
          {agent && (
            <>
              <div class="divider" />
              <div class="card-head center">
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", flex: "1 1 260px" }}>
                  <b style={{ fontSize: "14px", fontWeight: 600 }}>Mantis Агент {agent.version}</b>
                  <span class="small muted">Запускать при входе в систему – подсчёт продолжится сам после перезагрузки компьютера.</span>
                </div>
                <Switch on={agent.autostart} label="Автозапуск агента" onChange={async (v) => {
                  try {
                    const on = await agentAutostart(v);
                    setAgent({ ...agent, autostart: on });
                  } catch (e) {
                    c.toast(`Автозапуск: ${(e as Error).message}`, true);
                  }
                }} />
              </div>
            </>
          )}
          <div class="modal-actions">
            <button class="btn lg" onClick={p.onClose}>Отмена</button>
            <button class="btn lg primary" onClick={saveProfile}>Сохранить</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Field(p: { label: string; value: string; onInput: (v: string) => void; num?: boolean; placeholder?: string }) {
  const id = `f-${Array.from(p.label).reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7).toString(36)}`;
  return (
    <div class="field">
      <label for={id}>{p.label}</label>
      <input id={id} class="input" value={p.value} placeholder={p.placeholder} inputMode={p.num ? "decimal" : undefined}
        onInput={(e) => p.onInput((e.target as HTMLInputElement).value)} />
    </div>
  );
}
