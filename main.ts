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
  readonly moves: Array<[string, string]> = [];
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

interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

const leadingWs = (s: string): string => s.match(/^[ \t]*/)![0];

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

function reindent(line: string, tier: number, F: string, P: string): string {
  if (tier !== 2) return line;
  if (blank(line)) return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

function findMatches(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  minPos = 0,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  const m = oldLines.length;
  if (m === 0) return null;
  const startMax = fileLines.length - m;
  const startMin = eofOnly ? Math.max(minPos, startMax) : minPos;
  if (startMin > startMax) return null;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const normOld = oldLines.map((l) => normLine(l, tier));
    const positions: number[] = [];
    for (let i = startMin; i <= startMax; i += 1) {
      let ok = true;
      for (let j = 0; j < m; j += 1) {
        if (normLine(fileLines[i + j]!, tier) !== normOld[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNl?: boolean;
}

function applyOps(fileLines: string[], pos: number, oldLines: string[], ops: Op[], tier: number): string[] {
  const F = oldLines.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const P = oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oIdx]!);
      oIdx += 1;
    } else if (op.kind === 'del') {
      oIdx += 1;
    } else {
      out.push(reindent(op.text, tier, F, P));
    }
  }
  return out;
}

interface UnifiedHunk {
  oldStart: number;
  ops: Op[];
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  sawMinusPlus: boolean;
  hunks: UnifiedHunk[];
}

function parseUnifiedPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  const newSection = (): UnifiedSection => {
    const s: UnifiedSection = {
      gitOld: null,
      gitNew: null,
      minusPath: null,
      plusPath: null,
      renameFrom: null,
      renameTo: null,
      isNew: false,
      isDeleted: false,
      sawMinusPlus: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const inHeader = cur !== null && cur.hunks.length === 0 && !cur.sawMinusPlus;
      const nextIsPlus = i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');
      if (inHeader) {
        if (!nextIsPlus) throw new Exit2(`error: parse ${i + 2}`);
        cur!.minusPath = parseUnifiedPath(line);
        cur!.plusPath = parseUnifiedPath(lines[i + 1]!);
        cur!.sawMinusPlus = true;
        i += 2;
        continue;
      }
      if (nextIsPlus) {
        cur = newSection();
        cur.minusPath = parseUnifiedPath(line);
        cur.plusPath = parseUnifiedPath(lines[i + 1]!);
        cur.sawMinusPlus = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const oldStart = Number.parseInt(m[1]!, 10);
      i += 1;
      const rawBody: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          rawBody.push(bl);
          i += 1;
        } else {
          break;
        }
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();
      const ops: Op[] = [];
      for (const bl of rawBody) {
        if (bl === '') ops.push({ kind: 'ctx', text: '' });
        else if (bl.startsWith(' ')) ops.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl.startsWith('-')) ops.push({ kind: 'del', text: bl.slice(1) });
        else if (bl.startsWith('+')) ops.push({ kind: 'add', text: bl.slice(1) });
        else if (bl.startsWith('\\')) {
          if (ops.length > 0) ops[ops.length - 1]!.noNl = true;
        }
      }
      cur.hunks.push({ oldStart, ops });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).replace(/^ +| +$/g, '');
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).replace(/^ +| +$/g, '');
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.isNew = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.isDeleted = true;
    }
    i += 1;
  }

  const applyHunks = (before: string, hunks: UnifiedHunk[], errPath: string): string => {
    const file = splitFile(before);
    let d = 0;
    for (const h of hunks) {
      const O = h.ops.filter((op) => op.kind === 'ctx' || op.kind === 'del').map((op) => op.text);
      let lastNewNoNl = false;
      for (let k = h.ops.length - 1; k >= 0; k -= 1) {
        const op = h.ops[k]!;
        if (op.kind === 'ctx' || op.kind === 'add') {
          lastNewNoNl = op.noNl === true;
          break;
        }
      }
      if (O.length > 0) {
        const m = findMatches(file.lines, O, strict, 0, false);
        if (m === null) throw new Fail('no-match', errPath);
        const target = h.oldStart - 1 + d;
        let bestPos = m.positions[0]!;
        let bestDist = Math.abs(bestPos - target);
        for (let k = 1; k < m.positions.length; k += 1) {
          const pos = m.positions[k]!;
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            bestDist = dist;
            bestPos = pos;
          }
        }
        const atEnd = bestPos + O.length === file.lines.length;
        const rep = applyOps(file.lines, bestPos, O, h.ops, m.tier);
        file.lines.splice(bestPos, O.length, ...rep);
        if (atEnd) file.finalBreak = !lastNewNoNl;
        d += rep.length - O.length;
      } else {
        const insertAt = Math.max(0, Math.min(file.lines.length, h.oldStart + d));
        const atEnd = insertAt === file.lines.length;
        const rep = h.ops.filter((op) => op.kind === 'add').map((op) => op.text);
        file.lines.splice(insertAt, 0, ...rep);
        if (atEnd) file.finalBreak = !lastNewNoNl;
        d += rep.length;
      }
    }
    return joinFile(file);
  };

  return sections.map((sec): Edit => {
    const oldPath = sec.minusPath ?? sec.renameFrom ?? sec.gitOld;
    const newPath = sec.plusPath ?? sec.renameTo ?? sec.gitNew;
    if (oldPath === '/dev/null' || sec.isNew) {
      const target = newPath ?? '';
      return (tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const outLines: string[] = [];
        let lastAddNoNl = false;
        for (const h of sec.hunks) {
          for (const op of h.ops) {
            if (op.kind === 'add') {
              outLines.push(op.text);
              lastAddNoNl = op.noNl === true;
            }
          }
        }
        tree.now.set(target, joinFile({ lines: outLines, br: '\n', finalBreak: !lastAddNoNl }));
      };
    }
    if (newPath === '/dev/null' || sec.isDeleted) {
      const target = oldPath ?? '';
      return (tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      };
    }
    const src = oldPath ?? '';
    const dst = newPath ?? '';
    if (src !== dst) {
      return (tree) => {
        if (!safe(src)) throw new Fail('unsafe', src);
        if (!safe(dst)) throw new Fail('unsafe', dst);
        const before = tree.get(src);
        if (before === null) throw new Fail('missing', src);
        if (tree.get(dst) !== null) throw new Fail('exists', dst);
        const out = applyHunks(before, sec.hunks, src);
        tree.now.set(src, null);
        tree.now.set(dst, out);
        tree.moves.push([src, dst]);
      };
    }
    return (tree) => {
      if (!safe(src)) throw new Fail('unsafe', src);
      const before = tree.get(src);
      if (before === null) throw new Fail('missing', src);
      const out = applyHunks(before, sec.hunks, src);
      tree.now.set(src, out);
    };
  });
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let foundPath: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      foundPath = l.trim();
      break;
    }
    const path = foundPath ?? prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sepIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sepIdx = j;
        break;
      }
    }
    if (sepIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let endIdx = -1;
    for (let j = sepIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        endIdx = j;
        break;
      }
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, endIdx);
    prevPath = path;
    prevEnd = endIdx;
    i = endIdx + 1;

    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile({ lines: newLines, br: '\n', finalBreak: true }));
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const file = splitFile(before);
      const m = findMatches(file.lines, oldLines, strict, 0, false);
      if (m === null) throw new Fail('no-match', path);
      if (m.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = m.positions[0]!;
      const F = leadingWs(file.lines[pos]!);
      const P = leadingWs(oldLines[0]!);
      const rep = m.tier === 2 ? newLines.map((l) => reindent(l, 2, F, P)) : newLines;
      file.lines.splice(pos, oldLines.length, ...rep);
      tree.now.set(path, joinFile(file));
    });
  }
  return edits;
}

interface V4aChunk {
  anchor: string;
  ops: Op[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const isSectionHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = lines[i]!;
    if (!isSectionHeader(header)) throw new Exit2(`error: parse ${i + 1}`);
    const headerLineNum = i + 1;
    let end = i + 1;
    while (end < last && !isSectionHeader(lines[end]!)) end += 1;
    // Trim blank lines at the end of the section
    let bodyEnd = end;
    while (bodyEnd > i + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;

    if (header.startsWith('*** Add File: ')) {
      const path = header.slice('*** Add File: '.length).replace(/^ +| +$/g, '');
      const addLines: string[] = [];
      for (let j = i + 1; j < bodyEnd; j += 1) {
        const l = lines[j]!;
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile({ lines: addLines, br: '\n', finalBreak: true }));
      });
    } else if (header.startsWith('*** Delete File: ')) {
      const path = header.slice('*** Delete File: '.length).replace(/^ +| +$/g, '');
      if (bodyEnd > i + 1) throw new Exit2(`error: parse ${i + 2}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      const path = header.slice('*** Update File: '.length).replace(/^ +| +$/g, '');
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < bodyEnd && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).replace(/^ +| +$/g, '');
        j += 1;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      while (j < bodyEnd) {
        const l = lines[j]!;
        if (l.startsWith('@@')) {
          curChunk = { anchor: l.slice(2).replace(/^ +| +$/g, ''), ops: [], eof: false };
          chunks.push(curChunk);
          j += 1;
        } else if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${j + 1}`);
          curChunk.eof = true;
          curChunk = null;
          j += 1;
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (chunks.length === 0) {
              curChunk = { anchor: '', ops: [], eof: false };
              chunks.push(curChunk);
            } else {
              throw new Exit2(`error: parse ${j + 1}`);
            }
          }
          if (l === '') curChunk.ops.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) curChunk.ops.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) curChunk.ops.push({ kind: 'del', text: l.slice(1) });
          else curChunk.ops.push({ kind: 'add', text: l.slice(1) });
          j += 1;
        } else {
          throw new Exit2(`error: parse ${j + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLineNum}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const file = splitFile(before);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== '') {
            const am = findMatches(file.lines, [chunk.anchor], strict, cursor, false);
            if (am === null) throw new Fail('no-match', path);
            cursor = am.positions[0]! + 1;
          }
          const O = chunk.ops.filter((op) => op.kind === 'ctx' || op.kind === 'del').map((op) => op.text);
          if (O.length === 0) {
            const insertAt = chunk.eof ? file.lines.length : cursor;
            const rep = chunk.ops.filter((op) => op.kind === 'add').map((op) => op.text);
            file.lines.splice(insertAt, 0, ...rep);
            cursor = insertAt + rep.length;
          } else {
            const m = findMatches(file.lines, O, strict, cursor, chunk.eof);
            if (m === null) throw new Fail('no-match', path);
            const pos = m.positions[0]!;
            const rep = applyOps(file.lines, pos, O, chunk.ops, m.tier);
            file.lines.splice(pos, O.length, ...rep);
            cursor = pos + rep.length;
          }
        }
        const out = joinFile(file);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
    }

    i = end;
  }
  return edits;
}

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const renamedOld = new Set<string>();
  const renamedNew = new Set<string>();
  const entries: Array<{ key: string; line: string }> = [];
  for (let i = tree.moves.length - 1; i >= 0; i -= 1) {
    const [oldP, newP] = tree.moves[i]!;
    if (renamedOld.has(oldP) || renamedNew.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      renamedOld.add(oldP);
      renamedNew.add(newP);
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of tree.now.keys()) {
    if (renamedOld.has(p) || renamedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, now] of tree.now) {
      if (tree.original(p) !== now && now === null) rmSync(p, { force: true });
    }
    for (const [p, now] of tree.now) {
      if (tree.original(p) !== now && now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows = entries.map((e) => e.line);
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
