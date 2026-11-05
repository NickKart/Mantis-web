// POST /api/billing/autorenew {on} – включить или выключить ежемесячное списание с баланса.
import { body, caller, handler, json } from "../_lib/server.js";
import { setAutoRenew } from "../_lib/store.js";

export default handler(["POST"], async (req) => {
  const me = await caller(req);
  const b = await body<{ on: boolean }>(req);
  const account = await setAutoRenew(me.uid, b.on === true);
  return json(req, { account });
});
