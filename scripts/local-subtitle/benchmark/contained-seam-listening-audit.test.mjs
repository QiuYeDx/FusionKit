import test from 'node:test';
import assert from 'node:assert/strict';
import { auditContainedSeamListening as audit } from './contained-seam-listening-audit.mjs';
const sha = 'a'.repeat(64), prefix = 'こちらに案内するけど', middle = 'その人は図書館にいて', tail = '静かな場所で本を読んでいるよ', extra = '明日は';
function fixture() {
  const left = { id: 'left', text: prefix + middle + extra, startMs: 1000, endMs: 6000, observedStartMs: 1000, observedEndMs: 7000 };
  const right = { id: 'right', text: middle, startMs: 6000, endMs: 8000, observedStartMs: 5000, observedEndMs: 8000 };
  const following = { id: 'next', text: tail, startMs: 8000, endMs: 13000 };
  const source = { mediaSha256: sha, left, right, following };
  const annotation = { judgment: 'absent', mediaSha256: sha, sourceId: left.id, sourceText: left.text,
    from: Array.from(prefix + middle).length, to: Array.from(left.text).length, text: extra, feedbackSha256: sha, reviewId: sha };
  const view = (id, origin, shift) => ({ id, mediaSha256: sha, mode: 'uncompressed_non_vad', windowStartMs: origin, windowEndMs: 14000,
    segments: [prefix, middle, tail].map((text, i) => ({ text, startMs: [1000, 5000, 8000][i] - origin, endMs: [5000, 8000, 13000][i] - origin,
      dtwTokens: Array.from(text).map((text, j) => ({ text, pointMs: [1500, 5200 + shift, 8300 + shift][i] + j * 200 - origin })) })) });
  return [source, annotation, [view('one', 0, 0), view('two', 500, 40)]];
}
test('makes a strictly scoped manual candidate and preserves source wording', () => {
  const input = fixture(), copy = structuredClone(input), result = audit(...input);
  assert.equal(result.status, 'listening_candidate');assert.equal(result.automaticAcceptance, false);assert.equal(result.actualApplicationOutput, false);
  assert.deepEqual(result.replacements.map(s => [s.text, s.startMs, s.endMs]), [[prefix,1000,5200],[middle,5200,8300],[tail,8300,13000]]);
  assert.deepEqual(input, copy);
});
for (const field of ['judgment','mediaSha256','sourceId','sourceText','from','to','text','feedbackSha256','reviewId']) test('rejects unbound annotation: '+field, () => {
  const input = fixture();input[1][field] = 'wrong';assert.equal(audit(...input).reason, 'unbound_human_label');
});
for (const variant of ['missing','reverse','outside','drift','duplicate_origin','insert','repeat','contradiction']) test('retains adverse evidence: '+variant, () => {
  const input = fixture(), view = input[2][1], s = view.segments[1];
  if (variant === 'missing') delete s.dtwTokens[0].pointMs;
  if (variant === 'reverse') s.dtwTokens[1].pointMs = 1;
  if (variant === 'outside') view.segments[2].dtwTokens.at(-1).pointMs = 99999;
  if (variant === 'drift') s.dtwTokens.forEach(t => t.pointMs += 400);
  if (variant === 'duplicate_origin') view.windowStartMs = input[2][0].windowStartMs;
  if (variant === 'insert') { s.text = 'え' + s.text;s.dtwTokens.unshift({text:'え',pointMs:s.dtwTokens[0].pointMs}); }
  if (variant === 'repeat') { s.text += s.text;s.dtwTokens.push(...s.dtwTokens.map(t => ({...t,pointMs:s.dtwTokens.at(-1).pointMs}))); }
  if (variant === 'contradiction') { view.segments[2].text += extra;view.segments[2].dtwTokens.push({text:extra,pointMs:12500}); }
  assert.equal(audit(...input).status,'rejected');
});
test('keeps non-anchor lexical differences visible instead of normalizing them', () => {
  const input = fixture(), s = input[2][1].segments[0];s.text = 'あ' + s.text.slice(1);s.dtwTokens[0].text = 'あ';
  const r = audit(...input);assert.equal(r.status,'listening_candidate');assert.ok(r.observations[1].fullText.startsWith('あ'));assert.equal(r.replacements[0].text,prefix);
});
test('refuses a nonadjacent source', () => { const input=fixture();input[0].following.startMs++;assert.equal(audit(...input).status,'rejected'); });
test('refuses a short final cue', () => { const input=fixture();input[0].following.endMs=8500;assert.equal(audit(...input).reason,'short_result'); });
test('refuses a boundary inside a token', () => {
  const input=fixture(), v=input[2][1], a=v.segments[0], b=v.segments[1];
  const last=a.dtwTokens.pop(), first=b.dtwTokens.shift();a.text=a.dtwTokens.map(t=>t.text).join('');
  b.dtwTokens.unshift({text:last.text+first.text,pointMs:first.pointMs});b.text=b.dtwTokens.map(t=>t.text).join('');
  assert.equal(audit(...input).reason,'unsupported_anchor_point');
});
