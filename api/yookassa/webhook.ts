// POST /api/yookassa/webhook – уведомления ЮKassa: payment.succeeded, payment.canceled, payment_method.active.
// Телу уведомления не доверяем: берём номер и запрашиваем состояние у ЮKassa с нашими ключами.
// 200 – принято; 500 – ЮKassa повторит уведомление позже.
import { handler, json } from "../_lib/server.js";
import { applyPayment, applyPaymentMethod } from "../_lib/store.js";
import { getPayment, getPaymentMethod } from "../_lib/yookassa.js";

export default handler(["POST"], async (req) => {
  let id = "";
  let event = "";
  try {
    const n = (await req.json()) as { event?: string; object?: { id?: string } };
    id = n.object?.id ?? "";
    event = n.event ?? "";
  } catch {
    return json(req, { error: "bad json" }, 400);
  }
  if (!id) return json(req, { ok: true, skipped: true });
  if (event.startsWith("payment_method.")) return json(req, { ok: true, result: await applyPaymentMethod(await getPaymentMethod(id)) });
  if (event.startsWith("payment.")) return json(req, { ok: true, result: await applyPayment(await getPayment(id)) });
  return json(req, { ok: true, skipped: true });
});
