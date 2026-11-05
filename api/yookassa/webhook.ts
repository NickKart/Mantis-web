// POST /api/yookassa/webhook – уведомления ЮKassa (payment.succeeded, payment.canceled).
// Телу уведомления не доверяем: берём номер платежа и запрашиваем его состояние у ЮKassa с нашими ключами.
// 200 – принято; 500 – ЮKassa повторит уведомление позже.
import { handler, json } from "../_lib/server.js";
import { applyPayment } from "../_lib/store.js";
import { getPayment } from "../_lib/yookassa.js";

export default handler(["POST"], async (req) => {
  let id = "";
  try {
    const n = (await req.json()) as { event?: string; object?: { id?: string } };
    id = n.object?.id ?? "";
    if (!n.event?.startsWith("payment.") || !id) return json(req, { ok: true, skipped: true });
  } catch {
    return json(req, { error: "bad json" }, 400);
  }
  const result = await applyPayment(await getPayment(id));
  return json(req, { ok: true, result });
});
