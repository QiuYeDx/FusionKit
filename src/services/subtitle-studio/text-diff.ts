export type DiffPart = { kind: 'same' | 'removed' | 'added'; text: string };

/** Above this many token pairs the diff shows a whole-text replacement instead. */
const MAX_CELLS = 250_000;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}\p{M}_'’-]/u;

/** Words and runs of spaces stay whole; CJK characters and punctuation are compared one by one. */
export function diffTokens(text: string): string[] {
  const out: string[] = [];
  let current = '', kind = '';
  for (const char of text) {
    const next = CJK.test(char) ? 'cjk' : WORD.test(char) ? 'word' : /\s/u.test(char) ? 'space' : 'other';
    if (next === kind && (next === 'word' || next === 'space')) current += char;
    else { if (current) out.push(current); current = char; kind = next; }
  }
  if (current) out.push(current);
  return out;
}

function push(parts: DiffPart[], kind: DiffPart['kind'], text: string) {
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

/** A readable word-level diff of two short texts, such as one subtitle cue. */
export function diffText(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: 'same', text: before }] : [];
  const a = diffTokens(before), b = diffTokens(after);
  // Common ends first: most revisions touch a few words in the middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end), y = b.slice(start, b.length - end);
  const parts: DiffPart[] = [];
  if (start) push(parts, 'same', a.slice(0, start).join(''));
  const replace = () => {
    if (x.length) push(parts, 'removed', x.join(''));
    if (y.length) push(parts, 'added', y.join(''));
  };
  if (x.length * y.length > MAX_CELLS) replace();
  else {
    // Longest common subsequence, walked from the front.
    const width = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
      lcs[i * width + j] = x[i] === y[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    let i = 0, j = 0;
    const middle: DiffPart[] = [];
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { push(middle, 'same', x[i]); i++; j++; }
      // Removals come before additions, so a replacement reads old → new.
      else if (i < x.length && (j === y.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) { push(middle, 'removed', x[i]); i++; }
      else { push(middle, 'added', y[j]); j++; }
    }
    // A rewrite that shares only scraps of text reads better as old text, then new text.
    const shared = middle.reduce((sum, part) => sum + (part.kind === 'same' && /\S/u.test(part.text) ? part.text.length : 0), 0);
    if (shared * 2 < Math.min(x.join('').length, y.join('').length)) replace();
    else for (const part of middle) push(parts, part.kind, part.text);
  }
  if (end) push(parts, 'same', a.slice(a.length - end).join(''));
  return parts;
}
