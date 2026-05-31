import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  shell,
  systemPreferences,
} from "electron";
import electronUpdater from "electron-updater";
import QRCode from "qrcode";
import WebSocket from "ws";
import { createMobileBridgeServer } from "./mobile/bridge-server.js";
import {
  clearPairingSession,
  createPairingSession,
  deleteMobileDevice,
  getPairingSession,
  listMobileDevices,
} from "./mobile/pairing-store.js";
import {
  computerUseBrowserDocsUrl,
  createOsPermissionSnapshot,
  getMacOsPrivacySettingsUrl,
  getWindowsPrivacySettingsUrl,
  isKnownOsPermissionId,
} from "./os-permissions.js";
import { buildRealtimeInstructions } from "./realtime/prompts.js";
import {
  listActivity,
  migrateLegacyActivityStore,
  recordActivity,
} from "./realtime/tools/activity-store.js";
import { loadAgentProfile, saveAgentProfile } from "./realtime/tools/agent-profile-store.js";
import { getDatabasePath, setDatabaseUserDataPath } from "./realtime/tools/database.js";
import { executeRealtimeTool, getRealtimeToolDefinitions } from "./realtime/tools/index.js";
import {
  buildMemoryContext,
  deleteDailyLog,
  getMemoryOverview,
} from "./realtime/tools/memory-store.js";
import {
  loadMicrophoneDeviceId,
  saveMicrophoneDeviceId,
} from "./realtime/tools/microphone-store.js";
import {
  listCalendarItems,
  listTasks,
  migrateLegacyPlannerStore,
} from "./realtime/tools/planner-store.js";
import { loadWindowPosition, saveWindowPosition } from "./realtime/tools/window-state-store.js";

const { autoUpdater } = electronUpdater;
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// When the launching terminal/parent closes the stdout/stderr pipe, console
// writes raise EPIPE. Without a listener Node turns that into an uncaught
// exception that kills the app, so swallow broken-pipe errors on both streams.
for (const stream of [process.stdout, process.stderr]) {
  stream.on?.("error", (error) => {
    if (error?.code !== "EPIPE" && error?.code !== "ERR_STREAM_DESTROYED") {
      throw error;
    }
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDevelopment = !app.isPackaged;

const openAIAuthConfig = Object.freeze({
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
  redirectHost: "localhost",
  redirectPort: 1455,
  redirectPath: "/auth/callback",
});

const realtimeDefaults = Object.freeze({
  model: "gpt-realtime-2",
  voice: "cedar",
  speed: 1.0,
  sampleRate: 24_000,
});

const mobileAssistantDefaults = Object.freeze({
  model: "gpt-4.1-mini",
  maxToolRounds: 5,
});

const jarvisStyleInstructions = `# Voice Preset
- Use an original elite AI-butler/copilot style: calm, refined, precise, technically capable, and lightly dry.
- Aim for a low-drama, polished, cinematic command-center feel without impersonating any real actor or copyrighted character.
- Speak with composed confidence, crisp diction, and restrained warmth; never sound goofy, corporate, or overly cheerful.
- Prefer concise acknowledgements like "Certainly", "Right away", "On it", "Handled", and occasional "sir" when it fits naturally.
- Keep most replies to one clean sentence unless the task needs detail.
- For status updates, sound operational: report what changed, what is running, what is blocked, and the next useful action.
- When asked to operate tools, act like a capable systems copilot: calm preamble, execute, then concise result.
- Do not claim to be any specific fictional assistant, and do not imitate a specific actor's voice.`;

const realtimeVoicePresets = Object.freeze([
  {
    id: "jarvis",
    label: "JARVIS-style",
    description:
      "Elite AI-butler/copilot feel using Cedar; original, not an actor or character clone.",
    voice: "cedar",
    speed: 0.9,
    instructions: jarvisStyleInstructions,
  },
]);

const realtimeBuiltInVoiceOptions = Object.freeze([
  { id: "marin", label: "Marin", description: "Warm and natural" },
  { id: "cedar", label: "Cedar", description: "Calm and grounded" },
  { id: "alloy", label: "Alloy", description: "Balanced and clear" },
  { id: "ash", label: "Ash", description: "Direct and steady" },
  { id: "ballad", label: "Ballad", description: "Expressive and smooth" },
  { id: "coral", label: "Coral", description: "Bright and conversational" },
  { id: "echo", label: "Echo", description: "Crisp and articulate" },
  { id: "sage", label: "Sage", description: "Measured and thoughtful" },
  { id: "shimmer", label: "Shimmer", description: "Light and upbeat" },
  { id: "verse", label: "Verse", description: "Polished and lively" },
]);
const customVoiceOption = Object.freeze({
  id: "custom",
  label: "Custom voice ID",
  description: "Use a licensed OpenAI custom voice ID, such as voice_1234.",
});
const realtimeVoiceOptions = Object.freeze([
  ...realtimeVoicePresets,
  ...realtimeBuiltInVoiceOptions,
  customVoiceOption,
]);
const realtimeBuiltInVoiceIds = new Set(realtimeBuiltInVoiceOptions.map((voice) => voice.id));
const realtimeVoiceIds = new Set(realtimeVoiceOptions.map((voice) => voice.id));

const defaultSettings = Object.freeze({
  voice: "jarvis",
  customVoiceId: "",
});

const windowModes = Object.freeze({
  orb: { width: 172, height: 188, placement: "bottom-right" },
  call: { width: 226, height: 52, placement: "bottom-center" },
  panel: { width: 440, height: 600, placement: "bottom-right" },
});

let mainWindow;
let windowMode = "panel";
let windowFadeTimer = null;
let windowFadeResolve = null;
let activeComputerUseController = null;
let mobileBridgeServer = null;
let mobileBridgeHost = "127.0.0.1";
let mobileDevServerProcess = null;
let mobileDevServerPort = null;
// User-chosen window position (set by dragging the panel), persisted across
// launches. Only the draggable main panel honors it; transient call/orb modes
// keep their anchored placement.
let userWindowPosition = null;
let suppressMoveSave = false;
let moveSaveTimer = null;
// Set while we resize the window ourselves, so the resize guard ignores it.
let suppressBoundsGuard = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: windowModes.panel.width,
    height: windowModes.panel.height,
    minWidth: windowModes.panel.width,
    minHeight: windowModes.panel.height,
    maxWidth: windowModes.panel.width,
    maxHeight: windowModes.panel.height,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  applyWindowBounds(getWindowBoundsForMode(windowModes.panel, "panel"));
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Persist the position whenever the user drags the panel so it is restored on
  // the next launch. Programmatic moves (mode switches) are suppressed.
  mainWindow.on("move", handleWindowMove);
  // macOS auto-resizes this frameless, transparent window during screen capture
  // (desktopCapturer.getSources), ignoring even maxSize — it stretched the
  // computer-use pill to ~84px. Snap any unexpected resize back to the mode size.
  mainWindow.on("resize", enforceModeBounds);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function handleWindowMove() {
  if (suppressMoveSave || windowMode !== "panel" || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (moveSaveTimer !== null) {
    clearTimeout(moveSaveTimer);
  }
  moveSaveTimer = setTimeout(() => {
    moveSaveTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const [x, y] = mainWindow.getPosition();
    userWindowPosition = { x, y };
    try {
      saveWindowPosition(userWindowPosition);
    } catch (error) {
      safeConsole("warn", "Failed to persist window position", error);
    }
  }, 400);
}

// Applies bounds without recording them as a user-initiated move or tripping the
// resize guard.
function applyWindowBounds(bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  suppressMoveSave = true;
  suppressBoundsGuard = true;
  mainWindow.setBounds(bounds, false);
  setImmediate(() => {
    suppressMoveSave = false;
    suppressBoundsGuard = false;
  });
}

// Reverts any externally-driven resize (e.g. macOS during screen capture) back
// to the current mode's exact size, keeping the window's current position.
function enforceModeBounds() {
  if (suppressBoundsGuard || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const expected = windowModes[windowMode];
  if (!expected) {
    return;
  }
  const bounds = mainWindow.getBounds();
  if (bounds.width === expected.width && bounds.height === expected.height) {
    return;
  }
  suppressBoundsGuard = true;
  mainWindow.setBounds(
    { x: bounds.x, y: bounds.y, width: expected.width, height: expected.height },
    false,
  );
  setImmediate(() => {
    suppressBoundsGuard = false;
  });
}

function clampToVisibleArea(x, y, width, height) {
  const display = screen.getDisplayMatching({ x, y, width, height }) ?? screen.getPrimaryDisplay();
  const area = display.workArea;
  const clampedX = Math.min(Math.max(x, area.x), area.x + area.width - width);
  const clampedY = Math.min(Math.max(y, area.y), area.y + area.height - height);
  return { x: Math.round(clampedX), y: Math.round(clampedY) };
}

async function setMainWindowMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return windowMode;
  }
  const target = windowModes[mode] ?? windowModes.orb;
  windowMode = windowModes[mode] ? mode : "orb";
  const targetBounds = getWindowBoundsForMode(target, windowMode);
  const currentBounds = mainWindow.getBounds();
  const sizeChanged =
    currentBounds.width !== targetBounds.width || currentBounds.height !== targetBounds.height;
  if (sizeChanged) {
    await fadeMainWindowTo(0, 110);
  }
  // Pin BOTH min and max to the mode size. This frameless, transparent window
  // is otherwise auto-grown by macOS during screen capture (it stretched the
  // computer-use pill to ~84px tall); locking max prevents any such resize.
  mainWindow.setMinimumSize(targetBounds.width, targetBounds.height);
  mainWindow.setMaximumSize(targetBounds.width, targetBounds.height);
  applyWindowBounds(targetBounds);
  if (sizeChanged) {
    await fadeMainWindowTo(1, 130);
  }
  return windowMode;
}

function getWindowBoundsForMode(target, mode) {
  // The main panel is the only draggable surface, so it restores the user's
  // saved position; call/orb keep their anchored placement.
  if (mode === "panel" && userWindowPosition) {
    const { x, y } = clampToVisibleArea(
      userWindowPosition.x,
      userWindowPosition.y,
      target.width,
      target.height,
    );
    return { x, y, width: target.width, height: target.height };
  }
  const display = screen.getPrimaryDisplay();
  const margin = target.placement === "bottom-center" ? 14 : 24;
  const x =
    target.placement === "bottom-center"
      ? Math.round(display.workArea.x + (display.workArea.width - target.width) / 2)
      : Math.round(display.workArea.x + display.workArea.width - target.width - margin);
  return {
    x,
    y: Math.round(display.workArea.y + display.workArea.height - target.height - margin),
    width: target.width,
    height: target.height,
  };
}

function endActiveFade() {
  if (windowFadeTimer !== null) {
    clearInterval(windowFadeTimer);
    windowFadeTimer = null;
  }
  // Resolve a superseded fade's promise so anything awaiting it (e.g. the
  // window:set-mode IPC handler) never hangs — a hung await leaves the IPC
  // reply unsent ("reply was never sent").
  if (windowFadeResolve !== null) {
    const resolvePrevious = windowFadeResolve;
    windowFadeResolve = null;
    resolvePrevious();
  }
}

function fadeMainWindowTo(targetOpacity, duration) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve();
  }
  endActiveFade();
  const startOpacity = mainWindow.getOpacity();
  const startedAt = Date.now();

  return new Promise((resolve) => {
    windowFadeResolve = resolve;
    windowFadeTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        endActiveFade();
        return;
      }
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      const opacity = startOpacity + (targetOpacity - startOpacity) * eased;
      mainWindow.setOpacity(Math.max(0.01, Math.min(1, opacity)));
      if (progress >= 1) {
        clearInterval(windowFadeTimer);
        windowFadeTimer = null;
        windowFadeResolve = null;
        mainWindow.setOpacity(targetOpacity);
        resolve();
      }
    }, 1000 / 60);
  });
}

function wireUpdateEvents() {
  autoUpdater.autoDownload = false;

  autoUpdater.on("checking-for-update", () => {
    mainWindow?.webContents.send("update:status", "Checking for updates…");
  });

  autoUpdater.on("update-available", () => {
    mainWindow?.webContents.send("update:status", "Update available. Downloading…");
    autoUpdater.downloadUpdate();
  });

  autoUpdater.on("update-not-available", () => {
    mainWindow?.webContents.send("update:status", "You are running the latest version.");
  });

  autoUpdater.on("error", (error) => {
    mainWindow?.webContents.send("update:status", `Update error: ${error.message}`);
  });

  autoUpdater.on("update-downloaded", () => {
    mainWindow?.webContents.send("update:status", "Update downloaded. It will install on restart.");
  });
}

ipcMain.handle("app:get-version", () => app.getVersion());
ipcMain.handle("update:check", async () => {
  if (isDevelopment) {
    return "Updates are checked only in packaged builds.";
  }

  await autoUpdater.checkForUpdates();
  return "Update check started.";
});

ipcMain.handle("openai:get-status", () => getOpenAIStatus());

ipcMain.handle("openai:login", async () => {
  const credentials = await loginOpenAI();
  return credentialsToStatus(credentials);
});

ipcMain.handle("openai:logout", async () => {
  await clearOpenAICredentials();
  return { connected: false };
});

ipcMain.handle("openai:create-realtime-secret", async (_event, options = {}) =>
  createRealtimeSecret(options),
);

ipcMain.handle("agent:get-profile", () => loadAgentProfile());
ipcMain.handle("agent:set-profile", (_event, profile) => saveAgentProfile(profile));
ipcMain.handle("memory:get-overview", () => getMemoryOverview());
ipcMain.handle("memory:delete-daily-log", (_event, id) => deleteDailyLog(id));
ipcMain.handle("audio:get-microphone", () => loadMicrophoneDeviceId());
ipcMain.handle("audio:set-microphone", (_event, deviceId) => saveMicrophoneDeviceId(deviceId));
ipcMain.handle("settings:get", async () => ({
  settings: await loadSettings(),
  voices: realtimeVoiceOptions,
}));
ipcMain.handle("settings:update", async (_event, updates = {}) => saveSettings(updates));

ipcMain.handle("planner:list-tasks", () => listTasks());
ipcMain.handle("planner:list-calendar", () => listCalendarItems());
ipcMain.handle("activity:list", (_event, kind) => listActivity(kind));
ipcMain.handle("screenshots:list", () => listScreenshots());
ipcMain.handle("screenshots:reveal", (_event, name) => revealScreenshot(name));
ipcMain.handle("window:set-mode", (_event, mode) => setMainWindowMode(mode));
ipcMain.handle("window:set-focusable", (_event, focusable) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  mainWindow.setFocusable(Boolean(focusable));
  return Boolean(focusable);
});
ipcMain.handle("window:minimize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  mainWindow.minimize();
  return true;
});
ipcMain.handle("app:quit", () => {
  app.quit();
  return true;
});
ipcMain.handle("permissions:get-status", async () => getOsPermissionStatus());
ipcMain.handle("permissions:request", async (_event, id) => requestOsPermission(id));
ipcMain.handle("permissions:open-settings", async (_event, id) => openOsPermissionSettings(id));
ipcMain.handle("diagnostics:get-log-path", () => getDiagnosticLogPath());
ipcMain.handle("diagnostics:open-log", async () => {
  await shell.openPath(getDiagnosticLogPath());
  return getDiagnosticLogPath();
});
ipcMain.handle("diagnostics:write", async (_event, event, details = {}) => {
  await writeDiagnosticLog(`renderer.${event}`, sanitizeDiagnosticValue(details));
  return { ok: true };
});
ipcMain.handle("diagnostics:privacy", async () => collectPrivacyDiagnostics());
ipcMain.handle("tools:get-definitions", () => getRealtimeToolDefinitions());
ipcMain.handle("tools:execute", async (_event, name, args = {}) => executeToolRequest(name, args));

ipcMain.handle("mobile:get-status", () => getMobileBridgeStatus());
ipcMain.handle("mobile:start-pairing", async () => {
  await restartMobileBridgeForPairing();
  await startMobileDevServer();
  createPairingSession();
  return getMobileBridgeStatus();
});
ipcMain.handle("mobile:get-pairing-qr", async () => createMobilePairingQrPayload());
ipcMain.handle("mobile:stop-pairing", () => {
  clearPairingSession();
  return getMobileBridgeStatus();
});
ipcMain.handle("mobile:list-devices", () => listMobileDevices(getDatabasePath()));
ipcMain.handle("mobile:delete-device", (_event, deviceId) => {
  deleteMobileDevice(deviceId, getDatabasePath());
  return getMobileBridgeStatus();
});

ipcMain.handle("tools:cancel-computer-use", () => cancelComputerUse());

async function getOpenAIStatus() {
  const credentials = await getFreshOpenAICredentials();
  return credentials ? credentialsToStatus(credentials) : { connected: false };
}

async function createRealtimeSecret(options = {}) {
  const credentials = await getFreshOpenAICredentials();
  if (!credentials) {
    throw new Error("Sign in to OpenAI before starting Realtime.");
  }
  const settings = await loadSettings();
  const realtimeSettings = resolveRealtimeSettings(settings);

  return createRealtimeClientSecret(credentials, {
    ...options,
    voice: realtimeSettings.voice,
    speed: realtimeSettings.speed,
    instructions: buildRealtimeInstructions({
      memoryContext: buildMemoryContext(),
      profile: loadAgentProfile(),
      voiceStyle: realtimeSettings.instructions,
    }),
  });
}

async function handleMobileAssistantMessage(message, history = []) {
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("Message is required.");
  }
  const credentials = await getFreshOpenAICredentials();
  if (!credentials) {
    throw new Error("Connect OpenAI on desktop before chatting from mobile.");
  }
  const startedAt = Date.now();
  await writeDiagnosticLog("mobile.assistant.start", {
    message: message.slice(0, 500),
  });
  try {
    const reply = await runMobileAssistantResponse(credentials, message.trim(), history);
    await writeDiagnosticLog("mobile.assistant.finish", {
      elapsedMs: Date.now() - startedAt,
      reply: reply.slice(0, 500),
    });
    return { reply };
  } catch (error) {
    await writeDiagnosticLog("mobile.assistant.error", {
      elapsedMs: Date.now() - startedAt,
      error: formatDiagnosticError(error),
    });
    throw error;
  }
}

async function executeToolRequest(name, args = {}) {
  if (typeof name !== "string" || !name.trim()) {
    return {
      status: "invalid_arguments",
      message: "Tool name must be a non-empty string.",
    };
  }
  const startedAt = Date.now();
  await writeDiagnosticLog("tool.execute.start", {
    tool: name,
    args: sanitizeDiagnosticValue(args),
    permissions: summarizePermissionSnapshot(await getOsPermissionStatus()),
  });
  const isComputerUse = name === "computer_use_task";
  const abortController = isComputerUse ? new AbortController() : null;
  if (abortController) {
    activeComputerUseController?.abort();
    activeComputerUseController = abortController;
  }
  try {
    const credentials = isComputerUse ? await getFreshOpenAICredentials() : null;
    const screenshotOptions = {
      desktopCapturer,
      nativeImage,
      screen,
      systemPreferences,
      userDataPath: app.getPath("userData"),
      logger: createToolLogger(name),
      ...(credentials ? { openAI: { accessToken: credentials.accessToken } } : {}),
    };
    const result = await executeRealtimeTool(name, args, {
      screenshot: screenshotOptions,
      computerUse: {
        ...(credentials
          ? {
              openAI: {
                accessToken: credentials.accessToken,
                accountId: credentials.accountId,
              },
            }
          : {}),
        originator: "ggcoder",
        logger: createToolLogger(name),
        desktopCapturer,
        nativeImage,
        screen,
        systemPreferences,
        ensureOsControlAllowed,
        signal: abortController?.signal,
      },
      session: {
        cancelComputerUse,
      },
      memory: {
        storePath: getDatabasePath(),
      },
      fileSystem: {
        rootPath: app.getPath("home"),
      },
    });
    await writeDiagnosticLog("tool.execute.finish", {
      tool: name,
      elapsedMs: Date.now() - startedAt,
      result: summarizeToolResult(result),
    });
    await recordToolActivity(name, args, result);
    broadcastDataChanged(categoryForTool(name));
    return result;
  } catch (error) {
    await writeDiagnosticLog("tool.execute.error", {
      tool: name,
      elapsedMs: Date.now() - startedAt,
      error: formatDiagnosticError(error),
    });
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Tool execution failed.",
    };
  } finally {
    if (abortController && activeComputerUseController === abortController) {
      activeComputerUseController = null;
    }
  }
}

function cancelComputerUse() {
  if (activeComputerUseController) {
    activeComputerUseController.abort();
    return { cancelled: true };
  }
  return { cancelled: false };
}

app.whenReady().then(async () => {
  initializeDataStore();
  await startMobileBridgeForSavedDevices();
  void startDiagnosticSession();
  wireUpdateEvents();
  createMainWindow();

  if (!isDevelopment) {
    autoUpdater.checkForUpdatesAndNotify();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      return;
    }
    // Reopening from the Dock should restore a minimized companion window.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
      mainWindow.restore();
      mainWindow.show();
    }
  });
});

app.on("before-quit", () => {
  clearPairingSession();
  stopMobileDevServer();
  void stopMobileBridge();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

async function startMobileBridge(host = "127.0.0.1") {
  if (mobileBridgeServer && mobileBridgeHost === host) {
    return mobileBridgeServer.getStatus();
  }
  if (mobileBridgeServer) {
    await stopMobileBridge();
  }
  mobileBridgeHost = host;
  mobileBridgeServer = createMobileBridgeServer({
    host,
    port: 19455,
    pairingStorePath: getDatabasePath(),
    handlers: {
      getOpenAIStatus,
      createRealtimeSecret,
      getRealtimeTools: getRealtimeToolDefinitions,
      executeRealtimeTool: executeToolRequest,
      sendAssistantMessage: handleMobileAssistantMessage,
    },
    logger: {
      info: (message, details) => safeConsole("info", message, details),
      warn: (message, details) => safeConsole("warn", message, details),
      error: (message, details) => safeConsole("error", message, details),
    },
  });
  try {
    return await mobileBridgeServer.start();
  } catch (error) {
    safeConsole("warn", "Failed to start mobile bridge", error);
    mobileBridgeServer = null;
    mobileBridgeHost = "127.0.0.1";
    return getMobileBridgeStatus();
  }
}

async function startMobileBridgeForSavedDevices() {
  const devices = listMobileDevices(getDatabasePath());
  const lanHost = devices.length > 0 ? getLanHostAddress() : null;
  return startMobileBridge(lanHost ?? "127.0.0.1");
}

async function restartMobileBridgeForPairing() {
  const lanHost = getLanHostAddress();
  return startMobileBridge(lanHost ?? "127.0.0.1");
}

async function startMobileDevServer() {
  if (mobileDevServerProcess && !mobileDevServerProcess.killed) {
    return;
  }
  const mobileProjectPath = path.join(__dirname, "..", "mobile", "brah-mobile");
  if (!existsSync(mobileProjectPath)) {
    safeConsole("warn", "Mobile project not found", { mobileProjectPath });
    mobileDevServerPort = null;
    return;
  }
  const port = await getAvailableMobileDevServerPort();
  mobileDevServerPort = port;
  mobileDevServerProcess = spawn(
    "npm",
    ["run", "start", "--", "--host", "lan", "--port", String(port)],
    {
      cwd: mobileProjectPath,
      stdio: "ignore",
      detached: false,
    },
  );
  mobileDevServerProcess.on("error", (error) => {
    mobileDevServerPort = null;
    safeConsole("warn", "Failed to start mobile dev server", error);
  });
  mobileDevServerProcess.on("exit", () => {
    mobileDevServerProcess = null;
    mobileDevServerPort = null;
  });
}

async function getAvailableMobileDevServerPort() {
  for (let port = 8081; port <= 8090; port += 1) {
    if (!(await isLocalPortOpen(port))) {
      return port;
    }
  }
  return 8081;
}

function isLocalPortOpen(port) {
  return new Promise((resolve) => {
    const request = http.request(
      { host: "127.0.0.1", port, method: "HEAD", timeout: 500 },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

function stopMobileDevServer() {
  if (!mobileDevServerProcess || mobileDevServerProcess.killed) {
    mobileDevServerPort = null;
    return;
  }
  mobileDevServerProcess.kill();
  mobileDevServerProcess = null;
  mobileDevServerPort = null;
}

async function stopMobileBridge() {
  if (!mobileBridgeServer) {
    return getMobileBridgeStatus();
  }
  const server = mobileBridgeServer;
  mobileBridgeServer = null;
  const status = await server.stop();
  mobileBridgeHost = "127.0.0.1";
  return status;
}

function getMobileBridgeStatus() {
  const status = mobileBridgeServer?.getStatus() ?? {
    running: false,
    host: mobileBridgeHost,
    port: 19455,
    pairing: formatPairingStatus(getPairingSession()),
    clients: 0,
  };
  const pairingPayload = createMobilePairingPayload(status);
  return {
    ...status,
    pairing: formatPairingStatus(getPairingSession()),
    pairingPayload,
    pairingDeepLink: createMobilePairingDeepLink(pairingPayload),
    expoUrl: createMobileExpoUrl(status.host, pairingPayload),
    mobileDevServerPort,
    lanHost: getLanHostAddress(),
    devices: listMobileDevices(getDatabasePath()),
  };
}

async function createMobilePairingQrPayload() {
  const status = getMobileBridgeStatus();
  const pairingPayload = status.pairingPayload;
  const pairingDeepLink = createMobilePairingDeepLink(pairingPayload);
  const qrDataUrl = pairingPayload
    ? await QRCode.toDataURL(JSON.stringify(pairingPayload), {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 256,
      })
    : null;
  const expoQrDataUrl = status.expoUrl
    ? await QRCode.toDataURL(status.expoUrl, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 256,
      })
    : null;
  return {
    pairingPayload,
    pairingDeepLink,
    pairingQrDataUrl: qrDataUrl,
    expoUrl: status.expoUrl,
    expoQrDataUrl,
  };
}

function createMobilePairingPayload(status) {
  const pairing = status?.pairing ?? formatPairingStatus(getPairingSession());
  if (!pairing.active || !pairing.code) {
    return null;
  }
  return {
    type: "brah.mobile.pairing",
    version: 1,
    host: status.host,
    port: status.port,
    pairingCode: pairing.code,
    expiresAt: pairing.expiresAt,
  };
}

function createMobilePairingDeepLink(pairingPayload) {
  if (!pairingPayload) {
    return null;
  }
  const params = new URLSearchParams({
    host: pairingPayload.host,
    port: String(pairingPayload.port),
    pairingCode: pairingPayload.pairingCode,
    expiresAt: String(pairingPayload.expiresAt),
  });
  return `brahmobile://pair?${params.toString()}`;
}

function createMobileExpoUrl(host, pairingPayload) {
  if (typeof host !== "string" || host === "127.0.0.1" || !mobileDevServerPort || !pairingPayload) {
    return null;
  }
  const params = new URLSearchParams({
    type: pairingPayload.type,
    version: String(pairingPayload.version),
    host: pairingPayload.host,
    port: String(pairingPayload.port),
    pairingCode: pairingPayload.pairingCode,
    expiresAt: String(pairingPayload.expiresAt),
    autoPair: "1",
  });
  return `exp://${host}:${mobileDevServerPort}/--/pair?${params.toString()}`;
}

function getLanHostAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address) {
        candidates.push(entry.address);
      }
    }
  }
  return candidates.find((address) => address.startsWith("192.168.")) ?? candidates[0] ?? null;
}

function formatPairingStatus(session) {
  return session
    ? {
        active: true,
        code: session.code,
        expiresAt: session.expiresAt,
      }
    : {
        active: false,
        code: null,
        expiresAt: null,
      };
}

function initializeDataStore() {
  setDatabaseUserDataPath(app.getPath("userData"));
  try {
    migrateLegacyPlannerStore();
    migrateLegacyActivityStore();
  } catch (error) {
    safeConsole("warn", "Legacy store migration failed", error);
  }
  try {
    userWindowPosition = loadWindowPosition();
  } catch (error) {
    safeConsole("warn", "Failed to load window position", error);
  }
}

function getDiagnosticLogPath() {
  return path.join(app.getPath("userData"), "diagnostics.log");
}

function broadcastDataChanged(category) {
  if (!category || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("data:changed", { category });
}

function categoryForTool(name) {
  switch (name) {
    case "remember":
    case "forget":
    case "list_facts":
    case "memory_search":
    case "daily_log":
    case "soul_set":
    case "soul_get":
    case "soul_list":
    case "soul_delete":
      return "memory";
    case "add_task":
    case "delete_task":
    case "update_task_status":
      return "tasks";
    case "add_calendar_item":
    case "delete_calendar_item":
      return "calendar";
    case "take_screenshot":
    case "analyze_screen":
      return "screenshots";
    case "web_search":
    case "web_fetch":
      return "web";
    case "computer_use_task":
      return "computer";
    default:
      return null;
  }
}

async function recordToolActivity(name, args, result) {
  if (!isRecord(result)) {
    return;
  }
  try {
    if (name === "web_search") {
      await recordActivity({
        kind: "web_search",
        query: typeof result.query === "string" ? result.query : args?.query,
        resultCount: result.resultCount,
        results: result.results,
      });
      return;
    }
    if (name === "web_fetch") {
      await recordActivity({
        kind: "web_fetch",
        url: result.url ?? args?.url,
        title: result.title,
        text: result.text,
      });
      return;
    }
    if (name === "computer_use_task") {
      await recordActivity({
        kind: "computer_use",
        task: typeof args?.task === "string" ? args.task : "",
        statusText: result.status,
        steps: result.steps,
        finalText: result.finalText,
      });
    }
  } catch (error) {
    console.warn("Failed to record activity", error);
  }
}

async function listScreenshots() {
  const screenshotsDir = path.join(app.getPath("userData"), "screenshots");
  let names;
  try {
    names = await fs.readdir(screenshotsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const pngNames = names.filter((name) => name.toLowerCase().endsWith(".png"));
  const entries = await Promise.all(
    pngNames.map(async (name) => {
      const filePath = path.join(screenshotsDir, name);
      try {
        const [stats, bytes] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
        return {
          name,
          dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
          createdAt: stats.mtimeMs,
        };
      } catch {
        return null;
      }
    }),
  );
  return entries
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30);
}

async function revealScreenshot(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..")
  ) {
    throw new Error("Invalid screenshot name.");
  }
  const screenshotsDir = path.join(app.getPath("userData"), "screenshots");
  const filePath = path.join(screenshotsDir, name);
  if (path.dirname(filePath) !== screenshotsDir) {
    throw new Error("Invalid screenshot path.");
  }
  shell.showItemInFolder(filePath);
  return { revealed: true };
}

const MAX_DIAGNOSTIC_LOG_BYTES = 1_000_000;

async function writeDiagnosticLog(event, details = {}) {
  // Per-line entries stay lean (time/event/details) so the log is easy to read
  // and copy-paste; the static environment context lives in the session.start
  // header written once per launch.
  const entry = { time: new Date().toISOString(), event, details };
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await fs.mkdir(path.dirname(getDiagnosticLogPath()), { recursive: true });
    await fs.appendFile(getDiagnosticLogPath(), line);
  } catch (error) {
    safeConsole("error", "diagnostic log write failed", error);
  }
  safeConsole("info", "diagnostic", event, details);
}

// Rotates the log when it grows large and writes a session header so every run
// in the log is self-describing (app version, platform, displays).
async function startDiagnosticSession() {
  const logPath = getDiagnosticLogPath();
  try {
    const stats = await fs.stat(logPath);
    if (stats.size > MAX_DIAGNOSTIC_LOG_BYTES) {
      await fs.rename(logPath, `${logPath}.prev`);
    }
  } catch {
    // No existing log to rotate.
  }
  const primary = screen.getPrimaryDisplay();
  await writeDiagnosticLog("session.start", {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform} ${process.arch}`,
    osRelease: os.release(),
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    displayCount: screen.getAllDisplays().length,
    primaryWorkArea: primary.workArea,
  });
}

function safeConsole(level, ...args) {
  try {
    console[level](...args);
  } catch (error) {
    if (error?.code !== "EPIPE" && error?.code !== "ERR_STREAM_DESTROYED") {
      throw error;
    }
  }
}

function createToolLogger(tool) {
  return async (event, details = {}) => {
    await writeDiagnosticLog(event, { tool, ...details });
  };
}

function summarizePermissionSnapshot(permissions) {
  return Object.fromEntries(permissions.map((permission) => [permission.id, permission.status]));
}

function summarizeToolResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const summary = {
    status: result.status,
    message: typeof result.message === "string" ? result.message.slice(0, 500) : undefined,
    path: result.path,
    dimensions: result.dimensions,
    source: result.source,
    resultCount: result.resultCount,
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

function sanitizeDiagnosticValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeDiagnosticValue);
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value.slice(0, 500) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key.toLowerCase().includes("token") ? "[redacted]" : sanitizeDiagnosticValue(item),
    ]),
  );
}

function formatDiagnosticError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

async function collectPrivacyDiagnostics() {
  const diagnostics = {
    appPath: app.getAppPath(),
    executablePath: app.getPath("exe"),
    isPackaged: app.isPackaged,
    bundleIdentifier: app.getApplicationNameForProtocol("file") || null,
    statuses: Object.fromEntries(
      (await getOsPermissionStatus()).map((permission) => [permission.id, permission.status]),
    ),
    tccRows: process.platform === "darwin" ? await readMacOsTccRows() : [],
  };
  await writeDiagnosticLog("privacy.diagnostics", diagnostics);
  return diagnostics;
}

async function readMacOsTccRows() {
  const dbPath = "/Library/Application Support/com.apple.TCC/TCC.db";
  try {
    const { stdout } = await execFileAsync("sqlite3", [
      dbPath,
      "select service,client,client_type,auth_value,auth_reason,flags,last_modified from access where client like '%brah%' or client like '%Brah%' or client='com.unstablemind.brah' order by service,client;",
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [service, client, clientType, authValue, authReason, flags, lastModified] =
          line.split("|");
        return { service, client, clientType, authValue, authReason, flags, lastModified };
      });
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }];
  }
}

async function getOsPermissionStatus() {
  return createOsPermissionSnapshot({
    microphone: getMediaAccessStatus("microphone"),
    screen: getMediaAccessStatus("screen"),
    accessibility: getAccessibilityStatus(),
    computer: await getComputerUseBrowserStatus(),
  });
}

async function requestOsPermission(id) {
  if (!isKnownOsPermissionId(id)) {
    throw new Error("Unknown OS permission.");
  }
  if (id === "microphone") {
    if (process.platform === "darwin") {
      await systemPreferences.askForMediaAccess("microphone");
    } else if (process.platform === "win32") {
      await openOsPermissionSettings("microphone");
    }
    return getOsPermissionStatus();
  }
  if (id === "screen") {
    await requestScreenRecordingAccess();
    return getOsPermissionStatus();
  }
  if (id === "accessibility" && process.platform === "darwin") {
    systemPreferences.isTrustedAccessibilityClient(true);
    return getOsPermissionStatus();
  }
  if (id === "computer") {
    await installComputerUseBrowser();
    return getOsPermissionStatus();
  }
  await openOsPermissionSettings(id);
  return getOsPermissionStatus();
}

async function openOsPermissionSettings(id) {
  if (!isKnownOsPermissionId(id)) {
    throw new Error("Unknown OS permission.");
  }
  if (id === "computer") {
    await shell.openExternal(computerUseBrowserDocsUrl);
    return { opened: true };
  }
  if (process.platform === "darwin") {
    await shell.openExternal(getMacOsPrivacySettingsUrl(id));
    return { opened: true };
  }
  if (process.platform === "win32") {
    await shell.openExternal(getWindowsPrivacySettingsUrl(id));
    return { opened: true };
  }
  return { opened: false, message: "Open your system privacy settings manually." };
}

async function requestScreenRecordingAccess() {
  try {
    await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
  } catch {
    // The status check below reports the meaningful permission state.
  }
  if (process.platform === "darwin" && getMediaAccessStatus("screen") !== "granted") {
    await openOsPermissionSettings("screen");
  }
}

function getMediaAccessStatus(mediaType) {
  try {
    return systemPreferences.getMediaAccessStatus(mediaType);
  } catch {
    return process.platform === "linux" ? "unsupported" : "unknown";
  }
}

function ensureOsControlAllowed() {
  // OS-level mouse/keyboard control only requires platform privacy grants on macOS.
  // Windows (and other platforms) drive nut-js without Screen Recording or Accessibility grants.
  if (process.platform !== "darwin") {
    return { ok: true };
  }
  const screenGranted = getMediaAccessStatus("screen") === "granted";
  const accessibilityGranted = getAccessibilityStatus() === "granted";
  if (screenGranted && accessibilityGranted) {
    return { ok: true };
  }
  const missing = [
    screenGranted ? "" : "Screen Recording",
    accessibilityGranted ? "" : "Accessibility Control",
  ].filter(Boolean);
  return {
    ok: false,
    message: `Grant ${missing.join(" and ")} in the permissions screen before controlling the computer.`,
  };
}

function getAccessibilityStatus() {
  if (process.platform !== "darwin") {
    return "unsupported";
  }
  return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "not-determined";
}

async function getComputerUseBrowserStatus() {
  try {
    const { chromium } = await import("playwright");
    const executablePath = chromium.executablePath();
    return executablePath && existsSync(executablePath) ? "granted" : "not-determined";
  } catch {
    return "unknown";
  }
}

async function installComputerUseBrowser() {
  let cliPath;
  try {
    cliPath = require.resolve("playwright/cli.js");
  } catch {
    throw new Error("Playwright is not installed. Run `npm install` then retry.");
  }
  try {
    await execFileAsync(process.execPath, [cliPath, "install", "chromium"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : String(error);
    throw new Error(`Failed to install the automation browser: ${detail}`);
  }
}

async function loginOpenAI() {
  const redirectUri = createOpenAIRedirectUri();
  const verifier = createPkceVerifier();
  const challenge = createPkceChallenge(verifier);
  const state = randomBytes(24).toString("base64url");
  const callbackServer = await startOAuthCallbackServer({ state });
  const authUrl = new URL(openAIAuthConfig.authorizeUrl);
  authUrl.searchParams.set("client_id", openAIAuthConfig.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", openAIAuthConfig.scope);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("id_token_add_organizations", "true");
  authUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authUrl.searchParams.set("originator", "ggcoder");

  try {
    await shell.openExternal(authUrl.toString());
    const callback = await callbackServer.waitForCallback;
    if (callback.error) {
      throw new Error(`OpenAI login failed: ${callback.error}`);
    }
    if (!callback.code) {
      throw new Error("OpenAI login did not return an authorization code.");
    }

    const credentials = await exchangeOpenAICode({
      code: callback.code,
      codeVerifier: verifier,
      redirectUri,
    });
    await saveOpenAICredentials(credentials);
    return credentials;
  } finally {
    callbackServer.close();
  }
}

function createOpenAIRedirectUri() {
  return `http://localhost:${openAIAuthConfig.redirectPort}${openAIAuthConfig.redirectPath}`;
}

function createPkceVerifier() {
  return randomBytes(48).toString("base64url");
}

function createPkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function startOAuthCallbackServer({ state }) {
  let server;
  let timeout;
  let resolveCallback;
  let rejectCallback;
  const waitForCallback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  await new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      try {
        const callback = parseOAuthCallbackRequest(request.url ?? "/");
        const responseBody = callback.error
          ? "<html><body><h1>OpenAI login failed</h1><p>You can close this tab.</p></body></html>"
          : "<html><body><h1>OpenAI login complete</h1><p>You can return to Brah.</p></body></html>";
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(responseBody),
          Connection: "close",
        });
        response.end(responseBody);
        if (callback.state !== state) {
          rejectCallback(new Error("OpenAI login state mismatch."));
          return;
        }
        resolveCallback(callback);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Invalid OpenAI login callback.");
        rejectCallback(error);
      }
    });

    server.once("error", reject);
    server.listen(openAIAuthConfig.redirectPort, "127.0.0.1", () => {
      server.off("error", reject);
      timeout = setTimeout(() => {
        rejectCallback(new Error("OpenAI login callback timed out."));
        server.close();
      }, 120_000);
      resolve();
    });
  });

  return {
    waitForCallback,
    close() {
      clearTimeout(timeout);
      server?.close();
    },
  };
}

function parseOAuthCallbackRequest(rawUrl) {
  const url = new URL(rawUrl, createOpenAIRedirectUri());
  if (url.pathname !== openAIAuthConfig.redirectPath) {
    throw new Error(`Unexpected OpenAI OAuth callback path: ${url.pathname}`);
  }

  return {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    error: url.searchParams.get("error") ?? undefined,
  };
}

async function exchangeOpenAICode({ code, codeVerifier, redirectUri }) {
  return tokenJsonToCredentials(
    await postOpenAIForm(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: openAIAuthConfig.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
      "OpenAI token exchange",
    ),
  );
}

async function refreshOpenAICredentials(credentials) {
  const refreshed = tokenJsonToCredentials(
    await postOpenAIForm(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: openAIAuthConfig.clientId,
      }),
      "OpenAI token refresh",
    ),
    credentials.refreshToken,
  );
  await saveOpenAICredentials(refreshed);
  return refreshed;
}

async function postOpenAIForm(body, label) {
  const response = await fetch(openAIAuthConfig.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return parseJsonResponse(response, label);
}

async function runMobileAssistantResponse(credentials, message, history = []) {
  const clientSecret = await createRealtimeClientSecret(credentials, {
    instructions: buildMobileAssistantInstructions(),
  });
  const session = createMobileRealtimeSession(clientSecret);
  try {
    await session.connect();
    await session.update({
      instructions: buildMobileAssistantInstructions(),
      tools: getRealtimeToolDefinitions().filter((tool) => tool.name !== "end_call"),
      tool_choice: "auto",
      output_modalities: ["text"],
    });
    const input = [
      ...normalizeMobileAssistantHistory(history),
      createMobileAssistantUserMessage(message),
    ];

    for (let round = 0; round < mobileAssistantDefaults.maxToolRounds; round += 1) {
      const response = await session.createTextResponse(input);
      const calls = getRealtimeFunctionCalls(response);
      if (calls.length === 0) {
        return extractRealtimeResponseText(response) || "Done.";
      }
      for (const call of calls) {
        const result = await executeMobileAssistantTool(call);
        await session.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result),
          },
        });
      }
      input.length = 0;
    }

    return "I ran several tool steps, but need you to narrow that down before I continue.";
  } finally {
    session.close();
  }
}

function createMobileRealtimeSession(clientSecret) {
  const socket = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeDefaults.model)}`,
    {
      headers: {
        Authorization: `Bearer ${clientSecret.value}`,
      },
      perMessageDeflate: false,
    },
  );
  const pendingResponses = [];
  let pendingSessionUpdate = null;
  let connected = false;
  let closed = false;

  socket.on("message", (data) => {
    let event;
    try {
      event = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    handleMobileRealtimeEvent(event);
  });
  socket.on("error", (error) => {
    rejectPendingMobileRealtime(error);
  });
  socket.on("close", () => {
    closed = true;
    rejectPendingMobileRealtime(new Error("Realtime session closed."));
  });

  function handleMobileRealtimeEvent(event) {
    if (event?.type === "session.updated" && pendingSessionUpdate) {
      pendingSessionUpdate.resolve(event.session);
      pendingSessionUpdate = null;
      return;
    }
    if (event?.type === "response.done") {
      const pending = pendingResponses.shift();
      pending?.resolve(event.response);
      return;
    }
    if (event?.type === "error") {
      const error = new Error(event.error?.message || "Realtime session error.");
      if (event.error?.code) {
        error.code = event.error.code;
      }
      rejectPendingMobileRealtime(error);
    }
  }

  function rejectPendingMobileRealtime(error) {
    if (pendingSessionUpdate) {
      pendingSessionUpdate.reject(error);
      pendingSessionUpdate = null;
    }
    while (pendingResponses.length > 0) {
      pendingResponses.shift().reject(error);
    }
  }

  function sendEvent(event) {
    if (closed || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime session is not connected.");
    }
    socket.send(JSON.stringify(event));
  }

  return {
    async connect() {
      if (connected) {
        return;
      }
      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error("Realtime session connection timed out."));
          socket.close();
        }, 15_000);
        socket.once("open", () => {
          clearTimeout(timeoutId);
          connected = true;
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
      });
    },
    update(sessionUpdate) {
      if (pendingSessionUpdate) {
        throw new Error("Realtime session update already pending.");
      }
      return new Promise((resolve, reject) => {
        pendingSessionUpdate = { resolve, reject };
        sendEvent({
          type: "session.update",
          session: {
            type: "realtime",
            ...sessionUpdate,
          },
        });
      });
    },
    createTextResponse(input = []) {
      for (const item of input) {
        sendEvent({ type: "conversation.item.create", item });
      }
      return new Promise((resolve, reject) => {
        pendingResponses.push({ resolve, reject });
        sendEvent({
          type: "response.create",
          response: {
            output_modalities: ["text"],
          },
        });
      });
    },
    sendEvent(event) {
      sendEvent(event);
    },
    close() {
      socket.close();
    },
  };
}

async function executeMobileAssistantTool(call) {
  const toolName = typeof call.name === "string" ? call.name : "";
  if (!toolName || toolName === "end_call") {
    return { status: "refused", message: "That tool is not available from mobile chat." };
  }
  let args = {};
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return { status: "invalid_arguments", message: "Tool arguments were not valid JSON." };
  }
  return executeToolRequest(toolName, args);
}

function buildMobileAssistantInstructions() {
  return buildRealtimeInstructions({
    memoryContext: buildMemoryContext(),
    profile: loadAgentProfile(),
    voiceStyle:
      "You are being used from Greg's phone in text chat. Reply in concise mobile-friendly text. Use tools when useful. Do not call end_call.",
  });
}

function normalizeMobileAssistantHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter((item) => item?.role === "user" || item?.role === "assistant")
    .map((item) => createMobileAssistantMessage(item.role, item.text))
    .filter(Boolean)
    .slice(-12);
}

function createMobileAssistantUserMessage(message) {
  return createMobileAssistantMessage("user", message);
}

function createMobileAssistantMessage(role, text) {
  const trimmed = String(text ?? "")
    .trim()
    .slice(0, 2000);
  if (!trimmed) {
    return null;
  }
  return {
    type: "message",
    role,
    content: [
      {
        type: role === "assistant" ? "output_text" : "input_text",
        text: trimmed,
      },
    ],
  };
}

function getRealtimeFunctionCalls(response) {
  return (Array.isArray(response?.output) ? response.output : []).filter(
    (item) => item?.type === "function_call" && item.status !== "incomplete",
  );
}

function extractRealtimeResponseText(response) {
  const chunks = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") {
        chunks.push(content.text);
      } else if (typeof content?.transcript === "string") {
        chunks.push(content.transcript);
      }
    }
  }
  return chunks.join("\n").trim();
}

async function createRealtimeClientSecret(credentials, options) {
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ session: buildRealtimeSessionConfig(options) }),
  });
  const raw = await parseJsonResponse(response, "Realtime client secret request");
  const value = typeof raw.value === "string" ? raw.value : undefined;
  if (!value) {
    throw new Error("Realtime client secret response did not include a value.");
  }

  return {
    value,
    expiresAt: parseExpiresAt(raw.expires_at),
    raw,
  };
}

function buildRealtimeSessionConfig(options) {
  const model = typeof options.model === "string" ? options.model : realtimeDefaults.model;
  const voice = normalizeRealtimeVoice(options.voice);
  const speed = normalizeRealtimeSpeed(options.speed);
  const instructions =
    typeof options.instructions === "string" && options.instructions.trim()
      ? options.instructions.trim()
      : buildRealtimeInstructions({ memoryContext: buildMemoryContext() });

  return {
    type: "realtime",
    model,
    instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: realtimeDefaults.sampleRate },
        noise_reduction: { type: "near_field" },
        transcription: { model: "gpt-4o-transcribe" },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "high",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        format: { type: "audio/pcm", rate: realtimeDefaults.sampleRate },
        voice,
        speed,
      },
    },
    max_output_tokens: 4096,
    reasoning: { effort: "minimal" },
    tools: getRealtimeToolDefinitions(),
    tool_choice: "auto",
    tracing: "auto",
  };
}

function normalizeRealtimeVoice(value) {
  if (typeof value !== "string") {
    return realtimeDefaults.voice;
  }
  const trimmed = value.trim();
  if (realtimeBuiltInVoiceIds.has(trimmed) || /^voice_[a-zA-Z0-9_-]{3,120}$/.test(trimmed)) {
    return trimmed;
  }
  return realtimeDefaults.voice;
}

function normalizeRealtimeSpeed(value) {
  return typeof value === "number" && value >= 0.25 && value <= 1.5
    ? value
    : realtimeDefaults.speed;
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...defaultSettings };
  }
}

async function saveSettings(updates) {
  const settings = normalizeSettings({
    ...(await loadSettings()),
    ...(isRecord(updates) ? updates : {}),
  });
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settings;
}

function normalizeSettings(value) {
  const voice =
    isRecord(value) && realtimeVoiceIds.has(value.voice) ? value.voice : defaultSettings.voice;
  const customVoiceId =
    isRecord(value) && typeof value.customVoiceId === "string"
      ? normalizeCustomVoiceId(value.customVoiceId)
      : defaultSettings.customVoiceId;
  return { voice, customVoiceId };
}

function resolveRealtimeSettings(settings) {
  if (settings.voice === customVoiceOption.id) {
    return settings.customVoiceId
      ? {
          voice: settings.customVoiceId,
          speed: realtimeDefaults.speed,
          instructions: "",
        }
      : resolveRealtimeSettings(defaultSettings);
  }
  const preset = realtimeVoicePresets.find((voice) => voice.id === settings.voice);
  if (preset) {
    return {
      voice: preset.voice,
      speed: preset.speed,
      instructions: preset.instructions,
    };
  }
  if (realtimeBuiltInVoiceIds.has(settings.voice)) {
    return {
      voice: settings.voice,
      speed: realtimeDefaults.speed,
      instructions: "",
    };
  }
  return {
    voice: realtimeDefaults.voice,
    speed: realtimeDefaults.speed,
    instructions: "",
  };
}

function normalizeCustomVoiceId(value) {
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_-]{3,120}$/.test(trimmed) ? trimmed : "";
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function getFreshOpenAICredentials() {
  const credentials = await loadOpenAICredentials();
  if (!credentials) {
    return null;
  }
  const refreshMarginMs = 5 * 60 * 1000;
  if (credentials.expiresAt - refreshMarginMs > Date.now()) {
    return credentials;
  }
  return refreshOpenAICredentials(credentials);
}

async function loadOpenAICredentials() {
  try {
    const raw = await fs.readFile(credentialsPath(), "utf8");
    const payload = JSON.parse(raw);
    const serialized = typeof payload.data === "string" ? payload.data : undefined;
    if (!serialized) {
      return null;
    }
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(serialized, "base64"))
      : Buffer.from(serialized, "base64").toString("utf8");
    return parseCredentials(JSON.parse(json));
  } catch {
    return null;
  }
}

async function saveOpenAICredentials(credentials) {
  await fs.mkdir(path.dirname(credentialsPath()), { recursive: true });
  const json = JSON.stringify(credentials);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json).toString("base64")
    : Buffer.from(json, "utf8").toString("base64");
  await fs.writeFile(credentialsPath(), JSON.stringify({ data }, null, 2), { mode: 0o600 });
}

async function clearOpenAICredentials() {
  await fs.rm(credentialsPath(), { force: true });
}

function credentialsPath() {
  return path.join(app.getPath("userData"), "openai-credentials.json");
}

function tokenJsonToCredentials(response, fallbackRefreshToken) {
  if (!isRecord(response)) {
    throw new Error("OpenAI token response was not an object.");
  }
  if (typeof response.access_token !== "string") {
    throw new Error("OpenAI token response did not include an access token.");
  }
  const refreshToken = response.refresh_token ?? fallbackRefreshToken;
  if (typeof refreshToken !== "string") {
    throw new Error("OpenAI token response did not include a refresh token.");
  }
  if (typeof response.expires_in !== "number") {
    throw new Error("OpenAI token response did not include expires_in.");
  }
  const credentials = {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Date.now() + response.expires_in * 1000,
  };
  const accountId = getAccountId(response.access_token);
  return accountId ? { ...credentials, accountId } : credentials;
}

function parseCredentials(value) {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    return null;
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    ...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
  };
}

function credentialsToStatus(credentials) {
  return {
    connected: true,
    expiresAt: credentials.expiresAt,
    accountId: credentials.accountId ?? null,
  };
}

function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = isRecord(payload?.["https://api.openai.com/auth"])
    ? payload["https://api.openai.com/auth"]
    : null;
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

function decodeJwt(token) {
  try {
    const parts = token.split(".");
    const payload = parts[1];
    if (parts.length !== 3 || !payload) {
      return null;
    }
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function parseExpiresAt(value) {
  if (typeof value !== "number") {
    return undefined;
  }
  return value > 10_000_000_000 ? value : value * 1000;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
