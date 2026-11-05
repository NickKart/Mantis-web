// GET /api/billing/status – счёт пользователя: баланс, тариф, оплачено до, журнал. Заодно списывает за наступивший месяц
// и проверяет незавершённые платежи в ЮKassa.
import { caller, handler, json } from "../_lib/server.js";
import { chargeDue, ledger, syncPending } from "../_lib/store.js";
import { nextCharge } from "../_lib/tariffs.js";

export default handler(["GET"], async (req) => {
  const me = await caller(req);
  await syncPending(me.uid).catch((e) => console.error("syncPending", e));
  const account = await chargeDue(me.uid, me.email);
  const now = Date.now();
  return json(req, { account, next: nextCharge(account, now), ledger: await ledger(me.uid), now });
});
