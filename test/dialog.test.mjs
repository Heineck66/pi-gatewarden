import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Pi bundles pi-tui, so point the bare import at a local stand-in before loading the dialog.
const stubs = { "@earendil-works/pi-tui": new URL("./stubs/pi-tui.mjs", import.meta.url).href };
registerHooks({
  resolve: (specifier, context, next) =>
    stubs[specifier] ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context),
});
const { askRpc, askTui, describeInput, markLines } = await import("../dialog.ts");

const plain = { fg: (_color, text) => text, bold: (text) => text };
const keybindings = { matches: (data, id) => data === id };

// Opens the TUI dialog and returns its component plus the pending answer.
function open(prompt, signal) {
  let component;
  const answer = askTui({ ui: { custom: (factory) => new Promise((done) => {
    component = factory({ requestRender() {} }, plain, keybindings, done);
  }) } }, prompt, signal);
  return { component, answer };
}

const prompt = (overrides = {}) => ({
  bash: true, reasons: ["Delete files or directories"], cwd: "~/project",
  subject: "rm -rf build", highlights: ["rm -rf build"], ...overrides,
});

test("markLines marks every occurrence of each needle, line by line", () => {
  assert.deepEqual(markLines("cd x && rm a\nrm a", ["rm a"]), [
    [["cd x && ", false], ["rm a", true]],
    [["rm a", true]],
  ]);
  assert.deepEqual(markLines("cat .env", [".env", "cat"]), [[["cat", true], [" ", false], [".env", true]]]);
  assert.deepEqual(markLines("a\n\nb", ["", "zzz"]), [[["a", false]], [], [["b", false]]]);
});

test("describeInput puts each argument on its own line and cuts long values", () => {
  assert.equal(describeInput("read", { path: ".env", limit: 5 }), "read\n  path: .env\n  limit: 5");
  assert.equal(describeInput("write", { content: "a\n  b" }), "write\n  content: a b");
  assert.match(describeInput("write", { content: "x".repeat(500) }), /^write\n  content: x{200}… \(500 characters\)$/);
  assert.equal(describeInput("mcp__x", { filter: { open: true }, none: undefined }), 'mcp__x\n  filter: {"open":true}\n  none: undefined');
});

test("every rendered line fits the terminal, even a narrow one", () => {
  const { component } = open(prompt({ subject: `rm -rf ${"build/".repeat(60)}`, reasons: ["x".repeat(300)] }));
  for (const width of [8, 20, 80]) {
    for (const line of component.render(width)) assert.ok(line.length <= width, `${width}: ${line}`);
  }
});

test("long subjects show their first 40 rows and say how many highlighted rows are hidden", () => {
  const subject = [...Array.from({ length: 60 }, (_, i) => `echo ${i}`), "rm -rf build"].join("\n");
  const shown = open(prompt({ subject })).component.render(80).join("\n");
  assert.match(shown, /echo 39\n/);
  assert.doesNotMatch(shown, /echo 40\n/);
  assert.match(shown, /… 21 more lines not shown, 1 of them highlighted/);
});

test("terminal controls in the command are shown escaped, not run by the terminal", () => {
  const shown = open(prompt({ subject: "rm \x1b[2J -rf build", highlights: [] })).component.render(80).join("\n");
  assert.match(shown, /rm \\u001b\[2J -rf build/);
});

test("an already-aborted turn denies without waiting for a key", async () => {
  const { answer } = open(prompt(), AbortSignal.abort());
  assert.deepEqual(await answer, { choice: "deny" });
});

test("RPC: select, then an editor per prefix; a client stuck on bad prefixes is denied after three tries", async () => {
  const session = { pieces: [{ text: "git push", suggestion: "git push:*" }], also: [], check: (_i, p) => (p === "git push:*" ? undefined : "nope") };
  const titles = [];
  const ui = (answers) => ({
    select: async (_title, options) => options[2],
    editor: async (title) => { titles.push(title); return answers.shift(); },
  });
  assert.deepEqual(await askRpc({ ui: ui(["git push:*"]) }, prompt({ session })), { choice: "session", prefixes: ["git push:*"] });
  assert.deepEqual(await askRpc({ ui: ui(["x", "y", "z", "git push:*"]) }, prompt({ session })), { choice: "deny" });
  assert.match(titles.at(-1), /^✗ nope\nAllow for this session: git push/);
  assert.deepEqual(await askRpc({ ui: ui([undefined]) }, prompt({ session })), { choice: "deny" });
});
