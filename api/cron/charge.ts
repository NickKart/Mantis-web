// GET /api/cron/charge – раз в сутки (vercel.json → crons): списать за месяц у всех, у кого закончился оплаченный срок.
// Vercel передаёт Authorization: Bearer $CRON_SECRET; без него вызов отклоняется.
import { handler, json } from "../_lib/server.js";
import { chargeAllDue } from "../_lib/store.js";

export default handler(["GET"], async (req) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return json(req, { error: "Unauthorized" }, 401);
  return json(req, await chargeAllDue());
});
