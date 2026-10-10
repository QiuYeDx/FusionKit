import { app, BrowserWindow, Notification, screen, session } from "electron";

/**
 * How automated UI tests present FusionKit windows. Set through
 * FUSIONKIT_TEST_WINDOW; the Vitest config defaults it to "quiet".
 *
 * - quiet:    windows render off-screen, stay out of the taskbar and never
 *             take focus, maximize or post system notifications.
 * - inactive: windows appear on-screen so a run can be watched, but never
 *             activate or take focus from the window in front.
 * - visible:  the app behaves exactly as it does for users.
 *
 * Neither quiet nor inactive lets a page enter full screen over the
 * developer's screen.
 */
export type TestWindowMode = "quiet" | "inactive" | "visible";

export const TEST_WINDOW_MODE_ENV = "FUSIONKIT_TEST_WINDOW";

export function resolveTestWindowMode(
  value: string | undefined,
): TestWindowMode | null {
  const mode = value?.trim().toLowerCase();
  return mode === "quiet" || mode === "inactive" || mode === "visible"
    ? mode
    : null;
}

// Chromium marks off-screen or covered windows as occluded, which hides the
// page and pauses animation frames and timers. Tests need a live page.
const OCCLUSION_SWITCHES = [
  "disable-backgrounding-occluded-windows",
  "disable-renderer-backgrounding",
  "disable-background-timer-throttling",
];

function keepRendererLive() {
  for (const name of OCCLUSION_SWITCHES) app.commandLine.appendSwitch(name);
  const disabled = app.commandLine
    .getSwitchValue("disable-features")
    .split(",")
    .filter(Boolean);
  if (!disabled.includes("CalculateNativeWinOcclusion")) {
    app.commandLine.appendSwitch(
      "disable-features",
      [...disabled, "CalculateNativeWinOcclusion"].join(","),
    );
  }
}

function offscreenOrigin() {
  const displays = screen.getAllDisplays().map((display) => display.bounds);
  const right = Math.max(...displays.map((bounds) => bounds.x + bounds.width));
  const top = Math.min(...displays.map((bounds) => bounds.y));
  return { x: right + 200, y: top };
}

/** Must run before the app is ready so the Chromium switches apply. */
export function installTestWindowMode(mode: TestWindowMode | null) {
  if (!mode || mode === "visible") return;
  keepRendererLive();

  // Tests and the app call show()/focus() directly; neither may pull the
  // window in front of whatever the developer is doing.
  const proto = BrowserWindow.prototype;
  proto.show = function show(this: BrowserWindow) {
    this.showInactive();
  };
  proto.focus = function focus() {};
  proto.moveTop = function moveTop() {};
  proto.flashFrame = function flashFrame() {};
  proto.setFullScreen = function setFullScreen() {};
  app.focus = () => {};
  // HTML full screen (element.requestFullscreen) asks for this permission.
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission !== "fullscreen"));
  });

  if (mode !== "quiet") return;
  Notification.prototype.show = function show() {};
  // Maximizing would move an off-screen window onto the developer's display.
  proto.maximize = function maximize() {};
  app.on("browser-window-created", (_event, window) => {
    window.setSkipTaskbar(true);
    const { x, y } = offscreenOrigin();
    window.setPosition(x, y);
  });
}
