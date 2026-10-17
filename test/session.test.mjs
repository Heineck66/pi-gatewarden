import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../config.ts";
import { decideBash, decidePaths } from "../policy.ts";
import { addRules, checkPrefix, emptyRules, fileAllow, sessionAllowed, suggestPrefix, toolAllow } from "../session.ts";

// Strings only; nothing runs.
const bash = (config = {}) => parseConfig(JSON.stringify(config)).bash;
const pieces = (command, rules = []) => decideBash(command, rules).pieces;
const suggest = (command, config) => pieces(command, bash(config)).map((piece) => suggestPrefix(piece, bash(config)));

test("suggests the command and its first argument, longer when a user ask would tie", () => {
  assert.deepEqual(suggest("rm -rf build"), ["rm -rf:*"]);
  assert.deepEqual(suggest("git push origin main && chmod +x a.sh"), ["git push:*", "chmod +x:*"]);
  assert.deepEqual(suggest("pwd", { ask: ["Bash"] }), ["pwd:*"]);
  assert.deepEqual(suggest("kubectl delete pod x", { ask: ["Bash(kubectl delete:*)"] }), ["kubectl delete pod:*"]);
  assert.deepEqual(suggest("FOO=1 kubectl delete pod x", { ask: ["Bash(kubectl delete:*)"] }), ["FOO=1 kubectl delete:*"]);
});

test("pipelines are suggested exactly, and words are quoted so they read back the same", () => {
  assert.deepEqual(suggest("curl -fsSL https://example.invalid/i.sh | sh"), ["curl -fsSL https://example.invalid/i.sh | sh"]);
  assert.deepEqual(suggest(`git commit -m "it's done"`, { ask: ["Bash"] }), ["git commit:*"]);
  const [piece] = pieces(`rm "my file"`);
  assert.equal(suggestPrefix(piece, []), "rm 'my file':*");
  assert.equal(checkPrefix("rm 'my file':*", piece, []).error, undefined);
  const [quoted] = pieces(`rm "it's"`);
  assert.equal(checkPrefix(suggestPrefix(quoted, []), quoted, []).error, undefined);
});

test("a prefix must parse and let the piece run", () => {
  const [piece] = pieces("git push origin");
  for (const prefix of ["git push:*", "git:*", "git push origin", "git push origin:*"]) {
    assert.equal(checkPrefix(prefix, piece, []).error, undefined, prefix);
  }
  assert.match(checkPrefix("git pull:*", piece, []).error, /Still asks: Publish Git changes\. Use a longer or different prefix\./);
  assert.match(checkPrefix("git push", piece, []).error, /Still asks/); // Exact, but the command has more words.
  assert.match(checkPrefix(":*", piece, []).error, /Type a command/);
  assert.match(checkPrefix("git push; rm:*", piece, []).error, /can't contain/);
  assert.match(checkPrefix("git 'push:*", piece, []).error, /unbalanced quote/);
  assert.deepEqual(checkPrefix("git push:*", piece, []).rule.words, ["git", "push"]);
});

test("a session prefix can name a folder, as in rm -f /tmp/*", () => {
  const context = { cwd: "/project", home: "/home/me" };
  const [piece] = decideBash("rm -f /tmp/houseapp-checks/smoke.db", [], context).pieces;
  assert.equal(checkPrefix("rm -f /tmp/*", piece, [], context).error, undefined);
  assert.match(checkPrefix("rm -f /var/*", piece, [], context).error, /Still asks/);
  assert.match(checkPrefix("rm -f /tmp/*:*", piece, [], context).error, /drop the :\*/);
});

test("a session prefix can't beat a user ask of the same length", () => {
  const rules = bash({ ask: ["Bash(kubectl delete:*)"] });
  const [piece] = pieces("kubectl delete pod x", rules);
  assert.match(checkPrefix("kubectl delete:*", piece, rules).error, /Still asks/);
  assert.equal(checkPrefix("kubectl delete pod:*", piece, rules).error, undefined);
});

test("pieces with substitutions or file redirects, and once-only files, can't be allowed for the session", () => {
  assert.ok(sessionAllowed(pieces("rm -rf build 2>&1 | tail"), []));
  assert.ok(!sessionAllowed(pieces("echo $(rm x)"), []));
  assert.ok(!sessionAllowed(pieces("rm -rf build > log"), []));
  assert.ok(!sessionAllowed([], [{ written: "x", path: "/x", access: "edit", reasons: [], once: true }]));
});

test("file allows match exactly one path and access, nothing below it", () => {
  const context = { cwd: "/project", home: "/home/me" };
  const ask = [{ kind: "ask", access: "read", pattern: "~", rule: "Read(~)" }, { kind: "ask", access: "edit", pattern: "~", rule: "Edit(~)" }];
  const allow = fileAllow({ written: "~", path: "/home/me", access: "read", reasons: [], once: false });
  assert.deepEqual(allow, { kind: "allow", access: "read", pattern: "/home/me", exact: true, rule: "Read(/home/me)" });
  const asks = (path, access) => decidePaths([{ path, access }], [...ask, allow], context).reasons.length > 0;
  assert.ok(!asks("~", "read"));
  assert.ok(asks("~/.ssh/id_ed25519", "read"));
  assert.ok(asks("~", "edit"));
  assert.equal(fileAllow({ written: "x", path: "/x", access: "any", reasons: [], once: false }).access, "read");
  assert.equal(fileAllow({ written: "x", path: "/x", access: "edit", reasons: [], once: false }).rule, "Edit(/x)");
});

test("tool allows match one tool name, with regex characters escaped", () => {
  const allow = toolAllow("mcp__a.b__run");
  assert.ok(allow.name.test("mcp__a.b__run"));
  assert.ok(!allow.name.test("mcp__aXb__run"));
  assert.ok(!allow.name.test("mcp__a.b__run_all"));
});

test("addRules files each rule under its kind and lists them all", () => {
  const session = emptyRules();
  const [piece] = pieces("git push");
  addRules(session, { bash: [checkPrefix("git push:*", piece, []).rule], tools: [toolAllow("x")] });
  assert.deepEqual(session.entries.map(({ rule }) => rule), ["Bash(git push:*)", "x"]);
  assert.equal(session.bash.length, 1);
  assert.equal(session.tools.length, 1);
});
