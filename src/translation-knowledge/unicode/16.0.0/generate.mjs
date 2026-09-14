import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Deliberately offline: supply the two official, unmodified source files.
const sources = [
  ['CaseFolding.txt', '6f1f9c588eb4a5c718d9e8f93b782685e5c7fec872cf05e8e6878053599e09bb'],
  ['UnicodeData.txt', 'ff58e5823bd095166564a006e47d111130813dcf8bf234ef79fa51a870edb48f'],
];
if (process.argv.length !== 4) {
  throw new Error('Usage: node generate.mjs /path/CaseFolding.txt /path/UnicodeData.txt');
}
const contents = await Promise.all(sources.map(async ([name, digest], index) => {
  const bytes = await readFile(process.argv[index + 2]);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Error(`${name} does not match the pinned Unicode 16.0.0 source hash.`);
  }
  return bytes.toString('utf8');
}));

const folding = [];
for (const line of contents[0].split('\n')) {
  const [point, status, mapping] = line.split('#')[0].split(';').map(value => value.trim());
  if (status !== 'C' && status !== 'F') continue;
  folding.push([parseInt(point, 16), mapping.split(' ').map(value => parseInt(value, 16))]);
}
folding.sort((left, right) => left[0] - right[0]);

const ranges = [];
const assignedRanges = [];
const wordCategory = category => /^[LMN]/.test(category) || category === 'Pc';
let pendingRange;
function addRange(target, start, end) {
  const previous = target.at(-1);
  if (previous && previous[1] + 1 === start) previous[1] = end;
  else target.push([start, end]);
}
for (const line of contents[1].split('\n')) {
  if (!line) continue;
  const [point, name, category] = line.split(';');
  const codePoint = parseInt(point, 16);
  if (name.endsWith(', First>')) {
    if (pendingRange) throw new Error('Overlapping UnicodeData ranges.');
    pendingRange = { codePoint, category };
  } else if (name.endsWith(', Last>')) {
    if (!pendingRange || pendingRange.category !== category) throw new Error('Invalid UnicodeData range.');
    addRange(assignedRanges, pendingRange.codePoint, codePoint);
    if (wordCategory(category)) addRange(ranges, pendingRange.codePoint, codePoint);
    pendingRange = undefined;
  } else {
    addRange(assignedRanges, codePoint, codePoint);
    if (wordCategory(category)) addRange(ranges, codePoint, codePoint);
  }
}
if (pendingRange) throw new Error('Unclosed UnicodeData range.');

const hex = point => `0x${point.toString(16).toUpperCase()}`;
const stringLiteral = points => '"' + points.map(point =>
  point <= 0xFFFF
    ? `\\u${point.toString(16).toUpperCase().padStart(4, '0')}`
    : `\\u{${point.toString(16).toUpperCase()}}`,
).join('') + '"';
const output = [
  '// Generated from official Unicode 16.0.0 data. Do not edit manually.',
  '// Reproduction, source hashes and Unicode License V3: see README.md and LICENSE.txt.',
  '// Only default full C/F case folds, L/M/N/Pc ranges and assigned ranges are retained.',
  'export const FULL_CASE_FOLDING: Readonly<Record<number, string>> = Object.freeze({',
  ...folding.map(([point, mapping]) => `  ${hex(point)}: ${stringLiteral(mapping)},`),
  '});',
  '',
  '// Inclusive, sorted, disjoint and maximally coalesced code point ranges.',
  'export const WORD_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [',
  ...ranges.map(([start, end]) => `  [${hex(start)}, ${hex(end)}],`),
  '];',
  '',
  '// All assigned categories, including private-use and surrogate ranges.',
  'export const ASSIGNED_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [',
  ...assignedRanges.map(([start, end]) => `  [${hex(start)}, ${hex(end)}],`),
  '];',
  '',
].join('\n');
await writeFile(new URL('./data.ts', import.meta.url), output, 'utf8');
console.log(`Generated ${folding.length} case folds, ${ranges.length} word ranges and ${assignedRanges.length} assigned ranges.`);
