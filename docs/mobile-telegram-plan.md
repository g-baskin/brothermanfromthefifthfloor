# Brah Mobile + Telegram Surgical Plan

Owner identity: Greg.

## Goal

Make Brah usable away from the desktop in two ways:

1. **Telegram fallback** — text and voice-note chat through Telegram, routed to desktop Brah.
2. **Real mobile app** — iPhone/Android app that feels like sitting at the computer: live microphone, live assistant audio, and access to desktop Brah tools through a secure bridge.

## Ground Rules

- Desktop Brah remains the trusted tool box: filesystem, screenshots, OS/computer control, tasks, calendar, memory, and OpenAI OAuth tokens stay on the desktop.
- Mobile clients never receive long-lived OpenAI access tokens or refresh tokens.
- Mobile clients may receive only short-lived Realtime client secrets.
- Remote tool calls require pairing and an allowlist.
- Sensitive desktop actions still require confirmation.
- Build local-first before cloud relay.

## Phase 0 — Rename Brah for Greg

Status: started.

### Files

- `src/realtime/prompts.js`
- `src/realtime/tool-permissions.js`
- tests that assert the old default name/message

### Work

- Change default profile name from `Ken` to `Greg`.
- Change system instructions from Ken-specific wording to Greg-specific wording.
- Change permission-denied messages from Ken to Greg.
- Update tests.

### Verify

```bash
npm run check
npm test
```

## Phase 1 — Desktop Remote Bridge, Local Wi-Fi

### Purpose

Let a paired phone talk to the running desktop Brah over the same Wi-Fi network.

### Architecture

Desktop Brah starts a local WebSocket server bound to `127.0.0.1` by default, then optionally LAN IP after Greg enables mobile pairing.

Mobile connects to:

```text
ws://<desktop-lan-ip>:<pairing-port>/mobile
```

### Pairing

Desktop shows a QR code containing:

```json
{
  "host": "192.168.x.x",
  "port": 19455,
  "pairingCode": "6-digit-code",
  "deviceName": "Greg's Mac"
}
```

Mobile scans it, sends:

```json
{
  "type": "pair.request",
  "deviceName": "Greg's iPhone",
  "pairingCode": "123456"
}
```

Desktop returns a device token:

```json
{
  "type": "pair.accepted",
  "deviceId": "device_...",
  "deviceToken": "secret_..."
}
```

Desktop stores paired devices in SQLite.

### Bridge Message Types

Mobile to desktop:

```json
{ "type": "auth", "deviceId": "...", "deviceToken": "..." }
{ "type": "openai.status.get" }
{ "type": "openai.login.start" }
{ "type": "realtime.secret.create", "requestId": "..." }
{ "type": "tools.definitions.get", "requestId": "..." }
{ "type": "tools.execute", "requestId": "...", "name": "take_screenshot", "args": {} }
```

Desktop to mobile:

```json
{ "type": "auth.ok" }
{ "type": "openai.status", "connected": true }
{ "type": "realtime.secret", "requestId": "...", "value": "ephemeral_...", "expiresAt": 123 }
{ "type": "tools.result", "requestId": "...", "result": {} }
{ "type": "error", "requestId": "...", "message": "..." }
```

### Files to Add

- `src/mobile/pairing-store.js` — SQLite storage for paired devices.
- `src/mobile/bridge-server.js` — WebSocket server, auth, request routing.
- `src/mobile/message-protocol.js` — message validation and safe serializers.

### Files to Edit

- `package.json` — add `ws` dependency.
- `src/realtime/tools/database.js` — add `mobile_devices` table.
- `src/main.js` — start/stop bridge server; route bridge requests to existing OpenAI/tool handlers.
- `src/preload.js` — expose pairing controls for UI.
- `src/renderer/*` — simple pairing UI panel.

### Verify

- Unit test pairing store.
- Unit test protocol validation.
- Manual local WebSocket connect and auth.

## Phase 2 — Mobile App Prototype

### Purpose

Create a minimal iPhone/Android app that can pair with desktop Brah and exchange bridge messages.

### Recommended Stack

Use **React Native + Expo** first because it ships quickly to iOS and Android.

### Mobile App Screens

1. Pair screen — scan QR or enter host/code manually.
2. Status screen — connected desktop, OpenAI connected status.
3. Call screen — microphone button, speaker output, transcript/status log.
4. Tool activity sheet — shows when desktop tool is running.

### Mobile App Files

Create a sibling app, not inside Electron renderer:

```text
mobile/
  app.json
  package.json
  src/
    App.tsx
    bridge/client.ts
    bridge/protocol.ts
    realtime/session.ts
    screens/PairScreen.tsx
    screens/CallScreen.tsx
```

### Commands

```bash
npx create-expo-app mobile --template blank-typescript
cd mobile
npx expo install expo-camera expo-av
npm install
```

### Verify

- Pair with desktop over local Wi-Fi.
- Request OpenAI status.
- Request a Realtime secret.
- Execute a harmless tool like `list_tasks` through desktop bridge.

## Phase 3 — Mobile Realtime Voice

### Purpose

Make phone calls feel like the desktop Brah call.

### Flow

1. Mobile asks desktop bridge for `realtime.secret.create`.
2. Desktop creates short-lived Realtime client secret using Greg's saved OpenAI OAuth token.
3. Mobile opens WebRTC connection to OpenAI Realtime.
4. Mobile streams microphone audio directly to OpenAI.
5. OpenAI streams assistant audio directly to mobile.
6. Mobile opens data channel `oai-events`.
7. Mobile handles Realtime events.

### Tool Call Flow

When OpenAI emits a function call:

1. Mobile parses function call event.
2. Mobile sends `tools.execute` to desktop bridge.
3. Desktop runs existing Brah tool.
4. Desktop returns result to mobile.
5. Mobile sends `conversation.item.create` with `function_call_output` to OpenAI.
6. Mobile sends `response.create`.

### Key Decision

React Native WebRTC support may require `react-native-webrtc`, which may not work in pure Expo Go. If Expo Go blocks WebRTC, switch to an Expo dev build or bare React Native.

### Verify

- Phone mic reaches OpenAI.
- Assistant audio plays on phone.
- Tool call `list_tasks` works from phone.
- Tool call `analyze_screen` works by asking desktop to capture its screen and return Realtime image input.

## Phase 4 — Cloud Relay

### Purpose

Allow phone to reach desktop Brah when not on the same Wi-Fi.

### Preferred Relay Design

A tiny WebSocket relay service that passes encrypted messages between paired phone and desktop.

```text
Phone <-> Relay <-> Desktop Brah
```

Relay does not store OpenAI credentials, tool results, or messages beyond transient forwarding.

### Relay Responsibilities

- Device pairing handshake.
- Keep-alive/presence.
- Forward messages by paired device ID.
- Rate limits.
- No tool execution.
- No OpenAI token access.

### Options

1. **Self-hosted Node WebSocket relay** — simplest and cheapest.
2. **Cloudflare Workers Durable Objects** — good for always-on relay, but more setup.
3. **Supabase Realtime** — easy auth/storage, but external service dependency.

### Build Last

Do not build cloud relay until local Wi-Fi bridge and mobile Realtime voice work.

## Phase 5 — Telegram Fallback

### Purpose

Give Greg a simple phone interface even before the real app is complete.

### How Telegram Communicates

1. Greg creates a Telegram bot with BotFather.
2. Greg enters bot token and allowed Telegram user ID in Brah settings.
3. Desktop Brah starts a Telegram bot poller.
4. Telegram messages arrive at desktop Brah.
5. Desktop Brah sends text to a non-Realtime agent route or a lightweight OpenAI text route.
6. For voice notes, Brah downloads the OGG/Opus file and transcribes it.
7. Brah replies in Telegram.

### Important Limitation

Telegram is not true live voice. It is great for:

- text chat
- voice notes
- reminders
- async automations
- sending screenshots/results back

It is not ideal for:

- low-latency back-and-forth live calls
- streaming assistant audio while speaking

### Files to Add

- `src/channels/telegram/index.js`
- `src/channels/telegram/auth.js`
- `src/channels/telegram/voice.js`
- `src/realtime/tools/telegram-store.js`

### Dependencies

```bash
npm install grammy
```

Voice transcription options:

- OpenAI transcription API using desktop token/key path.
- Local Whisper via `@huggingface/transformers` later.

## Phase 6 — Memory and Remote Context

### Purpose

Make mobile and Telegram use the same long-term Brah memory as desktop voice.

### Work

- Add facts/daily log tables.
- Add `remember`, `forget`, `list_facts`, `memory_search`, `daily_log` tools.
- Inject memory into Realtime instructions for desktop and mobile calls.
- Store channel metadata: desktop, mobile, telegram.

## Recommended Execution Order

1. Finish Phase 0 rename/tests.
2. Implement Phase 1 desktop bridge with pairing.
3. Create Phase 2 mobile app shell.
4. Implement Phase 3 mobile Realtime voice.
5. Add Phase 5 Telegram fallback.
6. Add Phase 6 memory.
7. Add Phase 4 cloud relay only after local works.

## Success Criteria

### Local Mobile MVP

- Greg scans a QR code from desktop Brah.
- Mobile pairs successfully.
- Mobile starts a live OpenAI Realtime voice call.
- Greg talks from phone and hears Brah respond.
- Asking “what’s on my computer screen?” triggers desktop Brah screenshot/analyze tool.
- Desktop tool result is returned into the mobile Realtime call.
- Long-lived OpenAI credentials never leave desktop.

### Telegram MVP

- Greg messages the Telegram bot.
- Desktop Brah receives it.
- Brah replies.
- Greg sends a voice note.
- Brah transcribes and replies.
- Only Greg’s allowed Telegram user ID can use it.
