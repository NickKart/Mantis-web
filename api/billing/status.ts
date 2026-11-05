// GET /api/billing/status – счёт пользователя: баланс, тариф, оплачено до, карта, журнал.
// Заодно продлевает подписку, если срок наступил (с баланса, при нехватке – с карты),
// и проверяет незавершённые платежи и привязки карт в ЮKassa.
import { caller, handler, json } from "../_lib/server.js";
import { ledger, renew, syncPending } from "../_lib/store.js";
import { nextCharge } from "../_lib/tariffs.js";
import { autopayEnabled } from "../_lib/yookassa.js";

export default handler(["GET"], async (req) => {
  const me = await caller(req);
  await syncPending(me.uid).catch((e) => console.error("syncPending", e));
  const account = await renew(me.uid, me.email);
  const now = Date.now();
  return json(req, { account, next: nextCharge(account, now), ledger: await ledger(me.uid), now, autopay: autopayEnabled() });
});
