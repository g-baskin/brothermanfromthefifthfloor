import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeScreenshotTool } from "../src/realtime/tools/screenshot-tools.js";

test("take_screenshot uses the Electron desktopCapturer thumbnail when it is non-empty", async () => {
  await withTempUserData(async (userDataPath) => {
    let fallbackCalls = 0;
    const result = await executeScreenshotTool(
      "take_screenshot",
      { target: "primary_screen" },
      {
        desktopCapturer: createDesktopCapturer([
          {
            display_id: "101",
            id: "screen:1:0",
            name: "Entire Screen",
            thumbnail: createFakeImage({ png: "electron-screen" }),
          },
        ]),
        macOsScreencaptureExecFile: async () => {
          fallbackCalls += 1;
        },
        platform: "darwin",
        screen: createScreen([{ id: 101 }]),
        screenRecordingStatus: "granted",
        userDataPath,
      },
    );

    assert.equal(result.status, "captured");
    assert.equal(result.source.type, "screen");
    assert.deepEqual(result.dimensions, { width: 320, height: 180 });
    assert.deepEqual(await fs.readFile(result.path), Buffer.from("electron-screen"));
    assert.equal(fallbackCalls, 0);
  });
});

test("take_screenshot falls back to macOS screencapture for empty screen thumbnails", async () => {
  await withTempUserData(async (userDataPath) => {
    const fallbackCalls = [];
    let fallbackTempPath = "";
    let fallbackArgs = [];
    const nativeImage = {
      createFromBuffer(png) {
        assert.deepEqual(png, Buffer.from("fallback-screen"));
        return createFakeImage({ png: "decoded-fallback", width: 640, height: 360 });
      },
    };

    const result = await executeScreenshotTool(
      "take_screenshot",
      { target: "primary_screen" },
      {
        desktopCapturer: createDesktopCapturer([
          {
            display_id: "222",
            id: "screen:2:0",
            name: "Screen 2",
            thumbnail: createFakeImage({ empty: true }),
          },
        ]),
        macOsScreencaptureExecFile: async (file, args) => {
          fallbackCalls.push(args);
          fallbackArgs = args;
          fallbackTempPath = args.at(-1);
          assert.equal(file, "/usr/sbin/screencapture");
          await fs.writeFile(fallbackTempPath, Buffer.from("fallback-screen"));
        },
        macOsScreencaptureRetryDelayMs: 0,
        nativeImage,
        platform: "darwin",
        screen: createScreen([{ id: 111 }, { id: 222 }], 222),
        screenRecordingStatus: "granted",
        userDataPath,
      },
    );

    assert.equal(result.status, "captured");
    assert.equal(fallbackCalls.length, 1);
    assert.deepEqual(fallbackArgs.slice(0, 5), ["-x", "-t", "png", "-D", "2"]);
    assert.ok(fallbackTempPath.startsWith(path.join(os.tmpdir(), "brah-screencapture-")));
    await assert.rejects(() => fs.access(fallbackTempPath), { code: "ENOENT" });
    assert.deepEqual(result.dimensions, { width: 640, height: 360 });
    assert.deepEqual(await fs.readFile(result.path), Buffer.from("decoded-fallback"));
  });
});

test("take_screenshot retries with -m when primary display -D fallback hits a macOS race", async () => {
  await withTempUserData(async (userDataPath) => {
    const fallbackCalls = [];
    const nativeImage = {
      createFromBuffer(png) {
        assert.deepEqual(png, Buffer.from("primary-fallback"));
        return createFakeImage({ png: "decoded-primary", width: 1440, height: 900 });
      },
    };

    const result = await executeScreenshotTool(
      "take_screenshot",
      { target: "primary_screen" },
      {
        desktopCapturer: createDesktopCapturer([
          {
            display_id: "111",
            id: "screen:1:0",
            name: "Screen 1",
            thumbnail: createFakeImage({ empty: true }),
          },
        ]),
        macOsScreencaptureExecFile: async (_file, args) => {
          fallbackCalls.push(args.slice(0, -1));
          if (fallbackCalls.length === 1) {
            throw new Error("could not create image from display");
          }
          await fs.writeFile(args.at(-1), Buffer.from("primary-fallback"));
        },
        macOsScreencaptureRetryDelayMs: 0,
        nativeImage,
        platform: "darwin",
        screen: createScreen([{ id: 111 }, { id: 222 }], 111),
        screenRecordingStatus: "granted",
        userDataPath,
      },
    );

    assert.equal(result.status, "captured");
    assert.deepEqual(fallbackCalls, [
      ["-x", "-t", "png", "-D", "1"],
      ["-x", "-t", "png", "-m"],
    ]);
    assert.deepEqual(result.dimensions, { width: 1440, height: 900 });
    assert.deepEqual(await fs.readFile(result.path), Buffer.from("decoded-primary"));
  });
});

test("take_screenshot retries non-primary display -D fallback without using primary -m", async () => {
  await withTempUserData(async (userDataPath) => {
    const fallbackCalls = [];

    const result = await executeScreenshotTool(
      "take_screenshot",
      { target: "primary_screen" },
      {
        desktopCapturer: createDesktopCapturer([
          {
            display_id: "222",
            id: "screen:2:0",
            name: "Screen 2",
            thumbnail: createFakeImage({ empty: true }),
          },
        ]),
        macOsScreencaptureExecFile: async (_file, args) => {
          fallbackCalls.push(args.slice(0, -1));
          if (fallbackCalls.length === 1) {
            throw new Error("could not create image from display");
          }
          await fs.writeFile(args.at(-1), Buffer.from("secondary-fallback"));
        },
        macOsScreencaptureRetryDelayMs: 0,
        nativeImage: {
          createFromBuffer: () =>
            createFakeImage({ png: "decoded-secondary", width: 3200, height: 1800 }),
        },
        platform: "darwin",
        screen: createScreen([{ id: 111 }, { id: 222 }], 111),
        screenRecordingStatus: "granted",
        userDataPath,
      },
    );

    assert.equal(result.status, "captured");
    assert.deepEqual(fallbackCalls, [
      ["-x", "-t", "png", "-D", "2"],
      ["-x", "-t", "png", "-D", "2"],
    ]);
    assert.deepEqual(result.dimensions, { width: 3200, height: 1800 });
  });
});

test("take_screenshot does not run the macOS fallback for empty window thumbnails", async () => {
  await withTempUserData(async (userDataPath) => {
    let fallbackCalls = 0;
    const result = await executeScreenshotTool(
      "take_screenshot",
      { target: "window", window_query: "notes" },
      {
        desktopCapturer: createDesktopCapturer([
          {
            display_id: "",
            id: "window:44:0",
            name: "Notes Window",
            thumbnail: createFakeImage({ empty: true }),
          },
        ]),
        macOsScreencaptureExecFile: async () => {
          fallbackCalls += 1;
        },
        platform: "darwin",
        screen: createScreen([{ id: 101 }]),
        screenRecordingStatus: "granted",
        userDataPath,
      },
    );

    assert.equal(result.status, "error");
    assert.match(result.message, /empty window image/);
    assert.match(result.message, /fallback only applies to screen sources/);
    assert.match(result.message, /permission appears granted/);
    assert.equal(fallbackCalls, 0);
  });
});

test("take_screenshot reports an unknown display when the macOS fallback cannot map display_id", async () => {
  await withTempUserData(async (userDataPath) => {
    let fallbackCalls = 0;
    const result = await executeScreenshotTool(
      "take_screenshot",
      { target: "primary_screen" },
      {
        desktopCapturer: createDesktopCapturer([
          {
            display_id: "999",
            id: "screen:3:0",
            name: "Unknown Screen",
            thumbnail: createFakeImage({ empty: true }),
          },
        ]),
        macOsScreencaptureExecFile: async () => {
          fallbackCalls += 1;
        },
        nativeImage: { createFromBuffer: () => createFakeImage() },
        platform: "darwin",
        screen: createScreen([{ id: 101 }]),
        screenRecordingStatus: "granted",
        userDataPath,
      },
    );

    assert.equal(result.status, "error");
    assert.match(result.message, /permission appears granted/);
    assert.match(result.message, /display_id "999" did not match/);
    assert.equal(fallbackCalls, 0);
  });
});

async function withTempUserData(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brah-screenshot-test-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function createDesktopCapturer(sources) {
  return {
    async getSources(options) {
      assert.deepEqual(options.types, ["screen", "window"]);
      assert.deepEqual(options.thumbnailSize, { width: 1920, height: 1080 });
      assert.equal(options.fetchWindowIcons, false);
      return sources;
    },
  };
}

function createScreen(displays, primaryId = displays[0]?.id) {
  return {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays.find((display) => display.id === primaryId) ?? displays[0],
  };
}

function createFakeImage({ empty = false, png = "fake-png", width = 320, height = 180 } = {}) {
  return {
    isEmpty: () => empty,
    getSize: () => (empty ? { width: 0, height: 0 } : { width, height }),
    toPNG: () => Buffer.from(png),
    toJPEG: () => Buffer.from(`jpeg:${png}`),
    resize: ({ width: resizedWidth, height: resizedHeight }) =>
      createFakeImage({ empty, png, width: resizedWidth, height: resizedHeight }),
  };
}
