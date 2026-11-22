// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Written from scratch in this session from the makefun-site README + the
// reference's observable behaviour. Same answers, byte for byte, on every
// input; faster by avoiding the reference's per-character regex work:
//   - one pass over each body with a hand-rolled lexer, inline rendering
//     over index ranges (no slicing, no per-character replace calls),
//   - bulk HTML escaping, ASCII fast path + memoised slugify,
//   - manual front-matter and template parsing, array-joined output.
//
// Pure: no clock, no environment, no randomness, no I/O, no cross-case state
// (every cache lives in the per-run build state below).

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `s` with & < > " ' escaped. */
function escapeHtml(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, (c) => ESC[c]);
}

/** Whether a UTF-16 code unit is JS \s (the set behind \S / \s). */
function isWSCode(c) {
  return (
    c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 ||
    c === 160 || c === 5760 || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279 || (c >= 8192 && c <= 8202)
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const NON_ASCII = /[^\x00-\x7F]/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Pure-ASCII text skips normalisation (it is the identity there).
 */
function slugifyRaw(text) {
  let plain = text;
  if (NON_ASCII.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e < out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** Memoised slugify (cache lives in the per-run state). */
function slugify(st, text) {
  const hit = st.slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyRaw(text);
  st.slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  while (taken.has((out = `${slug}-${n}`))) n++;
  taken.add(out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 32 && c < 127) {
      if (!inWord) {
        inWord = true;
        count++;
      }
    } else if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
    else if (c < 32) {
      if (!inWord) {
        inWord = true;
        count++;
      }
    } else if (isWSCode(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether every character of `s` is a-z, 0-9 or '-'. */
function isNameChars(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: a-z and 0-9, single '-' between, at most 64 chars. */
function isSlugValue(s) {
  if (s.length === 0 || s.length > 64) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) continue;
    if (c >= 48 && c <= 57) continue;
    if (c === 45) {
      if (i === 0 || i === s.length - 1 || s.charCodeAt(i - 1) === 45) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isNameChars(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  if (nl0 === -1) return { error: 'the front matter is not closed' };
  // Find the closing '---' line: scan line starts.
  let closeStart = -1;
  let closeEnd = -1;
  let p = nl0 + 1;
  while (p <= text.length) {
    let e = text.indexOf('\n', p);
    if (e === -1) e = text.length;
    if (e - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      closeStart = p;
      closeEnd = e;
      break;
    }
    if (e === text.length) break;
    p = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const region = text.slice(nl0 + 1, closeStart);
  const lines = region === '' ? [] : region.split('\n');
  // lines[i] is line i+2 of the source (0-based line index i+1).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    // LINE: ([a-z_]+):(?: (.*))?  -- key, ':', optional ' ' + rest.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
      return { error: `line ${i + 2} is not "key: value"` };
    }
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 2} is not "key: value"` };
    // Trailing spaces and tabs dropped.
    let r = raw.length;
    while (r > 0) {
      const c = raw.charCodeAt(r - 1);
      if (c === 32 || c === 9) r--;
      else break;
    }
    if (r < raw.length) raw = raw.slice(0, r);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
/** The characters that can start an inline mark. Stateful (/g): lastIndex is set before every exec. */
const MARK_RE = /[\\`*[]/g;

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` (from `from`) is spaces/tabs only up to its end. */
function restIsBlank(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Fence-open language of `line`, or null ('' when no language). */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  if (!restIsBlank(line, i)) return null;
  return line.slice(3, i);
}

/** Whether `line` closes a fence: three backticks, then spaces/tabs only. */
function isFenceClose(line) {
  return line.length >= 3 && line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && restIsBlank(line, 3);
}

/**
 * A heading line's depth and text span, or null. Text is `line` from
 * `textStart` to `textEnd` (trailing spaces/tabs dropped, never empty).
 */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let s = h;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: h, start: s, end: e };
}

/** Whether `line` is a thematic break: --- or ***, then spaces/tabs only. */
function isHr(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  return restIsBlank(line, 3);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return lineKind(line) <= 3;
}

/**
 * One line's block kind, from its first character alone where possible:
 * 0 blank, 1 fence-open, 2 heading, 3 thematic break, 4 blockquote,
 * 5 bullet item, 6 ordered item, 7 anything else. A single call replaces
 * the four separate classifier calls the block loop used to make per line.
 */
function lineKind(line) {
  if (line.length === 0) return 0;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line) ? 0 : 7;
  if (c0 === 96) return fenceLang(line) !== null ? 1 : 7;
  if (c0 === 35) return headingOf(line) !== null ? 2 : 7;
  if (c0 === 45 || c0 === 42) {
    if (isHr(line)) return 3;
    if (line.length >= 2 && line.charCodeAt(1) === 32) return 5;
    return 7;
  }
  if (c0 === 62) return 4;
  if (c0 >= 48 && c0 <= 57) {
    let d = 0;
    while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
    if (d >= 1 && d <= 9 && d + 1 < line.length && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) return 6;
  }
  return 7;
}

/** An ordered-item line's start number. */
function orderedStart(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  return Number(line.slice(0, d));
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. Range-bound to `to`. */
function findUnescaped(s, what, from, to) {
  const wl = what.length;
  for (let j = from; j <= to - wl; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < to && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds any JS-whitespace character. */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWSCode(s.charCodeAt(i))) return true;
  return false;
}

/**
 * `s[from..to)` rendered inline into `out`; `env.link(target)` is a link's
 * href. Appends strings to `out` (joined by the caller). Plain runs are
 * skipped over with indexOf jumps between the four characters that can
 * start a mark, so a long run costs one escape pass, not one step a char.
 */
function inlineInto(s, env, out, from, to) {
  let i = from;
  while (i < to) {
    MARK_RE.lastIndex = i;
    const mk = MARK_RE.exec(s);
    const j = mk !== null && mk.index < to ? mk.index : to;
    if (j > i) out.push(escapeHtml(s.slice(i, j)));
    if (j >= to) break;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < to && ESCAPABLE.has(s[j + 1])) {
        out.push(s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const q = s.indexOf('`', j + 1);
      if (q !== -1 && q < to && q > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, q)), '</code>');
        i = q + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (j + 1 < to && s.charCodeAt(j + 1) === 42) {
        const q = findUnescaped(s, '**', j + 2, to);
        if (q > j + 2) {
          out.push('<strong>');
          inlineInto(s, env, out, j + 2, q);
          out.push('</strong>');
          i = q + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
        continue;
      }
      const q = findSingleStar(s, j + 1, to);
      if (q > j + 1) {
        out.push('<em>');
        inlineInto(s, env, out, j + 1, q);
        out.push('</em>');
        i = q + 1;
      } else {
        out.push('*');
        i = j + 1;
      }
      continue;
    }
    // c === 91: '['
    const kk = findUnescaped(s, ']', j + 1, to);
    let m = -1;
    if (kk !== -1 && kk + 1 < to && s.charCodeAt(kk + 1) === 40) {
      const q = s.indexOf(')', kk + 2);
      if (q !== -1 && q < to) m = q;
    }
    if (m !== -1) {
      const target = s.slice(kk + 2, m);
      if (target !== '' && !hasWS(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s, env, out, j + 1, kk);
        out.push('</a>');
        i = m + 1;
        continue;
      }
    }
    out.push('[');
    i = j + 1;
  }
}

/**
 * `src` rendered: { html, toc, excerpt }. Blocks are emitted in order, each
 * followed by "\n"; toc holds every level 2 and 3 heading (level, id, html);
 * excerpt is the first paragraph's inline HTML, or "". Inline parts go
 * straight into one parts array, so the whole body is joined exactly once.
 */
function renderMarkdown(st, src, env) {
  const lines = src.split('\n');
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const kind = lineKind(line);
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      const lang = fenceLang(line);
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      parts.push(`<pre><code${cls}>`);
      for (const l of body) {
        parts.push(escapeHtml(l), '\n');
      }
      parts.push('</code></pre>', '\n');
      continue;
    }
    if (kind === 2) {
      const heading = headingOf(line);
      const text = line.slice(heading.start, heading.end);
      const id = uniqueSlug(slugify(st, text), ids);
      parts.push(`<h${heading.depth} id="${id}">`);
      const mark = parts.length;
      inlineInto(line, env, parts, heading.start, heading.end);
      if (heading.depth === 2 || heading.depth === 3) {
        toc.push({ level: heading.depth, id, html: parts.slice(mark).join('') });
      }
      parts.push(`</h${heading.depth}>`, '\n');
      i++;
      continue;
    }
    if (kind === 3) {
      parts.push('<hr>', '\n');
      i++;
      continue;
    }
    if (kind === 4) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      if (body.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
      else {
        const text = body.join('\n');
        parts.push('<blockquote>\n<p>');
        inlineInto(text, env, parts, 0, text.length);
        parts.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    // List: kind 5 is a bullet item, 6 an ordered item.
    if (kind === 5 || kind === 6) {
      const ordered = kind === 6;
      const start = ordered ? orderedStart(line) : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        const lk = lineKind(l);
        if (!ordered && lk === 5) {
          items.push([trimLine(l.slice(2))]);
          i++;
        } else if (ordered && lk === 6) {
          let d = 0;
          while (d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          items.push([trimLine(l.slice(d + 2))]);
          i++;
        } else if (l.length >= 2 && l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32) {
          // Continued line: two or more spaces then a non-space.
          let k = 0;
          while (k < l.length && l.charCodeAt(k) === 32) k++;
          if (k >= 2 && k < l.length && !isWSCode(l.charCodeAt(k))) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      parts.push(`${open}\n`);
      for (const itemParts of items) {
        const text = itemParts.join('\n');
        parts.push('<li>');
        inlineInto(text, env, parts, 0, text.length);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>`, '\n');
      continue;
    }
    // Paragraph.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    parts.push('<p>');
    const mark = parts.length;
    inlineInto(text, env, parts, 0, text.length);
    if (excerpt === null) excerpt = parts.slice(mark).join('');
    parts.push('</p>', '\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

/** Whether the range `src[a..b)` is spaces/tabs only. */
function rangeIsBlank(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `c` (a code unit) starts a path name: a letter or '_'. */
function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** Whether `c` continues a path name: a letter, digit or '_'. */
function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const parts = text.split('.');
  for (const p of parts) {
    if (p.length === 0 || !isNameStart(p.charCodeAt(0))) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    for (let i = 1; i < p.length; i++) {
      if (!isNameChar(p.charCodeAt(i))) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    }
  }
  return parts;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line goes with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = rangeIsBlank(src, lineStart, open) && rangeIsBlank(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Parse a `for` tag body: { name, path } or null. `for <name> in <path>`. */
function parseFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (i >= tag.length || !isNameStart(tag.charCodeAt(i))) return null;
  const ns = i;
  while (i < tag.length && isNameChar(tag.charCodeAt(i))) i++;
  const varName = tag.slice(ns, i);
  if (tag.slice(i, i + 4) !== ' in ') return null;
  const path = tag.slice(i + 4);
  if (path.length === 0) return null;
  for (let j = 0; j < path.length; j++) if (isWSCode(tag.charCodeAt(i + 4 + j))) return null;
  return { name: varName, path };
}

/** Parse an `if` tag body: { not, path } or null. `if [not ]<path>`. */
function parseIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let i = 3;
  let not = false;
  if (tag.slice(i, i + 4) === 'not ') {
    not = true;
    i += 4;
  }
  const path = tag.slice(i);
  if (path.length === 0) return null;
  for (let j = 0; j < path.length; j++) if (isWSCode(path.charCodeAt(j))) return null;
  return { not, path };
}

/** Parse an `include` tag body: the template name or null. `include "<name>"`. */
function parseInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const inner = tag.slice(9, -1);
  if (inner.length === 0) return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = parseFor(tag)) !== null) {
        const node = { kind: 'for', name: m.name, path: pathOf(name, m.path), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = parseIf(tag)) !== null) {
        const node = { kind: 'if', not: m.not, path: pathOf(name, m.path), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = parseInclude(tag)) !== null) body.push({ kind: 'include', name: m });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }) to a string. */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        // One scope for the whole loop: rendering is synchronous, nothing
        // retains a scope, so the element and loop fields are mutated per item.
        const vars = { [n.name]: xs[0], loop: { index: 1, first: true, last: len === 1, length: len } };
        const child = { vars, parent: scope };
        for (let k = 0; k < len; k++) {
          // A loop variable named "loop" is shadowed by the loop record itself,
          // exactly as the reference's object literal leaves it.
          if (n.name !== 'loop') vars[n.name] = xs[k];
          const lp = vars.loop;
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === len - 1;
          out += renderNodes(n.body, child, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** A source's tags, each slug once, in its own order. */
function ownTags(st, s) {
  const seen = new Set();
  const out = [];
  const tags = s.data.tags ?? [];
  for (const name of tags) {
    const slug = slugify(st, name);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(name);
    }
  }
  return out;
}

/** Whether `t` has a scheme (`https:`, `mailto:` ...). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const st = { slugCache: new Map() };
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; refused sources and drafts are reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's directory and url, slug unique in its directory.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(st, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(st, s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, named as first met in the posts' order.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(st, p)) {
      const slug = slugify(st, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(st, s).map((name) => {
        const slug = slugify(st, name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages as templates read them.
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => {
    // A post's card is already built; a page's card is built once here.
    const card = cards.get(s) ?? cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // Layouts: every page, the index pages, the tag pages, then statics.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
