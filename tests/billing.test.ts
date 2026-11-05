import { describe, expect, it } from "vitest";
import {
  addMonths, applyCharges, applyTopup, checkSelection, emptyAccount, monthlyCharge, nextCharge, paymentAmount,
  planForCameras, startTrial,
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
    expect(nextCharge(paid.account, now + DAY)).toEqual({ at: now + 7 * DAY, amount: 1350_00, enough: true });
    const r = applyCharges(paid.account, now + 7 * DAY + 1);
    expect(r.entries[0].from).toBe(now + 7 * DAY);
    expect(r.account.status).toBe("active");
    expect(r.account.balance).toBe(0);
  });
});
