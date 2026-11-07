// Сборка старой версии Mantis (вариант B A/B-теста веб-версии) в dist/b – рядом с новой версией (dist).
// Исходники – github.com/Khomutyanskiy/mantiswebv1, коммит 2c7d700, плюс подписка и события A/B-теста (legacy/README.md).
//   npm run build        – собирает обе версии
//   npm run dev:b        – разработка старой версии
import { resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";
import { abGate } from "../ab/vite.ts";

const legacy = import.meta.dirname;
const root = resolve(import.meta.dirname, "..");

/** Блок подписки берётся из новой версии (src/app); его вход в Firebase – из старой версии, чтобы не было двух копий Firebase. */
function legacyFirebase(): Plugin {
  const target = resolve(legacy, "src/cloud/firebase.ts");
  return {
    name: "mantis-legacy-firebase",
    enforce: "pre",
    resolveId(id, importer) {
      if (!importer || !importer.startsWith(resolve(root, "src") + "/")) return null;
      if (!/(^|\/)cloud\/firebase(\.ts)?$/.test(id)) return null;
      return target;
    },
  };
}

export default defineConfig({
  root: legacy,
  base: "./",
  publicDir: resolve(legacy, "public"),
  plugins: [legacyFirebase(), abGate("b")],
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
  build: {
    outDir: resolve(root, "dist/b"),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { main: resolve(legacy, "index.html"), cabinet: resolve(legacy, "cabinet.html") } },
  },
  server: {
    port: 5174,
    fs: { allow: [root] },
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
  },
  preview: {
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
  },
});
