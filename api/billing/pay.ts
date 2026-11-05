// POST /api/billing/pay {plan, cameras, period} – создать платёж в ЮKassa на сумму выбранного тарифа.
// Ответ: {url} – страница оплаты ЮKassa. Деньги зачисляются на баланс после оплаты (вебхук или проверка статуса).
// saveCard (по умолчанию да, если автоплатежи включены) – сохранить карту, чтобы продлевать подписку с неё.
import { randomUUID } from "node:crypto";
import { HttpError, body, caller, handler, json, returnBase } from "../_lib/server.js";
import { savePayment } from "../_lib/store.js";
import { type Selection, checkSelection, describeSelection, paymentAmount } from "../_lib/tariffs.js";
import { autopayEnabled, createPayment } from "../_lib/yookassa.js";

export default handler(["POST"], async (req) => {
  const me = await caller(req);
  const b = await body<Selection & { saveCard: boolean }>(req);
  const sel = { plan: b.plan, cameras: Number(b.cameras), period: b.period } as Selection;
  const err = checkSelection(sel);
  if (err) throw new HttpError(400, err);
  const amount = paymentAmount(sel);
  const description = describeSelection(sel);
  const p = await createPayment({
    amount,
    description,
    returnUrl: `${returnBase(req)}/?payment=return`,
    metadata: { uid: me.uid, plan: sel.plan, cameras: String(sel.cameras), period: sel.period },
    email: me.email,
    saveCard: autopayEnabled() && b.saveCard !== false,
    idempotenceKey: randomUUID(),
  });
  await savePayment(me.uid, p, sel, amount, description, "checkout");
  const url = p.confirmation?.confirmation_url;
  if (!url) throw new HttpError(502, "ЮKassa не вернула страницу оплаты");
  return json(req, { url, paymentId: p.id });
});
