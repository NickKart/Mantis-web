// Плагин Vite: встраивает ab/gate.js первым скриптом в <head> страницы приложения (index.html) –
// до загрузки приложения, чтобы посетитель сразу попадал в свой вариант A/B-теста.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export function abGate(variant: "a" | "b"): Plugin {
  return {
    name: "mantis-ab-gate",
    transformIndexHtml: {
      order: "pre",
      handler(_html, ctx) {
        if (!/(^|\/)index\.html$/.test(ctx.filename)) return [];
        const config = readFileSync(resolve(here, "config.json"), "utf8").trim();
        const code = readFileSync(resolve(here, "gate.js"), "utf8")
          .replace("__AB_CONFIG__", config)
          .replace("__AB_ME__", JSON.stringify(variant))
          .replace(/^\s*\/\/.*\n/gm, "");
        return [{ tag: "script", children: code, injectTo: "head-prepend" }];
      },
    },
  };
}
