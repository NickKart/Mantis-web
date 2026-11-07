// Каркас: боковое меню (как в макете), экраны, поиск ⌘K, профиль, сообщения.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { changeEmail, changePassword, friendlyError, resetPassword, signIn, signOut, signUp } from "../cloud/firebase";
import { channelTitle } from "../multi/channel";
import { listRecordings, type RecordingMeta } from "../twin/store";
import { type ReturnKind, takePaymentReturn } from "./billing";
import { core } from "./core";
import { Subscription } from "./Subscription";
import { onboarding } from "./progress";
import {
  IcAB, IcBurger, IcCam, IcClose, IcFunnel, IcLive, IcRec, IcSearch, IcStart, Logo,
} from "./icons";
import { AskHost, Modal, type Screen, Toasts, go, useCore, useRoute, useTick } from "./ui";
import { Onboarding } from "./screens/Onboarding";
import { Live } from "./screens/Live";
import { Setup } from "./screens/Setup";
import { Analytics } from "./screens/Analytics";
import { Compare } from "./screens/Compare";
import { Records } from "./screens/Records";

const MENU: { screen: Screen; label: string; Icon: typeof IcStart; color: string; step?: number }[] = [
  { screen: "start", label: "Как начать работать", Icon: IcStart, color: "#D97706" },
  { screen: "live", label: "Запустить подсчёт Live", Icon: IcLive, color: "#E5484D", step: 2 },
  { screen: "setup", label: "Настройка камеры", Icon: IcCam, color: "#0891B2", step: 1 },
  { screen: "analytics", label: "Аналитика", Icon: IcFunnel, color: "#2370B4", step: 3 },
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
  // вернулись со страницы оплаты ЮKassa – сразу открываем профиль с подпиской
  const [paymentReturn] = useState(() => takePaymentReturn());
  useEffect(() => {
    if (!paymentReturn) return;
    void core.account.whenReady().then(() => setProfile(true));
  }, []);

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
      {profile && <ProfileModal returned={paymentReturn} onClose={() => setProfile(false)} />}
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
        {MENU.map((m, i) => [
          // вход и регистрация – сразу после «Как начать работать» (шаг 1 онбординга)
          i === 1 && (
            <button key="profile" class="nav" onClick={p.onProfile} title={user ? `Профиль · ${email}` : "Войти или зарегистрироваться"}>
              <span class="avatar">{user ? initials : "?"}</span>
              <span class="nav-text">{user ? pointName || email : "Вход и Регистрация"}</span>
              {!user && ob.next === 0 && <span class="dot-next" aria-label="следующий шаг" />}
            </button>
          ),
          <a key={m.screen} class="nav" href={`#/${m.screen}`} aria-current={p.screen === m.screen ? "page" : undefined}>
            <m.Icon color={p.screen === m.screen && m.screen === "analytics" ? "#2370B4" : m.color} />
            <span class="nav-text">{m.label}</span>
            {m.screen === "live" && c.pilot.running && <span class={`dot-live ${c.pilot.state === "recovering" ? "warn" : ""}`} title="Идёт подсчёт" />}
            {m.step !== undefined && m.step === ob.next && !(m.screen === "live" && c.pilot.running) && <span class="dot-next" aria-label="следующий шаг" />}
          </a>,
        ])}
      </div>
      <div class="side-bottom">
        <div class="nav-list">
          <button class="nav" onClick={p.onSearch}>
            <IcSearch />Поиск<span class="kbd">{mac ? "⌘K" : "Ctrl K"}</span>
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
    : det === "loading" ? "Нейросеть загружается…" : det === "error" ? "Нейросеть не загрузилась" : "Нейросеть · не запущена";
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
    list.push({ title: core.account.state.user ? "Профиль" : "Войти или зарегистрироваться", hint: "Профиль", run: p.onProfile });
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
function ProfileModal(p: { onClose: () => void; returned?: ReturnKind | null }) {
  const c = useCore();
  const st = c.account.state;
  return st.user
    ? <AccountModal email={st.user.email ?? ""} returned={p.returned} onClose={p.onClose} />
    : <SignInModal onClose={p.onClose} />;
}

function SignInModal(p: { onClose: () => void }) {
  const c = useCore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <Modal title="Вход в Mantis" onClose={p.onClose}>
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
    </Modal>
  );
}

/** Профиль вошедшего: почта и пароль (можно сменить) и подписка. */
function AccountModal(p: { email: string; returned?: ReturnKind | null; onClose: () => void }) {
  const c = useCore();
  const [email, setEmail] = useState(p.email);
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== p.email.toLowerCase();
  const passChanged = password.length > 0;
  const dirty = emailChanged || passChanged;

  const save = async () => {
    if (!dirty) return;
    if (emailChanged && !email.includes("@")) return setErr("Введите почту");
    if (passChanged && password.length < 6) return setErr("Новый пароль – минимум 6 символов");
    if (!current) return setErr("Введите текущий пароль");
    setErr(null);
    setBusy(true);
    try {
      if (passChanged) await changePassword(password, current);
      if (emailChanged) await changeEmail(email, current);
      c.toast(
        emailChanged
          ? `Письмо отправлено на ${email.trim()} – почта сменится после перехода по ссылке`
          : "Пароль изменён",
      );
      setPassword("");
      setCurrent("");
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Профиль" onClose={p.onClose} wide>
      <h3 class="sub-h">Аккаунт</h3>
      <div class="field"><label for="ac-email">Электронная почта</label>
        <input id="ac-email" class="input" type="email" autoComplete="email" value={email}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        {emailChanged && <span class="small muted">На новый адрес придёт письмо со ссылкой. После перехода по ней войдите с новой почтой.</span>}
      </div>
      <div class="field"><label for="ac-pass">Пароль</label>
        <input id="ac-pass" class="input" type="password" autoComplete="new-password" placeholder="••••••••" value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        {passChanged && <span class="small muted">Новый пароль, минимум 6 символов</span>}
      </div>
      {dirty && (
        <div class="field"><label for="ac-current">Текущий пароль – для подтверждения</label>
          <input id="ac-current" class="input" type="password" autoComplete="current-password" value={current}
            onInput={(e) => setCurrent((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && void save()} /></div>
      )}
      {err && <p class="error-text">{err}</p>}
      {dirty && (
        <div class="modal-actions">
          <button class="btn" disabled={busy} onClick={() => { setEmail(p.email); setPassword(""); setCurrent(""); setErr(null); }}>Отменить</button>
          <button class="btn primary" disabled={busy} onClick={() => void save()}>Сохранить почту и пароль</button>
        </div>
      )}
      <div class="divider" />
      <Subscription returned={p.returned} />
      <div class="divider" />
      <div class="modal-actions" style={{ justifyContent: "space-between" }}>
        <button class="btn ghost" disabled={busy} onClick={async () => {
          if (c.pilot.running) return c.toast("Сначала остановите подсчёт", true);
          await signOut();
          c.toast("Вы вышли. Статистика этого браузера осталась на нём.");
          p.onClose();
        }}>Выйти</button>
        <button class="btn lg" onClick={p.onClose}>Закрыть</button>
      </div>
    </Modal>
  );
}
