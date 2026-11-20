import { createJapaneseAsmrOnnxVad } from './japanese-asmr-onnx-vad';

const port = process.parentPort;
const modelPath = process.argv[2];
if (!port || !modelPath) process.exit(1);

async function main() {
  const session = await createJapaneseAsmrOnnxVad(modelPath!);
  port!.on('message', async ({ data }: { data: unknown }) => {
    try {
      if (data === 'close') {
        await session.release();
        process.exit(0);
      }
      if (!(data instanceof Float32Array)) throw new Error('Expected a PCM window.');
      port!.postMessage(await session.run(data));
    } catch { process.exit(1); }
  });
  port!.postMessage('ready');
}
void main().catch(() => process.exit(1));
