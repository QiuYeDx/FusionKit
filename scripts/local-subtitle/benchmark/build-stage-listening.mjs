import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { summarizeReviewWav } from './build-listening-review.mjs';
import { validateStageReview } from './stage-listening-contract.mjs';

export const stageSha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseStageSrt(text) {
  if (!text.trim()) return [];
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).map(block => {
    const lines = block.split('\n');
    const match = /^(\d+):(\d{2}):(\d{2}),(\d{3}) --> (\d+):(\d{2}):(\d{2}),(\d{3})$/.exec(lines[1]);
    if (!/^\d+$/.test(lines[0]) || !match || lines.length < 3) throw Error('Invalid SRT');
    const ms = offset => Number(match[offset]) * 3600000 + Number(match[offset+1]) * 60000 + Number(match[offset+2]) * 1000 + Number(match[offset+3]);
    return { startMs: ms(1), endMs: ms(5), text: lines.slice(2).join('\n') };
  });
}
export function parseStageLrc(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^\[(\d+):(\d{2})\.(\d{2,3})\](.*)$/.exec(line);
    if (!match) throw Error('Invalid LRC');
    return { startMs: Number(match[1])*60000+Number(match[2])*1000+Number(match[3].padEnd(3,'0')), text: match[4] };
  });
}
export async function buildStageListening(manifest, outputDirectory) {
  const out = path.resolve(outputDirectory), tracks = [];
  if (!manifest.tracks?.length || manifest.tracks.length > 8) throw Error('Expected 1–8 tracks');
  for (const input of manifest.tracks) {
    if (!/^[a-z][a-z0-9-]*$/.test(input.id)) throw Error('Invalid track ID');
    for (const file of [input.audioFile,input.srtFile,input.lrcFile,input.baselineFile].filter(Boolean)) {
      if (path.resolve(file).startsWith(out + path.sep)) throw Error('Build output must be separate from evidence');
    }
    const audio = await fs.readFile(input.audioFile);
    if (audio.length > 16*1024*1024) throw Error('Audio exceeds review bound');
    const { durationMs } = summarizeReviewWav(audio,1);
    const srt = input.srtFile ? await fs.readFile(input.srtFile) : Buffer.alloc(0);
    const lrc = input.lrcFile ? await fs.readFile(input.lrcFile) : Buffer.alloc(0);
    const cues = parseStageSrt(srt.toString('utf8'));
    const projected = parseStageLrc(lrc.toString('utf8'));
    if (projected.length !== cues.length || cues.some((cue,index) => Math.abs(projected[index].startMs-cue.startMs)>5 || projected[index].text !== cue.text.replace(/\n/g,' '))) throw Error('SRT/LRC mismatch');
    const baseline = input.baselineFile ? await fs.readFile(input.baselineFile) : null;
    tracks.push({ id:input.id, label:input.label, guidance:input.guidance, sourceStartMs:0,durationMs,
      audioSha256:stageSha256(audio),subtitleSha256:stageSha256(srt),lrcSha256:stageSha256(lrc),
      baselineSha256:baseline ? stageSha256(baseline) : null, baselineLabel:input.baselineLabel ?? '',
      baseline:baseline ? (input.baselineFile.endsWith('.lrc') ? parseStageLrc(baseline.toString('utf8')) : parseStageSrt(baseline.toString('utf8'))) : [],
      cues,bookmarks:input.bookmarks ?? [],audio:`data:audio/wav;base64,${audio.toString('base64')}`,
      srt:`${input.id}.srt`,lrc:`${input.id}.lrc`,hasOutput:cues.length>0 });
  }
  const metadata={schema:'fusionkit-stage-review-v1',buildCommit:manifest.buildCommit,provenance:manifest.provenance,
    tracks:tracks.map(({audio,...track})=>track)};
  const reviewId=stageSha256(JSON.stringify(metadata)),data={...metadata,reviewId,tracks};
  validateStageReview(data);
  const template=await fs.readFile(new URL('./stage-listening-review.html',import.meta.url),'utf8');
  const contract=await fs.readFile(new URL('./stage-listening-contract.mjs',import.meta.url),'utf8');
  await fs.mkdir(out,{recursive:true});
  for(const input of manifest.tracks) {
    if(input.srtFile)await fs.copyFile(input.srtFile,path.join(out,`${input.id}.srt`));
    if(input.lrcFile)await fs.copyFile(input.lrcFile,path.join(out,`${input.id}.lrc`));
  }
  await fs.writeFile(path.join(out,'review-data.json'),JSON.stringify({...metadata,reviewId},null,2));
  await fs.writeFile(path.join(out,'review.html'),template.replace('/* STAGE_CONTRACT */',()=>contract).replace('/* STAGE_DATA */',()=>JSON.stringify(data).replace(/</g,'\\u003c')));
  return {...metadata,reviewId};
}
