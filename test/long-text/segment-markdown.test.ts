import { describe, expect, it } from 'vitest';
import { LONG_TEXT_LIMITS } from '../../src/long-text/contract';
import type { SegmentRecord } from '../../src/long-text/model';
import { tableCells } from '../../src/long-text/segment-markdown';
import { displaySource } from '../../src/long-text/segments';
import { displays, expectInvariants, fixture, segment, uncoveredLetters } from './segment-test-utils';

/** Segments a Markdown text and checks invariants (a) and (b) on the way. */
async function md(S: string) {
  const result = await segment('markdown', S);
  expectInvariants(S, result.records);
  return result;
}
/** `[kind, display]` of every record; verbatim blocks as `verbatim:<kind>`. */
const shape = (S: string, records: readonly SegmentRecord[]) =>
  records.map(record => [record.k === 'verbatim' ? `verbatim:${record.vk}` : record.k, displaySource(S, record)]);
const shapeOf = async (S: string) => shape(S, (await md(S)).records);
const find = (S: string, records: readonly SegmentRecord[], text: string) => records.find(record => displaySource(S, record) === text);

describe('comprehensive fixture', () => {
  const S = fixture('comprehensive.md');

  it('keeps code, front matter, HTML, math and link definitions out of the translatable segments', async () => {
    const { records } = await md(S);
    const texts = displays(S, records).join('\n');
    for (const hidden of ['harbour --version', 'interval = 300', 'const trip', 'code inside a quote', 'title: Harbour', 'This note is written',
      'A comment that spans', "console.log('harbour')", 'window.harbour', '\\sqrt', 'v = d / t $$', 'https://example.com/faq', 'harbour sync --force',
      'indented code inside the item']) {
      expect(texts).not.toContain(hidden);
    }
    const verbatim = records.filter(record => !record.t).map(record => record.vk);
    expect(new Set(verbatim)).toEqual(new Set(['frontmatter', 'code', 'html', 'math', 'rule', 'other']));
    expect(verbatim.filter(kind => kind === 'code')).toHaveLength(6);
    expect(uncoveredLetters(S, records)).toEqual([
      '- [x]', '- [X]', '[^survey]:', '[^weekly]:',
      '[faq]: https://example.com/faq', '[changelog]: https://example.com/changelog "Changes"', '[Unused Label]: <https://example.com/unused>',
    ]);
  });

  it('marks headings, list items, task items, quotes and footnotes', async () => {
    const { records } = await md(S);
    const at = (text: string) => find(S, records, text);
    expect(at('Harbour Toolkit Guide')).toMatchObject({ k: 'heading', l: 1, ch: 1 });
    expect(at('Installation')).toMatchObject({ k: 'heading', l: 2, ch: 1 });
    expect(at('Getting started')).toMatchObject({ k: 'heading', l: 1, ch: 1 });
    expect(at('Configuration')).toMatchObject({ k: 'heading', l: 2, ch: 1 });
    expect(at('Heading with closing hashes')).toMatchObject({ k: 'heading', l: 3, ch: 0 });
    expect(at('Check the tide table before you leave and remember that tides change with the moon')).toMatchObject({ k: 'list_item', l: 1, m: '•', cp: '  ', b: [0] });
    expect(at('Choose **New trip**.')).toMatchObject({ k: 'list_item', m: '2.', cp: '   ' });
    expect(at('skipper')).toMatchObject({ k: 'list_item', l: 3, m: '•', cp: '       ' });
    expect(at('Pack the life jackets')).toMatchObject({ m: '☐' });
    expect(at('Charge the radio')).toMatchObject({ m: '☑' });
    expect(at('Print the chart')).toMatchObject({ m: '☑' });
    expect(at('And a second paragraph inside the same item, indented to the content.')).toMatchObject({ k: 'list_item', m: '' });
    expect(at('With a lazy line continuing the item above.')).toMatchObject({ k: 'list_item', m: '•' });
    expect(at('An ordered list starting at ten')).toMatchObject({ m: '10)', cp: '    ' });
    expect(at('A nested quote inside the first one, with two lines.')).toMatchObject({ k: 'quote', l: 2, cp: '> > ' });
    expect(at('Back at the first level, with a lazy continuation line.')).toMatchObject({ k: 'quote', l: 1, cp: '> ' });
    expect(at('first point')).toMatchObject({ k: 'list_item', l: 1, cp: '>   ' });
    expect(at('The national hydrographic survey publishes new tables every month.')).toMatchObject({ k: 'footnote', m: '[^survey]', cp: '    ' });
    expect(at('A second paragraph of the same footnote.')).toMatchObject({ k: 'footnote', m: '' });
    expect(at('Updates arrive every Monday.')).toMatchObject({ k: 'footnote', m: '[^weekly]' });
    expect(at('港口工具箱可以帮你规划航线、查看天气，并记录每一次出海的日志。')).toMatchObject({ k: 'paragraph', b: [0] });
    expect(at('Line one with two spaces\nline two with a backslash\nline three ends the paragraph.')).toMatchObject({ b: [1, 1], hb: '  ' });
  });

  it('makes one segment of a table header and of each body row', async () => {
    const { records } = await md(S);
    expect(records.filter(record => record.k === 'table_row').map(record => displaySource(S, record))).toEqual([
      '| Option | Default | Description |',
      '| `interval` | 300 | Seconds between two syncs |',
      '| `units` | metric | Units used for distance and speed |',
      '| `pipe` | `a|b` | A value with \\| an escaped pipe |',
      'Name | Value',
      'Speed | 12 knots',
      'Heading | north-east',
      '| 名称 | 说明 |',
      '| 航速 | 每小时十二海里 |',
    ]);
  });

  it('turns blocks without letters into verbatim blocks', async () => {
    const { records } = await md(S);
    for (const text of ['![](images/decoration.png)', '#', '12345']) {
      expect(find(S, records, text)).toMatchObject({ k: 'verbatim', vk: 'other', t: 0 });
    }
    expect(find(S, records, '<img src="images/logo.png" alt="">')).toMatchObject({ k: 'verbatim', vk: 'html', t: 0 });
    expect(find(S, records, '![Harbour map at sunset](images/map.png "Map")')).toMatchObject({ k: 'paragraph', t: 1 });
  });

  it('collects normalized link reference labels and suggests the technical style', async () => {
    const { refs, detectedStyle, structure } = await md(S);
    expect(refs).toEqual(['CHANGELOG', 'FAQ', 'UNUSED LABEL']);
    expect(detectedStyle).toBe('technical');
    expect(structure).toBeNull();
  });

  it('gives the same segments with CRLF and CR line endings', async () => {
    const lf = S.replace(/\r\n?/g, '\n');
    const expected = shape(lf, (await md(lf)).records);
    for (const ending of ['\r\n', '\r']) {
      const converted = lf.replace(/\n/g, ending);
      expect(await shapeOf(converted)).toEqual(expected);
    }
    // A lone CR before an empty LF-terminated line would read as one CRLF, so that CR becomes CRLF.
    const mixed = lf.split('\n').map((line, k, all) => {
      const ending = ['\r\n', '\r', '\n'][k % 3];
      return line + (ending === '\r' && all[k + 1] === '' ? '\r\n' : ending);
    }).join('');
    expect(await shapeOf(mixed)).toEqual(expected);
  });
});

describe('front matter', () => {
  it.each([
    ['YAML', '---\ntitle: A\n---\nBody text.', '---\ntitle: A\n---'],
    ['YAML closed by dots', '---\ntitle: A\n...\nBody text.', '---\ntitle: A\n...'],
    ['TOML', '+++\ntitle = "A"\n+++\nBody text.', '+++\ntitle = "A"\n+++'],
  ])('keeps %s front matter verbatim', async (_name, S, block) => {
    expect(await shapeOf(S)).toEqual([['verbatim:frontmatter', block], ['paragraph', 'Body text.']]);
  });

  it('treats an unclosed opening line as a thematic break', async () => {
    expect(await shapeOf('---\ntitle: A\n\nBody text.')).toEqual([['verbatim:rule', '---'], ['paragraph', 'title: A'], ['paragraph', 'Body text.']]);
  });

  it('only opens on the first line', async () => {
    expect(await shapeOf('Intro\n\n---\ntitle: A\n---')).toEqual([['paragraph', 'Intro'], ['verbatim:rule', '---'], ['heading', 'title: A']]);
  });
});

describe('fenced code', () => {
  it('runs to a closing fence of the same character that is at least as long', async () => {
    expect(await shapeOf('````md\n```\nnot closed\n````\nAfter.')).toEqual([['verbatim:code', '````md\n```\nnot closed\n````'], ['paragraph', 'After.']]);
    expect(await shapeOf('~~~\n```\n~~~\nAfter.')).toEqual([['verbatim:code', '~~~\n```\n~~~'], ['paragraph', 'After.']]);
  });

  it('runs to the end of the document when unclosed', async () => {
    expect(await shapeOf('Before.\n\n```\ncode\n\nmore code')).toEqual([['paragraph', 'Before.'], ['verbatim:code', '```\ncode\n\nmore code']]);
  });

  it('is not opened by a backtick fence whose info string has a backtick', async () => {
    expect(await shapeOf('``` a`b\ntext')).toEqual([['paragraph', '``` a`b text']]);
  });

  it('ends with the list item or quote that holds it', async () => {
    expect(await shapeOf('- item\n  ```\n  code\nOutside.')).toEqual([['list_item', 'item'], ['verbatim:code', '```\ncode'], ['paragraph', 'Outside.']]);
    expect(await shapeOf('> ```\n> code\n\nOutside.')).toEqual([['verbatim:code', '```\ncode'], ['paragraph', 'Outside.']]);
  });

  it('interrupts a paragraph', async () => {
    expect(await shapeOf('Text\n```\ncode\n```')).toEqual([['paragraph', 'Text'], ['verbatim:code', '```\ncode\n```']]);
  });
});

describe('headings and rules', () => {
  it('reads ATX headings, their level and chapter flag', async () => {
    const S = '# One\n## Two ##\n### Three\n#### Four #\n##### Five\n###### Six\n####### Seven';
    const { records } = await md(S);
    expect(shape(S, records)).toEqual([
      ['heading', 'One'], ['heading', 'Two'], ['heading', 'Three'], ['heading', 'Four'], ['heading', 'Five'], ['heading', 'Six'], ['paragraph', '####### Seven'],
    ]);
    expect(records.map(record => [record.l, record.ch])).toEqual([[1, 1], [2, 1], [3, 0], [4, 0], [5, 0], [6, 0], [0, 0]]);
  });

  it('turns a paragraph into a setext heading and keeps the underline out of the range', async () => {
    const S = 'Title\n=====\n\nTwo lines of\na subtitle\n---\n\nPara\n\n---\n\nPara\n***';
    const { records } = await md(S);
    expect(shape(S, records)).toEqual([
      ['heading', 'Title'], ['heading', 'Two lines of a subtitle'], ['paragraph', 'Para'], ['verbatim:rule', '---'], ['paragraph', 'Para'], ['verbatim:rule', '***'],
    ]);
    expect(records.slice(0, 2).map(record => [record.l, record.ch])).toEqual([[1, 1], [2, 1]]);
  });

  it('prefers a thematic break over a list item', async () => {
    expect(await shapeOf('- - -\n* * *\n- item')).toEqual([['verbatim:rule', '- - -'], ['verbatim:rule', '* * *'], ['list_item', 'item']]);
  });
});

describe('lists', () => {
  it('nests items by indentation and ends them at a less indented line after a blank', async () => {
    const S = '- a\n  - b\n    continued\n- c\n\nAfter.';
    const { records } = await md(S);
    expect(shape(S, records)).toEqual([['list_item', 'a'], ['list_item', 'b continued'], ['list_item', 'c'], ['paragraph', 'After.']]);
    expect(records.map(record => [record.l, record.cp])).toEqual([[1, '  '], [2, '    '], [1, '  '], [0, '']]);
  });

  it('lets only a bullet or an item numbered 1 interrupt a paragraph', async () => {
    expect(await shapeOf('Text\n2. not an item\n\nText\n1. an item')).toEqual([
      ['paragraph', 'Text 2. not an item'], ['paragraph', 'Text'], ['list_item', 'an item'],
    ]);
    expect(await shapeOf('1. one\n2. two')).toEqual([['list_item', 'one'], ['list_item', 'two']]);
  });

  it('gives an item that starts with a blank line its marker on its first block', async () => {
    const S = '-\n  later content\n3.\n   ```\n   code\n   ```';
    const { records } = await md(S);
    expect(shape(S, records)).toEqual([['list_item', 'later content'], ['verbatim:code', '```\ncode\n```']]);
    expect(records[0].m).toBe('•');
  });

  it('treats content five columns after the marker as indented code', async () => {
    expect(await shapeOf('-     code here\n  text')).toEqual([['verbatim:code', '    code here'], ['list_item', 'text']]);
  });

  it('shows task markers and keeps them out of the range', async () => {
    const S = '- [ ] open\n- [x] done\n- [y] not a task';
    const { records } = await md(S);
    expect(records.map(record => [record.m, displaySource(S, record)])).toEqual([['☐', 'open'], ['☑', 'done'], ['•', '[y] not a task']]);
  });
});

describe('quotes', () => {
  it('separates paragraphs at a bare > and ends at a blank line', async () => {
    const S = '> one\n>\n> two\nlazy\n\n> three';
    const { records } = await md(S);
    expect(shape(S, records)).toEqual([['quote', 'one'], ['quote', 'two lazy'], ['quote', 'three']]);
  });

  it('nests quotes and lists inside each other', async () => {
    const S = '> > deep\n> - item\n- > quoted item';
    const { records } = await md(S);
    expect(records.map(record => [record.k, record.l, record.cp, displaySource(S, record)])).toEqual([
      ['quote', 2, '> > ', 'deep'], ['list_item', 1, '>   ', 'item'], ['quote', 1, '  > ', 'quoted item'],
    ]);
  });
});

describe('tables', () => {
  it('needs a delimiter row with as many cells as the header', async () => {
    expect(await shapeOf('a | b\n--- | --- | ---\n')).toEqual([['paragraph', 'a | b --- | --- | ---']]);
    expect(await shapeOf('a | b\n:-- | --:\nc | d\ne\n')).toEqual([['table_row', 'a | b'], ['table_row', 'c | d'], ['paragraph', 'e']]);
  });

  it('ends at a blank line and interrupts a paragraph', async () => {
    expect(await shapeOf('Text\n| a | b |\n|---|---|\n| c | d |\n\n| e |')).toEqual([
      ['paragraph', 'Text'], ['table_row', '| a | b |'], ['table_row', '| c | d |'], ['paragraph', '| e |'],
    ]);
  });

  it('works inside a quote', async () => {
    expect(await shapeOf('> | a | b |\n> | - | - |\n> | c | d |')).toEqual([['table_row', '| a | b |'], ['table_row', '| c | d |']]);
  });

  it('counts cells without escaped pipes and pipes in code spans', () => {
    expect(tableCells('| a | b |')).toBe(2);
    expect(tableCells('a | b | c')).toBe(3);
    expect(tableCells('| a \\| b |')).toBe(1);
    expect(tableCells('| `a|b` | ``c`|`d`` |')).toBe(2);
    expect(tableCells('no pipe')).toBe(0);
  });
});

describe('link reference definitions and footnotes', () => {
  it('produce no segment for a definition but keep a line inside a paragraph as text', async () => {
    const S = '[Foo  Bar]: https://example.com\n\nText\n[x]: not a definition';
    const { records, refs } = await md(S);
    expect(shape(S, records)).toEqual([['paragraph', 'Text [x]: not a definition']]);
    expect(refs).toEqual(['FOO BAR']);
  });

  it('needs a whole one-line definition: a destination, an optional title, nothing else', async () => {
    const S = '[Q]: What is this tool?\n\nSee [Q] below.';
    const { records, refs } = await md(S);
    expect(shape(S, records)).toEqual([['paragraph', '[Q]: What is this tool?'], ['paragraph', 'See [Q] below.']]);
    expect(refs).toEqual([]);

    const titles = '[a]: /url "A \\"quoted\\" title"\n[b]: <x y> \'T\'\n[c]: /u (T)  \n[d]: <>\n[e]: /u "T" extra\n\n[f]: /u\n"Title on the next line"';
    const defined = await md(titles);
    expect(shape(titles, defined.records)).toEqual([['paragraph', '[e]: /u "T" extra'], ['paragraph', '"Title on the next line"']]);
    expect(defined.refs).toEqual(['A', 'B', 'C', 'D', 'F']);
  });

  it('continues a footnote by four columns of indentation or a lazy line', async () => {
    const S = '[^1]: First line\nlazy line\n    indented line\n\n    Second paragraph.\n\nOutside.';
    const { records } = await md(S);
    expect(records.map(record => [record.k, record.m, displaySource(S, record)])).toEqual([
      ['footnote', '[^1]', 'First line lazy line indented line'], ['footnote', '', 'Second paragraph.'], ['paragraph', '', 'Outside.'],
    ]);
  });
});

describe('HTML blocks', () => {
  it('ends comments and raw blocks at their closing marker and other blocks at a blank line', async () => {
    const S = '<!-- one line --> trailing\nText\n\n<pre>\n\nkeep\n</pre>\nAfter\n\n<section>\nInside\n\nOutside';
    expect(await shapeOf(S)).toEqual([
      ['verbatim:html', '<!-- one line --> trailing'], ['paragraph', 'Text'], ['verbatim:html', '<pre>\n\nkeep\n</pre>'],
      ['paragraph', 'After'], ['verbatim:html', '<section>\nInside'], ['paragraph', 'Outside'],
    ]);
  });

  it('leaves inline tags in a paragraph', async () => {
    expect(await shapeOf('<span>Hello</span> there\n<div>block</div>')).toEqual([['paragraph', '<span>Hello</span> there'], ['verbatim:html', '<div>block</div>']]);
  });

  it('runs a line of one complete tag to the next blank line, without interrupting a paragraph', async () => {
    expect(await shapeOf('<img src="logo.png" width="120">\nWelcome to the project.\n\nAfter.')).toEqual([
      ['verbatim:html', '<img src="logo.png" width="120">\nWelcome to the project.'], ['paragraph', 'After.'],
    ]);
    expect(await shapeOf('</custom-end>  \nText\n\nText\n<img src="x.png">')).toEqual([
      ['verbatim:html', '</custom-end>  \nText'], ['paragraph', 'Text <img src="x.png">'],
    ]);
    // Neither several tags nor an autolink is one complete tag.
    expect(await shapeOf('<a href="u"><img src="x.png"></a> Home\n\n<https://example.com>\nnext line')).toEqual([
      ['paragraph', '<a href="u"><img src="x.png"></a> Home'], ['paragraph', '<https://example.com> next line'],
    ]);
  });
});

describe('extension marker lines', () => {
  it('keeps the first line of a GitHub alert on a line of its own', async () => {
    expect(await shapeOf('> [!NOTE]\n> Useful information\n> on two lines.')).toEqual([
      ['verbatim:other', '[!NOTE]'], ['quote', 'Useful information on two lines.'],
    ]);
    expect(await shapeOf('> [!warning]  \n> Careful.\n\n[!NOTE] outside a quote')).toEqual([
      ['verbatim:other', '[!warning]  '], ['quote', 'Careful.'], ['paragraph', '[!NOTE] outside a quote'],
    ]);
    expect(await shapeOf('> Text first\n> [!NOTE]')).toEqual([['quote', 'Text first [!NOTE]']]);
  });

  it('keeps ::: container lines verbatim and ends a paragraph at them', async () => {
    expect(await shapeOf(':::tip\nbody text\n:::')).toEqual([['verbatim:other', ':::tip'], ['paragraph', 'body text'], ['verbatim:other', ':::']]);
    expect(await shapeOf('::: tip Pro tip\nRun the build before you deploy.\n:::')).toEqual([
      ['verbatim:other', '::: tip Pro tip'], ['paragraph', 'Run the build before you deploy.'], ['verbatim:other', ':::'],
    ]);
    expect(await shapeOf(':::note\n\nA note.\n\n:::')).toEqual([['verbatim:other', ':::note'], ['paragraph', 'A note.'], ['verbatim:other', ':::']]);
    expect(await shapeOf('> quoted\n:::')).toEqual([['quote', 'quoted'], ['verbatim:other', ':::']]);
  });

  it('keeps !!! and ??? admonition lines verbatim', async () => {
    expect(await shapeOf('!!! note "Heads up"\n    Body text.')).toEqual([['verbatim:other', '!!! note "Heads up"'], ['verbatim:code', '    Body text.']]);
    expect(await shapeOf('???+ tip "More"\n\n    Body text.\n\n!!!no space stays text')).toEqual([
      ['verbatim:other', '???+ tip "More"'], ['verbatim:code', '    Body text.'], ['paragraph', '!!!no space stays text'],
    ]);
  });
});

describe('indented code', () => {
  it('drops trailing blank lines and does not interrupt a paragraph', async () => {
    const S = 'Text\n    still text\n\n    code\n\n\n    more\n\n\nAfter';
    const { records } = await md(S);
    expect(shape(S, records)).toEqual([['paragraph', 'Text still text'], ['verbatim:code', '    code\n\n\n    more'], ['paragraph', 'After']]);
    expect(records[1].r).toHaveLength(8);
  });
});

describe('math blocks', () => {
  it('keeps $$ blocks verbatim but not inline $$ in text', async () => {
    expect(await shapeOf('$$\na\n\nb\n$$\n$$ c $$\n$$x$$ is inline\n$$\\begin{x}\ny\\end{x}$$')).toEqual([
      ['verbatim:math', '$$\na\n\nb\n$$'], ['verbatim:math', '$$ c $$'], ['paragraph', '$$x$$ is inline'], ['verbatim:math', '$$\\begin{x}\ny\\end{x}$$'],
    ]);
  });

  it('keeps \\[ … \\] blocks verbatim after a paragraph, in a list item and in a quote', async () => {
    expect(await shapeOf('Before.\n\\[\nE = mc^2 \\text{ where } c \\text{ is speed}\n\\]\nAfter.')).toEqual([
      ['paragraph', 'Before.'], ['verbatim:math', '\\[\nE = mc^2 \\text{ where } c \\text{ is speed}\n\\]'], ['paragraph', 'After.'],
    ]);
    expect(await shapeOf('- item\n  \\[\n  x^2 \\text{ in the item}\n  \\]')).toEqual([['list_item', 'item'], ['verbatim:math', '\\[\nx^2 \\text{ in the item}\n\\]']]);
    expect(await shapeOf('> \\[\n> x \\text{ quoted}\n> \\]\n> After.')).toEqual([['verbatim:math', '\\[\nx \\text{ quoted}\n\\]'], ['quote', 'After.']]);
    expect(await shapeOf('\\[\na $$ b\n\\]')).toEqual([['verbatim:math', '\\[\na $$ b\n\\]']]);
  });

  it('keeps a whole-line \\[ … \\] verbatim but escaped brackets in text a paragraph', async () => {
    expect(await shapeOf('\\[ x \\text{ alone} \\]')).toEqual([['verbatim:math', '\\[ x \\text{ alone} \\]']]);
    expect(await shapeOf('\\[1\\] Smith, J. A study.\n\n\\[a\\] and \\[b\\]')).toEqual([
      ['paragraph', '\\[1\\] Smith, J. A study.'], ['paragraph', '\\[a\\] and \\[b\\]'],
    ]);
  });
});

describe('hard breaks', () => {
  it('records both spellings, keeps the first and leaves the marker out of the range', async () => {
    const S = 'one\\\ntwo  \nthree\nfour\\';
    const { records } = await md(S);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ b: [1, 1, 0], hb: '\\' });
    expect(displaySource(S, records[0])).toBe('one\ntwo\nthree four\\');
    expect(records[0].r).toEqual([0, 3, 5, 8, 11, 16, 17, 22]);
  });

  it('does not take an escaped backslash or a single space as a hard break', async () => {
    const { records } = await md('a\\\\\nb \nc');
    expect(records[0].b).toEqual([0, 0]);
  });

  it('records the continuation prefix of list items', async () => {
    const S = '> - one  \n>   two';
    const { records } = await md(S);
    expect(records[0]).toMatchObject({ k: 'list_item', b: [1], hb: '  ', cp: '>   ' });
    expect(displaySource(S, records[0])).toBe('one\ntwo');
  });
});

describe('inline marks', () => {
  const codes = (count: number) => Array.from({ length: count }, (_, k) => `\`c${k}\``).join(' ');

  it('keeps a paragraph with 200 marks translatable and turns one with more into a verbatim block', async () => {
    expect((await md(`Text ${codes(LONG_TEXT_LIMITS.inlineMarks)}`)).records[0]).toMatchObject({ k: 'paragraph', t: 1 });
    expect((await md(`Text ${codes(LONG_TEXT_LIMITS.inlineMarks + 1)}`)).records[0]).toMatchObject({ k: 'verbatim', vk: 'other', t: 0 });
  });
});

describe('over-long segments', () => {
  it('splits at sentence ends outside inline marks and maps the parts back through the lines', async () => {
    const sentence = (k: number) => `Sentence ${k} mentions \`code. with a stop\` and [a link. here](https://example.com/${k}) before it ends.`;
    const lines = Array.from({ length: 150 }, (_, k) => sentence(k));
    const S = `Intro.\n\n> ${lines.join('\n> ')}\n\nOutro.`;
    const { records } = await md(S);
    const parts = records.filter(record => record.k === 'quote');
    expect(parts.length).toBeGreaterThan(1);
    expect(new Set(parts.map(part => part.g))).toEqual(new Set([parts[0].i]));
    expect(parts.map(part => displaySource(S, part)).join(' ')).toBe(lines.join(' '));
    for (const part of parts) {
      expect(part.n).toBeLessThanOrEqual(LONG_TEXT_LIMITS.chunkTokens);
      expect(displaySource(S, part)).toMatch(/^Sentence \d+ .* before it ends\.$/);
      expect(part).toMatchObject({ cp: '> ', l: 1 });
    }
  });

  it('does not split when every cut would fall inside a mark', async () => {
    const S = `[${'word '.repeat(2_000)}end](https://example.com)`;
    const { records } = await md(S);
    expect(records).toHaveLength(1);
    expect(records[0].n).toBeGreaterThan(LONG_TEXT_LIMITS.splitTokens);
  });

  it('never splits headings or table rows', async () => {
    const title = `# ${'word '.repeat(1_200)}end`;
    const { records } = await md(title);
    expect(records).toHaveLength(1);
    expect(records[0].k).toBe('heading');
  });
});
