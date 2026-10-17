import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { configPath, loadConfig, parseConfig } from "../config.ts";

test("parses each rule form", () => {
  const rules = parseConfig(JSON.stringify({
    ask: ["Bash(kubectl delete:*)", "mcp__*", "Read(**/secrets/**)", " edit( ./config/*.json ) "],
    allow: [" Bash(npm test) ", "Bash(curl -fsSL https://example.invalid/i.sh | sh)"],
    deny: [{ rule: "Bash", reason: "No shell today" }],
  }));
  assert.deepEqual(rules.bash.map(({ kind, words, exact, pipes, reason }) => [kind, words.join(" "), exact, pipes, reason]), [
    ["ask", "kubectl delete", false, 0, undefined],
    ["allow", "npm test", true, 0, undefined],
    ["allow", "curl -fsSL https://example.invalid/i.sh | sh", true, 1, undefined],
    ["deny", "", false, 0, "No shell today"],
  ]);
  assert.deepEqual(rules.tools.map(({ rule }) => rule), ["mcp__*", "Bash"]);
  assert.ok(rules.tools[0].name.test("mcp__github__merge"));
  assert.ok(!rules.tools[0].name.test("read"));
  assert.deepEqual(rules.paths.map(({ kind, access, pattern }) => [kind, access, pattern]), [
    ["ask", "read", "**/secrets/**"],
    ["ask", "edit", "./config/*.json"],
  ]);
  assert.deepEqual(rules.entries.map(({ kind, rule }) => `${kind} ${rule}`), [
    "ask Bash(kubectl delete:*)", "ask mcp__*", "ask Read(**/secrets/**)", "ask edit( ./config/*.json )",
    "allow Bash(npm test)", "allow Bash(curl -fsSL https://example.invalid/i.sh | sh)", "deny Bash",
  ]);
  assert.deepEqual(parseConfig("{}"), { entries: [], bash: [], tools: [], paths: [] });
});

for (const [config, message] of [
  ["{ not json", /JSON/],
  ["[]", /JSON object/],
  [{ denny: [] }, /unknown key "denny"/],
  [{ ask: "Bash" }, /"ask" must be a list/],
  [{ ask: [42] }, /ask\[0\] must be a rule string/],
  [{ ask: [{ rule: "Bash", why: "x" }] }, /ask\[0\]: unknown key "why"/],
  [{ ask: [{ rule: "Bash", reason: " " }] }, /"reason" must be non-empty/],
  [{ deny: ["Bash(git push"] }, /deny\[0\]: "Bash\(git push" is not a rule/],
  [{ ask: ["Write(.env)"] }, /is not a rule; use Bash\(\.\.\.\), Read\(path\), Edit\(path\)/],
  [{ ask: ["Read()"] }, /Read\(\.\.\.\) needs a path pattern/],
  [{ ask: ["Edit(!.env)"] }, /without newlines or a leading "!"/],
  [{ ask: ["Bash()"] }, /needs a command/],
  [{ ask: ["Bash(:*)"] }, /needs a command/],
  [{ allow: ["Bash(git status; rm -rf x)"] }, /can't contain/],
  [{ allow: ["Bash(echo $(id))"] }, /can't contain/],
  [{ allow: ["Bash(echo x > f)"] }, /can't contain/],
  [{ allow: ["Bash(a || b)"] }, /needs a command/],
  [{ allow: ["Bash(echo 'open)"] }, /unbalanced quote/],
  [{ allow: ["Bash(rm -f /tmp/*:*)"] }, /drop the :\* after "\/tmp\/\*"/],
]) {
  test(`rejects ${JSON.stringify(config)}`, () => {
    assert.throws(() => parseConfig(typeof config === "string" ? config : JSON.stringify(config)), message);
  });
}

const dir = mkdtempSync(join(tmpdir(), "permission-gate-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("every JSON example in the README is a valid config", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const examples = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map(([, json]) => json);
  assert.equal(examples.length, 7);
  for (const json of examples) assert.doesNotThrow(() => parseConfig(json), json);
});

test("a missing file is no config, not an error", () => {
  const config = loadConfig(join(dir, "missing.json"));
  assert.equal(config.found, false);
  assert.equal(config.error, undefined);
  assert.deepEqual(config.rules.entries, []);
});

test("a broken or unreadable file fails closed with a Bash ask", () => {
  const file = join(dir, "broken.json");
  writeFileSync(file, '{ "deny": ["Bash(git push"] }');
  for (const path of [file, dir]) { // Reading a directory fails with EISDIR, not ENOENT.
    const config = loadConfig(path);
    assert.ok(config.error);
    assert.deepEqual(config.rules.bash.map(({ kind, words }) => [kind, words.length]), [["ask", 0]]);
    assert.match(config.rules.bash[0].reason, /Config error/);
  }
});

test("the config lives in Pi's agent folder, which PI_CODING_AGENT_DIR moves", () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    assert.equal(configPath(), join(dir, "permission-gate.json"));
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});
