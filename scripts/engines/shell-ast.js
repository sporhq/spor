"use strict";
// A small, total POSIX/bash command parser for the pre-tool kill guard
// (issue-spor-kill-guard-structural-selector-to-kill-flow). It recovers the
// STRUCTURE a regex over the raw string cannot: which words are executed code
// and which are quoted data, where pipelines, compound commands
// (`while … do … done`, `{ …; }`, `( … )`, `for`, `if`, `case`, functions) begin
// and end, and every nested command string the shell itself runs — command
// substitutions `$(…)`/backticks (also inside double quotes), process
// substitutions `<(…)`/`>(…)`, array assignments and unquoted heredoc bodies.
//
// It is not a shell: no expansion is performed, and malformed input never
// throws — an unterminated quote is read as a literal character and a stray
// operator is skipped, so a parse always returns a tree.
//
// Tree shape:
//   list     { type: "list", items: [pipeline] }        (`;` `&&` `||` `&` newline)
//   pipeline { type: "pipeline", stages: [command] }    (`|` `|&`)
//   command  { type: "simple", assigns: [word], words: [word], redirs: [redir] }
//          | { type: "group"|"subshell", body: list, redirs }
//          | { type: "if", lists: [list], redirs }
//          | { type: "loop", cond: list, body: list, redirs }       (while/until)
//          | { type: "for", name, words: [word], body: list, redirs }
//          | { type: "case", word, bodies: [list], redirs }
//          | { type: "func", body: command }
//   word     { text, raw, quoted, subs: [{ kind: "cmd"|"in"|"out"|"array", ast: list }] }
//   redir    { op, target: word|null, heredoc?: { body, quoted, subs } }

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const REDIR_OPS = ["&>>", "<<<", "<<-", "<<", ">>", "<>", ">&", "<&", ">|", "&>", "<", ">"];
const MAX_DEPTH = 12;
// Compound-command nesting (`(`, `{`, `if`, `while`, `name()`, arrays) across
// all parsers of one input; past it the remaining input is left unparsed
// rather than overflowing the stack.
const MAX_NEST = 200;

class Parser {
  constructor(src, pos = 0, depth = 0) {
    this.src = src;
    this.pos = pos;
    this.depth = depth;
    this.peeked = null;
    this.consumed = 0;
    this.nest = 0;
    this.pendingHeredocs = [];
  }

  // A child parser for a nested command string; past MAX_DEPTH it is parsed
  // as an empty list (the caller still advances past it).
  child(src, pos) {
    const p = new Parser(src, pos, this.depth + 1);
    p.nest = this.nest;
    return p;
  }

  // ---- lexer -------------------------------------------------------------

  skipBlanks() {
    const s = this.src;
    for (;;) {
      const c = s[this.pos];
      if (c === " " || c === "\t" || c === "\r") this.pos++;
      else if (c === "\\" && s[this.pos + 1] === "\n") this.pos += 2;
      else if (c === "#") {
        while (this.pos < s.length && s[this.pos] !== "\n") this.pos++;
      } else return;
    }
  }

  peek() {
    if (!this.peeked) {
      const save = this.pos;
      const tok = this.readToken();
      this.peeked = { tok, end: this.pos };
      this.pos = save;
    }
    return this.peeked.tok;
  }

  next() {
    const tok = this.peek();
    this.pos = this.peeked.end;
    this.peeked = null;
    this.consumed++;
    if (tok.op === "\n") this.readHeredocBodies();
    return tok;
  }

  readToken() {
    this.skipBlanks();
    const s = this.src;
    const i = this.pos;
    if (i >= s.length) return { eof: true };
    const c = s[i];
    const two = s.slice(i, i + 2);
    const three = s.slice(i, i + 3);
    if (c === "\n") return this.advance(1, { op: "\n" });
    if (three === ";;&") return this.advance(3, { op: ";;" });
    if (two === ";;" || two === ";&") return this.advance(2, { op: ";;" });
    if (two === "&&" || two === "||" || two === "|&") return this.advance(2, { op: two === "|&" ? "|" : two });
    if ((c === "<" || c === ">") && s[i + 1] === "(") return this.readWordToken();
    for (const op of REDIR_OPS) if (s.startsWith(op, i)) return this.advance(op.length, { redir: op });
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") return this.advance(1, { op: c });
    return this.readWordToken();
  }

  advance(n, tok) {
    this.pos += n;
    return tok;
  }

  readWordToken() {
    const word = this.readWord();
    // `2>&1`, `3<file`: an all-digit word glued to a redirection is its fd.
    const c = this.src[this.pos];
    if (!word.quoted && !word.subs.length && /^\d+$/.test(word.raw) && (c === "<" || c === ">") && this.src[this.pos + 1] !== "(") {
      return this.readToken();
    }
    return { word };
  }

  readWord() {
    const s = this.src;
    const start = this.pos;
    let text = "";
    let quoted = false;
    const subs = [];
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ";" || c === "&" || c === "|" || c === ")") break;
      if (c === "(") {
        // `name=( … )` array assignment: its elements are words whose
        // substitutions run.
        if (ASSIGN_RE.test(text) && text.endsWith("=") && !quoted && this.depth < MAX_DEPTH) {
          const p = this.child(s, this.pos + 1);
          const ast = p.parseList([], [")"]);
          subs.push({ kind: "array", ast });
          this.pos = p.pos < s.length && s[p.pos] === ")" ? p.pos + 1 : p.pos;
          text += s.slice(start + text.length, this.pos);
          continue;
        }
        break;
      }
      if (c === "<" || c === ">") {
        if (s[this.pos + 1] !== "(") break;
        const kind = c === "<" ? "in" : "out";
        const from = this.pos;
        subs.push({ kind, ast: this.readNested(this.pos + 2) });
        text += s.slice(from, this.pos);
        continue;
      }
      if (c === "\\") {
        if (s[this.pos + 1] === "\n") this.pos += 2;
        else {
          text += s[this.pos + 1] ?? "";
          this.pos += 2;
          quoted = true;
        }
        continue;
      }
      if (c === "'") {
        const j = s.indexOf("'", this.pos + 1);
        if (j === -1) {
          text += c; // unterminated: a stray apostrophe, not a span
          this.pos++;
          continue;
        }
        text += s.slice(this.pos + 1, j);
        quoted = true;
        this.pos = j + 1;
        continue;
      }
      if (c === '"') {
        const close = this.findDoubleClose(this.pos + 1);
        if (close === -1) {
          text += c; // unterminated: a stray quote, not a span
          this.pos++;
          continue;
        }
        quoted = true;
        this.pos++;
        text += this.readDouble(subs, '"');
        this.pos++; // the closing quote
        continue;
      }
      if (c === "$" || c === "`") {
        const got = this.readExpansion(subs);
        if (got !== null) {
          text += got;
          continue;
        }
      }
      text += c;
      this.pos++;
    }
    return { text, raw: s.slice(start, this.pos), quoted, subs };
  }

  // Index of the `"` closing a double-quoted span opened just before `from`,
  // or -1 when unterminated (a cheap pre-scan; substitutions inside may hold
  // quotes, so it skips balanced `$(…)`/backticks).
  findDoubleClose(from) {
    const s = this.src;
    let depth = 0;
    let bt = false;
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "`") bt = !bt;
      else if (bt) continue;
      else if (c === "$" && s[i + 1] === "(") {
        depth++;
        i++;
      } else if (c === ")" && depth > 0) depth--;
      else if (c === "'" && depth > 0) {
        const j = s.indexOf("'", i + 1);
        if (j !== -1) i = j;
      } else if (c === '"' && depth === 0) return i;
    }
    return -1;
  }

  // Read double-quoted content up to `term` (or end of input when null),
  // collecting the substitutions that still run inside it.
  readDouble(subs, term) {
    const s = this.src;
    let text = "";
    while (this.pos < s.length && s[this.pos] !== term) {
      const c = s[this.pos];
      if (c === "\\") {
        const n = s[this.pos + 1];
        if (n === "\n") {
          this.pos += 2;
          continue;
        }
        text += n !== undefined && "$`\"\\".includes(n) ? n : c + (n ?? "");
        this.pos += 2;
        continue;
      }
      if (c === "$" || c === "`") {
        const got = this.readExpansion(subs);
        if (got !== null) {
          text += got;
          continue;
        }
      }
      text += c;
      this.pos++;
    }
    return text;
  }

  // `$(…)`, `$((…))`, `${…}` or a backtick span at this.pos: consumes it and
  // returns its raw text (kept in the word's text, so a re-parsed `sh -c`
  // body still sees it), or null when this.pos is a plain `$`.
  readExpansion(subs) {
    const s = this.src;
    const from = this.pos;
    if (s[from] === "`") {
      let j = from + 1;
      let body = "";
      while (j < s.length && s[j] !== "`") {
        if (s[j] === "\\" && "`$\\".includes(s[j + 1] ?? "")) {
          body += s[j + 1];
          j += 2;
        } else body += s[j++];
      }
      if (j >= s.length) return null; // unterminated backtick: literal
      subs.push({ kind: "cmd", ast: this.child(body, 0).parseAll() });
      this.pos = j + 1;
      return s.slice(from, this.pos);
    }
    if (s[from + 1] === "(") {
      subs.push({ kind: "cmd", ast: this.readNested(from + 2) });
      return s.slice(from, this.pos);
    }
    if (s[from + 1] === "{") {
      // `${name…}`: a parameter expansion; a `$(…)` in its default word runs.
      let j = from + 2;
      let depth = 1;
      while (j < s.length && depth > 0) {
        if (s[j] === "\\") j++;
        else if (s[j] === "$" && s[j + 1] === "(") {
          this.pos = j;
          subs.push({ kind: "cmd", ast: this.readNested(j + 2) });
          j = this.pos;
          continue;
        } else if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
      this.pos = j;
      return s.slice(from, this.pos);
    }
    return null;
  }

  // Parse a `(`-opened nested command string starting at `from`, leaving
  // this.pos just past its closing `)`.
  readNested(from) {
    if (this.depth >= MAX_DEPTH) {
      this.pos = this.src.length;
      return { type: "list", items: [] };
    }
    const p = this.child(this.src, from);
    const ast = p.parseList([], [")"]);
    this.pos = p.pos < this.src.length && this.src[p.pos] === ")" ? p.pos + 1 : p.pos;
    if (p.pendingHeredocs.length) this.pendingHeredocs.push(...p.pendingHeredocs);
    return ast;
  }

  readHeredocBodies() {
    const s = this.src;
    for (const h of this.pendingHeredocs.splice(0)) {
      const lines = [];
      while (this.pos < s.length) {
        let end = s.indexOf("\n", this.pos);
        if (end === -1) end = s.length;
        const line = s.slice(this.pos, end);
        this.pos = Math.min(end + 1, s.length);
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        lines.push(line);
      }
      const body = lines.join("\n");
      const subs = [];
      if (!h.quoted) this.child(body, 0).readDouble(subs, null);
      h.redir.heredoc = { body, quoted: h.quoted, subs };
    }
  }

  // ---- grammar -----------------------------------------------------------

  parseAll() {
    const items = [];
    while (!this.peek().eof) {
      const list = this.parseList([], []);
      items.push(...list.items);
      if (!this.peek().eof) this.next(); // a stray `)`/reserved word: skip it
    }
    return { type: "list", items };
  }

  isStop(tok, stopWords, stopOps) {
    if (tok.eof) return true;
    if (tok.op !== undefined) return stopOps.includes(tok.op);
    if (tok.word) return isReserved(tok.word) && stopWords.includes(tok.word.text);
    return false;
  }

  parseList(stopWords, stopOps) {
    const items = [];
    for (;;) {
      let tok = this.peek();
      while (tok.op === "\n" || tok.op === ";" || tok.op === "&" || tok.op === "&&" || tok.op === "||") {
        this.next();
        tok = this.peek();
      }
      if (this.isStop(tok, stopWords, stopOps)) break;
      const before = this.consumed;
      const pipeline = this.parsePipeline(stopWords, stopOps);
      if (pipeline.stages.length) items.push(pipeline);
      if (this.consumed === before) {
        // no progress on an unexpected token: drop it
        const t = this.peek();
        if (this.isStop(t, stopWords, stopOps)) break;
        this.next();
      }
    }
    return { type: "list", items };
  }

  parsePipeline(stopWords, stopOps) {
    const stages = [];
    for (;;) {
      let tok = this.peek();
      while (tok.word && isReserved(tok.word) && (tok.word.text === "!" || tok.word.text === "time")) {
        this.next();
        tok = this.peek();
      }
      if (this.isStop(tok, stopWords, stopOps)) break;
      const cmd = this.parseCommand(stopWords, stopOps);
      if (cmd) stages.push(cmd);
      else if (!tok.op || !["\n", ";", "&", "&&", "||", "|"].includes(tok.op)) {
        if (!this.isStop(this.peek(), stopWords, stopOps)) this.next();
      }
      if (this.peek().op !== "|") break;
      this.next();
      while (this.peek().op === "\n") this.next();
    }
    return { type: "pipeline", stages };
  }

  expectWord(text) {
    const t = this.peek();
    if (t.word && t.word.text === text && isReserved(t.word)) this.next();
  }

  skipSeparators() {
    while (this.peek().op === "\n" || this.peek().op === ";") this.next();
  }

  parseCommand(stopWords, stopOps) {
    if (this.nest >= MAX_NEST) {
      this.pos = this.src.length;
      this.peeked = null;
      return null;
    }
    this.nest++;
    try {
      return this.parseCompound(stopWords, stopOps);
    } finally {
      this.nest--;
    }
  }

  parseCompound(stopWords, stopOps) {
    const tok = this.peek();
    let node = null;
    if (tok.op === "(") {
      this.next();
      const body = this.parseList([], [")"]);
      if (this.peek().op === ")") this.next();
      node = { type: "subshell", body, redirs: [] };
    } else if (tok.word && isReserved(tok.word)) {
      const w = tok.word.text;
      if (w === "{") {
        this.next();
        const body = this.parseList(["}"], []);
        this.expectWord("}");
        node = { type: "group", body, redirs: [] };
      } else if (w === "if") {
        this.next();
        const lists = [this.parseList(["then"], [])];
        this.expectWord("then");
        for (;;) {
          lists.push(this.parseList(["elif", "else", "fi"], []));
          const t = this.peek();
          if (!t.word || !isReserved(t.word)) break;
          if (t.word.text === "fi") {
            this.next();
            break;
          }
          this.next();
          if (t.word.text === "elif") {
            lists.push(this.parseList(["then"], []));
            this.expectWord("then");
          }
        }
        node = { type: "if", lists, redirs: [] };
      } else if (w === "while" || w === "until") {
        this.next();
        const cond = this.parseList(["do"], []);
        this.expectWord("do");
        const body = this.parseList(["done"], []);
        this.expectWord("done");
        node = { type: "loop", cond, body, redirs: [] };
      } else if (w === "for" || w === "select") {
        this.next();
        let name = null;
        const words = [];
        if (this.peek().op === "(") {
          // `for (( … ))`: arithmetic, parsed as a subshell for its substitutions
          const arith = this.parseCommand([], []);
          if (arith) words.push({ text: "", raw: "", quoted: false, subs: [{ kind: "cmd", ast: { type: "list", items: [{ type: "pipeline", stages: [arith] }] } }] });
        } else if (this.peek().word) {
          name = this.next().word.text;
          while (this.peek().op === "\n") this.next();
          if (this.peek().word?.text === "in") {
            this.next();
            while (this.peek().word) words.push(this.next().word);
          }
        }
        this.skipSeparators();
        let body;
        if (this.peek().word?.text === "{") {
          this.next();
          body = this.parseList(["}"], []);
          this.expectWord("}");
        } else {
          this.expectWord("do");
          body = this.parseList(["done"], []);
          this.expectWord("done");
        }
        node = { type: "for", name, words, body, redirs: [] };
      } else if (w === "case") {
        this.next();
        const word = this.peek().word ? this.next().word : null;
        while (this.peek().op === "\n") this.next();
        this.expectWord("in");
        const bodies = [];
        for (;;) {
          this.skipSeparators();
          const t = this.peek();
          if (t.eof) break;
          if (t.word && t.word.text === "esac" && isReserved(t.word)) {
            this.next();
            break;
          }
          if (t.op === "(") this.next();
          // pattern words up to the closing `)`
          while (!this.peek().eof && this.peek().op !== ")") {
            const pt = this.next();
            if (pt.op && pt.op !== "|") break;
          }
          if (this.peek().op === ")") this.next();
          bodies.push(this.parseList(["esac"], [";;"]));
          if (this.peek().op === ";;") this.next();
        }
        node = { type: "case", word, bodies, redirs: [] };
      } else if (w === "function") {
        this.next();
        if (this.peek().word) this.next();
        if (this.peek().op === "(") {
          this.next();
          if (this.peek().op === ")") this.next();
        }
        while (this.peek().op === "\n") this.next();
        const body = this.parseCommand([], []);
        return body ? { type: "func", body } : null;
      } else {
        return null; // a stray stop word (`done`, `fi`, …) the caller handles
      }
    } else {
      return this.parseSimple();
    }
    this.parseRedirs(node.redirs);
    return node;
  }

  parseRedirs(redirs) {
    while (this.peek().redir) this.parseRedir(redirs);
  }

  parseRedir(redirs) {
    const op = this.next().redir;
    const t = this.peek();
    const target = t.word ? this.next().word : null;
    const redir = { op, target };
    if ((op === "<<" || op === "<<-") && target) {
      this.pendingHeredocs.push({ redir, delim: target.text, quoted: target.quoted, strip: op === "<<-" });
    }
    redirs.push(redir);
  }

  parseSimple() {
    const node = { type: "simple", assigns: [], words: [], redirs: [] };
    for (;;) {
      const tok = this.peek();
      if (tok.redir) {
        this.parseRedir(node.redirs);
        continue;
      }
      if (!tok.word) break;
      this.next();
      if (!node.words.length && ASSIGN_RE.test(tok.word.raw)) node.assigns.push(tok.word);
      else node.words.push(tok.word);
      // `name() { … }`: a function definition
      if (node.words.length === 1 && !node.assigns.length && this.peek().op === "(") {
        const save = { pos: this.pos, peeked: this.peeked };
        this.next();
        if (this.peek().op === ")") {
          this.next();
          while (this.peek().op === "\n") this.next();
          const body = this.parseCommand([], []);
          return body ? { type: "func", body } : null;
        }
        this.pos = save.pos;
        this.peeked = save.peeked;
        break;
      }
    }
    if (!node.words.length && !node.assigns.length && !node.redirs.length) return null;
    return node;
  }
}

// A word is a reserved word only when it is literal and unquoted.
function isReserved(word) {
  return !word.quoted && !word.subs.length && word.text === word.raw && RESERVED_WORDS.has(word.text);
}
const RESERVED_WORDS = new Set(["if", "then", "elif", "else", "fi", "do", "done", "case", "esac", "while", "until", "for", "select", "in", "function", "{", "}", "!", "time"]);

function parse(src) {
  if (typeof src !== "string") return { type: "list", items: [] };
  return new Parser(src, 0, 0).parseAll();
}

module.exports = { parse };
