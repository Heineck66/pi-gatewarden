// Loads ~/.pi/agent/permission-gate.json. Any problem rejects the whole file and fails closed,
// because skipping one bad line could silently drop a deny.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCommand } from "./shell.ts";

export type Kind = "ask" | "allow" | "deny";

export interface Entry {
  kind: Kind;
  rule: string;
  reason?: string;
}

export interface BashRule extends Entry {
  words: string[]; // Pipeline stages are separated by a "|" word.
  exact: boolean;
  pipes: number;
}

export interface ToolRule extends Entry {
  name: RegExp;
}

// Read covers read, grep, find and ls; Edit covers write and edit. Bash words are checked against both.
export interface PathRule extends Entry {
  access: "read" | "edit";
  pattern: string;
  exact?: boolean; // The pattern is one absolute path, nothing below it.
  once?: boolean; // Never offered for the session.
}

export interface Rules {
  entries: Entry[];
  bash: BashRule[];
  tools: ToolRule[];
  paths: PathRule[];
}

export interface Config {
  path: string;
  found: boolean;
  rules: Rules;
  error?: string;
}

const KINDS: readonly string[] = ["ask", "allow", "deny"];

export function configPath(): string {
  // Same agent folder as Pi: PI_CODING_AGENT_DIR moves it.
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "permission-gate.json");
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, found: false, rules: parseConfig("{}") };
    return failClosed(path, (error as Error).message);
  }
  try {
    return { path, found: true, rules: parseConfig(text) };
  } catch (error) {
    return failClosed(path, (error as Error).message);
  }
}

function failClosed(path: string, error: string): Config {
  const reason = "Config error: every Bash call asks until permission-gate.json is fixed";
  return { path, found: true, error, rules: parseConfig(JSON.stringify({ ask: [{ rule: "Bash", reason }] })) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfig(text: string): Rules {
  const data: unknown = JSON.parse(text);
  if (!isObject(data)) throw new Error("the file must hold a JSON object");
  const rules: Rules = { entries: [], bash: [], tools: [], paths: [] };
  for (const [kind, list] of Object.entries(data)) {
    if (!KINDS.includes(kind)) throw new Error(`unknown key "${kind}"; use "ask", "allow", or "deny"`);
    if (!Array.isArray(list)) throw new Error(`"${kind}" must be a list`);
    list.forEach((item, index) => addRule(rules, kind as Kind, item, `${kind}[${index}]`));
  }
  return rules;
}

function addRule(rules: Rules, kind: Kind, item: unknown, where: string) {
  let entry: Entry;
  if (typeof item === "string") entry = { kind, rule: item.trim() };
  else if (isObject(item) && typeof item.rule === "string") {
    const extra = Object.keys(item).find((key) => key !== "rule" && key !== "reason");
    if (extra) throw new Error(`${where}: unknown key "${extra}"`);
    if (item.reason !== undefined && (typeof item.reason !== "string" || !item.reason.trim())) {
      throw new Error(`${where}: "reason" must be non-empty text`);
    }
    entry = { kind, rule: item.rule.trim(), reason: item.reason };
  } else throw new Error(`${where} must be a rule string or { "rule": ..., "reason": ... }`);

  const bash = /^bash\((.*)\)$/is.exec(entry.rule);
  const path = /^(read|edit)\((.*)\)$/is.exec(entry.rule);
  if (bash) {
    rules.bash.push({ ...entry, ...bashPattern(bash[1], where) });
  } else if (path) {
    const pattern = path[2].trim();
    if (!pattern || pattern.includes("\n") || pattern.startsWith("!")) {
      throw new Error(`${where}: ${path[1]}(...) needs a path pattern without newlines or a leading "!"`);
    }
    rules.paths.push({ ...entry, access: path[1].toLowerCase() as PathRule["access"], pattern });
  } else if (/^[\w.*-]+$/.test(entry.rule)) {
    const name = new RegExp(`^${entry.rule.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`, "i");
    // A tool name covering Bash, like "Bash" or "*", is a rule for every Bash command.
    if (name.test("bash")) rules.bash.push({ ...entry, words: [], exact: false, pipes: 0 });
    rules.tools.push({ ...entry, name });
  } else {
    throw new Error(`${where}: "${entry.rule}" is not a rule; use Bash(...), Read(path), Edit(path), or a tool name`);
  }
  rules.entries.push(entry);
}

function bashPattern(inner: string, where: string) {
  const exact = !inner.endsWith(":*");
  const body = exact ? inner : inner.slice(0, -2);
  // A rule names one command or pipeline, so it can't hold separators, redirections, or substitutions.
  if (/[;&<>`()\n]/.test(body)) throw new Error(`${where}: Bash rules can't contain ; & < > \` ( ) or newlines`);
  const statements = parseCommand(body);
  if (statements.length !== 1) throw new Error(`${where}: Bash(...) needs a command; use "Bash" for every command`);
  const { stages } = statements[0];
  if (!stages.every((stage) => stage.allowable)) throw new Error(`${where}: unbalanced quote in "${inner}"`);
  return { words: stages.flatMap((stage, i) => (i ? ["|", ...stage.words] : stage.words)), exact, pipes: stages.length - 1 };
}
