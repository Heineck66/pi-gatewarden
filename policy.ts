// Heuristics for common accidents, NOT a security boundary.
// Keep every rule paired with examples in test/permission-gate.test.mjs.
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type BashRule, isPathPattern, type PathRule, type ToolRule } from "./config.ts";
import { parseCommand, type Stage } from "./shell.ts";

export interface Rule {
  reason: string;
  pattern: RegExp;
  pipeline?: boolean; // Checked against the whole pipeline instead of each stage.
}

function executable(names: string): RegExp {
  // Also recognize /usr/bin/rm, \rm (alias bypass), quoted names, and commands after shell operators.
  return new RegExp(`(?:^|[\\s;&|()<>\x60"'=/\\\\])(?:${names})(?=$|[\\s;&|()<>\x60"'])`);
}

function gitOperation(operation: string): RegExp {
  // Match only the subcommand, after global options such as -C repo, -c k=v, or --git-dir path,
  // so commit messages and `git stash push` don't ask. Option values can't start with "-",
  // which keeps the match linear on repeated options.
  const option = `-[Cc]\\s+[^\\s-]\\S*|--(?:git-dir|work-tree|namespace)\\s+[^\\s-]\\S*|-\\S+`;
  return new RegExp(`${executable("git").source}(?:\\s+(?:${option}))*\\s+(?:${operation})(?![\\w-])`);
}

export const rules: readonly Rule[] = [
  { reason: "Delete files or directories", pattern: executable("rm|rmdir|unlink|shred") },
  { reason: "Run with elevated or different user privileges", pattern: executable("sudo|doas|su") },
  { reason: "Change file permissions or ownership", pattern: executable("chmod|chown|chgrp") },
  { reason: "Write raw disks or change disk layout", pattern: executable("dd|mkfs(?:\\.[\\w-]+)?|wipefs|fdisk|sfdisk|parted") },
  { reason: "Publish Git changes", pattern: gitOperation("push") },
  {
    reason: "Reset, clean, restore, or discard Git changes",
    pattern: gitOperation("reset|clean|restore|checkout[^\\n;&|]*\\s(?:--|\\.)|stash\\s+(?:drop|clear)"),
  },
  {
    reason: "Delete a Git branch",
    pattern: gitOperation("branch[^\\n;&|]*\\s(?:-[a-zA-Z]*[dD]|--delete)"),
  },
  {
    reason: "Delete files using find or rsync",
    pattern: /\bfind\b[^\n;&|]*\s-delete\b|\brsync\b[^\n;&|]*\s--del(?:ete)?\b/,
  },
  {
    reason: "Run downloaded code in a shell",
    pipeline: true,
    pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:[^\s|;&]*\/)?(?:sh|bash|dash|zsh|ksh)\b|\b(?:sh|bash|dash|zsh|ksh)\b[^\n]*(?:<\(|\$\()\s*(?:curl|wget)\b/,
  },
];

export interface Decision {
  denied?: string; // Block without asking, even when the gate is off.
  reasons: string[]; // Ask with these reasons; none means run.
  pieces?: Piece[]; // Bash pieces that ask.
  files?: FileAsk[]; // Files that ask.
}

// One stage, or a whole pipeline when a rule spans it (curl ... | sh).
export interface Piece {
  text: string;
  stages: string[][]; // Words as written, one list per stage.
  allowable: boolean; // Whether any allow could cover it.
  reasons: string[];
}

export interface FileAsk {
  written: string; // As the tool or command wrote it.
  path: string; // Absolute, before following symlinks.
  access: Target["access"];
  reasons: string[];
  once: boolean; // A rule that can't be allowed for the session asks.
}

const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time"]);
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);

// What asks and denies compare: past variables, wrappers and keywords, with the command by name,
// so FOO=1 env /usr/bin/kubectl delete still matches kubectl delete. Allows compare words as written.
export function commandWords(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length) {
    if (/^[A-Za-z_]\w*=/.test(words[i]) || KEYWORDS.has(words[i])) i++;
    else if (WRAPPERS.has(words[i])) {
      i++;
      while (words[i]?.startsWith("-")) i++;
    } else break;
  }
  const rest = words.slice(i);
  if (rest.length > 0) rest[0] = rest[0].slice(rest[0].lastIndexOf("/") + 1);
  return rest;
}

// Words the shell could turn into a path elsewhere: options, variables, braces, brackets, ~user,
// a glob that can match "..", or a pipe between stages.
const UNSURE_PATH = /^$|^-|^~[^/]|[$`{}[\]|]|(?:^|\/)\.[*?]/;

// Where a path pattern's words are resolved. moved: a cd or a new HOME makes relative and ~ paths unknown.
export interface Where extends PathContext {
  moved: boolean;
}

// Whether a command word is a path inside a rule's path pattern, as written and through symlinks.
function inside(pattern: string, where: Where): (word: string) => boolean {
  const test = compilePattern({ pattern }, where);
  return (word) => !UNSURE_PATH.test(word) && (!where.moved || word.startsWith("/"))
    && candidates(word, where).every((path) => test(path, false));
}

// Whole words only: git push:* never matches git pushx. A path pattern matches one or more words;
// without a context it matches none.
function matches(rule: BashRule, words: readonly string[], where?: Where): boolean {
  const from = (r: number, w: number): boolean => {
    if (r === rule.words.length) return !rule.exact || w === words.length;
    const word = rule.words[r];
    if (!isPathPattern(word)) return word === words[w] && from(r + 1, w + 1);
    if (!where) return false;
    const test = inside(word, where);
    for (let end = w; end < words.length && test(words[end]); end++) if (from(r + 1, end + 1)) return true;
    return false;
  };
  return from(0, 0);
}

export const describe = (rule: { rule: string; reason?: string }) => rule.reason ?? `Matches ${rule.rule}`;
const denial = (rule: { rule: string; reason?: string }) => `denied by ${rule.rule}${rule.reason ? ` (${rule.reason})` : ""}`;

export function decideBash(command: string, userRules: readonly BashRule[] = [], context?: PathContext): Decision {
  const pieces: Piece[] = [];
  const allows = userRules.filter((rule) => rule.kind === "allow");
  const checks = userRules.filter((rule) => rule.kind !== "allow");
  const statements = parseCommand(command);
  const moved = statements.some(({ stages }) => stages.some(({ words }) =>
    ["cd", "pushd", "popd"].includes(commandWords(words)[0]) || words.some((word) => word.startsWith("HOME="))));
  const where = context && { ...context, moved };
  for (const { text, stages } of statements) {
    const pipes = stages.length - 1;
    const join = (lists: string[][]) => lists.flatMap((words, i) => (i ? ["|", ...words] : words));
    const pipeline = join(stages.map((stage) => stage.words));
    // An allow must be longer than what it overrides: built-in rules count -1, a bare Bash ask 0,
    // and an ask its word count, so a tie goes to the ask. Pipeline allows must span the pipeline.
    const covered = (strength: number, stage?: Stage) =>
      allows.some((allow) => allow.words.length > strength && (
        (stage !== undefined && allow.pipes === 0 && stage.allowable && matches(allow, stage.words, where)) ||
        (allow.pipes === pipes && stages.every((s) => s.allowable) && matches(allow, pipeline, where))
      ));
    for (const stage of stages) {
      const words = commandWords(stage.words);
      const asks = new Set<string>();
      for (const rule of checks) {
        if (rule.pipes > 0 || !matches(rule, words, where)) continue;
        if (rule.kind === "deny") return { denied: denial(rule), reasons: [] };
        if (!covered(rule.words.length, stage)) asks.add(describe(rule));
      }
      for (const rule of rules) {
        if (!rule.pipeline && rule.pattern.test(stage.text) && !covered(-1, stage)) asks.add(rule.reason);
      }
      if (asks.size > 0) pieces.push({ text: stage.text, stages: [stage.words], allowable: stage.allowable, reasons: [...asks] });
    }
    const seen = join(stages.map((stage) => commandWords(stage.words)));
    const asks = new Set<string>();
    for (const rule of checks) {
      if (rule.pipes === 0 || rule.pipes !== pipes || !matches(rule, seen, where)) continue;
      if (rule.kind === "deny") return { denied: denial(rule), reasons: [] };
      if (!covered(rule.words.length)) asks.add(describe(rule));
    }
    for (const rule of rules) {
      if (rule.pipeline && rule.pattern.test(text) && !covered(-1)) asks.add(rule.reason);
    }
    if (asks.size > 0) {
      const allowable = stages.every((stage) => stage.allowable);
      pieces.push({ text, stages: stages.map((stage) => stage.words), allowable, reasons: [...asks] });
    }
  }
  return { reasons: [...new Set(pieces.flatMap((piece) => piece.reasons))], pieces };
}

// Tool rules: deny beats allow, allow beats ask.
export function decideTool(name: string, userRules: readonly ToolRule[] = []): Decision {
  const hits = userRules.filter((rule) => rule.name.test(name));
  const deny = hits.find((rule) => rule.kind === "deny");
  if (deny) return { denied: denial(deny), reasons: [] };
  if (hits.some((rule) => rule.kind === "allow")) return { reasons: [] };
  return { reasons: hits.map(describe) };
}

// Secrets ask before any read or change, even when the gate is off. Your config can allow or deny them.
export function builtinPathRules(agentDir: string): PathRule[] {
  const rules: PathRule[] = [];
  type Access = PathRule["access"];
  const add = (kind: PathRule["kind"], pattern: string, reason: string, accesses: readonly Access[] = ["read", "edit"], once = false) => {
    for (const access of accesses) {
      rules.push({ kind, access, pattern, reason, rule: `${access === "read" ? "Read" : "Edit"}(${pattern})`, once });
    }
  };
  add("ask", ".env", "Secrets: .env file");
  add("ask", ".env.*", "Secrets: .env file");
  add("allow", ".env.example", "Example .env files hold no secrets");
  add("allow", ".env.sample", "Example .env files hold no secrets");
  add("ask", "~/.ssh", "Secrets: SSH keys");
  add("ask", "~/.aws", "Secrets: AWS credentials");
  add("ask", join(agentDir, "auth.json"), "Secrets: Pi provider credentials");
  add("ask", "*.pem", "Secrets: private key or certificate");
  add("ask", "*.key", "Secrets: private key");
  // The model could otherwise write itself an allow; edits only apply after /gate reload anyway.
  // Only ever allowed once: a session allow would let it rewrite the rules all session.
  add("ask", join(agentDir, "permission-gate.json"), "Change the permission gate's rules", ["edit"], true);
  return rules;
}

export interface PathContext {
  cwd: string;
  home: string;
}

export interface Target {
  path: string;
  access: "read" | "edit" | "any"; // Bash words could be either.
  folder?: boolean; // grep, find and ls read everything below a folder.
}

export function expandPath(path: string, { cwd, home }: PathContext): string {
  if (path === "~" || path.startsWith("~/")) return join(home, path.slice(2));
  return resolve(cwd, path);
}

// The path as written and, through symlinks in it or its nearest existing folder, the file it
// reaches (or would create).
function candidates(path: string, context: PathContext): string[] {
  const lexical = expandPath(path, context);
  let real: string | undefined;
  for (let base = lexical, rest = ""; real === undefined; rest = join(basename(base), rest), base = dirname(base)) {
    try {
      real = join(realpathSync(base), rest);
    } catch {
      if (base === dirname(base)) return [lexical];
    }
  }
  return real === lexical ? [lexical] : [lexical, real];
}

function globSource(glob: string): string {
  return glob.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) =>
    token === "**/" ? "(?:.*/)?" : token === "**" ? ".*" : token === "*" ? "[^/]*" : token === "?" ? "[^/]" : `\\${token}`);
}

// gitignore-style: without "/" a pattern names a file or folder anywhere; ~/, / and other paths are
// anchored (relative ones to the session's folder); a leading **/ floats. A match covers its contents.
function compilePattern({ pattern, exact }: Pick<PathRule, "pattern" | "exact">, context: PathContext): (path: string, folder: boolean) => boolean {
  // Session allows name one absolute path and nothing below it.
  if (exact) return (path) => path === pattern;
  const glob = pattern.replace(/(.)\/+$/, "$1");
  // ~, . and .. name folders, not file names.
  if (!glob.includes("/") && glob !== "~" && glob !== "." && glob !== "..") {
    const name = new RegExp(`^${globSource(glob)}$`);
    return (path) => path.split("/").some((part) => name.test(part));
  }
  if (glob.startsWith("**/")) {
    const tail = new RegExp(`(?:^|/)${globSource(glob.slice(3))}(?:/|$)`);
    return (path) => tail.test(path);
  }
  const anchored = expandPath(glob, context);
  const full = new RegExp(`^${globSource(anchored)}(?:/|$)`);
  const parts = anchored.split("/");
  const cut = parts.findIndex((part) => /[*?]/.test(part));
  const base = (cut < 0 ? parts : parts.slice(0, cut)).join("/") || "/";
  // A folder above the pattern is searched through too: grep across ~ reads ~/.ssh.
  return (path, folder) => full.test(path) || (folder && (path === "/" || base === path || base.startsWith(`${path}/`)));
}

// Per target: deny beats allow, allow beats ask.
export function decidePaths(targets: readonly Target[], pathRules: readonly PathRule[], context: PathContext): Decision {
  if (targets.length === 0) return { reasons: [] };
  const compiled = pathRules.map((rule) => ({ rule, test: compilePattern(rule, context) }));
  const files: FileAsk[] = [];
  for (const { path, access, folder = false } of targets) {
    const paths = candidates(path, context);
    const hits = compiled
      .filter(({ rule, test }) => (access === "any" || rule.access === access) && paths.some((p) => test(p, folder)))
      .map(({ rule }) => rule);
    const deny = hits.find((rule) => rule.kind === "deny");
    if (deny) return { denied: denial(deny), reasons: [] };
    if (hits.length === 0 || hits.some((rule) => rule.kind === "allow")) continue;
    const reasons = [...new Set(hits.map(describe))];
    files.push({ written: path, path: paths[0], access, reasons, once: hits.some((rule) => rule.once === true) });
  }
  return { reasons: [...new Set(files.flatMap((file) => file.reasons))], files };
}

const PATH_TOOLS = new Map([["read", false], ["grep", true], ["find", true], ["ls", true]]); // true: may be a folder

export function toolTargets(name: string, input: Record<string, unknown>): Target[] {
  const path = typeof input.path === "string" && input.path !== "" ? input.path : undefined;
  if (name === "write" || name === "edit") return path ? [{ path, access: "edit" }] : [];
  const folder = PATH_TOOLS.get(name);
  return folder === undefined ? [] : [{ path: path ?? ".", access: "read", folder }];
}

// Every word could be a path, including the value of --file=.env; redirections say which way.
export function bashTargets(command: string): Target[] {
  return parseCommand(command).flatMap(({ stages }) => stages.flatMap((stage) => [
    ...stage.words.flatMap((word) => [word, word.slice(word.indexOf("=") + 1)])
      .filter((path, i, list) => path !== "" && list.indexOf(path) === i)
      .map((path): Target => ({ path, access: "any" })),
    ...stage.redirects.map(({ path, write }): Target => ({ path, access: write ? "edit" : "read" })),
  ]));
}

export function approvalReasons(command: string): string[] {
  return decideBash(command).reasons;
}

export function displayText(text: string): string {
  // Preserve newlines, but make terminal controls and bidi controls visible.
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
