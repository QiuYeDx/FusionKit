import { deflateSync } from 'node:zlib';
import type { SubtitleDocument } from '../../../src/subtitle-studio/domain';
import { reviewDocument, type CueReviewResult } from '../../../src/subtitle-studio/transcription-review';

/** zlib's deflated size, the measure behind Whisper's compression ratio, which the loop rule compares against. */
export const compressedSize = (text: string) => deflateSync(Buffer.from(text, 'utf8')).length;

/**
 * The last review of the documents reviewed most recently, with the deflated size of each text
 * it measured. The same revision is answered again without reviewing; a new one (an edit, a
 * translation commit) measures only the texts that changed, which is most of the work.
 */
const memos = new Map<string, { revision: number; value: CueReviewResult; sizes: Map<string, number> }>();
const MEMO_DOCUMENTS = 2;

/** The transcription quality review of a whole document, for the list's review bar. Reads only. */
export function reviewCuesInDocument(doc: SubtitleDocument): CueReviewResult {
  const memo = memos.get(doc.id);
  if (memo?.revision === doc.revision) return memo.value;
  const known = memo?.sizes, sizes = new Map<string, number>();
  const value = reviewDocument(doc, { compressedSize: text => {
    const size = known?.get(text) ?? compressedSize(text);
    sizes.set(text, size);
    return size;
  } });
  memos.delete(doc.id);
  memos.set(doc.id, { revision: doc.revision, value, sizes });
  for (const id of memos.keys()) if (memos.size > MEMO_DOCUMENTS) memos.delete(id);
  return value;
}
