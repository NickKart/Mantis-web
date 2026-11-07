// Mantis web – новый интерфейс (макет prototype8) поверх прежнего ядра.
import "@fontsource-variable/inter/index.css";
import "./app.css";
import "./screens.css";
import "./legacy.css";
import { render } from "preact";
import { abInit } from "../../ab/client";
import { idToken } from "../cloud/firebase";
import { applyLightPlanTheme } from "../twin/paint";
import { App } from "./App";
import { core } from "./core";

// A/B-тест (mantis.rcmit.ru): события и закрепление варианта за аккаунтом
abInit(() => idToken().catch(() => null));
applyLightPlanTheme();
render(<App />, document.getElementById("app")!);

// Подсчёт шёл до перезагрузки страницы – продолжаем; иначе первый экран – по готовности
void core.resume().then((resumed) => {
  if (resumed && !location.hash) location.hash = "#/live";
});

// Для автопроверки в браузере
(window as unknown as { mantisCore: typeof core }).mantisCore = core;
