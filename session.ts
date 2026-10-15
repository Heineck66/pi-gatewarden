// Allows granted with the dialog's "Allow for session": in memory only, gone after /reload,
// a restart, or /gate clear. They beat asks like config allows do; denies still win.
import { type BashRule, type PathRule, parseConfig, type Rules, type ToolRule } from "./config.ts";
import { decideBash, type FileAsk, type Piece } from "./policy.ts";

export const emptyRules = (): Rules => ({ entries: [], bash: [], tools: [], paths: [] });

// Quote a word so parseCommand reads it back unchanged.
function quote(word: string): string {
  return /^[\w@%+=:,./~^-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

// Parses a prefix typed in the dialog and checks that it lets this piece run.
export function checkPrefix(input: string, piece: Piece, rules: readonly BashRule[]): { rule?: BashRule; error?: string } {
  if (!input.replace(/:\*$/, "").trim()) return { error: "Type a command, like git push:*" };
  let rule: BashRule;
  try {
    rule = parseConfig(JSON.stringify({ allow: [`Bash(${input})`] })).bash[0];
  } catch (error) {
    return { error: (error as Error).message.replace(/^allow\[0\]: /, "") };
  }
  const left = decideBash(piece.text, [...rules, rule]).reasons;
  return left.length > 0 ? { error: `Still asks: ${left.join("; ")}. Use a longer or different prefix.` } : { rule };
}

// A pipeline is suggested exactly, since the URL is what matters. Otherwise the command and its
// first argument, plus as many words as it takes to beat a user ask of the same length.
export function suggestPrefix(piece: Piece, rules: readonly BashRule[]): string {
  if (piece.stages.length > 1) return piece.stages.map((words) => words.map(quote).join(" ")).join(" | ");
  const words = piece.stages[0].map(quote);
  for (let n = Math.min(2, words.length); n <= words.length; n++) {
    const prefix = `${words.slice(0, n).join(" ")}:*`;
    if (!checkPrefix(prefix, piece, rules).error) return prefix;
  }
  return `${words.slice(0, 2).join(" ")}:*`;
}

// Exactly this file and this access. A Bash word could be either, so it is allowed as a read.
export function fileAllow({ path, access }: FileAsk): PathRule {
  const edit = access === "edit";
  return { kind: "allow", access: edit ? "edit" : "read", pattern: path, exact: true, rule: `${edit ? "Edit" : "Read"}(${path})` };
}

export function toolAllow(name: string): ToolRule {
  return { kind: "allow", rule: name, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") };
}

export function addRules(session: Rules, { bash = [], paths = [], tools = [] }: Partial<Rules>) {
  session.bash.push(...bash);
  session.paths.push(...paths);
  session.tools.push(...tools);
  session.entries.push(...bash, ...paths, ...tools);
}

// Prompts that can't be allowed for the session: pieces no allow could cover, and rules marked once.
export function sessionAllowed(pieces: readonly Piece[], files: readonly FileAsk[]): boolean {
  return pieces.every((piece) => piece.allowable) && !files.some((file) => file.once);
}
