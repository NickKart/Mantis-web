// Шаг «Источник»: камера компьютера / USB, IP-камера (через мост Mantis Агента) или видеофайл.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChannelConfig } from "../../multi/channel";
import { type FoundCamera, type IpCameraConfig, type LiveSource, listCameras, onvifStream, openIpCamera, openWebcam, scanCameras } from "../../sources";
import { core } from "../core";
import { IcApple, IcArrow, IcCam, IcFile, IcWifi, IcWindows } from "../icons";
import { AGENT_LINKS } from "./Onboarding";
import { go } from "../ui";

type Kind = "webcam" | "ip" | "file";

const EXAMPLES = [
  { brand: "Hikvision (доп. поток)", url: "rtsp://192.168.1.64:554/Streaming/Channels/102" },
  { brand: "Dahua (доп. поток)", url: "rtsp://192.168.1.108:554/cam/realmonitor?channel=1&subtype=1" },
  { brand: "Uniview", url: "rtsp://192.168.1.13:554/media/video2" },
  { brand: "TP-Link VIGI / Tapo", url: "rtsp://192.168.1.100:554/stream2" },
];

export function SourceStep(p: { config: ChannelConfig | null; onNext: (src: { kind: "webcam" | "ip"; deviceId: string; ip: IpCameraConfig | null; label: string }) => void }) {
  const [kind, setKind] = useState<Kind>(p.config?.kind ?? "webcam");
  return (
    <div class="setup-body">
      <div class="setup-intro">
        <h1>Источник</h1>
        <p class="lead">Выберите, откуда Mantis берёт картинку: камера ноутбука или USB-камера, IP-камера в сети магазина или готовое видео для пробы. Видео никуда не отправляется – нейросеть работает на этом компьютере.</p>
      </div>
      <div class="src-kinds" role="radiogroup" aria-label="Тип источника">
        {([
          ["webcam", IcCam, "Камера компьютера или USB", "Встроенная камера, веб-камера, телефон как камера"],
          ["ip", IcWifi, "IP-камера", "Wi-Fi или LAN-камера в сети магазина"],
          ["file", IcFile, "Видеофайл", "Проверить подсчёт на готовом ролике"],
        ] as [Kind, typeof IcCam, string, string][]).map(([k, Icon, t, d]) => (
          <button key={k} role="radio" aria-checked={kind === k} class="src-kind" onClick={() => (k === "file" ? go("setup", "video") : setKind(k))}>
            <Icon size={22} color={kind === k ? "#1D5C96" : "#3A4456"} />
            <b>{t}</b>
            <span>{d}</span>
          </button>
        ))}
      </div>
      {kind === "webcam" && <WebcamPick config={p.config} onNext={p.onNext} />}
      {kind === "ip" && <IpPick config={p.config} onNext={p.onNext} />}
    </div>
  );
}

// ---------------------------------------------------------------- камера компьютера / USB
function WebcamPick(p: { config: ChannelConfig | null; onNext: SourceStepNext }) {
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [sel, setSel] = useState<string>(p.config?.kind === "webcam" ? p.config.deviceId : "");
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<LiveSource | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const owners = core.pilot.webcamOwners(p.config?.id ?? null);

  // предпросмотр выбранной камеры (камеру пилота на время закрываем)
  useEffect(() => {
    let src: LiveSource | null = null;
    let gone = false;
    const own = p.config ? core.pilot.channels.find((c) => c.id === p.config!.id) : null;
    void (async () => {
      if (own && !core.pilot.running) await own.stopPreview();
      try {
        src = await openWebcam(sel || null);
        if (gone) return src.close();
        setLive(src);
        setErr(null);
        const list = await listCameras();
        setCams(list);
        const id = (src.video?.srcObject as MediaStream | null)?.getVideoTracks()[0]?.getSettings().deviceId ?? "";
        if (!sel && id) setSel(id);
      } catch (e) {
        setLive(null);
        setErr(core.pilot.running && owners.size
          ? "Камера занята подсчётом. Остановите подсчёт на экране Live или выберите другую камеру."
          : `Нет доступа к камере: ${(e as Error).message || "разрешите доступ в настройках браузера"}`);
        setCams(await listCameras().catch(() => []));
      }
    })();
    return () => {
      gone = true;
      src?.close();
    };
  }, [sel]);
  useEffect(() => {
    const v = live?.video;
    if (!v || !box.current) return;
    v.className = "src-video";
    box.current.replaceChildren(v);
  }, [live]);

  const label = cams.find((c) => c.deviceId === sel)?.label || live?.label || "Камера";
  return (
    <div class="setup-grid">
      <section class="setup-frame">
        <div class="frame-head">
          <span class="frame-title">{label}</span>
          {live && <span class="sub">USB · {live.width}×{live.height}</span>}
        </div>
        <div class="frame" style={{ aspectRatio: live ? `${live.width} / ${live.height}` : "16 / 9" }}>
          <div ref={box} class="src-video-box" />
          {!live && <div class="msg">{err ?? "Подключаю камеру…"}</div>}
        </div>
      </section>
      <aside class="setup-panel">
        <div class="field">
          <label for="cam-pick" class="panel-title">Камера</label>
          <select id="cam-pick" class="select" value={sel} onChange={(e) => setSel((e.target as HTMLSelectElement).value)}>
            {!cams.length && <option value="">Камера по умолчанию</option>}
            {cams.map((c, i) => (
              <option key={c.deviceId} value={c.deviceId}>
                {(c.label || `Камера ${i + 1}`) + (owners.has(c.deviceId) ? ` – уже в «${owners.get(c.deviceId)}»` : "")}
              </option>
            ))}
          </select>
          <span class="small muted">Телефон можно подключить как веб-камеру (Continuity Camera на Mac, DroidCam/Iriun на Windows) – он появится в этом списке.</span>
        </div>
        {err && <p class="error-text">{err}</p>}
        <div class="panel-foot">
          <button class="btn primary lg wide" disabled={!live || owners.has(sel)} onClick={() => p.onNext({ kind: "webcam", deviceId: sel, ip: null, label })}>
            Далее: разметка кадра<IcArrow size={16} width={2} />
          </button>
        </div>
      </aside>
    </div>
  );
}

type SourceStepNext = (src: { kind: "webcam" | "ip"; deviceId: string; ip: IpCameraConfig | null; label: string }) => void;

// ---------------------------------------------------------------- IP-камера
function IpPick(p: { config: ChannelConfig | null; onNext: SourceStepNext }) {
  const c = core;
  const [found, setFound] = useState<FoundCamera[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cur, setCur] = useState<FoundCamera | null>(null);
  const [url, setUrl] = useState(p.config?.ip?.url ?? "");
  const [user, setUser] = useState(p.config?.ip?.user ?? "admin");
  const [pass, setPass] = useState(p.config?.ip?.password ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shot, setShot] = useState<{ cfg: IpCameraConfig; w: number; h: number } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  if (c.bridge === false) {
    return (
      <section class="card">
        <div class="card-head"><h2>IP-камеры подключаются через программу Mantis</h2></div>
        <p class="lead">Браузер сам не умеет искать камеры в сети и читать RTSP. Установите Mantis на компьютер у витрины: программа находит ONVIF-камеры в сети и передаёт кадры нейросети. Видео и пароли не уходят в интернет.</p>
        <div class="onb-dl">
          <a class="btn lg" href={AGENT_LINKS.windows} download><IcWindows />Скачать для Windows</a>
          <a class="btn lg" href={AGENT_LINKS.mac} download><IcApple />Скачать для macOS</a>
        </div>
        <p class="muted">macOS: приложение Mantis для всех Mac (M1 и новее, Intel), macOS 13 и новее. Откройте Mantis-Installer.pkg и нажмите «Установить». Если Mac не даёт открыть установщик – «Системные настройки» → «Конфиденциальность и безопасность» → «Всё равно открыть».</p>
        <p class="muted">Windows: Mantis Агент. После распаковки откройте «Как запустить.txt».</p>
      </section>
    );
  }

  const scan = async () => {
    setScanning(true);
    setErr(null);
    try {
      const r = await scanCameras();
      setFound(r.cameras);
      if (!r.cameras.length) setErr("Камер не нашлось. Проверьте, что компьютер в той же сети, или введите адрес вручную.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setScanning(false);
    }
  };
  const title = (f: FoundCamera) => f.name || f.hardware || (f.onvifURL ? "ONVIF-камера" : "Устройство с RTSP");

  const connect = async () => {
    setErr(null);
    let u = url.trim();
    try {
      if (cur?.onvifURL && !u) {
        setBusy("Спрашиваю у камеры адрес потока…");
        u = (await onvifStream(cur.onvifURL, user, pass)).uri;
        setUrl(u);
      }
      if (!/^rtsps?:\/\//i.test(u)) throw new Error("Адрес должен начинаться с rtsp://");
      const cfg: IpCameraConfig = { url: u, user, password: pass, title: cur ? `${title(cur)} · ${cur.ip}` : u.replace(/^rtsps?:\/\/([^/@]*@)?/, "").split("/")[0] };
      setBusy("Подключаюсь к камере…");
      const src = await openIpCamera(cfg, (s) => setBusy(s));
      const bmp = await src.grab();
      src.close();
      setShot({ cfg, w: bmp.width, h: bmp.height });
      requestAnimationFrame(() => {
        const cv = canvas.current;
        if (!cv) return;
        cv.width = bmp.width;
        cv.height = bmp.height;
        cv.getContext("2d")!.drawImage(bmp, 0, 0);
        bmp.close();
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="setup-grid">
      <section class="setup-frame">
        <div class="frame-head">
          <span class="frame-title">{shot ? shot.cfg.title : "IP-камера"}</span>
          {shot && <span class="sub">IP · {shot.w}×{shot.h}</span>}
        </div>
        <div class="frame" style={{ aspectRatio: shot ? `${shot.w} / ${shot.h}` : "16 / 9" }}>
          <canvas ref={canvas} hidden={!shot} />
          {!shot && <div class="msg">{busy ? <><span class="spinner" />&nbsp;{busy}</> : "Найдите камеру в сети или введите адрес, затем нажмите «Подключить»"}</div>}
        </div>
      </section>
      <aside class="setup-panel">
        <div class="field">
          <span class="panel-title">Камеры в сети</span>
          <button class="btn" onClick={() => void scan()} disabled={scanning}>{scanning ? <><span class="spinner dark" />Ищу камеры…</> : "Найти камеры"}</button>
          {found && found.length > 0 && (
            <div class="ip-list">
              {found.map((f) => (
                <button key={f.ip} class={`ip-item ${cur?.ip === f.ip ? "on" : ""}`} onClick={() => {
                  setCur(f);
                  setUrl(f.onvifURL ? "" : f.templates[0]?.url ?? `rtsp://${f.ip}:554/`);
                  setShot(null);
                }}>
                  <b>{title(f)}</b>
                  <span>{[f.ip, f.onvifURL ? "ONVIF" : "", f.rtspPorts.length ? `RTSP :${f.rtspPorts.join(", :")}` : ""].filter(Boolean).join(" · ")}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {cur && !cur.onvifURL && cur.templates.length > 0 && (
          <div class="field">
            <label for="ip-brand">Марка камеры</label>
            <select id="ip-brand" class="select" onChange={(e) => setUrl((e.target as HTMLSelectElement).value)}>
              {cur.templates.map((t) => <option key={t.url} value={t.url}>{t.title}</option>)}
            </select>
          </div>
        )}
        <div class="field">
          <label for="ip-url">{cur?.onvifURL ? "Адрес потока (необязательно – ONVIF подскажет сам)" : "Адрес потока rtsp://"}</label>
          <input id="ip-url" class="input" value={url} placeholder="rtsp://192.168.1.64:554/Streaming/Channels/102" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
          {!cur && (
            <span class="small muted">Примеры: {EXAMPLES.map((x, i) => (
              <span key={x.url}>{i ? ", " : ""}<a href="#" onClick={(e) => { e.preventDefault(); setUrl(x.url); }}>{x.brand}</a></span>
            ))}</span>
          )}
        </div>
        <div class="form-grid">
          <div class="field"><label for="ip-user">Логин</label><input id="ip-user" class="input" value={user} autoComplete="off" onInput={(e) => setUser((e.target as HTMLInputElement).value)} /></div>
          <div class="field"><label for="ip-pass">Пароль</label><input id="ip-pass" class="input" type="password" value={pass} autoComplete="off" onInput={(e) => setPass((e.target as HTMLInputElement).value)} /></div>
        </div>
        <button class="btn" disabled={!!busy || (!url.trim() && !cur?.onvifURL)} onClick={() => void connect()}>{busy ? "Подключаюсь…" : "Подключить"}</button>
        {err && <p class="error-text">{err}</p>}
        <div class="panel-foot">
          <button class="btn primary lg wide" disabled={!shot} onClick={() => shot && p.onNext({ kind: "ip", deviceId: "", ip: shot.cfg, label: shot.cfg.title })}>
            Далее: разметка кадра<IcArrow size={16} width={2} />
          </button>
        </div>
      </aside>
    </div>
  );
}
