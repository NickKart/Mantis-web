// Состояние приложения: аккаунт, нейросеть, подсчёт на нескольких камерах, план точки (двойник),
// передача в облако, записи, настройки веб-версии. Всё это – ядро прежней веб-версии; здесь оно только собрано вместе
// для нового интерфейса. Экраны подписываются на изменения (subscribe) и на кадры камер (onShot).

import { Account } from "../cloud/account";
import { loadWebSettings, saveWebSettings } from "../cloud/firebase";
import { TwinPublisher } from "../cloud/twinPublisher";
import { desktopShell } from "../desktop";
import { Detector } from "../detector";
import type { FrameResult } from "../engine/session";
import type { Channel } from "../multi/channel";
import { channelColorIndex, channelShort } from "../multi/channel";
import { MultiPilot } from "../multi/model";
import { type HourStat, emptyHour } from "../pilot/hours";
import { TwinModel } from "../twin/model";
import type { RecCameraRef } from "../twin/plan";
import { type RecordingMeta, saveRecording } from "../twin/store";
import { bridgeInfo } from "../sources";

export interface Shot {
  canvas: HTMLCanvasElement;
  fr: FrameResult | null;
  at: number;
}

export interface Toast {
  id: number;
  text: string;
  error: boolean;
}

/** Оформление витрины: с какого дня действует (для подписей и сравнения периодов). */
export interface Showcase {
  id: string;
  name: string;
  /** День начала, YYYY-MM-DD. */
  from: string;
}

/** Сохранённое сравнение A/B. */
export interface SavedComparison {
  id: string;
  mode: "rec" | "period";
  a: string;
  b: string;
  title: string;
  at: number;
}

export interface WebSettings {
  showcases: Showcase[];
  /** Чеки из кассы: ключ «с|по» (YYYY-MM-DD) → число чеков. */
  checks: Record<string, number>;
  comparisons: SavedComparison[];
  /** Вид экрана Live: размывать видео камер в списке. */
  blurCams: boolean;
}

const SETTINGS_KEY = "mantis.web.settings.v1";
const defaultSettings = (): WebSettings => ({ showcases: [], checks: {}, comparisons: [], blurCams: true });

function loadLocalSettings(): WebSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<WebSettings>) };
  } catch {
    /* нет */
  }
  return defaultSettings();
}

/** Счётчики записи по ходу: [t, прошли мимо, притормозили, посмотрели, вернулись, зашли]. */
const countsRow = (t: number, h: HourStat): number[] => [Math.round(t * 10) / 10, h.people, h.slowed, h.looked, h.returned, h.entered];

export class Core {
  readonly account = new Account();
  readonly pilot: MultiPilot;
  readonly twin: TwinModel;
  readonly publisher: TwinPublisher;
  readonly shots = new Map<string, Shot>();
  detector: Detector | null = null;
  detectorState: "idle" | "loading" | "ready" | "error" = "idle";
  detectorText = "";
  toasts: Toast[] = [];
  settings: WebSettings = loadLocalSettings();
  /** Идёт запись фрагмента: с какого момента и счётчики по ходу. */
  recording: { started: number; base: HourStat; counts: number[][]; timer: number } | null = null;
  /** Агент (программа на компьютере) отдаёт эту страницу – доступны IP-камеры через мост. */
  bridge: boolean | null = null;

  private detectorLoading: Promise<Detector> | null = null;
  private subs = new Set<() => void>();
  private shotSubs = new Set<(id: string) => void>();
  private emitQueued = false;
  private toastSeq = 0;

  constructor() {
    this.pilot = new MultiPilot({
      account: this.account,
      getDetector: () => this.ensureDetector(),
      resetDetector: () => this.resetDetector(),
      hostname: () => "",
      onFrame: (ch, shot, fr) => this.storeShot(ch, shot, fr),
      onChange: () => this.emit(),
    });
    this.twin = new TwinModel(() => this.pilot.channels.map((c) => ({ id: c.id, title: c.title, isLive: c.isLive, last: c.last })));
    this.twin.start();
    this.publisher = new TwinPublisher({
      account: this.account, pilot: this.pilot, twin: this.twin,
      deviceName: () => deviceName(),
      onPlanFromCloud: () => {
        this.emit();
        this.toast("План точки обновлён из личного кабинета");
      },
    });
    this.account.subscribe(() => this.emit());
    this.account.hours.onChange(() => this.emit());
    let lastUid: string | null = null;
    this.account.subscribe((st) => {
      const uid = st.user?.uid ?? null;
      if (uid && uid !== lastUid) void this.pullSettings(uid);
      lastUid = uid;
    });
    window.addEventListener("beforeunload", (e) => {
      this.pilot.prepareForUnload();
      if (this.pilot.running && !desktopShell) e.preventDefault();
    });
    // Приложение для Windows перед выходом: досчитать и сохранить
    (window as unknown as { __mantisQuit?: () => void }).__mantisQuit = () => {
      this.pilot.prepareForUnload();
      this.account.hours.save();
      void this.account.upload();
    };
    void this.checkBridge();
  }

  // ---------------------------------------------------------------- подписки
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  /** Изменения копятся и рассылаются раз в кадр отрисовки. */
  emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    requestAnimationFrame(() => {
      this.emitQueued = false;
      for (const fn of this.subs) fn();
    });
  }
  onShot(fn: (id: string) => void): () => void {
    this.shotSubs.add(fn);
    return () => this.shotSubs.delete(fn);
  }

  private storeShot(ch: Channel, shot: ImageBitmap, fr: FrameResult | null): void {
    let s = this.shots.get(ch.id);
    if (!s) {
      s = { canvas: document.createElement("canvas"), fr: null, at: 0 };
      this.shots.set(ch.id, s);
    }
    if (s.canvas.width !== shot.width || s.canvas.height !== shot.height) {
      s.canvas.width = shot.width;
      s.canvas.height = shot.height;
    }
    s.canvas.getContext("2d")!.drawImage(shot, 0, 0);
    s.fr = fr;
    s.at = performance.now();
    for (const fn of this.shotSubs) fn(ch.id);
  }

  // ---------------------------------------------------------------- сообщения
  toast(text: string, error = false): void {
    const t = { id: ++this.toastSeq, text, error };
    this.toasts = [...this.toasts, t];
    this.emit();
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id);
      this.emit();
    }, error ? 7000 : 3500);
  }

  // ---------------------------------------------------------------- нейросеть
  ensureDetector(): Promise<Detector> {
    if (this.detector) return Promise.resolve(this.detector);
    if (!this.detectorLoading) {
      this.detectorState = "loading";
      this.detectorText = "Загружаю нейросеть…";
      this.emit();
      this.detectorLoading = Detector.create((st) => {
        this.detectorText = st;
        this.emit();
      })
        .then((d) => {
          this.detector = d;
          this.detectorState = "ready";
          this.detectorText = d.backend;
          this.emit();
          return d;
        })
        .catch((e: Error) => {
          this.detectorLoading = null;
          this.detectorState = "error";
          this.detectorText = "Нейросеть не загрузилась";
          this.emit();
          throw e;
        });
    }
    return this.detectorLoading;
  }

  resetDetector(): void {
    this.detector?.dispose();
    this.detector = null;
    this.detectorLoading = null;
    this.detectorState = "idle";
    this.emit();
  }

  /** GPU / CPU – для блока «Система». */
  get backendShort(): string {
    const b = this.detector?.backend ?? "";
    return b.startsWith("WebGPU") ? "GPU" : b ? "CPU" : "";
  }

  // ---------------------------------------------------------------- подсчёт
  async startCounting(): Promise<void> {
    if (!this.pilot.channels.length) {
      this.toast("Сначала добавьте камеру в «Настройке камеры»", true);
      return;
    }
    void this.ensureDetector().catch((e: Error) => this.toast(`Не удалось загрузить нейросеть: ${e.message}`, true));
    await this.pilot.start();
  }

  async stopCounting(): Promise<void> {
    if (this.recording) await this.stopRecording();
    await this.pilot.stop();
  }

  /** Подсчёт шёл до перезагрузки страницы – продолжаем сами. */
  async resume(): Promise<boolean> {
    if (!MultiPilot.wasActive || !this.pilot.channels.length) return false;
    await this.account.whenReady();
    await this.startCounting();
    this.toast("Подсчёт продолжен после перезагрузки страницы");
    return true;
  }

  /** Итоги за сегодня по всем камерам. */
  today(): HourStat {
    return this.pilot.today();
  }

  // ---------------------------------------------------------------- запись фрагмента
  startRecording(): void {
    if (this.recording) return;
    if (!this.pilot.running) {
      this.toast("Запись идёт во время подсчёта – сначала запустите подсчёт", true);
      return;
    }
    const refs: RecCameraRef[] = this.pilot.channels.map((ch, i) => ({ id: ch.id, name: channelShort(ch.config), colorIndex: channelColorIndex(ch.config, i) }));
    this.twin.startRecording(refs);
    const started = performance.now();
    const base = { ...this.pilot.totals };
    const rec = { started, base, counts: [countsRow(0, emptyHour())], timer: 0 };
    rec.timer = window.setInterval(() => {
      const t = (performance.now() - started) / 1000;
      const d = diffHours(this.pilot.totals, base);
      const last = rec.counts[rec.counts.length - 1];
      const row = countsRow(t, d);
      if (row.slice(1).some((v, i) => v !== last[i + 1])) rec.counts.push(row);
      this.emit();
    }, 1000);
    this.recording = rec;
    this.emit();
  }

  get recordingSeconds(): number {
    return this.recording ? (performance.now() - this.recording.started) / 1000 : 0;
  }

  /** Остановить и сохранить в «Записи». name – название (по умолчанию дата и время). */
  async stopRecording(name?: string): Promise<RecordingMeta | null> {
    const rec = this.recording;
    if (!rec) return null;
    clearInterval(rec.timer);
    this.recording = null;
    const t = (performance.now() - rec.started) / 1000;
    rec.counts.push(countsRow(t, diffHours(this.pilot.totals, rec.base)));
    const r = this.twin.stopRecording();
    this.emit();
    if (!r) {
      this.toast("Запись слишком короткая – не сохранена", true);
      return null;
    }
    const title = name?.trim() || `Запись ${new Date().toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`;
    const m = await saveRecording(title, "live", { ...r.data, counts: rec.counts }, null, this.twin.backgroundBlob);
    if (m) this.toast(`Сохранено в «Записи»: ${title}`);
    else this.toast("Не удалось сохранить запись", true);
    this.emit();
    return m;
  }

  // ---------------------------------------------------------------- настройки веб-версии
  updateSettings(p: Partial<WebSettings>): void {
    this.settings = { ...this.settings, ...p };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* нет */
    }
    const uid = this.account.uid;
    if (uid) {
      const { blurCams: _skip, ...cloud } = this.settings;
      void saveWebSettings(uid, cloud as unknown as Record<string, unknown>).catch(() => undefined);
    }
    this.emit();
  }

  private async pullSettings(uid: string): Promise<void> {
    try {
      const remote = (await loadWebSettings(uid)) as Partial<WebSettings> | null;
      if (!remote) {
        this.updateSettings({}); // отправить то, что есть в браузере
        return;
      }
      const byId = <T extends { id: string }>(a: T[] = [], b: T[] = []) => [...new Map([...a, ...b].map((x) => [x.id, x])).values()];
      this.updateSettings({
        showcases: byId(this.settings.showcases, remote.showcases).sort((a, b) => a.from.localeCompare(b.from)),
        checks: { ...this.settings.checks, ...(remote.checks ?? {}) },
        comparisons: byId(this.settings.comparisons, remote.comparisons),
      });
    } catch {
      /* без облака – только браузер */
    }
  }

  // ---------------------------------------------------------------- мост IP-камер
  private async checkBridge(): Promise<void> {
    this.bridge = !!(await bridgeInfo())?.ok;
    this.emit();
  }
}

function diffHours(a: HourStat, b: HourStat): HourStat {
  const o = emptyHour();
  for (const k of Object.keys(o) as (keyof HourStat)[]) o[k] = Math.max(0, (a[k] ?? 0) - (b[k] ?? 0));
  return o;
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
    : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return `Mantis · ${desktopShell === "windows" ? "Windows" : desktopShell === "macos" ? "Mac" : os ? `браузер на ${os}` : "браузер"}`;
}

export const core = new Core();
