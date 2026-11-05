// POST /api/billing/trial {plan, cameras} – начать пробный период 7 дней (Старт и Витрина, один раз).
import { HttpError, body, caller, handler, json } from "../_lib/server.js";
import { beginTrial } from "../_lib/store.js";
import { type Selection, isPlan } from "../_lib/tariffs.js";

export default handler(["POST"], async (req) => {
  const me = await caller(req);
  const b = await body<Selection>(req);
  if (!isPlan(b.plan)) throw new HttpError(400, "Неизвестный тариф");
  const account = await beginTrial(me.uid, b.plan, Number(b.cameras), me.email);
  return json(req, { account });
});
