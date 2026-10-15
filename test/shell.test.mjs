import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand } from "../shell.ts";

// [words joined by spaces, allowable] per stage, per statement. Strings only; nothing runs.
const shape = (command) =>
  parseCommand(command).map(({ stages }) => stages.map(({ words, allowable }) => [words.join(" "), allowable]));

const cases = [
  ["a && b || c; d & e\nf", [[["a", true]], [["b", true]], [["c", true]], [["d", true]], [["e", true]], [["f", true]]]],
  ["git log | head -5 |& cat", [[["git log", true], ["head -5", true], ["cat", true]]]],
  [`git commit -m "fix; rm" && echo 'a|b'`, [[["git commit -m fix; rm", true]], [["echo a|b", true]]]],
  ["\\rm -rf x", [[["rm -rf x", true]]]],
  ["su\\\ndo id", [[["sudo id", true]]]],
  ["(cd x && rm y)", [[["cd x", true]], [["rm y", true]]]],
  ["ls # rm -rf /", [[["ls", true]]]],
  ["echo 'open", [[["echo open", false]]]],
  [`echo "open`, [[["echo open", false]]]],
  // Redirections leave the words; only output to a real file makes a stage unallowable.
  ["git status 2>&1 | tail", [[["git status", true], ["tail", true]]]],
  ["cmd >/dev/null 2>/dev/null", [[["cmd", true]]]],
  ["cmd >&2", [[["cmd", true]]]],
  ["cat < in.txt", [[["cat", true]]]],
  ["cat <<< text", [[["cat", true]]]],
  ["echo x > out.txt", [[["echo x", false]]]],
  ["echo x >> out.txt", [[["echo x", false]]]],
  ["cmd &> log", [[["cmd", false]]]],
  ["cmd >& log", [[["cmd", false]]]],
  ["cmd >", [[["cmd", false]]]],
  // Substitutions make the stage unallowable and add their commands as unallowable statements.
  ["echo $(rm -rf x)", [[["echo $(rm -rf x)", false]], [["rm -rf x", false]]]],
  ["echo `rm x`", [[["echo `rm x`", false]], [["rm x", false]]]],
  [`echo "$(rm x) ok"`, [[["echo $(rm x) ok", false]], [["rm x", false]]]],
  ["diff <(a) <(b)", [[["diff <(a) <(b)", false]], [["a", false]], [["b", false]]]],
  ["echo $(echo ')')", [[["echo $(echo ')')", false]], [["echo )", false]]]],
  // Heredoc bodies are data: an apostrophe there must not swallow the next command.
  ["git commit -F - <<'EOF'\nDon't; rm\nEOF\ngit push", [[["git commit -F -", true]], [["git push", true]]]],
  ["cat <<-END\n\tit's\n\tEND\nls", [[["cat", true]], [["ls", true]]]],
];

for (const [command, expected] of cases) {
  test(`parses ${JSON.stringify(command)}`, () => assert.deepEqual(shape(command), expected));
}

test("stage and statement text keep the source, heredoc body included, for the regex rules", () => {
  const [commit, push] = parseCommand("git commit -F - <<EOF\nrm notes\nEOF\ngit push | cat");
  assert.equal(commit.stages[0].text, "git commit -F - <<EOF\nrm notes\nEOF");
  assert.equal(push.text, "git push | cat");
  assert.deepEqual(push.stages.map(({ text }) => text), ["git push", "cat"]);
});

test("redirection targets are kept apart from the words, with their direction", () => {
  const redirects = (command) => parseCommand(command).flatMap(({ stages }) => stages.map((stage) => stage.redirects));
  assert.deepEqual(redirects("sort < in.txt > out.txt 2>&1"), [[{ path: "in.txt", write: false }, { path: "out.txt", write: true }]]);
  assert.deepEqual(redirects("cmd &>> log >& err 2>/dev/null"), [[
    { path: "log", write: true }, { path: "err", write: true }, { path: "/dev/null", write: true },
  ]]);
  assert.deepEqual(redirects("> ~/.ssh/authorized_keys"), [[{ path: "~/.ssh/authorized_keys", write: true }]]);
  assert.deepEqual(redirects("cat <<EOF\nx\nEOF"), [[]]);
});

test("unclosed substitutions and deep nesting don't hang", () => {
  assert.deepEqual(shape("echo $(rm x"), [[["echo $(rm x", false]], [["rm x", false]]]);
  assert.equal(shape("echo `rm x").length, 2);
  const start = performance.now();
  parseCommand(`${"$(".repeat(500)}rm x${")".repeat(500)}`);
  assert.ok(performance.now() - start < 1000);
});
