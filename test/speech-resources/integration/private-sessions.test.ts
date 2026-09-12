import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import * as oldSession from '../../../electron/main/local-subtitle/server-session';
import * as studioSession from '../../../electron/main/subtitle-studio/transcription/native/server-session';
import * as oldContract from '../../../electron/main/local-subtitle/server-process-contract';
import * as studioContract from '../../../electron/main/subtitle-studio/transcription/native/server-process-contract';
import * as oldRuntime from '../../../electron/main/local-subtitle/resource-path';
import * as studioRuntime from '../../../electron/main/subtitle-studio/transcription/native/resource-path';
import { createRuntimeFixture as oldFixture } from '../../local-subtitle/runtimeFixture';
import { createRuntimeFixture as studioFixture } from '../../subtitle-studio/transcription/runtimeFixture';

it('keeps same-domain session brands valid outside the shared managed-resource root', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sr-session-'))), shared = path.join(root, 'speech-resources');
  await mkdir(shared); const old = await oldFixture(), studio = await studioFixture();
  try {
    const legacySession = await oldSession.createLocalSubtitleServerSession(path.join(root, 'local-subtitle'));
    const newSession = await studioSession.createLocalSubtitleServerSession(path.join(root, 'studio'));
    expect(oldSession.isLocalSubtitleServerSession(newSession)).toBe(false);
    expect(studioSession.isLocalSubtitleServerSession(legacySession)).toBe(false);
    const legacyVerified = await oldRuntime.verifyLocalSubtitleRuntimeBundle({ environment: old.environment, scope: 'server', signatureVerifier: async () => true });
    const studioVerified = await studioRuntime.verifyLocalSubtitleRuntimeBundle({ environment: studio.environment, scope: 'server', signatureVerifier: async () => true });
    const model = { storage: 'managed' as const, id: 'large-v3-q5_0', absolutePath: path.join(shared, 'models', 'large-v3-q5_0', 'model.bin'), byteSize: 100, sha256: 'a'.repeat(64) };
    const legacyDescriptor = oldContract.createLocalSubtitleServerProcessDescriptor({ purpose: 'inference', backend: 'cpu', model, threads: 1,
      managedResourceRoot: shared, verifiedRuntime: legacyVerified, serverArtifactId: oldRuntime.selectLocalSubtitleCpuServerArtifactId(legacyVerified),
      endpoint: oldContract.createLocalSubtitleServerEndpoint({ port: 43123 }), sessionRoot: legacySession.root,
      emptyPublicDirectory: legacySession.publicDirectory, temporaryDirectory: legacySession.temporaryDirectory });
    const studioDescriptor = studioContract.createLocalSubtitleServerProcessDescriptor({ purpose: 'inference', backend: 'cpu', model, threads: 1,
      managedResourceRoot: shared, verifiedRuntime: studioVerified, serverArtifactId: studioRuntime.selectLocalSubtitleCpuServerArtifactId(studioVerified),
      endpoint: studioContract.createLocalSubtitleServerEndpoint({ port: 43124 }), sessionRoot: newSession.root,
      emptyPublicDirectory: newSession.publicDirectory, temporaryDirectory: newSession.temporaryDirectory });
    expect(legacyDescriptor.loadIdentity.model.absolutePath).toBe(model.absolutePath);
    expect(studioDescriptor.loadIdentity.model.absolutePath).toBe(model.absolutePath);
    await oldSession.verifyLocalSubtitleServerSession(legacySession, { requireEmpty: true });
    await studioSession.verifyLocalSubtitleServerSession(newSession, { requireEmpty: true });
    await oldSession.cleanupLocalSubtitleServerSession(legacySession); await studioSession.cleanupLocalSubtitleServerSession(newSession);
  } finally { await old.cleanup(); await studio.cleanup(); await rm(root, { recursive: true, force: true }); }
});
