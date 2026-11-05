// Иконки из макета (линейные, 24×24).
import type { JSX } from "preact";

type P = { size?: number; color?: string; width?: number; style?: JSX.CSSProperties };

const svg = (body: JSX.Element, round = true) =>
  ({ size = 18, color = "currentColor", width = 1.8, style }: P) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} stroke-width={width} stroke-linecap="round"
      stroke-linejoin={round ? "round" : undefined} aria-hidden="true" style={style}>{body}</svg>
  );

export const IcStart = svg(<><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>);
export const IcLive = svg(<><circle cx="12" cy="12" r="3" /><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4" /></>, false);
export const IcCam = svg(<><path d="M15 10l5-3v10l-5-3z" /><rect x="3" y="6" width="12" height="12" rx="2" /></>);
export const IcFunnel = svg(<path d="M4 5h16M7 10h10M10 15h4M11 20h2" />);
export const IcAB = svg(<path d="M8 4v16M16 4v16M4 9h8M12 15h8" />, false);
export const IcRec = svg(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3z" /></>);
export const IcSearch = svg(<><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>, false);
export const IcMap = svg(<><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" /><path d="M9 4v16M15 6v16" /></>);
export const IcDownload = svg(<path d="M12 4v11M7 10l5 5 5-5M5 20h14" />, false);
export const IcFull = svg(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />, false);
export const IcClose = svg(<path d="M6 6l12 12M18 6 6 18" />, false);
export const IcBurger = svg(<path d="M4 7h16M4 12h16M4 17h16" />, false);
export const IcArrow = svg(<path d="M5 12h14M13 6l6 6-6 6" />, false);
export const IcBack = svg(<path d="M19 12H5M11 6l-6 6 6 6" />, false);
export const IcCheck = svg(<path d="m5 12 5 5 9-10" />);
export const IcPencil = svg(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>);
export const IcLock = svg(<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>, false);
export const IcEyeOff = svg(<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.6 3.2M6.4 7.4C4.3 9 3 12 3 12s4 6 9 6a8.6 8.6 0 0 0 3.6-.8" />, false);
export const IcReturn = svg(<><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>);
export const IcTrend = svg(<path d="m5 15 5-5 4 4 5-6" />, false);
export const IcClock = svg(<><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>, false);
export const IcAlert = svg(<><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></>, false);
export const IcOkCircle = svg(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>, false);
export const IcShield = svg(<><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z" /><path d="m9 12 2 2 4-4" /></>);
export const IcPlay = svg(<path d="M8 5v14l11-7z" />);
export const IcPause = svg(<path d="M8 5v14M16 5v14" />, false);
export const IcStop = svg(<rect x="6" y="6" width="12" height="12" rx="1.5" />);
export const IcBack10 = svg(<><path d="M4 12a8 8 0 1 0 2.3-5.7" /><path d="M4 4v4h4" /></>);
export const IcFwd10 = svg(<><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4h-4" /></>);
export const IcChevronDown = svg(<path d="m7 10 5 5 5-5" />);
export const IcChevronUp = svg(<path d="m7 14 5-5 5 5" />);
export const IcPlug = svg(<><path d="M10 7h4M12 3v4" /><rect x="7" y="7" width="10" height="8" rx="2" /><path d="M12 15v6" /></>);
export const IcPlus = svg(<path d="M12 5v14M5 12h14" />, false);
export const IcTrash = svg(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>);
export const IcFile = svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>);
export const IcWifi = svg(<><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" /><circle cx="12" cy="19.5" r=".8" /></>, false);
export const IcUser = svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const IcGear = svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);

export const Logo = () => (
  <div class="logo">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 18V6l8 7 8-7v12" /></svg>
  </div>
);

export const IcWindows = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5.5l7.5-1v7H3zM11.5 4.35L21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.35z" /></svg>
);
export const IcApple = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" /></svg>
);
