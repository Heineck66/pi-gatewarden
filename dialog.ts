// The approval dialog: a custom component in the terminal, Pi's plain select and editor over RPC.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { displayText } from "./policy.ts";

export interface Prompt {
  bash: boolean;
  reasons: string[];
  cwd: string;
  subject: string; // The command, or the tool and its input.
  highlights: string[]; // Parts of the subject that asked.
  session?: Offer; // Missing when this can't be allowed for the session.
}

export interface Offer {
  pieces: { text: string; suggestion: string }[]; // One prefix to choose per Bash piece.
  also: string[]; // What else gets allowed, like "read ~/app/.env".
  check(index: number, prefix: string): string | undefined; // An error, or nothing when the prefix works.
}

export type Answer =
  | { choice: "deny"; message?: string } // The message, when given, goes to the agent.
  | { choice: "once" }
  | { choice: "session"; prefixes: string[] };

type Theme = ExtensionContext["ui"]["theme"];

const DENY = "Deny";
const DENY_WITH_MESSAGE = "Deny with message…";
const ONCE = "Allow once";
const MESSAGE_HELP = "Tell the agent why, or what to do instead.";
const SUBJECT_ROWS = 40;
const PREFIX_HELP =
  "End with :* to allow every command starting with these words; without it, only this exact command.";

const sessionLabel = (offer: Offer) => (offer.pieces.length > 0 ? "Allow for session…" : "Allow for session");

function sessionHint(offer: Offer): string {
  const parts = [...offer.also];
  const count = offer.pieces.length;
  if (count > 0) parts.push(count === 1 ? "a command prefix you choose next" : `${count} command prefixes you choose next`);
  return `Allows ${parts.join(", ")} until /reload or /gate clear.`;
}

// The tool name, then one line per argument with long values cut.
export function describeInput(name: string, input: Record<string, unknown>): string {
  return [name, ...Object.entries(input).map(([key, value]) => {
    const text = (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).replace(/\s+/g, " ");
    return `  ${key}: ${text.length > 200 ? `${text.slice(0, 200)}… (${text.length} characters)` : text}`;
  })].join("\n");
}

// Splits text into lines of [text, risky] segments, marking every occurrence of each needle.
export function markLines(text: string, needles: readonly string[]): [string, boolean][][] {
  const risky = new Uint8Array(text.length);
  for (const needle of needles) {
    if (!needle) continue;
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
      risky.fill(1, i, i + needle.length);
    }
  }
  let offset = 0;
  return text.split("\n").map((line) => {
    const segments: [string, boolean][] = [];
    for (let i = 0; i < line.length;) {
      const mark = risky[offset + i] === 1;
      let end = i;
      while (end < line.length && (risky[offset + end] === 1) === mark) end++;
      segments.push([line.slice(i, end), mark]);
      i = end;
    }
    offset += line.length + 1;
    return segments;
  });
}

function subjectRows(text: string, needles: readonly string[], width: number, theme: Theme): string[] {
  const rows: { row: string; risky: boolean }[] = [];
  for (const segments of markLines(text, needles)) {
    const line = segments
      .map(([part, risky]) => (risky ? theme.fg("error", theme.bold(displayText(part))) : theme.fg("text", displayText(part))))
      .join("");
    const risky = segments.some(([, mark]) => mark);
    for (const row of wrapTextWithAnsi(line, Math.max(1, width - 4))) rows.push({ row: `   ${row}`, risky });
  }
  if (rows.length <= SUBJECT_ROWS) return rows.map(({ row }) => row);
  // shortcut: long commands show their first rows only, until a scrolling view is worth building.
  const hidden = rows.slice(SUBJECT_ROWS);
  const marked = hidden.filter(({ risky }) => risky).length;
  const note = `   … ${hidden.length} more lines not shown${marked > 0 ? `, ${marked} of them highlighted` : ""}`;
  return [...rows.slice(0, SUBJECT_ROWS).map(({ row }) => row), theme.fg("warning", note)];
}

export function askTui(ctx: ExtensionContext, prompt: Prompt, signal?: AbortSignal): Promise<Answer> {
  return ctx.ui.custom<Answer>((tui, theme, keybindings, done) => {
    const offer = prompt.session;
    const choices = [DENY, ONCE, ...(offer ? [sessionLabel(offer)] : [])];
    let selected = 0; // Deny, so a stray Enter denies.
    let step = -1; // -1 while choosing, else the piece whose prefix is being edited.
    let writing = false; // True while writing a message to send with a denial.
    let error: string | undefined;
    let focused = false;
    let cache: { width: number; lines: string[] } | undefined;
    const prefixes: string[] = [];
    const input = new Input();

    const update = () => {
      cache = undefined;
      tui.requestRender();
    };
    const deny = () => done({ choice: "deny" });
    signal?.addEventListener("abort", deny, { once: true });
    if (signal?.aborted) deny();

    function edit(index: number) {
      const { suggestion } = offer!.pieces[index];
      step = index;
      error = undefined;
      input.setValue(suggestion);
      input.cursor = suggestion.length; // setValue leaves the cursor where it was.
      input.focused = focused;
      update();
    }

    function write(on: boolean) {
      writing = on;
      input.focused = focused && on;
      update();
    }

    // Esc while writing goes back to the choices, so a typed message isn't lost to a slip.
    input.onEscape = () => (writing ? write(false) : deny());
    input.onSubmit = (value) => {
      if (writing) {
        const message = value.trim();
        return done(message ? { choice: "deny", message } : { choice: "deny" });
      }
      const prefix = value.trim();
      if (!prefix) return deny();
      error = offer!.check(step, prefix);
      if (error) return update();
      prefixes.push(prefix);
      if (step + 1 < offer!.pieces.length) edit(step + 1);
      else done({ choice: "session", prefixes });
    };

    function choose() {
      if (selected === 0) deny();
      else if (selected === 1) done({ choice: "once" });
      else if (offer!.pieces.length === 0) done({ choice: "session", prefixes: [] });
      else edit(0);
    }

    function handleInput(data: string) {
      if (step >= 0 || writing) {
        input.handleInput(data);
        update();
      } else if (keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
        selected = Math.max(0, selected - 1);
        update();
      } else if (keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
        selected = Math.min(choices.length - 1, selected + 1);
        update();
      } else if (keybindings.matches(data, "tui.select.confirm")) choose();
      else if (keybindings.matches(data, "tui.select.cancel")) deny();
      else if (keybindings.matches(data, "tui.input.tab")) {
        if (selected === 0) write(true);
      } else if (selected !== 0) {
        // Any other key goes back to Deny: typing meant for the editor, like "just do it", must not leave
        // the j's Allow selected for the Enter that follows.
        selected = 0;
        update();
      }
    }

    function render(width: number): string[] {
      if (cache?.width === width) return cache.lines;
      const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width - 2)).map((row) => ` ${row}`);
      const border = theme.fg("warning", "─".repeat(width));
      const lines = [border];
      if (writing) {
        lines.push(...wrap(theme.fg("error", theme.bold("Deny"))), "");
        lines.push(...subjectRows(prompt.subject, prompt.highlights, width, theme), "");
        lines.push(...wrap(theme.fg("muted", MESSAGE_HELP)));
        lines.push(...input.render(Math.max(1, width - 1)).map((row) => ` ${row}`));
        lines.push("", ...wrap(theme.fg("dim", "Enter deny · Esc back")));
      } else if (step < 0) {
        lines.push(...wrap(theme.fg("warning", theme.bold("Permission required"))), "");
        for (const reason of prompt.reasons) lines.push(...wrap(theme.fg("warning", `• ${displayText(reason)}`)));
        lines.push("", ...wrap(theme.fg("dim", `in ${displayText(prompt.cwd)}`)), "");
        lines.push(...subjectRows(prompt.subject, prompt.highlights, width, theme), "");
        choices.forEach((choice, i) => lines.push(i === selected ? ` ${theme.fg("accent", `→ ${choice}`)}` : `   ${choice}`));
        lines.push("");
        if (offer && selected === 2) lines.push(...wrap(theme.fg("muted", sessionHint(offer))));
        const tab = selected === 0 ? " · Tab add a message" : "";
        lines.push(...wrap(theme.fg("dim", `↑↓ or j/k choose · Enter confirm${tab} · Esc deny`)));
      } else {
        const count = offer!.pieces.length;
        lines.push(...wrap(theme.fg("accent", theme.bold(`Allow for this session${count > 1 ? ` (${step + 1} of ${count})` : ""}`))), "");
        lines.push(...subjectRows(offer!.pieces[step].text, [], width, theme), "");
        lines.push(...wrap(theme.fg("muted", PREFIX_HELP)));
        lines.push(...input.render(Math.max(1, width - 1)).map((row) => ` ${row}`));
        if (error) lines.push(...wrap(theme.fg("error", `✗ ${displayText(error)}`)));
        lines.push("", ...wrap(theme.fg("dim", "Enter save · Esc or empty deny")));
      }
      lines.push(border);
      // Pi stops with an error if any line is wider than the terminal.
      cache = { width, lines: lines.map((line) => truncateToWidth(line, width)) };
      return cache.lines;
    }

    return {
      render,
      handleInput,
      invalidate: () => { cache = undefined; },
      dispose: () => signal?.removeEventListener("abort", deny),
      get focused() { return focused; },
      set focused(value: boolean) {
        focused = value;
        input.focused = value && (step >= 0 || writing);
        cache = undefined;
      },
    };
  });
}

// RPC clients get Pi's select, then an editor for the denial message or each prefix.
export async function askRpc(ctx: ExtensionContext, prompt: Prompt, signal?: AbortSignal): Promise<Answer> {
  const offer = prompt.session;
  const options = [DENY, ONCE, ...(offer ? [sessionLabel(offer)] : []), DENY_WITH_MESSAGE];
  const title = [
    "Permission required",
    ...prompt.reasons.map((reason) => `• ${reason}`),
    `\nWorking directory: ${prompt.cwd}`,
    `\n${prompt.subject}\n`,
    ...(offer ? [`${sessionLabel(offer)}: ${sessionHint(offer)}`] : []),
    prompt.bash ? "Allow this command?" : "Allow this tool call?",
  ].join("\n");
  const choice = await ctx.ui.select(displayText(title), options, { signal });
  if (choice === ONCE) return { choice: "once" };
  if (choice === DENY_WITH_MESSAGE && !signal?.aborted) {
    const message = (await ctx.ui.editor(`${MESSAGE_HELP} Leave it empty to deny without one.`, ""))?.trim();
    return message ? { choice: "deny", message } : { choice: "deny" };
  }
  if (!offer || choice !== sessionLabel(offer)) return { choice: "deny" };
  const prefixes: string[] = [];
  for (const [index, piece] of offer.pieces.entries()) {
    let value = piece.suggestion;
    let error: string | undefined;
    // Three tries, so a client that keeps answering with a bad prefix can't loop forever.
    for (let attempt = 0; ; attempt++) {
      if (attempt === 3 || signal?.aborted) return { choice: "deny" };
      const lines = [error && `✗ ${error}`, `Allow for this session: ${piece.text}`, PREFIX_HELP, "Clear the text to deny."];
      const answer = await ctx.ui.editor(displayText(lines.filter(Boolean).join("\n")), value);
      const prefix = answer?.trim();
      if (!prefix) return { choice: "deny" };
      error = offer.check(index, prefix);
      if (!error) {
        prefixes.push(prefix);
        break;
      }
      value = answer!;
    }
  }
  return { choice: "session", prefixes };
}
