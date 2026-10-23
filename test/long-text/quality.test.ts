import { describe, expect, it } from 'vitest';
import type { LanguageTag, LongTextFormat, SegmentKind } from '../../src/long-text/contract';
import { project } from '../../src/long-text/inline';
import {
  checkModelOutput, checkUserEdit, coldStartRatio, isOmission, ledgerHits, measureLength, RatioReference, termOccurs,
  type ModelOutputCheck, type QualityFlag,
} from '../../src/long-text/quality';

interface CheckCase extends Partial<Omit<ModelOutputCheck, 'source' | 'target' | 'marks'>> { kind?: SegmentKind; format?: LongTextFormat }

/** Checks a model translation of `source`, with the marks of its projection; English to Simplified Chinese by default. */
function check(source: string, target: string, { kind = 'paragraph', format = 'markdown', ...input }: CheckCase = {}): QualityFlag[] {
  return checkModelOutput({
    source, target, srcLang: 'en', tgtLang: 'zh-Hans', marks: project(source, kind, format).marks, repaired: [],
    ratioRef: coldStartRatio(input.srcLang ?? 'en', input.tgtLang ?? 'zh-Hans'), confirmedLedgerHits: [], requiredTermIssues: [], ...input,
  });
}
const codes = (flags: readonly QualityFlag[]) => flags.map(flag => flag.code);
const han = (count: number) => '港口今天非常安静我们一起出发去看海吧'.repeat(Math.ceil(count / 18)).slice(0, count);
const latin = (count: number) => 'harbourlights'.repeat(Math.ceil(count / 13)).slice(0, count);

describe('RatioReference', () => {
  it('starts from the cold-start table of the language families', () => {
    const pairs: Array<[LanguageTag, LanguageTag, number]> = [
      ['zh-Hans', 'en', 3], ['ja', 'fr', 3], ['en', 'zh-Hant', 0.33], ['ko', 'en', 2], ['en', 'ko', 0.5],
      ['zh-Hans', 'ko', 1.4], ['ko', 'ja', 0.7], ['en', 'fr', 1], ['en', 'ru', 1], ['zh-Hans', 'zh-Hant', 1], ['ja', 'zh-Hans', 1],
    ];
    for (const [source, target, expected] of pairs) {
      expect(coldStartRatio(source, target)).toBe(expected);
      expect(new RatioReference({ source, target }).value).toBe(expected);
    }
  });

  it('switches to the median once 30 ratios were pushed', () => {
    const reference = new RatioReference({ source: 'zh-Hans', target: 'en' });
    for (let k = 1; k <= 29; k++) reference.push(k);
    expect(reference.value).toBe(3);
    reference.push(30);
    expect(reference.value).toBe(15.5);
    reference.push(100);
    expect(reference.value).toBe(16);
  });

  it('keeps only the latest 200 ratios', () => {
    const reference = new RatioReference({ source: 'en', target: 'fr' });
    for (let k = 0; k < 200; k++) reference.push(1);
    for (let k = 0; k < 100; k++) reference.push(5);
    expect(reference.value).toBe(3);
    reference.push(5);
    expect(reference.value).toBe(5);
  });

  it('ignores invalid ratios and accepts initial samples', () => {
    const reference = new RatioReference({ source: 'en', target: 'zh-Hans' }, Array.from({ length: 30 }, () => 0.5));
    expect(reference.value).toBe(0.5);
    for (const ratio of [Number.NaN, Number.POSITIVE_INFINITY, -1]) reference.push(ratio);
    expect(reference.value).toBe(0.5);
  });
});

describe('length hints', () => {
  it('compares Chinese sources of 16 characters or more against the reference', () => {
    expect(check(han(16), latin(23), { srcLang: 'zh-Hans', tgtLang: 'en' })).toEqual([{ code: 'length_short', detail: { ratio: 0.48 } }]);
    expect(check(han(16), latin(24), { srcLang: 'zh-Hans', tgtLang: 'en' })).toEqual([]);
    expect(check(han(15), latin(1), { srcLang: 'zh-Hans', tgtLang: 'en' })).toEqual([]);
    expect(check(han(16), latin(97), { srcLang: 'zh-Hans', tgtLang: 'en' })).toEqual([{ code: 'length_long', detail: { ratio: 2.02 } }]);
    expect(check(han(16), latin(96), { srcLang: 'zh-Hans', tgtLang: 'en' })).toEqual([]);
  });

  it('compares alphabetic sources of 40 characters or more', () => {
    expect(check(latin(40), han(6))).toEqual([{ code: 'length_short', detail: { ratio: 0.45 } }]);
    expect(check(latin(39), han(1))).toEqual([]);
    expect(check(latin(40), han(27))).toEqual([{ code: 'length_long', detail: { ratio: 2.05 } }]);
    expect(check('여기는 아주 조용한 항구입니다 오늘 밤', 'harbour', { srcLang: 'ko', tgtLang: 'en' })).toEqual([{ code: 'length_short', detail: { ratio: 0.22 } }]);
    expect(check('여기는 조용한 항구입니다 오늘', 'harbour', { srcLang: 'ko', tgtLang: 'en' })).toEqual([]);
  });

  it('uses the document median after 30 model translations (AC-LT-16-1)', () => {
    const reference = new RatioReference({ source: 'zh-Hans', target: 'en' }, Array.from({ length: 29 }, () => 6));
    const flags = (target: string) => codes(check(han(20), target, { srcLang: 'zh-Hans', tgtLang: 'en', ratioRef: reference.value }));
    expect(flags(latin(28))).toEqual(['length_short']);
    expect(flags(latin(58))).toEqual([]);
    reference.push(6);
    expect(flags(latin(58))).toEqual(['length_short']);
    expect(flags(latin(120))).toEqual([]);
  });

  it('counts neither markup nor matched terms', () => {
    const url = 'https://example.com/a/very/long/path/to/the/harbour/documentation';
    const source = `Read [the guide](${url}) and \`npm install harbour-toolkit-cli\` before ${'x'.repeat(12)}`;
    const target = `先读[指南](${url})，再运行 \`npm install harbour-toolkit-cli\`。`;
    const measure = measureLength({ source, target, srcLang: 'en', marks: project(source, 'paragraph', 'markdown').marks });
    // A link keeps its opening bracket: only the destination part `](…)` is markup.
    expect(measure.sourceChars).toBe('Read[theguideandbefore'.length + 12);
    expect(measure.ratio).toBeCloseTo('先读[指南，再运行。'.length / measure.sourceChars);
    expect(measure.eligible).toBe(false);

    const hit = { source: 'Harbour Toolkit', target: '港湾工具箱' };
    const named = measureLength({ source: 'Harbour Toolkit keeps a log', target: '港湾工具箱记日志', srcLang: 'en', marks: [], terms: [hit] });
    expect(named).toEqual({ ratio: '记日志'.length / 'keepsalog'.length, sourceChars: 'keepsalog'.length, eligible: false });
  });

  it('rejects items far below the reference instead of flagging them', () => {
    const at = (source: string, target: string) => measureLength({ source, target, srcLang: 'en', marks: [] });
    expect(isOmission(at(latin(40), '港'), 0.33)).toBe(true);
    expect(isOmission(at(latin(40), '港口'), 0.33)).toBe(false);
    expect(isOmission(at(latin(39), ''), 0.33)).toBe(false);
    expect(isOmission(at(han(40), 'ab'), 3)).toBe(true);
    expect(at(han(16), '').eligible).toBe(false);
    expect(measureLength({ source: han(16), target: '', srcLang: 'ja', marks: [] }).eligible).toBe(true);
    expect(measureLength({ source: '가'.repeat(16), target: '', srcLang: 'ko', marks: [] }).eligible).toBe(true);
  });
});

describe('untranslated', () => {
  it('flags a copy of the source with at least 12 letters (AC-LT-16-2)', () => {
    const fr = { srcLang: 'en', tgtLang: 'fr' } as const;
    expect(codes(check('The harbour is quiet tonight.', 'The harbour is quiet tonight.', fr))).toEqual(['untranslated']);
    expect(codes(check('The harbour is quiet tonight.', '  the HARBOUR is   quiet tonight. ', fr))).toEqual(['untranslated']);
    expect(codes(check('The harbour is quiet tonight.', 'Ｔｈｅ harbour is quiet tonight.', fr))).toEqual(['untranslated']);
    expect(codes(check('Hello world', 'Hello world', fr))).toEqual([]);
    expect(codes(check('The harbour is quiet tonight.', 'Le port est calme ce soir.', fr))).toEqual([]);
  });

  it('flags letters of a script only the source language uses (AC-LT-16-2)', () => {
    const jaZh = { srcLang: 'ja', tgtLang: 'zh-Hans' } as const;
    expect(codes(check('今日は港へ行きます', '我们今天去了港口ですよね', jaZh))).toEqual([]);
    expect(codes(check('今日は港へ行きます', '我们今天去了港口ですよねえ', jaZh))).toEqual(['untranslated']);
    expect(codes(check('今日は港へ行きます', `${han(30)}ですよねえ`, jaZh))).toEqual([]);
    expect(codes(check('The harbour is quiet', '这是 The harbour is quiet'))).toEqual(['untranslated']);
    expect(codes(check('Use the API now', '现在使用 API 接口'))).toEqual([]);
    const zhEn = { srcLang: 'zh-Hans', tgtLang: 'en' } as const;
    expect(codes(check('港口今天很安静', 'The 港口 is quiet', zhEn))).toEqual([]);
    expect(codes(check('港口今天很安静', '港口今天很安静 is quiet', zhEn))).toEqual(['untranslated']);
    expect(codes(check('Тихая гавань', 'Тихая гавань sleeps', { srcLang: 'ru', tgtLang: 'en' }))).toEqual(['untranslated']);
  });

  it('flags Japanese and Korean translations without kana or Hangul', () => {
    const zhJa = { srcLang: 'zh-Hans', tgtLang: 'ja' } as const;
    expect(codes(check('今天港口非常安静我们出发', '今日港口非常静寂我等出発準備完了状態確認済', zhJa))).toEqual(['untranslated']);
    expect(codes(check('今天港口非常安静我们出发', '今日の港はとても静かで私たちは出発の準備をした', zhJa))).toEqual([]);
    expect(codes(check('今天港口非常安静', '今日港口非常静寂', zhJa))).toEqual([]);
    expect(codes(check('The harbour is very quiet today', 'Le port est très calme aujourd’hui', { tgtLang: 'ko' }))).toEqual(['untranslated']);
    expect(codes(check('The harbour is very quiet today', '오늘 항구는 아주 조용합니다', { tgtLang: 'ko' }))).toEqual([]);
  });

  it('leaves markup and matched terms out', () => {
    expect(codes(check('Run `npm install harbour` to set it up', '运行 `npm install harbour` 即可安装'))).toEqual([]);
    const hit = { source: 'Harbour Toolkit', target: 'Harbour Toolkit' };
    expect(codes(check('We work in Harbour Toolkit', '我们在 Harbour Toolkit 中工作'))).toEqual([]);
    expect(codes(check('We work in Harbour Toolkit', '我们在 Harbour Toolkit 中工作', { confirmedLedgerHits: [hit] }))).toEqual([]);
    expect(codes(check('We work in Harbour Toolkit', '我们在 Harbour Toolkit 中工作', { materialHits: [hit] }))).toEqual([]);
  });

  it('does not flag technical translations that keep names, acronyms and identifiers', () => {
    expect(check('Open the project in VS Code and click "Save".', '在 VS Code 中打开项目并点击“保存”。')).toEqual([]);
    expect(check('Install Python and run the script.', '安装 Python 并运行脚本。')).toEqual([]);
    expect(check('Deploy the service with GitHub Actions and Docker Compose.', '使用 GitHub Actions 和 Docker Compose 进行部署。')).toEqual([]);
    expect(check('The new iPhone 15 supports USB-C and the S3 upload works.', '新款 iPhone 15 支持 USB-C，S3 上传也可用。')).toEqual([]);
    expect(check('Call useEffect after the first render of the component.', '在组件首次渲染后调用 useEffect。')).toEqual([]);
    expect(check('Run the npm install command to set up the dependencies.', '运行 npm install 命令来安装依赖。')).toEqual([]);
  });

  it('still flags translations that leave sentences in the source language', () => {
    // The English left in is also long against the 0.33 cold start.
    expect(codes(check('Click Save to keep your changes before you close the window.', '点击 Save to keep your changes before you close the window.')))
      .toEqual(['untranslated', 'length_long']);
    expect(codes(check('Open VS Code. Then you can edit the settings file there.', '打开 VS Code。Then you can edit the settings file there.'))).toContain('untranslated');
    expect(codes(check('Getting Started With Harbour', 'Getting Started With Harbour'))).toEqual(['untranslated']);
    expect(codes(check('Getting Started With Harbour', 'Getting Started With Harbour', { tgtLang: 'fr' }))).toEqual(['untranslated']);
  });

  it('leaves kept names out of the length ratio', () => {
    const source = 'Deploy the service with GitHub Actions and Docker Compose.';
    const target = '使用 GitHub Actions 和 Docker Compose 进行部署。';
    const measure = measureLength({ source, target, srcLang: 'en', marks: [] });
    expect(measure.sourceChars).toBe('Deploytheservicewithand.'.length);
    expect(measure.ratio).toBeCloseTo('使用和进行部署。'.length / measure.sourceChars);
  });
});

describe('term_missing', () => {
  const hit = { source: 'Harbour Toolkit', target: '港湾工具箱' };

  it('checks the confirmed glossary hits against the normalized translation', () => {
    expect(check('Open Harbour Toolkit', '打开港湾工具箱', { confirmedLedgerHits: [hit] })).toEqual([]);
    expect(check('Open Harbour Toolkit', '打开 harbour toolkit', { confirmedLedgerHits: [{ source: 'Harbour Toolkit', target: 'Harbour Toolkit' }] })).toEqual([]);
    expect(check('Open Harbour Toolkit', '打开港湾工具箱', { confirmedLedgerHits: [{ source: 'Harbour', target: 'ＨＡＲＢＯＵＲ' }] })).toEqual([
      { code: 'term_missing', detail: { source: 'Harbour', target: 'ＨＡＲＢＯＵＲ', more: 0 } },
    ]);
    expect(check('Open Harbour Toolkit', '打开港口工具', { confirmedLedgerHits: [hit] })).toEqual([
      { code: 'term_missing', detail: { source: 'Harbour Toolkit', target: '港湾工具箱', more: 0 } },
    ]);
  });

  it('adds the required material terms reported by checkRequiredTerms, without repeats', () => {
    const tide = { source: 'tide table', target: '潮汐表' };
    const crew = { source: 'crew', target: '船员' };
    expect(check('Open Harbour Toolkit', '打开港湾工具箱', { requiredTermIssues: [tide] })).toEqual([
      { code: 'term_missing', detail: { source: 'tide table', target: '潮汐表', more: 0 } },
    ]);
    expect(check('Harbour Toolkit, crew and tide table', '工具、人和表', {
      confirmedLedgerHits: [hit, crew], requiredTermIssues: [tide, { source: 'Crew', target: '船员' }],
    })).toEqual([{ code: 'term_missing', detail: { source: 'Harbour Toolkit', target: '港湾工具箱', more: 2 } }]);
  });

  it('matches glossary entries like the glossary (only confirmed ones)', () => {
    const entries = [
      { source: 'Harbour Toolkit', target: '港湾工具箱', confirmed: true },
      { source: 'art', target: '艺术', confirmed: true },
      { source: 'tide', target: '潮汐', confirmed: false },
      { source: '港口', target: 'harbour', confirmed: true },
      { source: 'v2', target: 'v2', confirmed: true },
    ];
    expect(ledgerHits(entries, 'Start HARBOUR toolkit before the tide turns')).toEqual([{ source: 'Harbour Toolkit', target: '港湾工具箱' }]);
    expect(ledgerHits(entries, 'Art is long; 去港口吧, v20 is out')).toEqual([{ source: 'art', target: '艺术' }, { source: '港口', target: 'harbour' }]);
    expect(termOccurs('使用Harbour Toolkit工具', 'harbour toolkit')).toBe(true);
    expect(termOccurs('Ｈａｒｂｏｕｒ Ｔｏｏｌｋｉｔ', 'Harbour Toolkit')).toBe(true);
    expect(termOccurs('the harbours', 'harbour')).toBe(false);
    expect(termOccurs('release v2.', 'V2')).toBe(true);
    expect(termOccurs('anything', '  ')).toBe(false);
  });
});

describe('checkModelOutput', () => {
  it('reports repaired markup with its kinds', () => {
    expect(check('Hello world', '你好世界', { repaired: ['code', 'link'] })).toEqual([{ code: 'placeholder_repaired', detail: { kinds: ['code', 'link'] } }]);
  });

  it('orders the hints and gives at most four', () => {
    const source = 'Read the guide about Harbour Toolkit before you go out to sea tonight.';
    const flags = check(source, source, { repaired: ['link'], confirmedLedgerHits: [{ source: 'Harbour Toolkit', target: '港湾工具箱' }] });
    expect(codes(flags)).toEqual(['placeholder_repaired', 'term_missing', 'untranslated', 'length_long']);
  });
});

describe('checkUserEdit', () => {
  const marksOf = (source: string, kind: SegmentKind = 'paragraph', format: LongTextFormat = 'markdown') => project(source, kind, format).marks;

  it('flags link destinations and code an edited Markdown segment lost (AC-LT-16-3)', () => {
    const marks = marksOf('Read [the guide](https://example.com/guide) and run `harbour sync`.');
    expect(checkUserEdit({ target: '先阅读指南，再运行 `harbour sync`。', marks, format: 'markdown' })).toEqual([
      { code: 'markup_missing', detail: { items: ['](https://example.com/guide)'] } },
    ]);
    expect(checkUserEdit({ target: '先阅读[指南](https://example.com/guide)，再运行 `harbour sync`。', marks, format: 'markdown' })).toEqual([]);
  });

  it('lists at most three items of at most 60 characters', () => {
    const long = `https://example.com/${'x'.repeat(80)}`;
    const marks = marksOf(`See ${long}, \`a\`, \`b\` and \`c\`.`);
    const [flag] = checkUserEdit({ target: '都删了', marks, format: 'markdown' });
    expect(flag.detail.items).toEqual([long.slice(0, 60), '`a`', '`b`']);
  });

  it('checks table separators and gives plain text no hint', () => {
    expect(checkUserEdit({ target: '甲 乙', marks: marksOf('| a | b |', 'table_row'), format: 'markdown' })).toEqual([
      { code: 'markup_missing', detail: { items: ['|'] } },
    ]);
    expect(checkUserEdit({ target: '没有链接', marks: marksOf('See https://example.com now', 'line', 'txt'), format: 'txt' })).toEqual([]);
  });
});
