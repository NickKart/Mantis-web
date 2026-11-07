import { type Plugin, defineConfig } from "vite";
// @ts-expect-error — мост написан на чистом JS (bridge/*.mjs), типы не нужны
import { createBridge } from "./bridge/api.mjs";
import { abGate } from "./ab/vite.ts";

/** Мост IP-камер внутри сервера разработки и предпросмотра: /api/* на том же адресе, что страница. */
function cameraBridge(): Plugin {
  let bridge: { handle: (req: unknown, res: unknown, next: () => void) => void; close: () => void } | null = null;
  const get = () => (bridge ??= createBridge());
  return {
    name: "mantis-camera-bridge",
    configureServer(server) {
      server.middlewares.use((req, res, next) => get().handle(req, res, next));
      server.httpServer?.on("close", () => bridge?.close());
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => get().handle(req, res, next));
    },
  };
}

// onnxruntime-web подгружает свои .wasm/.mjs во время работы — не даём Vite их пережёвывать.
export default defineConfig({
  base: "./",
  plugins: [cameraBridge(), abGate("a")],
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    // страницы: приложение (index.html), личный кабинет (cabinet.html), отчёт A/B-теста (ab.html)
    rollupOptions: { input: { main: "index.html", cabinet: "cabinet.html", ab: "ab.html" } },
  },
  server: {
    // Нужны для многопоточного WASM (SharedArrayBuffer)
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60000 },
});
