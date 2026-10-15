// A small Bash tokenizer for permission rules, NOT a full shell parser. It errs toward asking:
// a stage it can't follow (substitutions, file redirects, open quotes) can never be allowed.
export interface Stage {
  text: string; // Source text, including heredoc bodies, for the built-in regex rules.
  words: string[]; // Unquoted words; redirections and their targets are left out.
  redirects: { path: string; write: boolean }[]; // Files redirected to or from.
  allowable: boolean;
}

export interface Statement {
  text: string;
  stages: Stage[]; // Pipeline stages, split on | and |&.
}

type Redirect = "out" | "dup" | "in" | "heredoc" | "heredoc-strip";

// Index of the ")" closing src[open], or src.length when it never closes.
function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c) i += c === '"' && src[i] === "\\" ? 2 : 1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return src.length;
}

// Statements are split on ; & && || newlines and parentheses. Commands inside $( ), backticks,
// <( ) and >( ) come back as extra statements whose stages can never be allowed.
export function parseCommand(command: string, nested = false): Statement[] {
  // Bash removes line continuations first, which can join a command name: su\<newline>do.
  const src = command.replace(/\\\r?\n/g, "");
  const statements: Statement[] = [];
  const inner: Statement[] = [];
  const heredocs: { delimiter: string; strip: boolean }[] = [];
  let stages: Stage[] = [];
  let words: string[] = [];
  let redirects: Stage["redirects"] = [];
  let word = "";
  let inWord = false;
  let allowable = !nested;
  let redirect: Redirect | undefined;
  let stageStart = 0;
  let statementStart = 0;
  let i = 0;

  const endWord = () => {
    if (!inWord) return;
    const fd = redirect === "dup" && /^(?:\d+-?|-)$/.test(word);
    if (redirect === "out" || (redirect === "dup" && !fd)) {
      allowable &&= word === "/dev/null";
      redirects.push({ path: word, write: true });
    } else if (redirect === "in") redirects.push({ path: word, write: false });
    else if (redirect === "heredoc" || redirect === "heredoc-strip") {
      heredocs.push({ delimiter: word, strip: redirect === "heredoc-strip" });
    } else if (!redirect) words.push(word);
    redirect = undefined;
    word = "";
    inWord = false;
  };
  const endStage = (end: number) => {
    endWord();
    if (redirect) allowable = false; // A redirection with no target.
    redirect = undefined;
    // Keep a bare redirection too: "> file" empties the file.
    if (words.length > 0 || redirects.length > 0) {
      stages.push({ text: src.slice(stageStart, end).trim(), words, redirects, allowable });
    }
    words = [];
    redirects = [];
    allowable = !nested;
  };
  const endStatement = (end: number) => {
    endStage(end);
    if (stages.length > 0) statements.push({ text: src.slice(statementStart, end).trim(), stages });
    stages = [];
  };
  const restart = (index: number, statement: boolean) => {
    i = index;
    stageStart = index;
    if (statement) statementStart = index;
  };
  // Parses the command inside a substitution; returns the index of its closing character.
  const substitution = (open: number, close: number) => {
    inner.push(...parseCommand(src.slice(open + 1, close), true));
    allowable = false;
    inWord = true;
    return close;
  };
  const backtick = (open: number) => {
    let close = open + 1;
    while (close < src.length && src[close] !== "`") close += src[close] === "\\" ? 2 : 1;
    return substitution(open, Math.min(close, src.length));
  };
  // Heredoc bodies are data: skip them so an apostrophe in a commit message can't derail quoting.
  const skipHeredocs = (from: number) => {
    for (const { delimiter, strip } of heredocs.splice(0)) {
      while (from < src.length) {
        const end = src.indexOf("\n", from);
        let line = src.slice(from, end < 0 ? src.length : end).replace(/\r$/, "");
        if (strip) line = line.replace(/^\t+/, "");
        from = end < 0 ? src.length : end + 1;
        if (line === delimiter) break;
      }
    }
    return from;
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "'") {
      inWord = true;
      const end = src.indexOf("'", i + 1);
      if (end < 0) allowable = false;
      word += src.slice(i + 1, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          word += '$`"\\'.includes(src[i + 1]) ? src[i + 1] : src.slice(i, i + 2);
          i += 2;
        } else if (src[i] === "$" && src[i + 1] === "(") {
          const close = substitution(i + 1, closingParen(src, i + 1));
          word += src.slice(i, close + 1);
          i = close + 1;
        } else if (src[i] === "`") {
          const close = backtick(i);
          word += src.slice(i, close + 1);
          i = close + 1;
        } else word += src[i++];
      }
      if (i >= src.length) allowable = false;
      i++;
    } else if (c === "\\") {
      inWord = true;
      word += next ?? "";
      i += 2;
    } else if ((c === "$" || ((c === "<" || c === ">") && !inWord)) && next === "(") {
      const close = substitution(i + 1, closingParen(src, i + 1));
      word += src.slice(i, close + 1);
      i = close + 1;
    } else if (c === "`") {
      const close = backtick(i);
      word += src.slice(i, close + 1);
      i = close + 1;
    } else if (c === "#" && !inWord) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
    } else if (c === "\n") {
      endWord();
      const end = skipHeredocs(i + 1);
      endStatement(end);
      restart(end, true);
    } else if (c === ";" || c === "(" || c === ")" || (c === "&" && next !== ">") || (c === "|" && next === "|")) {
      endStatement(i);
      restart(i + ((c === "&" && next === "&") || c === "|" ? 2 : 1), true);
    } else if (c === "|") {
      endStage(i);
      restart(i + (next === "&" ? 2 : 1), false);
    } else if (c === ">" || c === "<" || c === "&") {
      if (inWord && /^\d+$/.test(word)) {
        word = ""; // A file descriptor, as in 2>.
        inWord = false;
      } else endWord();
      const op = /^(?:&>>?|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(src.slice(i, i + 3))![0];
      redirect = op === "<<<" || op === "<" ? "in" : op === "<<" ? "heredoc" : op === "<<-" ? "heredoc-strip"
        : op === ">&" || op === "<&" ? "dup" : "out";
      i += op.length;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endStatement(src.length);
  return [...statements, ...inner];
}
