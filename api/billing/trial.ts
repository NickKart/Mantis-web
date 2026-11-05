// POST /api/billing/trial {plan, cameras} – пробный период 7 дней (Старт и Витрина, один раз на аккаунт).
// Если автоплатежи включены, сначала привязывается карта (без списания): ответ {url} – страница ЮKassa,
// пробный период начнётся, когда карта привяжется; по его окончании подписка оплатится с карты.
// Если карта уже привязана или автоплатежи выключены – пробный период начинается сразу: ответ {account}.
import { HttpError, body, caller, handler, json, returnBase } from "../_lib/server.js";
import { beginTrial, checkTrial, startCardBinding } from "../_lib/store.js";
import { type Selection, isPlan } from "../_lib/tariffs.js";
import { autopayEnabled } from "../_lib/yookassa.js";

export default handler(["POST"], async (req) => {
  const me = await caller(req);
  const b = await body<Selection>(req);
  if (!isPlan(b.plan)) throw new HttpError(400, "Неизвестный тариф");
  const cameras = Number(b.cameras);
  const current = await checkTrial(me.uid, b.plan, cameras);
  if (autopayEnabled() && !current.card) {
    const url = await startCardBinding(me.uid, `${returnBase(req)}/?card=return`, "trial", b.plan, cameras);
    return json(req, { url });
  }
  return json(req, { account: await beginTrial(me.uid, b.plan, cameras, me.email) });
});
