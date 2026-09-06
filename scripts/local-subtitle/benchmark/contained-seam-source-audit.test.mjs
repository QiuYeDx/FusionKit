import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditContainedSeamSources as audit } from './contained-seam-source-audit.mjs';
const part = (id, text, startMs, endMs, observedStartMs = startMs, observedEndMs = endMs) => ({ id, text, startMs, endMs, observedStartMs, observedEndMs });
const input = () => ({ left: [part('a', 'あなたにはエッチな行為によって', 12000, 16000), part('b', '相手から魔力を吸収する能力', 16000, 17500, 16000, 20000)],
  right: part('c', 'によって相手から魔力を吸収する能力を与えておいたわ', 17500, 22000, 15710, 22000) });
test('accounts for a repeated suffix spanning two parents without authorizing deletion', () => {
  const source = input(), before = structuredClone(source), r = audit(source);
  assert.equal(r.kind, 'multi_source_prefix');assert.equal(r.automaticAcceptance, false);
  assert.equal(r.redundantRight.text, 'によって相手から魔力を吸収する能力');
  assert.equal(r.composedText, 'あなたにはエッチな行為によって相手から魔力を吸収する能力を与えておいたわ');
  assert.equal(r.coveredLeft.length, 2);assert.deepEqual(source, before);
});
test('retains every word outside the middle containment as unresolved', () => {
  const r = audit({ left: [part('a', '前の話その子は魔力過剰症といって今日は', 1000, 5000, 1000, 7000)], right: part('b', 'その子は魔力過剰症といって', 5000, 6500, 4000, 6500) });
  assert.equal(r.kind, 'right_contained');assert.equal(r.before, '前の話');assert.equal(r.after, '今日は');
  assert.equal(r.composedText, undefined);
});
for (const scenario of ['disjoint', 'repeated', 'changed', 'source_id', 'reverse', 'many_parents']) test('rejects '+scenario, () => {
  const d = input();
  if(scenario==='disjoint') d.right.observedStartMs=20000;
  if(scenario==='repeated') d.right.text+=d.right.text;
  if(scenario==='changed') d.right.text=d.right.text.replace('魔力','体力');
  if(scenario==='source_id') d.right.id='a';
  if(scenario==='reverse') d.left[1].startMs=15000;
  if(scenario==='many_parents') d.left.push(d.left[1]);
  assert.equal(audit(d).status,'rejected');
});
test('uses grapheme positions for supplementary characters and punctuation', () => {
  const d=input();d.left[0].text='𠮷'+d.left[0].text;const r=audit(d);
  assert.equal(r.kept[0].endGrapheme,Array.from(d.left[0].text).length);
  assert.ok(r.composedText.startsWith('𠮷'));assert.equal(r.status,'source_accounting_only');
});
