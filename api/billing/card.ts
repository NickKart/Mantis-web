// POST /api/billing/card {action: "bind"} – привязать карту для автоплатежей (без списания): ответ {url} – страница ЮKassa.
// POST /api/billing/card {action: "unbind"} – отвязать карту: дальше продление только с баланса.
import { HttpError, body, caller, handler, json, returnBase } from "../_lib/server.js";
import { startCardBinding, unbindCard } from "../_lib/store.js";
import { autopayEnabled } from "../_lib/yookassa.js";

export default handler(["POST"], async (req) => {
  const me = await caller(req);
  const b = await body<{ action: "bind" | "unbind" }>(req);
  if (b.action === "unbind") return json(req, { account: await unbindCard(me.uid) });
  if (b.action !== "bind") throw new HttpError(400, "Неизвестное действие");
  if (!autopayEnabled()) throw new HttpError(409, "Автоплатежи пока не подключены");
  return json(req, { url: await startCardBinding(me.uid, `${returnBase(req)}/?card=return`, "bind") });
});
