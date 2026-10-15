# pi-gatewarden

A permission gate for Pi: it asks before the agent runs risky shell commands, reads or
changes secret files, or calls tools you name. It started from Pi's
[permission-gate.ts example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts)
and is tested with Pi 1.1.0 on Linux. It has no dependencies.

It should work on macOS too. On native Windows its file rules don't match, so secret
files aren't guarded there.

**It's an accident guard, not a sandbox.** It catches common mistakes in what the agent
writes. It can't contain an agent that is determined or has been tricked. See
[Limitations](#limitations).

## Install

```sh
pi install git:github.com/Heineck66/pi-gatewarden
```

Run `/reload` in Pi, or start a new session. The footer should show `gate: on`. If it
doesn't, the gate isn't loaded: check `pi list`, then `/reload`.

Install it only once. Pi also loads any folder in `~/.pi/agent/extensions/` that has an
`index.ts`, even one named `.permission-gate.old`, and two copies mean two dialogs for
every command.

To remove the gate, run `pi remove git:github.com/Heineck66/pi-gatewarden`, then `/reload`.

## What asks by default

With no configuration, these ask before running.

**Bash commands.** Each command in a chain is checked on its own.

| Asks before | Commands |
|---|---|
| Deleting files | `rm`, `rmdir`, `unlink`, `shred`, also written `\rm` or `/usr/bin/rm` |
| Running as another user | `sudo`, `doas`, `su` |
| Changing permissions or owners | `chmod`, `chown`, `chgrp` |
| Writing disks | `dd`, `mkfs`, `mkfs.*`, `wipefs`, `fdisk`, `sfdisk`, `parted` |
| Publishing Git changes | `git push` |
| Discarding Git changes | `git reset`, `clean`, `restore`, `checkout -- <path>`, `checkout .`, `stash drop`, `stash clear` |
| Deleting Git branches | `git branch -d`, `-D`, `--delete` |
| Deleting with find or rsync | `find ... -delete`, `rsync --delete` |
| Running downloaded code | `curl ... \| sh`, `bash <(curl ...)`, `sh -c "$(curl ...)"` |

Only the Git subcommand counts, so `git commit -m "push fix"` doesn't ask.

**Files.** Reading or changing these asks, even when the gate is off:

| Files | Why |
|---|---|
| `.env` and `.env.*` in any folder, except `.env.example` and `.env.sample` | Secrets |
| `~/.ssh`, `~/.aws`, and everything in them | Keys and credentials |
| `*.pem`, `*.key` | Private keys and certificates |
| Pi's `auth.json` | Your provider logins |
| `permission-gate.json` (changes only) | The gate's own rules |

These rules cover Pi's `read`, `grep`, `find`, `ls`, `write`, and `edit` tools. They also
cover Bash commands that name the file, such as `cat .env`, `node --env-file=.env`, or
`echo key >> ~/.ssh/authorized_keys`. Using `grep`, `find`, or `ls` on a folder that
contains `~/.ssh`, `~/.aws`, or Pi's folder also asks, because they would look inside.

Everything else runs without asking.

## The dialog

```
───────────────────────────────────────────
 Permission required

 • Delete files or directories
 • Secrets: .env file

 in ~/code/app

   npm run build && rm -rf dist/cache
   cat .env | grep API_URL

 → Deny
   Allow once
   Allow for session…

 ↑↓ or j/k choose · Enter confirm · Tab add a message · Esc deny
───────────────────────────────────────────
```

The parts that asked, here `rm -rf dist/cache` and `.env`, are shown in red.

- **Deny** is preselected, so a stray Enter denies. Esc also denies.
- **Tab** on Deny opens a message field: say why, or what to do instead ("use trash",
  "why do you need to delete this?"). Enter denies and sends the message to the agent,
  which is told to follow it. Esc goes back to the choices; an empty message is a plain deny.
- The arrow keys or j/k move. Any other key moves the selection back to Deny, so text
  meant for the editor ends on Deny unless its last letter is j: in "just do it" the j
  moves down and the u moves back. Whatever you had typed before the dialog opened is
  still in the editor afterwards.
- **Allow once** runs this call only.
- **Allow for session…** runs it and allows similar calls until `/reload`, a restart, or
  `/gate clear`. See [Session allows](#session-allows).

If the agent makes several calls at once, their dialogs open one at a time. Each call is
checked again when its turn comes, so allowing the first for the session can answer the
rest.

A denied call tells the agent: "Do not retry this with a different command or tool; ask
the user." Without that, agents often work around a denial, for example by deleting
with Python after you deny `rm`.

A command longer than 40 rows shows its first 40. A note says how many rows are hidden
and how many of those have highlighted parts.

### Session allows

**Allow for session…** saves allows that last for this session:

- **Commands:** for each risky command you edit a suggested prefix. The suggestion is the
  command and its first argument, such as `git push:*` or `rm -rf:*`. End with `:*` to
  allow every command starting with those words, or remove it to allow only this exact
  command. A pipeline like `curl ... | sh` is suggested exactly, because the URL is what
  matters. If a prefix wouldn't let this command run, the dialog refuses it and says
  which rule still asks. Esc or an empty prefix denies the call.
- **Files:** exactly that file with that access, and nothing inside it. In a Bash command,
  naming a file counts as reading it; `> file` counts as changing it.
- **Tools:** that one tool name.

Session allows live in memory only. The footer counts them (`gate: on +2`),
`/permissions` lists them, and `/gate clear` drops them all. They last through `/gate off`,
`/gate on`, and `/gate reload`, but not `/reload` or a restart. Deny rules still win.

**Allow for session…** isn't offered when the call:

- changes `permission-gate.json` (only **Allow once** is offered);
- includes a command that no allow can cover: one with `$( )`, backticks, `<( )`, or
  output redirected to a file.

## Commands and flags

| | |
|---|---|
| `/gate off` | Stop asking about Bash commands and tools for this session. File rules and deny rules still apply. |
| `/gate on` | Start asking again. |
| `/gate` | Switch between on and off. |
| `/gate reload` | Re-read `permission-gate.json`. |
| `/gate clear` | Drop all session allows. |
| `/permissions` | Show the mode, your rules, session allows, and the built-in rules. |
| `pi --no-permission-gate` | Start a session with the gate off. |

The off switch is never saved. Every `/reload` or new session starts with the gate on,
unless the flag is given.

Put `--no-permission-gate` after your prompt, or write `--no-permission-gate=1`. Pi reads
the word after an extension flag as its value, so `pi --no-permission-gate "fix the
tests"` would lose the prompt. Any value turns the gate off, even `=0` or `=false`.

| Footer | Meaning |
|---|---|
| `gate: on` (dim) | Asking as usual. |
| `gate: off` (red) | Off for this session. |
| `gate: config error` (red) | `permission-gate.json` is broken; see [Errors](#errors). |
| `+N` after any of these | N session allows are active. |
| No `gate:` at all | The gate isn't loaded. |

## Your rules

Put your rules in `~/.pi/agent/permission-gate.json`, then run `/gate reload`. If you set
`PI_CODING_AGENT_DIR`, the file moves with Pi's other files. Without the file, only the
built-in rules apply.

```json
{
  "ask": ["Bash(kubectl delete:*)", "mcp__*"],
  "allow": ["Bash(chmod +x:*)", "Read(./.env.test)"],
  "deny": [{ "rule": "Bash(terraform destroy:*)", "reason": "Run it yourself" }]
}
```

- **ask** opens the dialog, **allow** runs without asking, and **deny** blocks without
  asking, even when the gate is off.
- Write a rule as a string, or as `{ "rule": "...", "reason": "..." }` to choose the text
  that the dialog shows and the agent reads. A rule without a reason shows
  "Matches <rule>".
- The gate reads the file only at startup and on `/gate reload`, so an edit, including
  one by the agent, does nothing until you reload. Changing the file through the agent
  asks first.
- The file is plain JSON: no comments, no trailing commas.

### Rule forms

| Rule | Matches |
|---|---|
| `Bash(git push:*)` | Bash commands that start with the words `git push` |
| `Bash(npm test)` | Exactly `npm test`, with no more words |
| `Bash(curl -fsSL https://sh.rustup.rs \| sh)` | That exact pipeline |
| `Bash` | Every Bash command |
| `Read(pattern)` | `read`, `grep`, `find`, and `ls` on matching paths, and Bash commands that name them |
| `Edit(pattern)` | `write` and `edit` on matching paths, and Bash commands that name them |
| `mcp__github__*` | Every call of matching tools; `*` matches anything, and case doesn't matter |

A tool-name rule that also matches `bash`, such as `*`, is a Bash rule too, so
`"ask": ["*"]` asks before every call of every tool.

### How Bash rules match

- Words are compared whole: `git push:*` matches `git push --tags` but not `git pushx`.
  Quotes work as in the shell: `Bash(git commit -m "wip")`.
- A prefix matches from the first word. `Bash(git push --force:*)` catches
  `git push --force origin`, but not `git push origin --force` or `git push -f`. List
  each form you care about.
- Each command in a chain (`;`, `&&`, `||`, `|`, `&`, or a new line) is checked on its
  own, including commands inside `$( )`, backticks, and `<( )`. A deny on any of them
  blocks the whole call.
- Asks and denies look past what comes before the command name: `FOO=1`, `env`,
  `command`, `exec`, `nohup`, `time`, shell words like `if` and `then`, and the folder in
  `/usr/bin/kubectl`. So `Bash(kubectl delete:*)` also catches
  `env FOO=1 /usr/local/bin/kubectl delete pod x`.
- Allows compare words as written. They never cover a command with `$( )`, backticks,
  `<( )`, or output redirected to a file (`2>&1` and `>/dev/null` are fine). So
  `Bash(git status:*)` doesn't allow `GIT_SSH_COMMAND=x git status` or
  `git status > notes.txt`.
- A rule can't contain `;`, `&`, `<`, `>`, backticks, parentheses, or new lines.

### How file patterns match

Patterns work like `.gitignore`:

| Pattern | Matches |
|---|---|
| `secrets`, `*.pem` | That name in any folder, and everything inside it |
| `~/notes`, `/etc/hosts` | That path, and everything inside it |
| `config/*.json`, `./config/*.json` | A path inside the session's folder |
| `**/secrets/**` | That path at any depth |
| `~`, `.`, `..` | Your home folder, the session's folder, its parent folder |

`*` matches within one folder name, `**` matches across folders, and `?` matches one
character. There's no `!` negation or `[abc]` set; brackets are matched literally.
Symlinks are followed, so reading a link to `~/.ssh/id_ed25519` asks like reading the key.

### Which rule wins

1. **Deny always wins**: over every allow, over the off switch, and without a dialog.
2. For Bash, when your ask and an allow both match, **the longer rule wins** and a tie
   asks. With `"ask": ["Bash(kubectl:*)"]` and `"allow": ["Bash(kubectl get:*)"]`, every
   `kubectl` command asks except `kubectl get`.
3. A matching allow beats the built-in Bash rules, and a matching `Bash(...)` allow beats
   a bare `"ask": ["Bash"]`.
4. For files and tools, a matching allow beats an ask.

### Recipes

Ask before every Bash command, except a few safe ones:

```json
{
  "ask": ["Bash"],
  "allow": ["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ls:*)", "Bash(npm test:*)"]
}
```

Never let the agent run some commands:

```json
{
  "deny": [
    { "rule": "Bash(terraform destroy:*)", "reason": "Run it yourself" },
    "Bash(git push --force:*)",
    "Bash(git push -f:*)"
  ]
}
```

Ask before MCP tools, except one read-only server:

```json
{ "ask": ["mcp__*"], "allow": ["mcp__docs__*"] }
```

Guard a private folder, and stop asking about a test `.env` and development certificates:

```json
{
  "ask": ["Read(~/Documents/private)", "Edit(~/Documents/private)"],
  "allow": ["Read(./.env.test)", "Read(./certs/*.pem)"]
}
```

Drop all the built-in Bash rules but keep your own Bash asks and every file rule:

```json
{ "allow": ["Bash"] }
```

### Errors

If the file isn't valid JSON or any rule is malformed, the whole file is rejected,
because skipping one bad line could silently drop a deny. Until you fix it and run
`/gate reload`:

- every Bash call asks;
- `/gate off` is refused;
- the built-in file rules still apply;
- the footer shows a red `gate: config error`, and `/permissions` names the problem.

## When the gate is off

`/gate off` and `--no-permission-gate` stop the Bash rules and the tool-name asks. File
rules, built-in and yours, and every deny still apply. An agent working with the gate off
still stops at `.env` and `~/.ssh`.

## Print, JSON, RPC, and Herdr

- **Print and JSON mode** have no dialog, so anything that would ask is blocked instead.
  With `--no-permission-gate`, only file rules and denies block.
- **RPC clients** get Pi's select dialog, then an editor prefilled with each session
  prefix. **Deny with message…** opens an editor for the message to the agent. A cancelled dialog denies. A client that never answers leaves the call waiting
  until the turn is aborted.
- **Herdr**: while a dialog is open, the gate emits `herdr:blocked`, so Herdr shows the
  pane as waiting for you. To run a Herdr agent without Bash prompts, start it with
  `pi "..." --no-permission-gate`. It still stops and waits in its pane if it touches a
  secret file.

## Limitations

- Only tool calls the agent makes through Pi are checked, including calls one tool makes
  through another (`ctx.executeTool()`). `!` and `!!` commands you type aren't checked.
  Other extensions can start processes directly, or change a tool's arguments after the
  gate has checked them.
- The gate doesn't fully parse Bash. Aliases, functions, variables, scripts, Git aliases
  (`git -c alias.p=push p`), and obfuscated commands can get past it. Your prefix rules
  don't look inside `bash -c "..."`, `eval`, or interpreters like `python -c`. The
  built-in rules see quoted text, but not what a script does once it runs. Many
  destructive commands aren't listed at all.
- File rules see paths as written. `$HOME/.ssh/id_ed25519`, globs the shell expands, and
  files a script opens get past them. A `grep` across a project can still print lines
  from a `.env` that isn't gitignored, because Pi's grep searches hidden files. Bash
  commands aren't treated as folder searches, so `grep -r KEY ~` doesn't ask.
- Approving a script approves everything it does.
- Rules err toward asking. Quoted examples, comments, dry runs (`git clean --dry-run`),
  and `find . -name "*.key"` all ask.
- The dialog queue orders this gate's dialogs only, not other extensions' dialogs.
- Nothing is logged, and allows from the dialog are never saved.

For real containment, run Pi in a container or VM. Pi's own security notes
(`docs/security.md`, installed with Pi) explain the options.

## Troubleshooting

- **No `gate:` in the footer.** The gate isn't loaded. Check `pi list`, then `/reload`.
  Check this first after a Pi upgrade.
- **Two dialogs for every command.** Two copies are loaded, such as the package and a
  folder under `~/.pi/agent/extensions/`. Remove one.
- **It keeps asking although I allowed it.** An allow doesn't cover `$( )`, a redirect to a
  file, or a leading `VAR=x`, and a tie with your own ask still asks. See
  [How Bash rules match](#how-bash-rules-match). When you choose a session prefix, the
  dialog names the rule that still asks.
- **`gate: config error`.** `/permissions` shows what's wrong with the file.
- **Pi stopped with "Rendered line exceeds terminal width".** The dialog drew a line wider
  than the terminal. The message names a `pi-tui-crash.log` file; report the bug with it.

## Development

| File | Does |
|---|---|
| `index.ts` | Pi hooks, `/gate` and `/permissions`, the footer, the dialog queue |
| `policy.ts` | The built-in rules, and how all rules decide a call |
| `shell.ts` | Splits Bash commands into the pieces rules check |
| `config.ts` | Loads `permission-gate.json` |
| `session.ts` | Turns dialog answers into session allows |
| `dialog.ts` | Draws the dialog in the terminal, and the select and editor fallback for RPC |

To work on a clone, install it from its folder. Pi loads it in place, so `/reload` picks
up your edits:

```sh
pi install /path/to/pi-gatewarden
```

To change a built-in rule, edit `policy.ts`, add an example to
`test/permission-gate.test.mjs`, and `/reload`. Run the tests from the clone:

```sh
node --test --test-timeout=30000 test/*.test.mjs
```

The tests need Node 22.19 or newer, for its TypeScript support, and no npm install. They
use a mocked Pi and a stand-in for pi-tui (`test/stubs/`). They never run the dangerous
example commands or read your real config.

## License

MIT. See [LICENSE](LICENSE).
