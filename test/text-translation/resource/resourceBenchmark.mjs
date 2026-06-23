import { mkdir, mkdtemp, open, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { countTokens } from "gpt-tokenizer";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";

const MB = 1024 * 1024;
const TXT_SIZES_MB = [1, 10, 50];
const MARKDOWN_SIZE_MB = 5;
const TOKEN_SAMPLE_BYTES = 64 * 1024;

const textChunk = [
  "第一章 旧城的雨",
  "她把钥匙放进口袋，回头望向车站尽头的灯。The old station clock kept ticking, slow but stubborn.",
  "雨声像细密的脚步，提醒他们不能在这里停留太久。彼は小さく頷いて、まだ言えない秘密を飲み込んだ。",
  "",
  "",
].join("\n");

const markdownChunk = [
  "---",
  "title: 长篇 Markdown 资源测试",
  "tags: [fiction, benchmark]",
  "---",
  "",
  "# 第一章 旧城的雨",
  "",
  "她把钥匙放进口袋，回头望向 [车站](https://example.invalid/station) 尽头的灯。",
  "",
  "- 人物：爱丽丝",
  "- 地点：旧城车站",
  "- 线索：`silver-key` 不应被翻译",
  "",
  "> 雨声像细密的脚步，提醒他们不能在这里停留太久。",
  "",
  "| 原文 | 备注 |",
  "| --- | --- |",
  "| Silver Gate | 用户术语优先 |",
  "",
  "```ts",
  "const protectedValue = 'do-not-translate'",
  "```",
  "",
].join("\n");

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-resource-bench-"));

try {
  const results = {
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      tmpRoot,
      gcExposed: typeof global.gc === "function",
    },
    txt: [],
    markdown: undefined,
    workspace: undefined,
    disk: await measureDisk(tmpRoot),
  };

  for (const sizeMb of TXT_SIZES_MB) {
    console.error(`[resource-benchmark] measuring TXT ${sizeMb} MB`);
    results.txt.push(await measureTxt(sizeMb));
  }

  console.error(`[resource-benchmark] measuring Markdown ${MARKDOWN_SIZE_MB} MB`);
  results.markdown = await measureMarkdown(MARKDOWN_SIZE_MB);
  console.error("[resource-benchmark] measuring workspace model");
  results.workspace = await measureWorkspaceModel(10_000);

  console.log(JSON.stringify(results, null, 2));
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

async function measureTxt(sizeMb) {
  forceGc();
  const filePath = path.join(tmpRoot, `sample-${sizeMb}mb.txt`);
  await writeRepeatedFile(filePath, sizeMb * MB, textChunk);

  let peakRss = rssMb();
  const before = memorySnapshot();

  const read = await measureStep(async () => {
    return readFile(filePath);
  });
  peakRss = Math.max(peakRss, rssMb());

  const decode = await measureStep(async () => {
    return read.value.toString("utf8");
  });
  peakRss = Math.max(peakRss, rssMb());

  const tokenize = await measureStep(async () => {
    const sample = decode.value.slice(0, TOKEN_SAMPLE_BYTES);
    const sampleTokenCount = countTokens(sample);
    return {
      strategy: "sampled_64kb_estimate",
      sampleBytes: Buffer.byteLength(sample, "utf8"),
      sampleTokenCount,
      tokenCount: Math.round(
        (sampleTokenCount / Buffer.byteLength(sample, "utf8")) *
          read.value.byteLength,
      ),
    };
  });
  peakRss = Math.max(peakRss, rssMb());

  const plan = await measureStep(async () => {
    return planSegmentsByCharBudget(decode.value, 8_000);
  });
  peakRss = Math.max(peakRss, rssMb());

  const after = memorySnapshot();
  const result = {
    sizeMb,
    bytes: read.value.byteLength,
    readMs: round(read.ms),
    decodeMs: round(decode.ms),
    tokenCountMs: round(tokenize.ms),
    tokenCountStrategy: tokenize.value.strategy,
    sampleBytes: tokenize.value.sampleBytes,
    sampleTokenCount: tokenize.value.sampleTokenCount,
    planMs: round(plan.ms),
    tokenCount: tokenize.value.tokenCount,
    segmentCount: plan.value.length,
    rssBeforeMb: before.rssMb,
    rssAfterMb: after.rssMb,
    peakObservedRssMb: round(peakRss),
    heapUsedAfterMb: after.heapUsedMb,
    externalAfterMb: after.externalMb,
  };

  // Explicitly release large references before next sample.
  read.value = undefined;
  decode.value = undefined;
  forceGc();
  return result;
}

async function measureMarkdown(sizeMb) {
  forceGc();
  const filePath = path.join(tmpRoot, `sample-${sizeMb}mb.md`);
  await writeRepeatedFile(filePath, sizeMb * MB, markdownChunk);

  let peakRss = rssMb();
  const before = memorySnapshot();
  const read = await measureStep(async () => readFile(filePath));
  peakRss = Math.max(peakRss, rssMb());
  const decode = await measureStep(async () => read.value.toString("utf8"));
  peakRss = Math.max(peakRss, rssMb());
  const parse = await measureStep(async () =>
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ["yaml", "toml"])
      .parse(decode.value),
  );
  peakRss = Math.max(peakRss, rssMb());

  const nodeCount = countAstNodes(parse.value);
  const after = memorySnapshot();
  const result = {
    sizeMb,
    bytes: read.value.byteLength,
    readMs: round(read.ms),
    decodeMs: round(decode.ms),
    parseMs: round(parse.ms),
    astNodeCount: nodeCount,
    rssBeforeMb: before.rssMb,
    rssAfterMb: after.rssMb,
    peakObservedRssMb: round(peakRss),
    heapUsedAfterMb: after.heapUsedMb,
  };

  read.value = undefined;
  decode.value = undefined;
  parse.value = undefined;
  forceGc();
  return result;
}

async function measureWorkspaceModel(segmentCount) {
  const workspacePath = path.join(tmpRoot, "workspace-model");
  const indexPath = path.join(workspacePath, "segments", "index.ndjson");
  const resultPath = path.join(workspacePath, "results", "000042.txt");
  const eventsPath = path.join(workspacePath, "events.ndjson");
  const manifestPath = path.join(workspacePath, "single-manifest.json");

  await mkdir(path.dirname(indexPath), { recursive: true });
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeRepeatedNdjson(indexPath, segmentCount, (index) => ({
    segmentId: `seg-${String(index).padStart(6, "0")}`,
    sourcePath: `segments/source/${String(index).padStart(6, "0")}.txt`,
    sourceBytes: 6_000,
  }));

  const translatedText = "译文".repeat(2_000);
  const resultWrite = await measureStep(async () => {
    await writeFile(resultPath, translatedText, "utf8");
  });
  const eventLine = `${JSON.stringify({
    type: "segment_completed",
    segmentId: "seg-000042",
    resultPath,
    at: new Date(0).toISOString(),
  })}\n`;
  const eventAppend = await measureStep(async () => {
    await writeFile(eventsPath, eventLine, { flag: "a", encoding: "utf8" });
  });

  const simulatedManifest = JSON.stringify({
    schemaVersion: 1,
    segmentCount,
    fragments: Array.from({ length: segmentCount }, (_, index) => ({
      index,
      status: index === 42 ? "resolved" : "pending",
      sourceHash: "x".repeat(64),
      translatedContent: index === 42 ? translatedText : undefined,
    })),
  });
  const manifestRewrite = await measureStep(async () => {
    await writeFile(manifestPath, simulatedManifest, "utf8");
  });

  const indexStats = await stat(indexPath);
  return {
    segmentCount,
    indexNdjsonBytes: indexStats.size,
    independentResultWriteMs: round(resultWrite.ms),
    eventAppendMs: round(eventAppend.ms),
    resultBytes: Buffer.byteLength(translatedText, "utf8"),
    eventBytes: Buffer.byteLength(eventLine, "utf8"),
    simulatedSingleManifestBytes: Buffer.byteLength(simulatedManifest, "utf8"),
    simulatedSingleManifestWriteMs: round(manifestRewrite.ms),
  };
}

async function measureDisk(directoryPath) {
  const stats = await statfs(directoryPath);
  return {
    path: directoryPath,
    availableMb: round((Number(stats.bavail) * Number(stats.bsize)) / MB),
    blockSize: Number(stats.bsize),
  };
}

async function writeRepeatedFile(filePath, targetBytes, chunk) {
  const handle = await open(filePath, "w");
  let written = 0;
  try {
    while (written < targetBytes) {
      const remaining = targetBytes - written;
      const next = chunk.slice(0, Math.min(chunk.length, remaining));
      await handle.write(next, undefined, "utf8");
      written += Buffer.byteLength(next, "utf8");
    }
  } finally {
    await handle.close();
  }
}

async function writeRepeatedNdjson(filePath, count, factory) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lines = [];
  for (let index = 0; index < count; index++) {
    lines.push(`${JSON.stringify(factory(index))}\n`);
  }
  await writeFile(filePath, lines.join(""), "utf8");
}

async function measureStep(fn) {
  const start = performance.now();
  const value = await fn();
  return {
    ms: performance.now() - start,
    value,
  };
}

function planSegmentsByCharBudget(text, charBudget) {
  const segments = [];
  let start = 0;
  let currentStart = 0;
  let currentChars = 0;

  while (start < text.length) {
    const nextBreak = text.indexOf("\n\n", start);
    const end = nextBreak >= 0 ? nextBreak + 2 : text.length;
    const paragraphChars = end - start;

    if (currentChars > 0 && currentChars + paragraphChars > charBudget) {
      segments.push({ start: currentStart, end: start, estimatedChars: currentChars });
      currentStart = start;
      currentChars = 0;
    }

    currentChars += paragraphChars;
    start = end;
  }

  if (currentChars > 0) {
    segments.push({ start: currentStart, end: text.length, estimatedChars: currentChars });
  }
  return segments;
}

function countAstNodes(node) {
  if (!node || typeof node !== "object") return 0;
  let count = 1;
  if (Array.isArray(node.children)) {
    for (const child of node.children) count += countAstNodes(child);
  }
  return count;
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssMb: round(memory.rss / MB),
    heapUsedMb: round(memory.heapUsed / MB),
    externalMb: round(memory.external / MB),
  };
}

function rssMb() {
  return process.memoryUsage().rss / MB;
}

function forceGc() {
  if (typeof global.gc === "function") {
    global.gc();
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}
