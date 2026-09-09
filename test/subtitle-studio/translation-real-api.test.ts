import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { readSubtitle } from '../../electron/main/subtitle-studio/input-service';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { serializeTranslationRequest } from '../../electron/main/subtitle-studio/translation-planner';
import { sendModelRuntimeText } from '../../electron/main/ai/model-runtime-client';

describe.runIf(process.env.FUSIONKIT_STUDIO_REAL === '1')('Subtitle Studio authorized real API', () => {
  const fixtures: { root: string; service: TranslationService }[] = [];
  afterAll(async () => {
    for (const fixture of fixtures) {
      await fixture.service.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  it.each(['srt', 'lrc'] as const)('translates %s with the same defaults as the workspace', async format => {
    const apiKey = process.env.FUSIONKIT_STUDIO_REAL_API_KEY;
    if (!apiKey) throw new Error('Missing explicitly authorized test credential');
    const root = await mkdtemp(path.join(tmpdir(), 'studio-real-'));
    const source = format === 'srt'
      ? '41\n00:00:01,000 --> 00:00:03,000\n<b>Welcome to the workshop.</b>\n\n73\n00:00:04,000 --> 00:00:06,000\nPlease keep the door open.\n\n'
      : Array.from({ length: 52 }, (_, i) => `[00:${String(i).padStart(2, '0')}.000]${['皆さん、こんにちは。', '今日は新しい道具を使います。', '準備ができたら始めましょう。', 'この作業は丁寧に進めてください。'][i % 4]}`).join('\n');
    // A local file is only used when the operator explicitly supplies its authorized path.
    const authorizedInput = format === 'lrc' ? process.env.FUSIONKIT_STUDIO_REAL_INPUT_PATH : undefined;
    const input = authorizedInput ?? path.join(root, `synthetic.${format}`);
    if (!authorizedInput) await writeFile(input, source);
    const originalBytes = await readFile(input);
    const repo = new DocumentRepository(path.join(root, 'documents'));
    const doc = await repo.create(await readSubtitle(input, 'utf-8'));
    let requests = 0;
    const service = new TranslationService(repo, async request => {
      expect(JSON.parse(serializeTranslationRequest(request)).thinking).toEqual({ type: 'disabled' });
      requests++;
      return sendModelRuntimeText(request);
    });
    fixtures.push({ root, service });
    const plan = await service.plan(1, doc.id, doc.revision, {
      model: { profileId: 'authorized-studio-test', endpoint: 'https://api.deepseek.com', modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions' },
      language: 'zh', instructions: '', contextWindow: 32768, maxOutputTokens: 4096, maxBatchCues: 32,
    });
    const { taskId } = await service.start(1, doc.id, doc.revision, plan.planId, apiKey);
    await service.settled(taskId);
    const result = await repo.readSnapshot(doc.id);
    const task = result.tasks[0];
    console.log(JSON.stringify({ model: 'deepseek-v4-flash', format, inputKind: authorizedInput ? 'authorized-local-file' : 'synthetic', cues: doc.cues.length, status: task.status, error: task.translation?.error, attempts: task.attempts, batches: plan.batchCount, estimatedInputTokens: plan.estimatedInputTokens, outputReserve: plan.outputTokenReserve, usage: task.translation?.usage }));
    expect(task.status).toBe('completed');
    expect(requests).toBe(plan.batchCount);
    expect(task.translation?.config.model.thinkingEnabled).toBe(false);
    expect(result.document.cues).toEqual(doc.cues);
    expect(result.document.preservation).toEqual(doc.preservation);
    expect((await readFile(input)).equals(originalBytes)).toBe(true);
    const entries = result.document.translationTracks[0].entries;
    expect(Object.keys(entries)).toHaveLength(doc.cues.length);
    for (const entry of Object.values(entries)) expect(entry.text.plain.trim().length).toBeGreaterThan(0);
    expect(Object.values(entries).some(entry => /[\u3400-\u9fff]/.test(entry.text.plain))).toBe(true);
    if (format === 'srt') expect(entries[doc.cues[0].id].text.spans.some(span => span.marks.includes('b'))).toBe(true);
  }, 300000);
});
