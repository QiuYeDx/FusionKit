// Pure reporting for the real-audio A/B comparison: alignment, statistics and the three Markdown reports.
// Nothing here judges quality; the reports only point the listener at the places that differ.
import type { AsrAbDevice, AsrAbVariant } from './ab-config';

export interface AsrAbCue { startMs: number; endMs: number; text: string; confidence?: number }
export type AsrAbRequestKind = 'primary' | 'quality_recovery' | 'separator';
/** One whisper-server request: the multipart fields it sent, its window and what the window returned. */
export interface AsrAbRequest {
  ordinal: number; kind: AsrAbRequestKind; fields: Record<string, string>;
  /** `conditioning` is the low-volume mode the window asked for; the gain is what it applied. */
  window?: { startMs: number; endMs: number; quietAudioGainDb?: number; conditioning?: string };
  elapsedMs?: number; language?: string; segments?: number; textChars?: number; error?: string;
}
export type AsrAbCaseStatus = 'completed' | 'no_content' | 'failed' | 'cancelled' | 'not_implemented';
export interface AsrAbCase {
  sampleId: string; variant: AsrAbVariant; status: AsrAbCaseStatus; cues: AsrAbCue[]; requests: AsrAbRequest[];
  timings: { totalMs?: number; normalizeMs?: number; loadMs?: number; inferenceMs?: number };
  /** Whether a recognition request carried the profile's voice-detection fields. */
  profileApplied?: boolean;
  /** Review flags once the review rules exist (T-ASRQ-05); absent until then. */
  reviewFlags?: number;
  error?: string;
}
export interface AsrAbSample {
  id: string; language: string; description: string; status: 'present' | 'missing' | 'changed';
  path?: string; durationMs?: number; reason?: string;
}
export interface AsrAbReport {
  runId: string; startedAt: string; completedAt?: string;
  model: { id: string; sha256?: string; source: string }; device: AsrAbDevice; environment: string[];
  samples: AsrAbSample[]; variants: AsrAbVariant[]; cases: AsrAbCase[];
}

export const cueChars = (text: string) => [...text.replace(/\s+/gu, '')].length;
/** Text two runs can be compared on: width-folded, without whitespace or punctuation. */
export const comparableText = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '');
const terminal = (status: AsrAbCaseStatus) => status === 'completed' || status === 'no_content';

/** `mm:ss` (`h:mm:ss` past an hour) for a listener seeking in a player, or SRT's `hh:mm:ss,mmm`. */
function clock(ms: number, milliseconds?: ',') {
  const value = Math.max(0, Math.round(ms)), hours = Math.floor(value / 3_600_000), minutes = Math.floor(value / 60_000) % 60;
  const second = Math.floor(value / 1000) % 60, pad = (number: number, width = 2) => String(number).padStart(width, '0');
  return milliseconds ? `${pad(hours)}:${pad(minutes)}:${pad(second)}${milliseconds}${pad(value % 1000, 3)}`
    : `${hours ? `${hours}:` : ''}${pad(minutes)}:${pad(second)}`;
}
export const formatClock = (ms: number) => clock(ms);
/** Whole seconds that cover the range: the start rounds down and the end up. */
export const formatRange = (startMs: number, endMs: number) =>
  `${formatClock(Math.floor(startMs / 1000) * 1000)}–${formatClock(Math.ceil(endMs / 1000) * 1000)}`;

/** The layout of the app's SRT export; no cues give an empty file. */
export function formatSrt(cues: readonly AsrAbCue[]) {
  return cues.map((cue, index) => `${index + 1}\n${clock(cue.startMs, ',')} --> ${clock(cue.endMs, ',')}\n${cue.text}\n`).join('\n');
}

export type AsrAbChange = 'same' | 'minor' | 'changed' | 'added' | 'removed';
/** Cues of both runs that overlap one another; `minor` keeps the words but not the punctuation, split or edges. */
export interface AsrAbAlignedGroup { kind: AsrAbChange; startMs: number; endMs: number; base: AsrAbCue[]; other: AsrAbCue[] }
export const ASR_AB_ALIGNMENT = Object.freeze({ boundaryToleranceMs: 250, matchShare: 0.5, overlapMs: 300, overlapShare: 0.3 });

const overlapOf = (a: AsrAbCue, b: AsrAbCue) => Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
const shorterOf = (a: AsrAbCue, b: AsrAbCue) => Math.max(1, Math.min(a.endMs - a.startMs, b.endMs - b.startMs));
/** Covering half of the shorter cue pairs two sentences, though their edges moved by a second. */
const matches = (a: AsrAbCue, b: AsrAbCue) => overlapOf(a, b) > 0 && overlapOf(a, b) >= shorterOf(a, b) * ASR_AB_ALIGNMENT.matchShare;
/** A cue left unpaired joins its largest overlap, unless that is only a shared edge of a few frames. */
const touches = (a: AsrAbCue, b: AsrAbCue) => overlapOf(a, b) > 0
  && overlapOf(a, b) >= Math.min(ASR_AB_ALIGNMENT.overlapMs, shorterOf(a, b) * ASR_AB_ALIGNMENT.overlapShare);
function classify(base: readonly AsrAbCue[], other: readonly AsrAbCue[]): AsrAbChange {
  if (!base.length) return 'added';
  if (!other.length) return 'removed';
  const joined = (cues: readonly AsrAbCue[]) => cues.map(cue => cue.text).join('');
  if (comparableText(joined(base)) !== comparableText(joined(other))) return 'changed';
  const { boundaryToleranceMs: tolerance } = ASR_AB_ALIGNMENT;
  const same = base.length === other.length && base.every((cue, index) => cue.text.trim() === other[index]!.text.trim()
    && Math.abs(cue.startMs - other[index]!.startMs) <= tolerance && Math.abs(cue.endMs - other[index]!.endMs) <= tolerance);
  return same ? 'same' : 'minor';
}

export function alignCues(base: readonly AsrAbCue[], other: readonly AsrAbCue[]): AsrAbAlignedGroup[] {
  const order = (cues: readonly AsrAbCue[]) => [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const left = order(base), right = order(other), all = [...left, ...right], parent = all.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const paired = new Set<number>(), join = (i: number, j: number) => { parent[find(left.length + j)] = find(i); paired.add(i).add(left.length + j); };
  for (let i = 0; i < left.length; i++) for (let j = 0; j < right.length; j++) if (matches(left[i]!, right[j]!)) join(i, j);
  for (let index = 0; index < all.length; index++) {
    if (paired.has(index)) continue;
    const own = index < left.length, cue = all[index]!, counterparts = own ? right : left;
    const best = counterparts.reduce<number | undefined>((found, candidate, position) => touches(cue, candidate)
      && (found === undefined || overlapOf(cue, candidate) > overlapOf(cue, counterparts[found]!)) ? position : found, undefined);
    if (best !== undefined) { if (own) join(index, best); else join(best, index - left.length); }
  }
  const groups = new Map<number, { base: AsrAbCue[]; other: AsrAbCue[] }>();
  all.forEach((cue, index) => {
    const group = groups.get(find(index)) ?? { base: [], other: [] }; groups.set(find(index), group);
    (index < left.length ? group.base : group.other).push(cue);
  });
  return [...groups.values()].map(group => {
    const cues = [...group.base, ...group.other];
    return { kind: classify(group.base, group.other), startMs: Math.min(...cues.map(cue => cue.startMs)),
      endMs: Math.max(...cues.map(cue => cue.endMs)), ...group };
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** What a minor group changed: the split, the punctuation, or else its edges by up to this much. */
export function minorDetail(group: Pick<AsrAbAlignedGroup, 'base' | 'other'>) {
  if (group.base.length !== group.other.length) return `断句 ${group.base.length}→${group.other.length}`;
  if (group.base.some((cue, index) => cue.text.trim() !== group.other[index]!.text.trim())) return '标点';
  const shift = Math.max(0, ...group.base.flatMap((cue, index) =>
    [Math.abs(cue.startMs - group.other[index]!.startMs), Math.abs(cue.endMs - group.other[index]!.endMs)]));
  return `边界 ${(shift / 1000).toFixed(1)} s`;
}

export function countChanges(groups: readonly AsrAbAlignedGroup[]) {
  const counts: Record<AsrAbChange, number> = { same: 0, minor: 0, changed: 0, added: 0, removed: 0 };
  for (const group of groups) counts[group.kind]++;
  return counts;
}

/** The upper edges of the confidence buckets; the review rules start at 0.45. */
export const ASR_AB_CONFIDENCE_EDGES = [0.3, 0.45, 0.6, 0.8] as const;
export function confidenceDistribution(cues: readonly AsrAbCue[]) {
  const values = cues.flatMap(cue => typeof cue.confidence === 'number' && Number.isFinite(cue.confidence) ? [cue.confidence] : [])
    .sort((a, b) => a - b);
  if (!values.length) return undefined;
  const buckets = [...ASR_AB_CONFIDENCE_EDGES, Infinity].map(() => 0);
  for (const value of values) {
    const index = ASR_AB_CONFIDENCE_EDGES.findIndex(edge => value < edge);
    buckets[index === -1 ? ASR_AB_CONFIDENCE_EDGES.length : index]!++;
  }
  const middle = values.length >> 1, median = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  return { count: values.length, min: values[0]!, median, mean: values.reduce((sum, value) => sum + value, 0) / values.length, buckets };
}

export type AsrAbFieldSummary = Partial<Record<AsrAbRequestKind, { count: number; fields: Record<string, Record<string, number>> }>>;
/** How many requests of each kind sent each field value; a field missing from some requests counts fewer. */
export function summarizeRequestFields(requests: readonly Pick<AsrAbRequest, 'kind' | 'fields'>[]): AsrAbFieldSummary {
  const summary: AsrAbFieldSummary = {};
  for (const request of requests) {
    const entry = summary[request.kind] ??= { count: 0, fields: {} }; entry.count++;
    for (const [name, value] of Object.entries(request.fields)) { const values = entry.fields[name] ??= {}; values[value] = (values[value] ?? 0) + 1; }
  }
  return summary;
}
/** Only these fields change between the audio types; the rest are the verified standard request. */
export const ASR_AB_PROFILE_FIELDS = ['vad_threshold', 'vad_min_speech_duration_ms', 'vad_speech_pad_ms', 'no_speech_thold', 'suppress_nst'] as const;
export function describeProfileFields(summary: AsrAbFieldSummary) {
  const parts: string[] = [];
  for (const kind of ['primary', 'quality_recovery'] as const) {
    const entry = summary[kind]; if (!entry) continue;
    for (const name of ASR_AB_PROFILE_FIELDS) {
      const values = entry.fields[name]; if (!values) continue;
      parts.push(`${kind === 'primary' ? '' : '重放 '}${name}=${Object.entries(values).map(([value, count]) => `${value}×${count}`).join('/')}`);
    }
  }
  return parts.join('; ') || '无';
}

export interface AsrAbListeningEntry { variant: AsrAbVariant; kind: AsrAbChange; base: string; other: string }
export interface AsrAbListeningRegion { startMs: number; endMs: number; entries: AsrAbListeningEntry[] }
export const ASR_AB_LISTENING = Object.freeze({ padMs: 500, mergeGapMs: 1000 });

/** Padded ranges where a variant's words differ from the standard, merged across variants. */
export function listeningRegions(comparisons: readonly { variant: AsrAbVariant; groups: readonly AsrAbAlignedGroup[] }[], durationMs?: number) {
  const { padMs, mergeGapMs } = ASR_AB_LISTENING, end = durationMs ?? Infinity;
  const raw = comparisons.flatMap(({ variant, groups }) => groups.filter(group => group.kind !== 'same' && group.kind !== 'minor').map(group => ({
    startMs: Math.max(0, group.startMs - padMs), endMs: Math.min(end, group.endMs + padMs),
    entry: { variant, kind: group.kind, base: group.base.map(cue => cue.text).join(' / '), other: group.other.map(cue => cue.text).join(' / ') } })))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const regions: AsrAbListeningRegion[] = [];
  for (const item of raw) {
    const last = regions.at(-1);
    if (last && item.startMs - last.endMs <= mergeGapMs) { last.endMs = Math.max(last.endMs, item.endMs); last.entries.push(item.entry); }
    else regions.push({ startMs: item.startMs, endMs: item.endMs, entries: [item.entry] });
  }
  return regions;
}

const STATUS_TEXT: Record<AsrAbCaseStatus, string> = { completed: '完成', no_content: '无内容', failed: '失败', cancelled: '已取消', not_implemented: '未实现' };
const CHANGE_TEXT: Record<AsrAbChange, string> = { same: '相同', minor: '细微', changed: '改变', added: '新增', removed: '消失' };
const KIND_TEXT: Record<AsrAbRequestKind, string> = { primary: '识别', quality_recovery: '质量重放', separator: '分句候选' };
const cell = (value: string) => value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ') || '—';
const duration = (ms?: number) => ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`;
const caseOf = (report: AsrAbReport, sampleId: string, variant: AsrAbVariant) =>
  report.cases.find(value => value.sampleId === sampleId && value.variant === variant);
function confidenceText(cues: readonly AsrAbCue[]) {
  const distribution = confidenceDistribution(cues); if (!distribution) return '无置信度';
  const labels = ['<0.30', '0.30–0.45', '0.45–0.60', '0.60–0.80', '≥0.80'];
  return `${distribution.buckets.map((count, index) => `${labels[index]}:${count}`).join(' ')}；中位 ${distribution.median.toFixed(2)}`;
}
function header(report: AsrAbReport, title: string) {
  return [`# ${title}`, '', `- 运行：${report.runId}（${report.startedAt} — ${report.completedAt ?? '进行中'}）`,
    `- 模型：${report.model.id}${report.model.sha256 ? `（SHA-256 ${report.model.sha256.slice(0, 12)}…）` : ''}，${report.model.source}；设备：${report.device}`,
    ...report.environment.map(line => `- ${line}`), ''];
}

export function renderSummary(report: AsrAbReport) {
  const lines = [...header(report, '真实音频对照摘要'),
    '本摘要只列客观统计；哪个变体更好以听审为准（见 listening.md）。', '', '## 样本', '', '| 样本 | 语言 | 说明 | 时长 | 状态 |', '| --- | --- | --- | --- | --- |'];
  for (const sample of report.samples) lines.push(`| ${sample.id} | ${sample.language} | ${cell(sample.description)} | ${duration(sample.durationMs)} | ${
    sample.status === 'present' ? '存在' : `${sample.status === 'missing' ? '缺失' : '已变化'}：${cell(sample.reason ?? '')}`} |`);
  lines.push('', '## 结果', '', '| 样本 | 变体 | 状态 | 字幕 | 字数 | 请求（识别/重放/分句） | 耗时（总/归一化/加载/识别） | 置信度 | 复核标记 | 预设字段 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const value of report.cases) {
    const count = (kind: AsrAbRequestKind) => value.requests.filter(request => request.kind === kind).length;
    lines.push(`| ${value.sampleId} | ${value.variant} | ${STATUS_TEXT[value.status]} | ${terminal(value.status) ? value.cues.length : '—'} | ${
      terminal(value.status) ? value.cues.reduce((sum, cue) => sum + cueChars(cue.text), 0) : '—'} | ${value.requests.length}（${count('primary')}/${
      count('quality_recovery')}/${count('separator')}） | ${[value.timings.totalMs, value.timings.normalizeMs, value.timings.loadMs, value.timings.inferenceMs].map(duration).join(' / ')} | ${
      terminal(value.status) ? confidenceText(value.cues) : '—'} | ${value.reviewFlags ?? '未实现'} | ${cell(describeProfileFields(summarizeRequestFields(value.requests)))} |`);
  }
  const noise = report.cases.filter(value => value.sampleId === 'B-noise');
  if (noise.length) {
    lines.push('', '## 负对照 B-noise', '', '任何变体在 B-noise 上输出文字都说明该变体会产生幻觉，预设不得推荐。', '');
    for (const value of noise) lines.push(`- ${value.variant}：${terminal(value.status)
      ? value.cues.length ? value.cues.map(cue => `${formatRange(cue.startMs, cue.endMs)} ${cue.text}`).join('；') : '（无文字）' : STATUS_TEXT[value.status]}`);
  }
  const notes = report.cases.flatMap(value => value.status === 'not_implemented'
    ? [`- ${value.sampleId} / ${value.variant}：未实现（${value.error ?? '任务配置不接受该音频类型'}）`]
    : value.variant !== 'standard' && terminal(value.status) && value.profileApplied === false
      ? [`- ${value.sampleId} / ${value.variant}：任务已接受该音频类型，但没有任何识别请求带上预设字段`] : []);
  if (notes.length) lines.push('', '## 未生效的变体', '', ...notes);
  const failures = report.cases.filter(value => value.status === 'failed' || value.status === 'cancelled');
  if (failures.length) lines.push('', '## 失败', '', ...failures.map(value => `- ${value.sampleId} / ${value.variant}：${cell(value.error ?? STATUS_TEXT[value.status])}`));
  lines.push('', '## 请求明细', '', '每个变体的逐请求字段、窗口语言与耗时见同名 JSON；请求类型：' +
    Object.entries(KIND_TEXT).map(([kind, text]) => `${kind}=${text}`).join('，') + '。', '');
  return lines.join('\n');
}

function comparisonsOf(report: AsrAbReport, sampleId: string) {
  const base = caseOf(report, sampleId, 'standard');
  return report.variants.filter(variant => variant !== 'standard').map(variant => {
    const other = caseOf(report, sampleId, variant);
    const comparable = base && other && terminal(base.status) && terminal(other.status);
    return { variant, base, other, groups: comparable ? alignCues(base.cues, other.cues) : undefined };
  });
}
const presentSamples = (report: AsrAbReport) => report.samples.filter(sample => sample.status === 'present');

export function renderDiff(report: AsrAbReport) {
  const { boundaryToleranceMs, matchShare, overlapMs, overlapShare } = ASR_AB_ALIGNMENT;
  const lines = [...header(report, '标准与音频类型的字幕差异'),
    `按时间重叠对齐：两条字幕的重叠达到较短一条的 ${matchShare * 100}% 视为同一句；其余字幕若与对方重叠不少于 min(${overlapMs} ms, ` +
    `较短一条的 ${overlapShare * 100}%)，并入重叠最多的那一句，否则记为新增或消失。` +
    `“细微”= 去掉空白与标点后文字相同，只是标点、断句或边界（>${boundaryToleranceMs} ms）不同；“改变/新增/消失”是文字差异。`, ''];
  for (const sample of presentSamples(report)) {
    lines.push(`## ${sample.id}`, '');
    const comparisons = comparisonsOf(report, sample.id);
    if (!comparisons.length) lines.push('只运行了 standard，没有可比较的变体。', '');
    for (const { variant, base, other, groups } of comparisons) {
      lines.push(`### standard → ${variant}`, '');
      if (!groups) {
        lines.push(`无法比较：standard ${base ? STATUS_TEXT[base.status] : '未运行'}，${variant} ${other ? STATUS_TEXT[other.status] : '未运行'}。`, ''); continue;
      }
      const counts = countChanges(groups), chars = (cues: readonly AsrAbCue[]) => cues.reduce((sum, cue) => sum + cueChars(cue.text), 0);
      lines.push(`${(Object.keys(counts) as AsrAbChange[]).map(kind => `${CHANGE_TEXT[kind]} ${counts[kind]}`).join(' · ')}；字幕 ${base!.cues.length} → ${
        other!.cues.length}，字数 ${chars(base!.cues)} → ${chars(other!.cues)}`, '');
      const texts = (group: AsrAbAlignedGroup) => `${cell(group.base.map(cue => cue.text).join(' / '))} | ${cell(group.other.map(cue => cue.text).join(' / '))}`;
      const words = groups.filter(group => group.kind !== 'same' && group.kind !== 'minor'), minor = groups.filter(group => group.kind === 'minor');
      if (!words.length && !minor.length) { lines.push('两者逐句相同。', ''); continue; }
      if (words.length) lines.push(`| 区间 | 类型 | standard | ${variant} |`, '| --- | --- | --- | --- |',
        ...words.map(group => `| ${formatRange(group.startMs, group.endMs)} | ${CHANGE_TEXT[group.kind]} | ${texts(group)} |`), '');
      else lines.push('没有文字差异。', '');
      if (minor.length) lines.push(`细微差异 ${minor.length} 处（文字相同，不需听审）：`, '', `| 区间 | 说明 | standard | ${variant} |`, '| --- | --- | --- | --- |',
        ...minor.map(group => `| ${formatRange(group.startMs, group.endMs)} | ${minorDetail(group)} | ${texts(group)} |`), '');
    }
  }
  return lines.join('\n');
}

export function renderListening(report: AsrAbReport) {
  const { padMs, mergeGapMs } = ASR_AB_LISTENING;
  const lines = [...header(report, '听审清单'),
    `只列文字有实质差异（改变/新增/消失）的位置；每个区间前后各留 ${padMs / 1000} s，相距 ${mergeGapMs / 1000} s 内的合并。` +
    '请在播放器中跳到该时间听原音，判断哪个版本更接近，结论填在最后一列（由用户填写，Agent 不代签）。', ''];
  for (const sample of presentSamples(report)) {
    lines.push(`## ${sample.id}（${sample.description}）`, '', ...sample.path ? [`文件：${sample.path}`, ''] : []);
    const comparisons = comparisonsOf(report, sample.id), missing = comparisons.filter(value => !value.groups);
    const state = (value?: AsrAbCase) => value ? STATUS_TEXT[value.status] : '未运行';
    if (missing.length) lines.push(`未比较：${missing.map(value => `${value.variant}（standard ${state(value.base)}，${state(value.other)}）`).join('、')}。`, '');
    const regions = listeningRegions(comparisons.flatMap(value => value.groups ? [{ variant: value.variant, groups: value.groups }] : []), sample.durationMs);
    if (!regions.length) { lines.push(comparisons.length > missing.length ? '各变体与 standard 没有文字差异。' : '没有可比较的变体。', ''); continue; }
    lines.push('| # | 区间 | 差异 | standard | 变体文字 | 听审结论 |', '| --- | --- | --- | --- | --- | --- |');
    regions.forEach((region, index) => region.entries.forEach((entry, position) => lines.push(`| ${position ? '' : index + 1} | ${
      position ? '' : formatRange(region.startMs, region.endMs)} | ${entry.variant} ${CHANGE_TEXT[entry.kind]} | ${cell(entry.base)} | ${cell(entry.other)} |  |`)));
    lines.push('');
  }
  return lines.join('\n');
}
