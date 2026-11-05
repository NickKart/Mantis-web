// Тарифы Mantis и расчёт списаний. Общий код для сервера (api/*) и интерфейса (src/app).
// Цены – с rcmit.ru/mantis (ноябрь 2026): за одну камеру в месяц, в копейках.
// Без зависимостей от Node и браузера, чтобы считать одинаково везде и проверять тестами.

export type PlanId = "start" | "vitrina" | "set";
export type Period = "month" | "year";

export interface Tariff {
  id: PlanId;
  name: string;
  /** Цена за камеру в месяц, копейки. */
  month: number;
  /** Цена за камеру в месяц при оплате за год, копейки; null – годовой оплаты нет. */
  year: number | null;
  minCameras: number;
  maxCameras: number;
  trial: boolean;
  features: string[];
}

export const TARIFFS: Record<PlanId, Tariff> = {
  start: {
    id: "start", name: "Старт", month: 190_00, year: null, minCameras: 1, maxCameras: 1, trial: true,
    features: ["1 камера: телефон, USB или IP", "Аналитика", "PDF-отчёт с отметкой «Сделано в Mantis»"],
  },
  vitrina: {
    id: "vitrina", name: "Витрина", month: 450_00, year: 400_00, minCameras: 2, maxCameras: 4, trial: true,
    features: ["2–4 камеры", "Аналитика и дополнительная аналитика", "PDF-отчёт без отметки"],
  },
  set: {
    id: "set", name: "Сеть", month: 500_00, year: 450_00, minCameras: 5, maxCameras: 100, trial: false,
    features: ["От 5 камер", "Сравнение точек, конверсия по чекам", "Интеграция с 1С и кассой, API"],
  },
};

export const PLAN_IDS: PlanId[] = ["start", "vitrina", "set"];
export const MAX_CAMERAS = 100;
export const TRIAL_DAYS = 7;
/** Если подписка закончилась не позже этого срока, следующий месяц идёт встык, без разрыва. */
const GRACE_MS = 3 * 24 * 3600_000;

export const isPlan = (x: unknown): x is PlanId => typeof x === "string" && x in TARIFFS;

/** Тариф по числу камер: 1 – Старт, 2–4 – Витрина, от 5 – Сеть. */
export function planForCameras(cameras: number): PlanId {
  if (cameras <= 1) return "start";
  if (cameras <= 4) return "vitrina";
  return "set";
}

/** Месячное списание за все камеры, копейки. annual – действует оплата за год. */
export function monthlyCharge(plan: PlanId, cameras: number, annual: boolean): number {
  const t = TARIFFS[plan];
  return (annual && t.year != null ? t.year : t.month) * cameras;
}

export interface Selection {
  plan: PlanId;
  cameras: number;
  period: Period;
}

/** Проверить выбор пользователя. Возвращает текст ошибки или null. */
export function checkSelection(s: Partial<Selection>): string | null {
  if (!isPlan(s.plan)) return "Неизвестный тариф";
  const n = s.cameras;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_CAMERAS) return "Число камер – от 1 до 100";
  const t = TARIFFS[s.plan];
  if (n < t.minCameras || n > t.maxCameras) return `Тариф «${t.name}» – для ${rangeText(t)}`;
  if (s.period !== "month" && s.period !== "year") return "Неизвестный период оплаты";
  if (s.period === "year" && t.year == null) return `У тарифа «${t.name}» нет оплаты за год`;
  return null;
}

/** Сумма платежа за выбранный тариф: месяц или 12 месяцев по годовой цене, копейки. */
export function paymentAmount(s: Selection): number {
  return s.period === "year" ? monthlyCharge(s.plan, s.cameras, true) * 12 : monthlyCharge(s.plan, s.cameras, false);
}

export function rangeText(t: Tariff): string {
  if (t.minCameras === t.maxCameras) return `${t.minCameras} ${plural(t.minCameras, "камера", "камеры", "камер")}`;
  if (t.maxCameras >= MAX_CAMERAS) return `${t.minCameras} и более камер`;
  return `${t.minCameras}–${t.maxCameras} камер`;
}

export function describeSelection(s: Selection): string {
  const t = TARIFFS[s.plan];
  return `Mantis, тариф «${t.name}», ${s.cameras} ${plural(s.cameras, "камера", "камеры", "камер")}, ${s.period === "year" ? "12 мес." : "1 мес."}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** Прибавить месяцы к дате (мс), 31 января + 1 месяц = 28/29 февраля. */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

// ---------------------------------------------------------------- состояние счёта

export type Status = "none" | "trial" | "active" | "expired";

/** Счёт пользователя. Деньги – копейки, даты – мс. */
export interface Account {
  balance: number;
  plan: PlanId | null;
  cameras: number;
  /** До какого момента месячные списания идут по годовой цене (оплачен год). */
  annualUntil: number | null;
  /** До какого момента подписка оплачена (или идёт пробный период). */
  paidUntil: number | null;
  status: Status;
  trialUsed: boolean;
  autoRenew: boolean;
}

export const emptyAccount = (): Account => ({
  balance: 0, plan: null, cameras: 1, annualUntil: null, paidUntil: null, status: "none", trialUsed: false, autoRenew: true,
});

export interface Entry {
  type: "topup" | "charge" | "trial";
  /** + зачисление, − списание, копейки. */
  amount: number;
  balanceAfter: number;
  at: number;
  plan: PlanId | null;
  cameras: number;
  from?: number;
  to?: number;
  annual?: boolean;
  paymentId?: string;
  note: string;
}

/**
 * Списать с баланса за месяцы, срок которых наступил. Чистая функция: возвращает новое состояние и записи журнала.
 * Месяц списывается, если подписка закончилась, автопродление включено и денег хватает на месяц целиком;
 * иначе подписка помечается закончившейся и ждёт пополнения.
 */
export function applyCharges(acc: Account, now: number): { account: Account; entries: Entry[] } {
  const a = { ...acc };
  const entries: Entry[] = [];
  for (let i = 0; i < 24; i++) {
    if (a.paidUntil != null && a.paidUntil > now) break;
    if (!a.plan) {
      a.status = "none";
      break;
    }
    if (!a.autoRenew) {
      a.status = a.paidUntil == null ? "none" : "expired";
      break;
    }
    const from = a.paidUntil != null && now - a.paidUntil <= GRACE_MS ? a.paidUntil : now;
    const annual = a.annualUntil != null && from < a.annualUntil;
    const cost = monthlyCharge(a.plan, a.cameras, annual);
    if (a.balance < cost) {
      a.status = a.paidUntil == null ? "none" : "expired";
      break;
    }
    const to = addMonths(from, 1);
    a.balance -= cost;
    a.paidUntil = to;
    a.status = "active";
    entries.push({
      type: "charge", amount: -cost, balanceAfter: a.balance, at: now, plan: a.plan, cameras: a.cameras,
      from, to, annual, note: `Подписка «${TARIFFS[a.plan].name}», ${a.cameras} ${plural(a.cameras, "камера", "камеры", "камер")}${annual ? ", по годовой цене" : ""}`,
    });
  }
  if (a.paidUntil != null && a.paidUntil > now && a.status !== "trial") a.status = "active";
  return { account: a, entries };
}

/** Зачислить оплату: деньги на баланс, выбранный тариф – в счёт; при оплате за год – 12 месяцев по годовой цене. */
export function applyTopup(acc: Account, sel: Selection, amount: number, paymentId: string, now: number): { account: Account; entries: Entry[] } {
  const a = { ...acc, balance: acc.balance + amount, plan: sel.plan, cameras: sel.cameras, autoRenew: true };
  if (sel.period === "year") {
    const start = a.annualUntil != null && a.annualUntil > now ? a.annualUntil
      : a.paidUntil != null && a.paidUntil > now ? a.paidUntil : now;
    a.annualUntil = addMonths(start, 12);
  }
  const top: Entry = {
    type: "topup", amount, balanceAfter: a.balance, at: now, plan: sel.plan, cameras: sel.cameras, paymentId,
    note: `Оплата через ЮKassa: ${describeSelection(sel).replace(/^Mantis, /, "")}`,
  };
  const r = applyCharges(a, now);
  return { account: r.account, entries: [top, ...r.entries] };
}

/** Начать пробный период: 7 дней без списания, один раз на аккаунт, только Старт и Витрина. */
export function startTrial(acc: Account, plan: PlanId, cameras: number, now: number): { account: Account; entry: Entry } | string {
  if (acc.trialUsed) return "Пробный период уже был";
  if (acc.paidUntil != null && acc.paidUntil > now) return "Подписка уже действует";
  if (!TARIFFS[plan].trial) return `У тарифа «${TARIFFS[plan].name}» нет пробного периода`;
  const err = checkSelection({ plan, cameras, period: "month" });
  if (err) return err;
  const to = now + TRIAL_DAYS * 24 * 3600_000;
  const account: Account = { ...acc, plan, cameras, paidUntil: to, status: "trial", trialUsed: true, autoRenew: true };
  return {
    account,
    entry: { type: "trial", amount: 0, balanceAfter: acc.balance, at: now, plan, cameras, from: now, to, note: `Пробный период ${TRIAL_DAYS} дней, тариф «${TARIFFS[plan].name}»` },
  };
}

/** Следующее списание: когда и сколько (если автопродление включено и тариф выбран). */
export function nextCharge(acc: Account, now: number): { at: number; amount: number; enough: boolean } | null {
  if (!acc.plan || !acc.autoRenew) return null;
  const at = acc.paidUntil != null && acc.paidUntil > now ? acc.paidUntil : now;
  const amount = monthlyCharge(acc.plan, acc.cameras, acc.annualUntil != null && at < acc.annualUntil);
  return { at, amount, enough: acc.balance >= amount };
}

/** Рубли из копеек: «1 350 ₽», «190,50 ₽». */
export function rub(kop: number): string {
  const r = kop / 100;
  return `${r < 0 ? "−" : ""}${Math.abs(r).toLocaleString("ru-RU", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })} ₽`;
}
