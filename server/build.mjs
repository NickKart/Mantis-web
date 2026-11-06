// Сборка сервера API в один файл server/dist/server.cjs – на сервер не нужно ставить node_modules.
// Обработчики api/* импортируют базу из store.ts (Firestore, для Vercel); здесь вместо неё подставляется
// store-pg.ts (PostgreSQL), так что firebase-admin в сборку не попадает.

import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** ./store.js → api/_lib/store-pg.ts */
const postgresStore = {
  name: "postgres-store",
  setup(b) {
    b.onResolve({ filter: /(^|\/)store\.js$/ }, (args) => {
      const from = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      if (from !== resolve(root, "api/_lib/store.ts")) return undefined;
      return { path: resolve(root, "api/_lib/store-pg.ts") };
    });
  },
};

const result = await build({
  entryPoints: [resolve(root, "server/index.ts")],
  outfile: resolve(root, "server/dist/server.cjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  legalComments: "none",
  external: ["pg-native", "firebase-admin", "firebase-admin/*"],
  plugins: [postgresStore],
  metafile: true,
  logLevel: "info",
});

const inputs = Object.keys(result.metafile.inputs);
if (inputs.some((p) => p.includes("firebase-admin") || p.endsWith("api/_lib/store.ts") || p.endsWith("api/_lib/firestore.ts"))) {
  console.error("В сборку сервера попал Firestore – проверьте импорты");
  process.exit(1);
}
