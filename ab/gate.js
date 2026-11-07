// A/B-тест веб-версии: какую версию показать. Встраивается сборкой первым скриптом в <head> обеих версий
// (ab/vite.ts): A – новая (корень сайта), B – старая (/b/). Конфигурация – ab/config.json.
//
// Новому посетителю вариант выпадает случайно (доля B – splitB) и запоминается в cookie mantis_v на год.
// После входа вариант закрепляется за аккаунтом на сервере (ab/client.ts → /api/ab/assign).
// ?ab=a / ?ab=b – открыть нужный вариант и пометить браузер как тестовый (в статистику не идёт), ?ab=off – снять пометку.
// Тест идёт только на адресах из hosts; на остальных (Vercel, Агент) – без перенаправлений, только ?ab=.
// Сборка подставляет вариант этой страницы ("a" | "b") и содержимое config.json.
(function () {
  var C = __AB_CONFIG__;
  var ME = __AB_ME__;
  var HOME = { a: "/", b: "/b/" };
  var YEAR = 365 * 24 * 3600;

  function get(n) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + n + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function set(n, v, maxAge) {
    document.cookie = n + "=" + encodeURIComponent(v) + "; path=/; max-age=" + maxAge + "; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
  }
  function isV(v) {
    return v === "a" || v === "b";
  }

  var url = new URL(location.href);
  var q = url.searchParams.get("ab");
  if (q !== null) {
    if (isV(q)) {
      set("mantis_v", q, YEAR);
      set("mantis_ab_test", "1", YEAR);
    } else if (q === "off") set("mantis_ab_test", "", 0);
    url.searchParams.delete("ab");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }

  var onHost = C.hosts.indexOf(location.hostname) >= 0;
  var running = onHost && C.active && !C.force;
  var v = get("mantis_v");
  if (!get("mantis_vid")) set("mantis_vid", Math.random().toString(36).slice(2, 10) + Date.now().toString(36), YEAR);

  if (C.force && isV(C.force)) v = C.force;
  else if (onHost && !C.active) v = isV(C.winner) ? C.winner : "a";
  else if (running && !isV(v)) {
    v = Math.random() < C.splitB ? "b" : "a";
    set("mantis_v", v, YEAR);
    // cookie не сохраняются – не перенаправляем, иначе каждый заход будет новый вариант
    if (get("mantis_v") !== v) v = ME;
  }

  window.__mantisAB = {
    experiment: C.experiment,
    variant: ME,
    running: running,
    test: get("mantis_ab_test") === "1",
    vid: get("mantis_vid"),
    home: HOME,
  };

  // на чужом адресе без явного ?ab= остаёмся там, куда пришли
  if ((onHost || isV(q)) && isV(v) && v !== ME) {
    // откуда пришёл посетитель – после перехода на другую версию document.referrer будет наш адрес
    try {
      if (document.referrer && !sessionStorage.getItem("mantis_ab_ref")) sessionStorage.setItem("mantis_ab_ref", document.referrer);
    } catch (e) {
      /* нет */
    }
    location.replace(HOME[v] + url.search + url.hash);
  }
})();
