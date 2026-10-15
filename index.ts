/**
 * pi-gatewarden: a permission gate for Pi, based on Pi's permission-gate.ts example.
 * Guards model-issued tool calls, including nested calls through Pi: Bash by the built-in rules
 * in policy.ts and your rules in permission-gate.json, files by path rules, other tools by name.
 * Extension-internal execution and user ! commands are out of scope.
 */
import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig } from "./config.ts";
import { askRpc, askTui, describeInput, type Offer, type Prompt } from "./dialog.ts";
import {
  bashTargets, builtinPathRules, decideBash, decidePaths, decideTool, type FileAsk, type Piece, rules, toolTargets,
} from "./policy.ts";
import { addRules, checkPrefix, emptyRules, fileAllow, sessionAllowed, suggestPrefix, toolAllow } from "./session.ts";

const OFF_FLAG = "no-permission-gate";
const STATUS = "permission-gate";
const COMMANDS = ["on", "off", "reload", "clear"];

function blocked(reason: string): ToolCallEventResult {
  // Models tend to route around a block (shutil.rmtree after a denied rm) unless told not to.
  return { block: true, reason: `Permission gate: ${reason}. Do not retry this with a different command or tool; ask the user.` };
}

// The parts of a tool_call event the gate reads.
interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

interface Check {
  denied?: string;
  reasons: string[];
  pieces: Piece[];
  files: FileAsk[];
  tool?: string; // Set when a tool rule asks.
}

export default function permissionGate(pi: ExtensionAPI) {
  // Each instance has its own queue; no saved approvals or persistent bypasses.
  let pending: Promise<void> = Promise.resolve();
  // Set by /gate and never saved, so every reload or restart starts from the flag again.
  let switchedOn: boolean | undefined;
  const path = configPath();
  const home = homedir();
  const secrets = builtinPathRules(dirname(path));
  let config = loadConfig(path);
  let session = emptyRules();
  // A config error keeps the gate on: the broken file may have held your denies.
  const on = () => config.error !== undefined || (switchedOn ?? pi.getFlag(OFF_FLAG) !== true);
  const tilde = (p: string) => (p === home || p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p);
  const bashRules = () => [...config.rules.bash, ...session.bash];

  function configSummary() {
    if (config.error) return `Config error in ${path}: ${config.error}`;
    const count = config.rules.entries.length;
    return config.found ? `Config: ${path} (${count} rule${count === 1 ? "" : "s"})` : `Config: none at ${path}`;
  }

  function showStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const { theme } = ctx.ui;
    const red = (text: string) => theme.fg("error", theme.bold(text));
    const allows = session.entries.length > 0 ? ` +${session.entries.length}` : "";
    ctx.ui.setStatus(
      STATUS,
      config.error ? red(`gate: config error${allows}`) : on() ? theme.fg("dim", `gate: on${allows}`) : red(`gate: off${allows}`),
    );
  }

  function warn(ctx: ExtensionContext) {
    if (config.error) {
      ctx.ui.notify(`${configSummary()}\nEvery Bash call asks until you fix it and run /gate reload.`, "error");
    } else if (!on()) {
      ctx.ui.notify(
        "Permission gate is OFF: Bash commands run without asking. File rules and denies still apply. /gate on turns it back on.",
        "warning",
      );
    }
  }

  pi.registerFlag(OFF_FLAG, {
    description: "Start with the permission gate off; /gate on turns it back on",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    showStatus(ctx);
    if (ctx.hasUI) warn(ctx);
  });

  pi.registerCommand("gate", {
    description: "Switch the permission gate, re-read its config, or drop session allows: /gate [on|off|reload|clear]",
    getArgumentCompletions: (prefix) => {
      const matches = COMMANDS.filter((value) => value.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "reload") {
        config = loadConfig(path);
        showStatus(ctx);
        if (!config.error) ctx.ui.notify(configSummary(), "info");
        warn(ctx);
        return;
      }
      if (arg === "clear") {
        const count = session.entries.length;
        session = emptyRules();
        showStatus(ctx);
        ctx.ui.notify(`Cleared ${count} session allow${count === 1 ? "" : "s"}.`, "info");
        return;
      }
      if (arg !== "" && arg !== "on" && arg !== "off") {
        ctx.ui.notify("Usage: /gate [on|off|reload|clear]", "error");
        return;
      }
      const next = arg === "" ? !on() : arg === "on";
      if (!next && config.error) {
        ctx.ui.notify(`Fix ${path} and run /gate reload before turning the gate off.`, "error");
        return;
      }
      switchedOn = next;
      showStatus(ctx);
      if (next) ctx.ui.notify("Permission gate is ON.", "info");
      else warn(ctx);
    },
  });

  pi.registerCommand("permissions", {
    description: "Show permission gate mode, your rules, session allows, and the built-in rules",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          `Permission gate: ${on() ? "on" : "OFF"}.`,
          configSummary(),
          ...config.rules.entries.map(({ kind, rule, reason }) => `• ${kind} ${rule}${reason ? ` (${reason})` : ""}`),
          `Session allows (until /reload or /gate clear): ${session.entries.length > 0 ? "" : "none"}`,
          ...session.entries.map(({ rule }) => `• allow ${rule}`),
          "Built-in Bash rules:",
          ...rules.map(({ reason }) => `• ${reason}`),
          "Built-in file rules (on even when off):",
          ...new Set(secrets.map(({ kind, pattern, reason }) => `• ${kind} ${pattern}: ${reason}`)),
          "Deny is the default. No UI means deny. Deny rules apply even when off.",
          `/gate on|off switches it for this session, /gate reload re-reads the config, /gate clear drops session allows, pi --${OFF_FLAG} starts it off.`,
          "Accident guard, not a sandbox.",
        ].join("\n"),
        "info",
      );
    },
  });

  function check(event: ToolCall, ctx: ExtensionContext): Check {
    const bash = event.toolName === "bash";
    const command = event.input.command as string;
    const call = bash
      ? decideBash(command, bashRules())
      : decideTool(event.toolName, [...config.rules.tools, ...session.tools]);
    const files = decidePaths(
      bash ? bashTargets(command) : toolTargets(event.toolName, event.input),
      [...secrets, ...config.rules.paths, ...session.paths],
      { cwd: ctx.cwd, home },
    );
    const denied = call.denied ?? files.denied;
    // OFF keeps the file rules: secrets and the gate's own config stay guarded.
    const gated = on() && !denied;
    return {
      denied,
      reasons: [...new Set([...(gated ? call.reasons : []), ...files.reasons])],
      pieces: gated ? call.pieces ?? [] : [],
      files: files.files ?? [],
      tool: gated && !bash && call.reasons.length > 0 ? event.toolName : undefined,
    };
  }

  function prompt(event: ToolCall, ctx: ExtensionContext, found: Check): Prompt {
    const bash = event.toolName === "bash";
    const offer: Offer | undefined = sessionAllowed(found.pieces, found.files)
      ? {
        pieces: found.pieces.map((piece) => ({ text: piece.text, suggestion: suggestPrefix(piece, bashRules()) })),
        also: [
          ...found.files.map((file) => `${file.access === "edit" ? "change" : "read"} ${tilde(file.path)}`),
          ...(found.tool ? [`every ${found.tool} call`] : []),
        ],
        check: (index, prefix) => checkPrefix(prefix, found.pieces[index], bashRules()).error,
      }
      : undefined;
    return {
      bash,
      reasons: found.reasons,
      cwd: tilde(ctx.cwd),
      subject: bash ? (event.input.command as string) : describeInput(event.toolName, event.input),
      highlights: bash
        // Single characters like "." or "~" would mark half the command.
        ? [...found.pieces.map((piece) => piece.text), ...found.files.map((file) => file.written)].filter((text) => text.length > 1)
        : found.files.map((file) => `path: ${file.written}`),
      session: offer,
    };
  }

  function allowForSession(found: Check, prefixes: string[], ctx: ExtensionContext) {
    const bash = prefixes.map((prefix, i) => {
      const { rule, error } = checkPrefix(prefix, found.pieces[i], bashRules());
      if (!rule) throw new Error(error); // Fails closed in the caller.
      return rule;
    });
    const added = { bash, paths: found.files.map(fileAllow), tools: found.tool ? [toolAllow(found.tool)] : [] };
    addRules(session, added);
    showStatus(ctx);
    const names = [...added.bash, ...added.paths, ...added.tools].map(({ rule }) => rule).join(", ");
    ctx.ui.notify(`Allowed for this session: ${names}. /gate clear drops it.`, "info");
  }

  pi.on("tool_call", async (event, ctx) => {
    const bash = event.toolName === "bash";
    if (bash && typeof event.input.command !== "string") return blocked("invalid Bash command");
    const first = check(event, ctx);
    if (first.denied) return blocked(first.denied);
    if (first.reasons.length === 0) return undefined;
    if (!ctx.hasUI) return blocked(`${first.reasons.join("; ")} (no UI for confirmation)`);

    // Capture the turn's signal before waiting; a later turn must not own this prompt.
    const signal = ctx.signal;
    const request = pending.then(async () => {
      if (signal?.aborted) return blocked("approval cancelled");
      // Check again: an earlier dialog may have allowed this for the session, or the rules changed.
      const found = check(event, ctx);
      if (found.denied) return blocked(found.denied);
      if (found.reasons.length === 0) return undefined;
      pi.events.emit("herdr:blocked", {
        active: true,
        label: bash ? "Waiting for command approval" : "Waiting for tool approval",
      });
      try {
        const ask = ctx.mode === "tui" ? askTui : askRpc;
        const answer = await ask(ctx, prompt(event, ctx, found), signal);
        if (signal?.aborted) return blocked("approval cancelled");
        if (answer.choice === "deny") {
          if (!answer.message) return blocked("denied by the user");
          return {
            block: true,
            reason: `Permission gate: denied by the user. The user says: ${answer.message}\n`
              + "Follow the user's message; do not otherwise retry this with a different command or tool.",
          };
        }
        if (answer.choice === "session") allowForSession(found, answer.prefixes, ctx);
        return undefined;
      } catch {
        // A failed dialog must never turn into permission to execute.
        return blocked("approval dialog failed");
      } finally {
        // Balance Herdr's blocked counter even on denial, cancellation, or UI failure.
        pi.events.emit("herdr:blocked", { active: false });
      }
    });

    // Serialize this extension's dialogs, even when tool calls run in parallel.
    pending = request.then(() => undefined, () => undefined);
    return request;
  });
}
