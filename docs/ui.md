# Brah UI — Current State & Direction

This document describes Brah's desktop UI as it exists today and the direction we
want to take it, especially the **live-call experience**.

---

## 1. Overview

Brah is an Electron app with a single always-floating window. The renderer
(`src/renderer/`) drives everything; the main process (`src/main.js`) owns the
window, auth, OS permissions, and tool execution.

The window has **two physical sizes** (set in `main.js` → `windowModes`, applied
via the `window:set-mode` IPC):

| Mode  | Size (w×h) | Purpose |
|-------|-----------|---------|
| `panel` | 440 × 600 | Full UI — menu, activity tabs, permissions |
| `orb`   | 172 × 188 | Collapsed — just the call orb + status |

The shell root is `#app-shell` with two data attributes that drive all styling:

- `data-mode`: `idle` · `connecting` · `listening` · `speaking` · `thinking`
- `data-panel`: `open` · `closed`

---

## 2. Current UI inventory

### 2.1 The orb (always visible) — `#call-toggle .fab-orb`
- A circular "Siri-style" orb (`.siri-orb` with surface/core/glow layers).
- Doubles as the **Call / End toggle** (`toggleCall` in `renderer.js`).
- Reacts to audio: `--orb-level` is updated ~60fps from mic + remote-audio RMS
  (`startAudioLevelMonitor`), so the orb pulses with speech.
- Label underneath (`#call-label`) reads "Call" / "End" (currently hidden via CSS).

### 2.2 Status line — `#status`
- Small text at the bottom: "Ready", "Listening", "Speaking", "Connecting",
  "Connect OpenAI", error messages, and transient tool statuses.

### 2.3 Tool-activity banner — `#tool-activity` (recent)
- Amber pill at the top with a pulsing dot, a label
  ("Computer use running…"), and a red **Stop** button.
- Shown only while a stoppable tool (`computer_use_task`) is in motion;
  Stop calls `cancelComputerUse()`. Auto-hides on completion or call end.

### 2.4 Panel (full UI) — `#panel`, controlled by `panel.js`
- **Header**: menu button, "Brah" title, OpenAI connection indicator.
- **Menu** (`#app-menu`): Connect OpenAI · Permissions · Collapse to orb.
- **Permissions view**: list of OS permissions (mic, screen, accessibility,
  computer) each with status + Request/Settings buttons; Refresh + Log.
- **Activity tabs** (`#panel-tabs`): Tasks · Calendar · Shots · Web · Computer.
  Each renders rows from local stores / activity log; live-updates via
  `onDataChanged`.
- **Footer**: item counts.

### 2.5 Expand affordance — `#orb-expand`
- A small button to reopen the panel from orb mode.

### Visual system
- Dark, minimal. Tokens in `styles.css` `:root` (surfaces, text, accent indigo,
  success/warn/danger, radii, motion easing). Fonts: Geist + Space Grotesk.

---

## 3. What's wrong / what we want

**Overall: significantly more polish.** The pieces work but the live-call moment
in particular is not clean — during a call we still expose the full app chrome
(menu, tabs, panel) which is noise when the user just wants to talk.

### 3.1 Live-call experience (primary goal)

When a call is **active**, we do NOT want the full UI. We want a clean, compact
**floating action button (FAB)–style call surface** — a focused call HUD, nothing
else. It should show:

1. **Call duration** — a running timer (mm:ss) from when the call connected.
2. **Audio waveform** — a live audio-wave/visualizer display (replacing or
   surrounding the orb), reacting to the conversation audio. Just the wave; no
   tabs, no menu, no activity lists.
3. **A clear "End" button** — unmistakable, always reachable, ends the call.

Essentially: on a live call the window should feel like a minimal call widget
(think: a phone call's in-call screen), not a dashboard.

### 3.2 Desired mode model

| App state | Window | What's shown |
|-----------|--------|--------------|
| Not connected | small | Connect prompt only |
| Idle (connected, no call) | small/orb | Orb + "Ready", quiet |
| **In call (live)** | **compact call HUD** | **duration + waveform + End** |
| **Computer use active** | **computer-use display near FAB** | **status/step + Cancel; coexists with call HUD** |
| Other tool in motion | overlaid on current | lightweight activity hint |
| Browsing data (tasks/calendar/…) | panel | full tabs UI, opened deliberately |

Key principle: **the call HUD and the data panel are separate surfaces.** A live
call defaults to the minimal HUD; the full panel is opt-in (and ideally not the
default backdrop during a call).

### 3.4 Computer-use display (live, while active)

Separate from the call HUD, when the agent is **using computer use** we want a
dedicated display that appears **only while a computer-use task is active** and
disappears when it ends. It lives **near the same area as the FAB / call HUD** —
an extra surface that pops up on demand.

Think of it as the richer evolution of today's `#tool-activity` banner:

- **Visible only during a run.** Pops up when `computer_use_task` starts, hides
  on completion / cancel / error.
- **Shows what the agent is doing** — current status/step (we already log
  `computer_use.action.start/ok/error` per action), target (browser vs OS),
  and ideally a brief live trace or step count.
- **Manual control** — a clear **Cancel/Stop** that aborts the run
  (`cancelComputerUse()` → main `AbortController`), plus room for future controls
  (pause, take-over, etc.).
- **Coexists with the call HUD.** Computer use often runs during a live call, so
  this display should sit alongside the call HUD near the FAB, not replace it.

This replaces the idea that the only computer-use affordance is a single Stop
pill — instead it's a small, self-contained "agent is operating" panel with
status + controls, scoped to the duration of the run.

### 3.3 Polish targets
- Refined typography, spacing, and motion; smoother mode transitions
  (orb ↔ call HUD ↔ panel) instead of hard size swaps.
- A real audio visualizer (multi-bar or waveform) rather than a single pulsing
  orb level, driven by the existing analyser data.
- Consistent, legible controls; the End button styled as a clear primary/danger
  action.
- The Stop/activity banner visually consistent with the new call HUD.

---

## 4. Notes for implementation (later)
- Audio levels already available via `startAudioLevelMonitor` / `createAnalyser`
  in `renderer.js` — a waveform can read `getByteTimeDomainData`/frequency data
  from the same analysers.
- Call lifecycle hooks already exist: `startCall` (connected → start timer),
  `stopCall` (teardown → stop timer), and connection-state changes.
- A new `call` window mode (alongside `orb`/`panel`) may be warranted so the HUD
  gets its own clean size.
- The End button can reuse `toggleCall`/`stopCall`; the hang-up tool
  (`end_call`) already drives the same teardown path.

---

## 5. Open questions
- Should the data panel be reachable during a call (e.g. a small expand chip), or
  fully hidden until the call ends?
- Waveform style: single waveform line, mirrored bars, or frequency bars?
- Should duration + waveform live inside the orb window size, or a dedicated
  wider-but-short call bar?
- Computer-use display: how much to show — just status + Cancel, or a live step
  trace / latest screenshot thumbnail too?
- When both are active (live call + computer use), how do the two surfaces stack
  near the FAB without crowding the small window?
