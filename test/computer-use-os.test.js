import assert from "node:assert/strict";
import test from "node:test";
import { executeComputerActions } from "../src/realtime/tools/computer-use-actions.js";
import { createOsComputerTarget, mapKeyToNut } from "../src/realtime/tools/computer-use-os.js";

test("mapKeyToNut maps normalized keys, letters, and digits to nut Keys", () => {
  const Key = { Enter: 1, LeftControl: 2, LeftSuper: 3, Up: 4, A: 5, Num1: 6 };
  assert.equal(mapKeyToNut("Enter", Key), 1);
  assert.equal(mapKeyToNut("Control", Key), 2);
  assert.equal(mapKeyToNut("Meta", Key), 3);
  assert.equal(mapKeyToNut("ArrowUp", Key), 4);
  assert.equal(mapKeyToNut("a", Key), 5);
  assert.equal(mapKeyToNut("1", Key), 6);
  assert.throws(() => mapKeyToNut("F13", Key), /Unsupported computer key/);
});

test("createOsComputerTarget captures at the logical size so coordinates are 1:1", async () => {
  const calls = [];
  const target = await createOsComputerTarget(buildOsOptions(calls));

  assert.deepEqual(target.displaySize, { width: 1000, height: 500 });
  const png = await target.captureScreenshot();
  assert.ok(Buffer.isBuffer(png));
  // The 2000x1000 native thumbnail is resized down to the logical 1000x500.
  assert.deepEqual(target.displaySize, { width: 1000, height: 500 });
  assert.deepEqual(calls[0], ["resize", 1000, 500]);
});

test("createOsComputerTarget maps screenshot coordinates 1:1 onto logical points", async () => {
  const calls = [];
  const target = await createOsComputerTarget(buildOsOptions(calls));
  await target.captureScreenshot(); // image is logical-sized, so scale is 1:1
  calls.length = 0; // drop the resize bookkeeping

  await executeComputerActions(target.actionTarget, [
    { type: "click", x: 100, y: 100, button: "right" },
    { type: "move", x: 200, y: 100 },
    { type: "scroll", x: 0, y: 0, scroll_x: 0, scroll_y: -400 },
    { type: "keypress", keys: ["ENTER"] },
    { type: "type", text: "hi" },
  ]);

  assert.deepEqual(calls, [
    ["setPosition", 100, 100],
    ["click", 2],
    ["setPosition", 200, 100],
    ["setPosition", 0, 0],
    ["scrollUp", 400],
    ["pressKey", 103],
    ["releaseKey", 103],
    ["type", "hi"],
  ]);
});

test("createOsComputerTarget rejects unsupported platforms", async () => {
  await assert.rejects(
    () => createOsComputerTarget({ ...buildOsOptions([]), platform: "freebsd" }),
    /not supported on platform/,
  );
});

function buildOsOptions(calls) {
  return {
    platform: "darwin",
    nut: createFakeNut(calls),
    screen: createFakeScreen(),
    desktopCapturer: createFakeDesktopCapturer(calls),
  };
}

function createFakeNut(calls) {
  class Point {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }
  }
  return {
    Point,
    Button: { LEFT: 0, MIDDLE: 1, RIGHT: 2 },
    Key: { Enter: 103, LeftControl: 104, LeftSuper: 105, A: 30, Num1: 40 },
    mouse: {
      setPosition: async (point) => calls.push(["setPosition", point.x, point.y]),
      click: async (button) => calls.push(["click", button]),
      doubleClick: async (button) => calls.push(["doubleClick", button]),
      pressButton: async (button) => calls.push(["pressButton", button]),
      releaseButton: async (button) => calls.push(["releaseButton", button]),
      scrollUp: async (amount) => calls.push(["scrollUp", amount]),
      scrollDown: async (amount) => calls.push(["scrollDown", amount]),
      scrollLeft: async (amount) => calls.push(["scrollLeft", amount]),
      scrollRight: async (amount) => calls.push(["scrollRight", amount]),
    },
    keyboard: {
      type: async (text) => calls.push(["type", text]),
      pressKey: async (...keys) => calls.push(["pressKey", ...keys]),
      releaseKey: async (...keys) => calls.push(["releaseKey", ...keys]),
    },
    sleep: async (ms) => calls.push(["sleep", ms]),
  };
}

function createFakeScreen() {
  return {
    getPrimaryDisplay: () => ({ id: 1, size: { width: 1000, height: 500 }, scaleFactor: 2 }),
  };
}

function createFakeDesktopCapturer(calls = []) {
  const makeImage = (width, height) => ({
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.from("os-screenshot"),
    resize: ({ width: w, height: h }) => {
      calls.push(["resize", w, h]);
      return makeImage(w, h);
    },
  });
  return {
    getSources: async () => [
      { id: "screen:1", display_id: "1", name: "Primary screen", thumbnail: makeImage(2000, 1000) },
    ],
  };
}
