// Pure reporting for recognizing cues again with the recognize-only models: the original line, what the app's
// recognition returned, and the same clip heard with timestamps. Nothing here judges which text is right.
import type { RecognizeClipRequest } from '../../electron/main/subtitle-studio/transcription/runtime';
import type { CueRecognizeResult } from '../../src/subtitle-studio/cue-recognize-contract';
import { cueChars, formatRange } from './ab-report';

/** What whisper-server returned for one clip; segment times are the clip's own. */
export interface AsrRecognizeHeard {
  text: string; language: string;
  segments: { startMs: number; endMs: number; averageLogProbability: number; noSpeechProbability: number }[];
}
/** One request for a clip: what the app asked the runtime for, the multipart fields the server got and its answer. */
export interface AsrRecognizeRequest {
  request?: Omit<RecognizeClipRequest, 'filePath' | 'signal'>; fields?: Record<string, string>; heard?: AsrRecognizeHeard;
  oddLead?: string; serverMs?: number; loadMs?: number; error?: string;
}
export interface AsrRecognizeCue extends AsrRecognizeRequest {
  sampleId: string; index: number; startMs: number; endMs: number; original: { text: string; confidence?: number };
  /** The clip the app decoded, copied beside the report, and its length. */
  clip?: string; clipMs?: number;
  result?: CueRecognizeResult; elapsedMs?: number;
  /** The same clip heard again with timestamps (no_timestamps=false), which the model's profile leaves out. */
  timed?: AsrRecognizeRequest;
}
export interface AsrRecognizeModelRun {
  modelId: string; sha256: string; sampleIds: string[]; devicePreference: string;
  processIds: number[]; serverLoads: string[]; backendProofs: { processId: number; backend: string; acceleratorPackGeneration?: string }[];
  cues: AsrRecognizeCue[]; observerErrors: string[]; error?: string;
  cleanup?: { joined: boolean; processesExited: boolean; killed: number[]; workRemoved: boolean; error?: string };
}
export interface AsrRecognizeSample { id: string; language: string; path: string; sha256: string; durationMs: number; cues: number }
export interface AsrRecognizeReport {
  runId: string; startedAt: string; completedAt?: string; cuesRun: string; environment: string[];
  samples: AsrRecognizeSample[]; models: AsrRecognizeModelRun[];
}

/**
 * Latin letters, digits or U+FFFD in front of the line that the original line does not start with: the stray
 * token anime-whisper put before most lines when it was asked for timestamps (records/model-smoke.md).
 */
export function oddLead(text: string, original: string) {
  const lead = /^[\s\p{Script=Latin}\p{Nd}�]+/u.exec(text)?.[0].trim();
  return lead && !original.trimStart().startsWith(lead) ? lead : undefined;
}

/** The fields that tell how a clip was asked for, with every value they took. */
export const ASR_RECOGNIZE_FIELDS = Object.freeze(['language', 'no_timestamps', 'vad', 'vad_speech_pad_ms', 'prompt', 'beam_size', 'temperature']);
export function describeFields(requests: readonly AsrRecognizeRequest[]) {
  return ASR_RECOGNIZE_FIELDS.flatMap(name => {
    const values = [...new Set(requests.flatMap(request => request.fields && name in request.fields ? [request.fields[name]!] : []))];
    return values.length ? [`${name}=${values.join('/')}`] : [];
  }).join(', ') || '无';
}

const cell = (value: string) => value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ') || '—';
const seconds = (ms?: number) => ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`;
const scored = (text: string, confidence?: number) => `${cell(text)}${confidence === undefined ? '' : `（${confidence.toFixed(3)}）`}`;
const sum = (values: readonly (number | undefined)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

function modelSection(run: AsrRecognizeModelRun) {
  const heard = run.cues.filter(cue => cue.result), timed = run.cues.filter(cue => cue.timed?.heard);
  const lines = [`## ${run.modelId}`, '',
    `- 模型 SHA-256 ${run.sha256.slice(0, 12)}…；样本 ${run.sampleIds.join('、')}；设备偏好 ${run.devicePreference}`,
    `- 服务进程 ${run.processIds.join('、') || '无'}；加载 ${run.serverLoads.join('、') || '无'}；后端证明 ${
      run.backendProofs.map(proof => `${proof.processId}:${proof.backend}${proof.acceleratorPackGeneration ? `（包代 ${proof.acceleratorPackGeneration.slice(0, 8)}…）` : ''}`).join('、') || '无'}`,
    `- 识别 ${heard.length}/${run.cues.length} 句，失败 ${run.cues.length - heard.length} 句；总耗时 ${seconds(sum(run.cues.map(cue => cue.elapsedMs)))}，` +
    `其中服务 ${seconds(sum(run.cues.map(cue => cue.serverMs)))}、首句加载 ${seconds(run.cues[0]?.loadMs)}；字数 ${
      sum(run.cues.map(cue => cueChars(cue.original.text)))} → ${sum(heard.map(cue => cueChars(cue.result!.text)))}`,
    `- 应用请求字段：${describeFields(run.cues)}`,
    `- 有时间戳对照字段：${describeFields(run.cues.flatMap(cue => cue.timed ? [cue.timed] : []))}`,
    `- 开头怪字：应用路径 ${heard.filter(cue => cue.oddLead).length}/${heard.length} 句，有时间戳对照 ${timed.filter(cue => cue.timed!.oddLead).length}/${timed.length} 句；` +
    `被复核规则标记 ${heard.filter(cue => cue.result!.reasons.length).length} 句`,
    ...run.cleanup ? [`- 清理：关闭${run.cleanup.joined ? '完成' : '未完成'}，进程${run.cleanup.processesExited ? '全部退出' : '仍在运行'}${
      run.cleanup.killed.length ? `（由工具结束 ${run.cleanup.killed.join('、')}）` : ''}，临时目录${run.cleanup.workRemoved ? '已删除' : '保留'}${
      run.cleanup.error ? `；${cell(run.cleanup.error)}` : ''}`] : [],
    ...run.error ? [`- 失败：${cell(run.error)}`] : [], ...run.observerErrors.map(error => `- 观察错误：${cell(error)}`), '',
    '| # | 样本 | 区间 | 原文（large-v3） | 重识别 | 复核原因 | 开头怪字 | 有时间戳对照 | 剪辑 | 耗时（总/服务） | 结论 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  run.cues.forEach((cue, position) => lines.push(`| ${position + 1} | ${cue.sampleId} #${cue.index} | ${formatRange(cue.startMs, cue.endMs)} | ${
    scored(cue.original.text, cue.original.confidence)} | ${cue.result ? scored(cue.result.text, cue.result.confidence) : `失败：${cell(cue.error ?? '')}`} | ${
    cue.result?.reasons.join('、') || '—'} | ${cue.result ? cue.oddLead ?? '无' : '—'} | ${
    cue.timed?.heard ? `${cell(cue.timed.heard.text)}${cue.timed.oddLead ? `（怪字 ${cue.timed.oddLead}）` : ''}` : cue.timed?.error ? `失败：${cell(cue.timed.error)}` : '—'} | ${
    seconds(cue.clipMs)} | ${seconds(cue.elapsedMs)} / ${seconds(cue.serverMs)} |  |`));
  return [...lines, ''];
}

export function renderRecognizeReport(report: AsrRecognizeReport) {
  return [`# 仅重识别模型的应用路径冒烟`, '', `- 运行：${report.runId}（${report.startedAt} — ${report.completedAt ?? '进行中'}）`,
    `- 字幕来源：${report.cuesRun} 中 standard 变体的转写（large-v3）`, ...report.environment.map(line => `- ${line}`), '',
    '“重识别”是应用的重新识别路径（recognizeCue → 运行时 recognize.clip → whisper-server）返回的文字，括号内是置信度（0–1，只是解码器的把握程度）。' +
    '“有时间戳对照”是同一剪辑去掉 no_timestamps 再识别一次的文字，应用不会这样请求，只用来对照开头怪字。区间按整秒取，可直接在播放器里跳转；结论由用户听审后填写，Agent 不代签。', '',
    '## 样本', '', '| 样本 | 语言 | 文件 | 时长 | 字幕 |', '| --- | --- | --- | --- | --- |',
    ...report.samples.map(sample => `| ${sample.id} | ${sample.language} | ${cell(sample.path)} | ${seconds(sample.durationMs)} | ${sample.cues} |`), '',
    ...report.models.flatMap(modelSection)].join('\n');
}
