// «Как начать работать»: четыре шага по реальному состоянию и что появится в аналитике.
import { num } from "../format";
import { IcArrow, IcCam, IcCheck, IcFunnel, IcLive, IcUser } from "../icons";
import { MIN_PEOPLE, onboarding } from "../progress";
import { Bar, type Screen, go, useCore } from "../ui";

/** Программы для компьютера у витрины (нужны для IP-камер) – собирает «Деплой в прод» и кладёт на прод-сервер
 *  в downloads/ (docs/agent.md): для Windows – Mantis Агент, для Mac – приложение Mantis (установщик для всех Mac).
 *  Адреса полные: кнопки работают и на Vercel, и внутри самого Агента. */
const DL = "https://mantis.rcmit.ru/downloads";
export const AGENT_LINKS = {
  windows: `${DL}/Mantis-Agent-Windows.zip`,
  mac: `${DL}/Mantis-Installer.pkg`,
};

const STEPS: { title: string; time: string; cta: string; doneText: string; text: string; menu: string; Icon: typeof IcCam; screen: Screen }[] = [
  {
    title: "Зарегистрируйтесь в приложении", time: "≈ 3 минуты", cta: "Зарегистрироваться", doneText: "Вход выполнен", menu: "Вход и Регистрация", Icon: IcUser, screen: "start",
    text: "Создайте аккаунт по почте и паролю. Вам станут доступны все функции приложения.",
  },
  {
    title: "Настройте камеру", time: "≈ 5 минут", cta: "Настроить камеру", doneText: "Камера настроена", menu: "Настройка камеры", Icon: IcCam, screen: "setup",
    text: "Подключите камеру или телефон и отметьте на кадре витрину, вход в магазин, область где люди проходят мимо витрины/входа. Именно эти места будет анализировать камера.",
  },
  {
    title: "Запустите подсчёт", time: "≈ 1 минута", cta: "Запустить подсчёт", doneText: "Подсчёт идёт", menu: "Запустить подсчёт Live", Icon: IcLive, screen: "live",
    text: "Включите камеру – Mantis начнёт считать прохожих в реальном времени. Компьютер и камеру можно оставить без присмотра.",
  },
  {
    title: "Смотрите аналитику", time: "через 15–20 минут", cta: "Открыть аналитику", doneText: "Данные собираются", menu: "Аналитика", Icon: IcFunnel, screen: "analytics",
    text: `Первые доли воронки появятся, когда мимо пройдёт хотя бы ${MIN_PEOPLE} человек. Полная картина по часам и дням – через сутки.`,
  },
];

export function Onboarding() {
  const c = useCore();
  const ob = onboarding();
  const all = ob.next >= 4;
  const today = c.today();
  const counting = ob.done[2];
  const doneCount = ob.done.filter(Boolean).length;
  const preview: [string, number, string, string][] = [
    ["Прошли мимо", today.people, "var(--r1)", "весь поток у витрины"],
    ["Заинтересовались", today.slowed, "var(--r2)", "насколько витрина заметна"],
    ["Посмотрели", today.looked, "var(--r3)", "насколько оформление цепляет"],
    ["Зашли", today.entered, "var(--r4)", "сколько внимания стало визитами"],
  ];
  const openProfile = () => window.dispatchEvent(new Event("mantis:profile"));
  const start = (i: number) => {
    if (i === 0) return openProfile();
    if (i === 2 && !c.pilot.running) void c.startCounting();
    go(STEPS[i].screen, i === 1 && !c.pilot.channels.length ? "new" : "");
  };
  return (
    <main class="main onb" id="start">
      <header class="onb-head">
        <h1>{all ? "Всё готово – Mantis считает" : ob.next === 0 ? "Добро пожаловать в Mantis" : "Отлично, продолжаем"}</h1>
        <p class="onb-lead">{all
          ? "Аналитика наполняется. Загляните через час – появятся первые выводы, а через неделю можно сравнивать оформления витрины."
          : "Четыре шага – и вы увидите, сколько людей проходит мимо витрины, сколько её замечает и сколько заходит. Займёт около 5 минут."}</p>
        {!all && (
          <div class="onb-progress" role="progressbar" aria-label="Начало работы" aria-valuemin={0} aria-valuemax={4} aria-valuenow={doneCount}>
            <span class="onb-progress-top">
              <b>Начало работы · {doneCount} из 4</b>
              <span>Дальше: {STEPS[ob.next].title.toLowerCase()}</span>
            </span>
            <span class="onb-track"><span style={{ width: `${Math.round((doneCount / 4) * 100)}%` }} /></span>
          </div>
        )}
      </header>

      <ol class="onb-steps" aria-label="Начало работы">
        {STEPS.map((s, i) => {
          const done = ob.done[i];
          const hl = i === ob.next;
          return (
            <li key={s.title} class={`onb-step ${hl ? "hl" : ""}`} aria-current={hl ? "step" : undefined}>
              <div class="onb-step-top">
                {done
                  ? <span class="onb-num done"><IcCheck size={16} color="#15803D" width={3} /></span>
                  : <span class={`onb-num ${hl ? "on" : ""}`}>{i + 1}</span>}
                <span class="onb-stepno">{i + 1}-й шаг</span>
                <span class="onb-time">{s.time}</span>
              </div>
              <div class="onb-menu"><s.Icon size={16} color="#3A4456" /><span>{s.menu}</span></div>
              <div class="onb-text">
                <h2>{s.title}</h2>
                <p>{s.text}</p>
              </div>
              <div style={{ marginTop: "auto" }}>
                {done ? (
                  <span class="onb-done">
                    <span>{i === 3 && ob.people >= MIN_PEOPLE ? `Собрано: ${num(ob.people)} чел.` : i === 2 && !c.pilot.running ? "Подсчёт запускался" : s.doneText}</span>
                    {i === 0
                      ? <a href="#" onClick={(e) => { e.preventDefault(); openProfile(); }}>Профиль</a>
                      : <a href={`#/${s.screen}`}>{i === 1 ? "Изменить" : "Открыть"}</a>}
                  </span>
                ) : (
                  <button class="btn primary lg wide" onClick={() => start(i)}>{s.cta}<IcArrow size={16} width={2} /></button>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <section class="card" aria-labelledby="preview-h">
        <div class="card-head">
          <h2 id="preview-h">Что вы увидите в аналитике</h2>
          <span class="sub">{counting ? "сегодня, вживую" : "Цифры появятся после запуска подсчёта"}</span>
        </div>
        <div class="onb-preview">
          {preview.map(([label, v, color, hint], i) => (
            <div key={label}>
              <span class="pv-label">{label}</span>
              <span class="pv-value" style={{ color: counting ? "var(--ink)" : "var(--faint)" }}>{counting ? num(v) : "–"}</span>
              <Bar value={counting ? (i === 0 ? (v > 0 ? 1 : 0) : today.people ? v / today.people : 0) : 1} color={counting ? color : "#DCE2EC"} />
              <span class="pv-hint">{hint}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
