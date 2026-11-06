// Firebase Admin для базы оплат в Firestore (контур разработки на Vercel).
// На своём сервере не используется: там база – PostgreSQL (store-pg.ts).

import { type App, cert, getApps, initializeApp } from "firebase-admin/app";
import { type Firestore, getFirestore } from "firebase-admin/firestore";
import { HttpError } from "./server.js";

let app: App | null = null;

function adminApp(): App {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) return (app = existing);
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new HttpError(503, "Оплата ещё не настроена: нет ключа Firebase на сервере");
  let sa: Record<string, string>;
  try {
    sa = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new HttpError(503, "Ключ Firebase на сервере повреждён");
  }
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  app = initializeApp({ credential: cert(sa as never), projectId: sa.project_id });
  return app;
}

export function db(): Firestore {
  return getFirestore(adminApp());
}
