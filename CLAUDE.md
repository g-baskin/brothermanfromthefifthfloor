# Brah

Electron desktop voice assistant with a paired Expo mobile client. The desktop owns OpenAI OAuth/Realtime sessions, local memory/planner storage, screenshots, computer-use tools, and the local mobile WebSocket bridge.

## Key packages/apps/modules

- Root package `brah` (`package.json`) is an ESM Electron app; entry point is `src/main.js`.
- `mobile/brah-mobile/` is a separate npm package for the Expo dev-client app; entry point is `expo/AppEntry.js` loading `App.js`.
- `src/main.js` coordinates Electron windows, IPC handlers, OpenAI OAuth/realtime secret creation, tool execution, diagnostics, auto-update, and mobile bridge startup.
- `src/preload.js` exposes the context-isolated `window.brah` API; renderer-to-main calls use `ipcRenderer.invoke` channels.
- `src/renderer/` contains the desktop UI plus shared realtime helpers (`realtime-playback.js`, `realtime-response-queue.js`) that are also imported by `src/main.js`.
- `src/realtime/prompts.js` builds realtime session instructions; `src/realtime/tool-permissions.js` defines per-tool permission metadata.
- `src/realtime/tools/` contains tool schemas, dispatch, implementations, and local stores for memory, planner, web, filesystem, screenshots, computer-use, session, microphone, activity, and window state.
- `src/mobile/` contains the desktop-side bridge: WebSocket routing (`bridge-server.js`), message normalization (`message-protocol.js`), and pairing/device persistence (`pairing-store.js`).
- `test/` contains `node --test` suites that mirror the stores/tools/mobile bridge/renderer realtime helper modules.

## Project-specific architecture notes

- Realtime tool dispatch is centralized in `src/realtime/tools/index.js`; tools are exposed from `tool-schemas.js` and then handled by one of the executor modules in dispatch order.
- Planner, memory, activity, profile, microphone, pairing, and window-state data persist through store modules under `src/realtime/tools/` and `src/mobile/`; SQLite setup lives in `src/realtime/tools/database.js` and is pointed at Electron `userData` by `src/main.js`.
- Computer use has two targets: Playwright browser mode (`computer-use-browser.js`) and OS mode through `@nut-tree-fork/nut-js` (`computer-use-os.js`).
- OpenAI credentials are handled by desktop OAuth in `src/main.js`; tokens are encrypted with Electron `safeStorage`. The mobile app is a paired client and does not own OpenAI credentials.
- Mobile pairing uses a local WebSocket bridge on default port `19455`; the Expo app stores paired device credentials with `expo-secure-store` and sends authenticated bridge messages after pairing.
- Mobile voice supports one-shot turns, streamed PCM turns, and long-lived realtime conversations via `voice.conversation.*` bridge messages.
- Electron window modes are `orb`, `call`, and `panel`; mode switching goes through the `window:set-mode` IPC channel.

## Commands

Root package:

- `npm start` — run the Electron app (`electron .`).
- `npm run check` — Biome format/lint check.
- `npm run format` — Biome format write.
- `npm run lint` — Biome lint only.
- `npm test` — `npm run check && node --test`.
- `npm run build:mac` — `electron-builder --mac dir`.
- `npm run open:mac` — build mac dir target then open `dist/mac-arm64/Brah.app`.
- `npm run update:deps` — `ncu -u && npm install`.

Mobile package delegates from root:

- `npm run mobile:install` — install mobile dependencies with `npm install --prefix mobile/brah-mobile`.
- `npm run mobile:start` — start Expo dev-client Metro with LAN host.
- `npm run mobile:android` / `npm run mobile:dev-client` — run Expo Android dev client on a device.

Mobile package direct scripts:

- `npm run start --prefix mobile/brah-mobile` — `expo start --dev-client --host lan`.
- `npm run android --prefix mobile/brah-mobile` — `expo run:android --device`.
- `npm run android:metro --prefix mobile/brah-mobile` — `expo start --dev-client --host lan --android`.
- `npm run eas:android --prefix mobile/brah-mobile` — EAS development APK build.
- `npm run ios --prefix mobile/brah-mobile` — `expo run:ios`.
- `npm run web --prefix mobile/brah-mobile` — `expo start --web`.

## Build/config constraints

- Root uses npm (`package-lock.json`) and ESM (`"type": "module"`); the mobile app is a separate npm package with its own lockfile and `node >=20` engine.
- Biome is the root formatter/linter; `biome.json` includes all files except `node_modules`, `dist`, `out`, and `release`.
- Electron Builder packages only `src/**/*` and `package.json`; macOS target is `dir` with hardened runtime and entitlements in `build/`.
- `@nut-tree-fork/**` must remain in `asarUnpack` because it ships native code.
- Expo app config uses scheme `brahmobile`, Android package `com.unstablemind.brahmobile`, permissions `INTERNET`, `CAMERA`, and `RECORD_AUDIO`, and default bridge port `19455`.
