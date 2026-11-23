// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- SPEC.md section 3: a file as lines, its line break, its final break ----
interface FDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): FDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}

function renderDoc(doc: FDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

function loadDoc(tree: Tree, p: string): FDoc {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return parseDoc(t);
}

function storeDoc(tree: Tree, p: string, doc: FDoc): void {
  tree.now.set(p, renderDoc(doc));
}

// ---- SPEC.md section 5: matching lines at three tiers ----
const rstripWS = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWS(a) === rstripWS(b);
  return stripWS(a) === stripWS(b);
}

function occurrencesAt(fileLines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(tier, fileLines[i + j]!, O[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

function findTier(fileLines: string[], O: string[], strict: boolean, from: number): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(fileLines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NLine {
  text: string;
  ctx: number; // index into O when this is a context line, else -1
}

/** Replace the matched lines at `pos` with N, per section 5 (context lines keep the file's own text; tier 2 re-indents). */
function applyReplace(doc: FDoc, pos: number, O: string[], N: NLine[], tier: number): void {
  const F = O.length > 0 ? leadWS(doc.lines[pos]!) : '';
  const P = O.length > 0 ? leadWS(O[0]!) : '';
  const written = N.map((n) => {
    if (n.ctx >= 0) return doc.lines[pos + n.ctx]!;
    if (tier === 2 && O.length > 0 && n.text !== '' && stripWS(n.text) !== '' && n.text.startsWith(P)) {
      return F + n.text.slice(P.length);
    }
    return n.text;
  });
  doc.lines.splice(pos, O.length, ...written);
}

// ---- SPEC.md section 6: unified diffs ----
interface UHunk {
  a: number;
  O: string[];
  N: NLine[];
  noFinalBreak: boolean; // a `\` line follows the hunk's last context or `+` line
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  hunks: UHunk[];
  plusLines: string[];
  lastPlusNoBreak: boolean;
}

function uPath(raw: string): string | null {
  const tab = raw.indexOf('\t');
  let p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: (USection & { sawPair: boolean; sawRename: boolean; forceNew: boolean; forceDel: boolean }) | null = null;
  const newSection = (): NonNullable<typeof cur> => {
    const s = { oldPath: null, newPath: null, hunks: [], plusLines: [], lastPlusNoBreak: false, sawPair: false, sawRename: false, forceNew: false, forceDel: false };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.oldPath = m[1]!;
      cur.newPath = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.sawPair) cur = newSection();
      cur.oldPath = uPath(line.slice(4));
      cur.newPath = uPath(lines[i + 1]!.slice(4));
      cur.sawPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), O: [], N: [], noFinalBreak: false };
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      let lastCtxPlus = -1;
      body.forEach((bl, bi) => {
        if (bl.startsWith('\\')) {
          if (bi - 1 === lastCtxPlus) hunk.noFinalBreak = true;
          if (bi > 0 && body[bi - 1]!.startsWith('+')) cur!.lastPlusNoBreak = true;
          return;
        }
        if (bl.startsWith('+')) {
          hunk.N.push({ text: bl.slice(1), ctx: -1 });
          cur!.plusLines.push(bl.slice(1));
          cur!.lastPlusNoBreak = false;
          lastCtxPlus = bi;
        } else if (bl.startsWith('-')) {
          hunk.O.push(bl.slice(1));
        } else {
          const text = bl === '' ? '' : bl.slice(1);
          hunk.N.push({ text, ctx: hunk.O.length });
          hunk.O.push(text);
          lastCtxPlus = bi;
        }
      });
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ') && !cur.sawPair) {
        cur.oldPath = line.slice(12).trim();
        cur.sawRename = true;
      } else if (line.startsWith('rename to ') && !cur.sawPair) {
        cur.newPath = line.slice(10).trim();
        cur.sawRename = true;
      } else if (line.startsWith('new file mode')) cur.forceNew = true;
      else if (line.startsWith('deleted file mode')) cur.forceDel = true;
    }
    i++;
  }
  return sections.map((s) => {
    const sec = s as USection & { forceNew: boolean; forceDel: boolean };
    let oldPath = sec.oldPath;
    let newPath = sec.newPath;
    if (sec.forceNew) oldPath = null;
    if (sec.forceDel) newPath = null;
    return (tree: Tree) => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (oldPath === null && newPath !== null) {
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const doc: FDoc = { lines: [...sec.plusLines], br: '\n', final: !sec.lastPlusNoBreak };
        storeDoc(tree, newPath, doc);
        return;
      }
      if (newPath === null && oldPath !== null) {
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath === null || newPath === null) throw new Fail('missing', oldPath ?? newPath ?? '');
      const isMove = oldPath !== newPath;
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const doc = loadDoc(tree, oldPath);
      let d = 0;
      for (const h of sec.hunks) {
        if (h.O.length === 0) {
          const at = Math.min(Math.max(h.a + d, 0), doc.lines.length);
          const atEnd = at === doc.lines.length;
          doc.lines.splice(at, 0, ...h.N.map((n) => n.text));
          if (atEnd) doc.final = !h.noFinalBreak;
        } else {
          const hit = findTier(doc.lines, h.O, strict, 0);
          if (hit === null) throw new Fail('no-match', oldPath);
          const target = h.a - 1 + d;
          let best = hit.occ[0]!;
          for (const o of hit.occ) if (Math.abs(o - target) < Math.abs(best - target)) best = o;
          const runsToEnd = best + h.O.length === doc.lines.length;
          applyReplace(doc, best, h.O, h.N, hit.tier);
          if (runsToEnd) doc.final = !h.noFinalBreak;
        }
        d += h.N.length - h.O.length;
      }
      if (isMove) {
        tree.now.set(oldPath, null);
        storeDoc(tree, newPath, doc);
        tree.moves.push([oldPath, newPath]);
      } else {
        storeDoc(tree, oldPath, doc);
      }
    };
  });
}

// ---- SPEC.md section 7: SEARCH/REPLACE blocks ----
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines: string[] = [];
    i++;
    while (i < lines.length && lines[i]!.trimEnd() !== '=======') {
      oldLines.push(lines[i]!);
      i++;
    }
    if (i >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    i++;
    const newLines: string[] = [];
    while (i < lines.length && lines[i]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[i]!);
      i++;
    }
    if (i >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    i++;
    searchFrom = i;
    prevPath = path;
    const p = path;
    const O = oldLines;
    const N: NLine[] = newLines.map((text) => ({ text, ctx: -1 }));
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (O.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        storeDoc(tree, p, { lines: [...newLines], br: '\n', final: true });
        return;
      }
      const doc = loadDoc(tree, p);
      const hit = findTier(doc.lines, O, strict, 0);
      if (hit === null) throw new Fail('no-match', p);
      if (hit.occ.length > 1) throw new Fail('ambiguous', p);
      applyReplace(doc, hit.occ[0]!, O, N, hit.tier);
      storeDoc(tree, p, doc);
    });
  }
  return edits;
}

// ---- SPEC.md section 8: V4A patches ----
interface VChunk {
  anchor: string | null;
  O: string[];
  N: NLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  let sawEnd = false;
  const sectionStart = (l: string): string | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.trim() === '*** End Patch') {
      sawEnd = true;
      i++;
      break;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    const path = line.slice(line.indexOf(': ') + 2).trim();
    i++;
    const body: string[] = [];
    while (
      i < lines.length &&
      sectionStart(lines[i]!) === null &&
      !(lines[i]!.trim() === '*** End Patch' && !lines[i]!.startsWith(' ') && !lines[i]!.startsWith('-') && !lines[i]!.startsWith('+'))
    ) {
      body.push(lines[i]!);
      i++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      body.forEach((bl, bi) => {
        if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else if (bl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${headLine + 1 + bi}`);
      });
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        storeDoc(tree, path, { lines: fileLines, br: '\n', final: true });
      });
    } else if (kind === 'delete') {
      body.forEach((bl, bi) => {
        if (!blank(bl)) throw new Exit2(`error: parse ${headLine + 1 + bi}`);
      });
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let bi = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        moveTo = body[0]!.slice(13).trim();
        bi = 1;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      const pushChunk = (): void => {
        if (chunk !== null) chunks.push(chunk);
        chunk = null;
      };
      for (; bi < body.length; bi++) {
        const bl = body[bi]!;
        if (bl.startsWith('@@')) {
          pushChunk();
          const anchor = bl.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, O: [], N: [], eof: false };
        } else if (bl === '*** End of File') {
          if (chunk === null) chunk = { anchor: null, O: [], N: [], eof: false };
          chunk.eof = true;
          pushChunk();
        } else if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${headLine + 1 + bi}`);
            chunk = { anchor: null, O: [], N: [], eof: false };
          }
          if (bl.startsWith('+')) chunk.N.push({ text: bl.slice(1), ctx: -1 });
          else if (bl.startsWith('-')) chunk.O.push(bl.slice(1));
          else {
            const text = bl === '' ? '' : bl.slice(1);
            chunk.N.push({ text, ctx: chunk.O.length });
            chunk.O.push(text);
          }
        } else {
          throw new Exit2(`error: parse ${headLine + 1 + bi}`);
        }
      }
      pushChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      const mt = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const doc = loadDoc(tree, path);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const tiers = strict ? [0] : [0, 1, 2];
            let found = -1;
            for (const t of tiers) {
              for (let k = cursor; k < doc.lines.length; k++) {
                if (tierEq(t, doc.lines[k]!, ch.anchor)) {
                  found = k;
                  break;
                }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', path);
            cursor = found + 1;
          }
          if (ch.O.length === 0) {
            const at = ch.eof ? doc.lines.length : cursor;
            doc.lines.splice(at, 0, ...ch.N.map((n) => n.text));
            cursor = at + ch.N.length;
          } else {
            const hit = findTier(doc.lines, ch.O, strict, cursor);
            if (hit === null) throw new Fail('no-match', path);
            let occ = hit.occ;
            if (ch.eof) occ = occ.filter((o) => o + ch.O.length === doc.lines.length);
            if (occ.length === 0) throw new Fail('no-match', path);
            const pos = occ[0]!;
            applyReplace(doc, pos, ch.O, ch.N, hit.tier);
            cursor = pos + ch.N.length;
          }
        }
        if (mt !== null) {
          tree.now.set(path, null);
          storeDoc(tree, mt, doc);
          tree.moves.push([path, mt]);
        } else {
          storeDoc(tree, path, doc);
        }
      });
    }
  }
  if (!sawEnd) throw new Exit2(`error: parse ${lines.length + 1}`);
  for (; i < lines.length; i++) {
    if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const keyed: { key: string; text: string }[] = [];
  const renamed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : wasOld;
    const wasNew = tree.original(newP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && !renamed.has(oldP) && !renamed.has(newP)) {
      keyed.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      renamed.add(oldP);
      renamed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!renamed.has(p)) keyed.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = keyed.map((k) => k.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
