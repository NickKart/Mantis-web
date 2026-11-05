import { describe, expect, it } from "vitest";
import {
  addMonths, applyCharges, applyTopup, autopayAmount, autopayAttempt, checkSelection, emptyAccount, monthlyCharge,
  nextCharge, paymentAmount, planForCameras, startTrial,
} from "../api/_lib/tariffs";

const D = (s: string) => Date.parse(s);
const DAY = 24 * 3600_000;

describe("тарифы", () => {
  it("тариф по числу камер", () => {
    expect([1, 2, 4, 5, 30].map(planForCameras)).toEqual(["start", "vitrina", "vitrina", "set", "set"]);
  });
  it("суммы как на rcmit.ru/mantis", () => {
    expect(paymentAmount({ plan: "start", cameras: 1, period: "month" })).toBe(190_00);
    expect(paymentAmount({ plan: "vitrina", cameras: 3, period: "month" })).toBe(1350_00);
    expect(paymentAmount({ plan: "vitrina", cameras: 2, period: "year" })).toBe(400_00 * 2 * 12);
    expect(paymentAmount({ plan: "set", cameras: 6, period: "year" })).toBe(450_00 * 6 * 12);
    expect(monthlyCharge("set", 5, false)).toBe(2500_00);
  });
  it("проверка выбора", () => {
    expect(checkSelection({ plan: "start", cameras: 1, period: "month" })).toBeNull();
    expect(checkSelection({ plan: "start", cameras: 1, period: "year" })).toMatch(/нет оплаты за год/);
    expect(checkSelection({ plan: "vitrina", cameras: 5, period: "month" })).toMatch(/2–4/);
    expect(checkSelection({ plan: "set", cameras: 0, period: "month" })).toMatch(/от 1 до 100/);
    expect(checkSelection({ plan: "x" as never, cameras: 1, period: "month" })).toMatch(/Неизвестный/);
  });
  it("месяц вперёд с концом месяца", () => {
    expect(new Date(addMonths(D("2026-01-31T10:00:00Z"), 1)).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(new Date(addMonths(D("2026-11-05T12:00:00Z"), 12)).toISOString()).toBe("2027-11-05T12:00:00.000Z");
  });
});

describe("списания", () => {
  const now = D("2026-11-05T12:00:00Z");

  it("оплата месяца: деньги зачислены и сразу списаны за первый месяц", () => {
    const r = applyTopup(emptyAccount(), { plan: "vitrina", cameras: 2, period: "month" }, 900_00, "p1", now);
    expect(r.account.balance).toBe(0);
    expect(r.account.status).toBe("active");
    expect(r.account.paidUntil).toBe(D("2026-12-05T12:00:00Z"));
    expect(r.entries.map((e) => [e.type, e.amount])).toEqual([["topup", 900_00], ["charge", -900_00]]);
  });

  it("не хватает на следующий месяц – подписка закончилась, после пополнения продолжается", () => {
    const a = applyTopup(emptyAccount(), { plan: "start", cameras: 1, period: "month" }, 190_00, "p1", now).account;
    const later = D("2026-12-06T00:00:00Z");
    const r = applyCharges(a, later);
    expect(r.entries).toHaveLength(0);
    expect(r.account.status).toBe("expired");
    const t = applyTopup(r.account, { plan: "start", cameras: 1, period: "month" }, 190_00, "p2", later);
    // закончилась меньше 3 дней назад – новый месяц встык с прошлым
    expect(t.account.paidUntil).toBe(D("2027-01-05T12:00:00Z"));
    expect(t.account.status).toBe("active");
  });

  it("после долгого перерыва месяц считается от сегодня", () => {
    const a = { ...emptyAccount(), plan: "start" as const, cameras: 1, paidUntil: D("2026-09-01T00:00:00Z"), status: "expired" as const, balance: 500_00 };
    const r = applyCharges(a, now);
    expect(r.entries).toHaveLength(1);
    expect(r.account.paidUntil).toBe(D("2026-12-05T12:00:00Z"));
    expect(r.account.balance).toBe(310_00);
  });

  it("баланс на несколько месяцев списывается по одному, когда наступает срок", () => {
    let a = applyTopup(emptyAccount(), { plan: "start", cameras: 1, period: "month" }, 190_00, "p1", now).account;
    a = { ...a, balance: 380_00 };
    expect(applyCharges(a, D("2026-11-20T00:00:00Z")).entries).toHaveLength(0);
    const r = applyCharges(a, D("2026-12-05T12:00:01Z"));
    expect(r.entries).toHaveLength(1);
    expect(r.account.balance).toBe(190_00);
    expect(r.account.paidUntil).toBe(D("2027-01-05T12:00:00Z"));
  });

  it("оплата за год – 12 списаний по годовой цене, потом по месячной", () => {
    let { account: a } = applyTopup(emptyAccount(), { plan: "vitrina", cameras: 2, period: "year" }, 9600_00, "p1", now);
    expect(a.balance).toBe(8800_00);
    let t = now;
    let charges = 1;
    for (let m = 1; m <= 11; m++) {
      t = a.paidUntil! + 1000;
      const r = applyCharges(a, t);
      charges += r.entries.length;
      expect(r.entries[0].amount).toBe(-800_00);
      a = r.account;
    }
    expect(charges).toBe(12);
    expect(a.balance).toBe(0);
    a = { ...a, balance: 900_00 };
    const r = applyCharges(a, a.paidUntil! + 1000);
    expect(r.entries[0].amount).toBe(-900_00);
    expect(r.entries[0].annual).toBe(false);
  });

  it("автопродление выключено – не списывает", () => {
    const a = { ...applyTopup(emptyAccount(), { plan: "start", cameras: 1, period: "month" }, 380_00, "p1", now).account, autoRenew: false };
    const r = applyCharges(a, D("2026-12-06T00:00:00Z"));
    expect(r.entries).toHaveLength(0);
    expect(r.account.status).toBe("expired");
    expect(r.account.balance).toBe(190_00);
  });

  it("пробный период: 7 дней бесплатно один раз, потом списание с баланса", () => {
    const tr = startTrial(emptyAccount(), "vitrina", 3, now);
    if (typeof tr === "string") throw new Error(tr);
    expect(tr.account.status).toBe("trial");
    expect(tr.account.paidUntil).toBe(now + 7 * DAY);
    expect(startTrial(tr.account, "vitrina", 3, now + 8 * DAY)).toMatch(/уже был/);
    expect(startTrial(emptyAccount(), "set", 5, now)).toMatch(/нет пробного/);
    // оплатил во время пробного – списание только когда пробный закончится
    const paid = applyTopup(tr.account, { plan: "vitrina", cameras: 3, period: "month" }, 1350_00, "p1", now + DAY);
    expect(paid.entries).toHaveLength(1);
    expect(paid.account.status).toBe("trial");
    expect(nextCharge(paid.account, now + DAY)).toEqual({ at: now + 7 * DAY, amount: 1350_00, enough: true, fromCard: 0 });
    const r = applyCharges(paid.account, now + 7 * DAY + 1);
    expect(r.entries[0].from).toBe(now + 7 * DAY);
    expect(r.account.status).toBe("active");
    expect(r.account.balance).toBe(0);
  });
});

describe("автоплатёж с карты", () => {
  const now = D("2026-11-05T12:00:00Z");
  const card = { id: "pm-1", title: "Bank card *4444" };
  const trial = () => {
    const t = startTrial({ ...emptyAccount(), card }, "vitrina", 2, now);
    if (typeof t === "string") throw new Error(t);
    return t.account;
  };

  it("во время пробного периода не списываем", () => {
    expect(autopayAmount(trial(), now + 3 * DAY)).toBeNull();
  });

  it("пробный закончился, баланс пуст – списать с карты месяц целиком, после зачисления подписка встык", () => {
    const a = trial();
    const end = now + 7 * DAY;
    const t = end + 6 * 3600_000; // ежедневная проверка через 6 часов
    expect(autopayAmount(a, t)).toBe(900_00);
    expect(nextCharge(a, now + DAY)).toEqual({ at: end, amount: 900_00, enough: false, fromCard: 900_00 });
    const r = applyTopup(applyCharges(a, t).account, { plan: "vitrina", cameras: 2, period: "month" }, 900_00, "ap-1", t, true);
    expect(r.entries.map((e) => e.type)).toEqual(["topup", "charge"]);
    expect(r.entries[0].note).toMatch(/Автоплатёж с карты Bank card \*4444/);
    expect(r.account.status).toBe("active");
    expect(r.account.paidUntil).toBe(addMonths(end, 1));
    expect(r.account.balance).toBe(0);
    expect(autopayAmount(r.account, t)).toBeNull();
  });

  it("часть на балансе – с карты только недостающее", () => {
    const a = { ...trial(), balance: 300_00 };
    expect(autopayAmount(a, now + 7 * DAY + 1)).toBe(600_00);
  });

  it("без карты, при выключенном автопродлении и через 3 дня после окончания – не списываем", () => {
    const end = now + 7 * DAY;
    expect(autopayAmount({ ...trial(), card: null }, end + 1)).toBeNull();
    expect(autopayAmount({ ...trial(), autoRenew: false }, end + 1)).toBeNull();
    expect(autopayAmount(trial(), end + 3 * DAY + 1)).toBeNull();
  });

  it("попытки – одна в сутки: 0, 1, 2", () => {
    const a = trial();
    const end = now + 7 * DAY;
    expect([end + 1, end + DAY + 1, end + 2 * DAY + 5].map((t) => autopayAttempt(a, t))).toEqual([0, 1, 2]);
  });

  it("по годовой цене – пока действует год", () => {
    const a = { ...emptyAccount(), card, plan: "set" as const, cameras: 5, paidUntil: now, annualUntil: addMonths(now, 3), status: "active" as const };
    expect(autopayAmount(a, now + 1)).toBe(450_00 * 5);
  });
});
