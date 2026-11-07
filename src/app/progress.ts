// «Как начать работать»: четыре шага по настоящему состоянию – вход выполнен, камера размечена, подсчёт шёл, данных хватает.
import { core } from "./core";

export interface Onboarding {
  done: [boolean, boolean, boolean, boolean];
  /** Номер следующего шага (0–3) или 4 – всё готово. */
  next: number;
  /** Сколько людей прошло мимо за всё время. */
  people: number;
}

/** Порог для первых долей воронки. */
export const MIN_PEOPLE = 30;

export function onboarding(): Onboarding {
  const chs = core.pilot.channels;
  const cameraReady = chs.some((c) => c.config.ready);
  let people = 0, seconds = 0;
  for (const h of Object.values(core.account.hours.hours)) {
    people += h.people;
    seconds += h.seconds;
  }
  const counted = core.pilot.running || seconds > 0;
  const enough = people >= MIN_PEOPLE;
  const registered = !!core.account.state.user;
  const done: [boolean, boolean, boolean, boolean] = [registered, cameraReady, cameraReady && counted, cameraReady && counted && enough];
  const next = done.indexOf(false);
  return { done, next: next < 0 ? 4 : next, people };
}
