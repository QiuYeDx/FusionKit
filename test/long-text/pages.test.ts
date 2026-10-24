import { describe, expect, it } from 'vitest';
import { LONG_TEXT_LIMITS } from '../../src/long-text/contract';
import type { SegmentRecord } from '../../src/long-text/model';
import { pageTitle, paginate } from '../../src/long-text/pages';
import { fixture, segment } from './segment-test-utils';

type Shape = Pick<SegmentRecord, 'k' | 't' | 'n' | 'ch'>;
const text = (n = 10): Shape => ({ k: 'paragraph', t: 1, n, ch: 0 });
const block = (): Shape => ({ k: 'verbatim', t: 0, n: 50, ch: 0 });
const chapter = (): Shape => ({ k: 'heading', t: 1, n: 5, ch: 1 });
const ranges = (pages: Array<{ start: number; end: number }>) => pages.map(({ start, end }) => [start, end]);
const pagesOf = (records: Shape[], titles: Record<number, string> = {}) =>
  paginate(records, index => titles[index] ?? `heading ${index}`, 'markdown');

describe('paginate', () => {
  it('closes a page at 60 segments, verbatim blocks included', () => {
    const records = Array.from({ length: 130 }, (_, k) => (k % 3 ? text() : block()));
    expect(ranges(pagesOf(records))).toEqual([[0, 59], [60, 119], [120, 129]]);
  });

  it('keeps the translatable token estimate of a page at 8,000 or less', () => {
    expect(ranges(pagesOf(Array.from({ length: 20 }, () => text(1_000))))).toEqual([[0, 7], [8, 15], [16, 19]]);
    const pages = pagesOf(Array.from({ length: 7 }, () => text(3_000)));
    expect(ranges(pages)).toEqual([[0, 1], [2, 3], [4, 5], [6, 6]]);
    expect(ranges(pagesOf([text(100), text(9_000), text(100), block()]))).toEqual([[0, 0], [1, 1], [2, 3]]);
    expect(LONG_TEXT_LIMITS.pageTokens).toBe(8_000);
  });

  it('starts a new page at a chapter heading once the page holds 8 translatable segments', () => {
    const early = [text(), text(), text(), block(), block(), block(), block(), block(), chapter(), text()];
    expect(ranges(pagesOf(early))).toEqual([[0, 9]]);
    const late = [...Array.from({ length: 8 }, () => text()), block(), chapter(), text(), chapter(), text()];
    expect(ranges(pagesOf(late))).toEqual([[0, 8], [9, 12]]);
  });

  it('takes the first heading of a page as its title', () => {
    const records: Shape[] = [text(), { k: 'heading', t: 1, n: 5, ch: 0 }, chapter(), ...Array.from({ length: 60 }, () => text())];
    const pages = pagesOf(records, { 1: '## **Getting** started', 2: 'Second' });
    expect(pages.map(page => page.title)).toEqual(['## Getting started', null]);
    expect(pagesOf([])).toEqual([]);
  });
});

describe('pageTitle', () => {
  it('drops inline markup, keeps the words and cuts at 60 characters', () => {
    expect(pageTitle('Install **the** [CLI](https://example.com) with `npm`<sup>1</sup>[^1] \\*now\\*', 'markdown')).toBe('Install the CLI with npm1 *now*');
    expect(pageTitle('![Map](map.png) and _more_ ~~old~~', 'markdown')).toBe('Map and more old');
    expect(pageTitle('第十二章　夜', 'txt')).toBe('第十二章　夜');
    expect(pageTitle('**not markup in txt**', 'txt')).toBe('**not markup in txt**');
    const long = pageTitle('字'.repeat(70), 'markdown');
    expect(Array.from(long)).toHaveLength(60);
    expect(Array.from(pageTitle(`${'𠀀'.repeat(59)}ab`, 'txt'))).toHaveLength(60);
  });
});

describe('pages of a segmented document', () => {
  it('numbers every record with its page and titles pages by their first heading', async () => {
    const S = fixture('comprehensive.md');
    const { records, pages, table } = await segment('markdown', S);
    expect(pages[0]).toMatchObject({ start: 0, title: 'Harbour Toolkit Guide' });
    expect(pages.at(-1)!.end).toBe(records.length - 1);
    pages.forEach((page, number) => {
      if (number) expect(page.start).toBe(pages[number - 1].end + 1);
      expect(page.end - page.start + 1).toBeLessThanOrEqual(LONG_TEXT_LIMITS.pageSegments);
      for (let i = page.start; i <= page.end; i++) {
        expect(records[i].pg).toBe(number);
        expect(table.page[i]).toBe(number);
      }
    });
  });

  it('breaks a novel at its chapters once a page is full enough', async () => {
    const chapterText = (k: number) => `第${k}章　标题\n\n${Array.from({ length: 10 }, (_, line) => `　　第${k}章的第${line + 1}段。`).join('\n')}\n`;
    const S = Array.from({ length: 12 }, (_, k) => chapterText(k + 1)).join('\n');
    const { pages, records } = await segment('txt', S);
    expect(pages.every(page => records[page.start].ch === 1)).toBe(true);
    expect(pages.map(page => page.title)).toEqual(Array.from({ length: 12 }, (_, k) => `第${k + 1}章　标题`));
  });
});
