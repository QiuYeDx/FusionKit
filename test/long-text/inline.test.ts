import { describe, expect, it } from 'vitest';
import type { LanguageTag, LongTextFormat, SegmentKind } from '../../src/long-text/contract';
import { decode, findInlineSpans, hasTranslatableText, markupRaws, normalizeLabel, project, type ProjectOptions } from '../../src/long-text/inline';
import type { InlineMark } from '../../src/long-text/model';

interface DecodeCase { kind?: SegmentKind; format?: LongTextFormat; final?: boolean; target?: LanguageTag; refs?: ReadonlySet<string> }

/** Decodes `modelText` as the answer for `display`. */
function answer(display: string, modelText: string, { kind = 'paragraph', format = 'markdown', final = false, target = 'zh-Hans', refs }: DecodeCase = {}) {
  const projection = project(display, kind, format, { refs });
  return decode(modelText, projection.marks, kind, { final, joinerTarget: target, format, source: projection.text });
}

function roundTrip(display: string, kind: SegmentKind, format: LongTextFormat, options: ProjectOptions = {}) {
  const projection = project(display, kind, format, options);
  return decode(projection.text, projection.marks, kind, { final: false, joinerTarget: 'en', format, source: projection.text });
}

const atom = (id: number, kind: Extract<InlineMark, { atom: true }>['kind'], raw: string): InlineMark => ({ id, atom: true, kind, raw });

describe('project', () => {
  it('protects token-like text in every format', () => {
    const txt = project('Use <x1/> and ＜m2＞ or < x3 / >', 'line', 'txt');
    expect(txt.text).toBe('Use <x1/> and <x2/> or <x3/>');
    expect(txt.marks).toEqual([atom(1, 'literal', '<x1/>'), atom(2, 'literal', '＜m2＞'), atom(3, 'literal', '< x3 / >')]);
    expect(project('a </m1> b', 'paragraph', 'markdown').marks).toEqual([atom(1, 'literal', '</m1>')]);
  });

  it('turns hard breaks into atoms', () => {
    expect(project('first\nsecond', 'paragraph', 'markdown')).toEqual({ text: 'first<x1/>second', marks: [atom(1, 'break', '\n')] });
  });

  it('protects backslash escapes', () => {
    expect(project('1\\*2 and \\_x\\_', 'paragraph', 'markdown').text).toBe('1<x1/>2 and <x2/>x<x3/>');
    expect(project('a \\q b', 'paragraph', 'markdown').marks).toEqual([]);
  });

  it('protects code spans by matching backtick runs', () => {
    expect(project('use `npm i` now', 'paragraph', 'markdown')).toEqual({ text: 'use <x1/> now', marks: [atom(1, 'code', '`npm i`')] });
    expect(project('``a ` b`` and `c`', 'paragraph', 'markdown').marks).toEqual([atom(1, 'code', '``a ` b``'), atom(2, 'code', '`c`')]);
    expect(project('an `open run', 'paragraph', 'markdown').marks).toEqual([]);
    expect(project('``x` y', 'paragraph', 'markdown').marks).toEqual([]);
  });

  it('protects autolinks, inline HTML tags and comments one by one', () => {
    expect(project('<https://a.io/x> or <me@x.org>', 'paragraph', 'markdown').marks)
      .toEqual([atom(1, 'url', '<https://a.io/x>'), atom(2, 'url', '<me@x.org>')]);
    expect(project('a <b class="k">bold</b> <!-- note --> c <br/>', 'paragraph', 'markdown')).toEqual({
      text: 'a <x1/>bold<x2/> <x3/> c <x4/>',
      marks: [atom(1, 'html', '<b class="k">'), atom(2, 'html', '</b>'), atom(3, 'html', '<!-- note -->'), atom(4, 'html', '<br/>')],
    });
    expect(project('1 < 2 and 3 > 2', 'paragraph', 'markdown').marks).toEqual([]);
  });

  it('projects images with a description as pairs and without one as atoms', () => {
    expect(project('![a cat](cat.png "Cat") here', 'paragraph', 'markdown')).toEqual({
      text: '<m1>a cat</m1> here',
      marks: [{ id: 1, atom: false, kind: 'image', open: '![', close: '](cat.png "Cat")', inner: 'a cat', parent: null }],
    });
    expect(project('![](x.png) and ![123][ref]', 'paragraph', 'markdown').marks)
      .toEqual([atom(1, 'url', '![](x.png)'), atom(2, 'url', '![123][ref]')]);
  });

  it('projects links as pairs, nesting images and other marks inside', () => {
    expect(project('see [the guide](https://x.y/a_(b)) now', 'paragraph', 'markdown')).toEqual({
      text: 'see <m1>the guide</m1> now',
      marks: [{ id: 1, atom: false, kind: 'link', open: '[', close: '](https://x.y/a_(b))', inner: 'the guide', parent: null }],
    });
    const nested = project('[![logo](l.png) home `x`](/) end', 'paragraph', 'markdown');
    expect(nested.text).toBe('<m1><m2>logo</m2> home <x1/></m1> end');
    expect(nested.marks).toEqual([
      { id: 1, atom: false, kind: 'link', open: '[', close: '](/)', inner: '![logo](l.png) home `x`', parent: null },
      { id: 2, atom: false, kind: 'image', open: '![', close: '](l.png)', inner: 'logo', parent: 1 },
      atom(1, 'code', '`x`'),
    ]);
    expect(project('[a [b] c](u)', 'paragraph', 'markdown').text).toBe('<m1>a [b] c</m1>');
    expect(project('[`]`](u)', 'paragraph', 'markdown').marks).toEqual([atom(1, 'url', '[`]`](u)')]);
  });

  it('recognises reference links by the document definitions', () => {
    const closes = (display: string, options?: ProjectOptions) => project(display, 'paragraph', 'markdown', options).marks.map(mark => mark.atom ? mark.raw : mark.close);
    expect(closes('[text][ref] and [more][] and [plain]')).toEqual(['][ref]', '][]']);
    const refs = new Set([normalizeLabel(' The  Guide '), normalizeLabel('ref')]);
    expect(closes('[the guide] and [text][REF] and [x][missing] and [other]', { refs })).toEqual([']', '][REF]']);
    expect(project('[123](u) and [ ](u)', 'paragraph', 'markdown').marks).toEqual([atom(1, 'url', '[123](u)'), atom(2, 'url', '[ ](u)')]);
  });

  it('protects footnote references', () => {
    expect(project('see[^note-1].', 'paragraph', 'markdown')).toEqual({ text: 'see<x1/>.', marks: [atom(1, 'footnote', '[^note-1]')] });
  });

  it('pairs emphasis and strikethrough delimiters', () => {
    const { text, marks } = project('*a* __b__ ***c*** ~~d~~ **e *f* g**', 'paragraph', 'markdown');
    expect(text).toBe('<m1>a</m1> <m2>b</m2> <m3>c</m3> <m4>d</m4> <m5>e <m6>f</m6> g</m5>');
    expect(marks.map(mark => !mark.atom && [mark.open, mark.close, mark.parent])).toEqual([
      ['*', '*', null], ['__', '__', null], ['***', '***', null], ['~~', '~~', null], ['**', '**', null], ['*', '*', 5],
    ]);
  });

  it('leaves unmatched and intraword delimiters as text', () => {
    for (const display of ['snake_case_name here', 'x * not emphasis', 'a * b * c', '~single~ tilde', '**open only', '****four****', 'end*']) {
      expect(project(display, 'paragraph', 'markdown').marks).toEqual([]);
    }
  });

  it('protects inline math but not prices', () => {
    expect(project('$x^2$ and $$y$$ and \\(z\\)', 'paragraph', 'markdown').marks)
      .toEqual([atom(1, 'math', '$x^2$'), atom(2, 'math', '$$y$$'), atom(3, 'math', '\\(z\\)')]);
    for (const display of ['costs $5 and $6', '$ x$', '$x $', '$x$1 dollars']) {
      expect(project(display, 'paragraph', 'markdown').marks).toEqual([]);
    }
  });

  it('protects bare URLs without trailing punctuation, and e-mail addresses', () => {
    expect(project('see https://a.b/c?d=1. Or www.x.org, (https://w.io/a_(b)) me@x.org!', 'paragraph', 'markdown').marks).toEqual([
      atom(1, 'url', 'https://a.b/c?d=1'), atom(2, 'url', 'www.x.org'), atom(3, 'url', 'https://w.io/a_(b)'), atom(4, 'url', 'me@x.org'),
    ]);
    expect(project('访问https://例.cn/路径。然后', 'line', 'txt').marks).toEqual([atom(1, 'url', 'https://例.cn/路径')]);
    expect(project('xhttps://a.b nowww.x.org', 'paragraph', 'markdown').marks).toEqual([]);
  });

  it('protects HTML entities', () => {
    expect(project('&amp; &#169; &#x1F600; & &zz', 'paragraph', 'markdown').marks)
      .toEqual([atom(1, 'entity', '&amp;'), atom(2, 'entity', '&#169;'), atom(3, 'entity', '&#x1F600;')]);
  });

  it('splits table rows at unescaped separators outside code spans', () => {
    expect(project('| a | b |', 'table_row', 'markdown')).toEqual({
      text: '<x1/>a<x2/>b<x3/>',
      marks: [atom(1, 'sep', '| '), atom(2, 'sep', ' | '), atom(3, 'sep', ' |')],
    });
    expect(project('a \\| b | `c|d` | *e*', 'table_row', 'markdown').text).toBe('a <x1/> b<x2/><x3/><x4/><m1>e</m1>');
    expect(project('a | b', 'paragraph', 'markdown').marks).toEqual([]);
  });

  it('protects only token-like text, line breaks, URLs and e-mail in TXT', () => {
    const { text, marks } = project('*a* `b` [c](d) $e$ &amp; \\* <b> see https://x.y or me@x.org', 'paragraph', 'txt');
    expect(text).toBe('*a* `b` [c](d) $e$ &amp; \\* <b> see <x1/> or <x2/>');
    expect(marks).toEqual([atom(1, 'url', 'https://x.y'), atom(2, 'url', 'me@x.org')]);
  });

  it('stays linear on unbalanced link syntax', () => {
    const started = performance.now();
    for (const piece of ['[a](', '[a](b (', '[a](b "', '[a][b ', '$a ', '<!-- ']) {
      expect(project(piece.repeat(20_000), 'paragraph', 'markdown').marks).toEqual([]);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('keeps block syntax the source starts a line with as a literal', () => {
    expect(project('| not a table', 'paragraph', 'markdown').text).toBe('<x1/> not a table');
    expect(project('Steps:\n2. second', 'paragraph', 'markdown').text).toBe('Steps:<x1/><x2/> second');
    expect(project('*a\n# b*', 'paragraph', 'markdown').text).toBe('<m1>a<x1/><x2/> b</m1>');
    expect(project('| a |', 'heading', 'markdown').marks).toEqual([]);
    expect(project('# a', 'paragraph', 'txt').marks).toEqual([]);
  });
});

describe('findInlineSpans', () => {
  it('returns the extent of every mark in order of start, a pair covering its text', () => {
    const display = 'a `b` [c *d*](e) f';
    expect(findInlineSpans(display, 'paragraph', 'markdown')).toEqual([[2, 5], [6, 16], [9, 12]]);
    expect(findInlineSpans(display, 'paragraph', 'markdown')).toHaveLength(project(display, 'paragraph', 'markdown').marks.length);
    expect(findInlineSpans('see https://x.y', 'line', 'txt')).toEqual([[4, 15]]);
    const refs = new Set([normalizeLabel('guide')]);
    expect(findInlineSpans('[guide] x', 'paragraph', 'markdown')).toEqual([]);
    expect(findInlineSpans('[guide] x', 'paragraph', 'markdown', { refs })).toEqual([[0, 7]]);
  });
});

describe('hasTranslatableText', () => {
  it('looks for a letter outside the atoms', () => {
    expect(hasTranslatableText('![](a.png) `code` https://x.io', 'paragraph', 'markdown')).toBe(false);
    expect(hasTranslatableText('[123](u) &amp; $x$ | --- |', 'paragraph', 'markdown')).toBe(false);
    expect(hasTranslatableText('**`code`** see', 'paragraph', 'markdown')).toBe(true);
    expect(hasTranslatableText('![a map](m.png)', 'paragraph', 'markdown')).toBe(true);
    expect(hasTranslatableText('https://x.io', 'line', 'txt')).toBe(false);
    expect(hasTranslatableText('`code` here', 'line', 'txt')).toBe(true);
  });
});

/** Seeded generator for the property tests. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  'a', 'word', ' ', ' ', '中文', 'の', '*', '**', '_', '~~', '`', '``', '[', ']', '(', ')', '![', '](u)', '$', '$$', '\\', '\\(', '\\)',
  '<', '>', '<b>', '</b>', '<!--', '-->', '|', '#', '# ', '- ', '1. ', '> ', '---', '```', '&amp;', '&', '^', '[^1]', 'x1/', '<x1/>',
  '＜m2＞', 'https://x.io/a', 'www.y.org', 'me@z.org', '.', ',', '。', '“', '”', '\n', '  ',
];

describe('decode', () => {
  it('restores the display text of its own projection: invariant (c)', () => {
    const corpus: Array<[string, SegmentKind, LongTextFormat]> = [
      ['Install with `npm i fusion`, then read [the guide](https://x.y/docs "Docs").', 'paragraph', 'markdown'],
      ['**Bold** and *italic* and ~~gone~~ with $E=mc^2$ and a note[^1].', 'list_item', 'markdown'],
      ['Line one\nline two\\* with &amp; and <span>html</span>', 'quote', 'markdown'],
      ['Chapter *One*: the [start][intro]', 'heading', 'markdown'],
      ['| `a|b` | [link](u) | \\| escaped |', 'table_row', 'markdown'],
      ['|left|right|', 'table_row', 'markdown'],
      ['| not a table, still a paragraph', 'paragraph', 'markdown'],
      ['Steps:\n2. second\n- third', 'footnote', 'markdown'],
      ['　　他说：“去 https://example.com 看看。”', 'paragraph', 'markdown'],
      ['https://example.com/only-a-url', 'line', 'txt'],
      ['  leading and trailing  ', 'paragraph', 'markdown'],
      ['Mail me@x.org about <x1/> tokens.', 'line', 'txt'],
      ['第一章　夜の森', 'heading', 'txt'],
    ];
    for (const [display, kind, format] of corpus) {
      expect(roundTrip(display, kind, format), display).toEqual({ ok: true, text: display, repaired: [] });
    }
    const refs = new Set([normalizeLabel('intro'), normalizeLabel('guide')]);
    expect(roundTrip('See [guide] and [Guide][] and [x][intro].', 'paragraph', 'markdown', { refs }))
      .toEqual({ ok: true, text: 'See [guide] and [Guide][] and [x][intro].', repaired: [] });
  });

  it('holds invariant (c) for random markup', () => {
    const next = random(20261022);
    const kinds: Array<[SegmentKind, LongTextFormat]> = [
      ['paragraph', 'markdown'], ['quote', 'markdown'], ['list_item', 'markdown'], ['footnote', 'markdown'],
      ['heading', 'markdown'], ['table_row', 'markdown'], ['line', 'txt'], ['paragraph', 'txt'],
    ];
    for (let n = 0; n < 4000; n++) {
      const [kind, format] = kinds[n % kinds.length];
      const singleLine = kind === 'heading' || kind === 'table_row';
      let display = '';
      const length = 1 + Math.floor(next() * 24);
      for (let k = 0; k < length; k++) {
        const piece = PIECES[Math.floor(next() * PIECES.length)];
        display += singleLine && piece === '\n' ? ' ' : piece;
      }
      expect(roundTrip(display, kind, format), JSON.stringify([display, kind, format])).toEqual({ ok: true, text: display, repaired: [] });
    }
  });

  it('normalises token spellings, fullwidth forms and stray atom closers', () => {
    const display = 'Run `npm i` then read [the docs](https://d.io).';
    expect(answer(display, '运行 < X1 / > ，然后阅读＜m1＞文档＜／m1＞。'))
      .toEqual({ ok: true, text: '运行 `npm i` ，然后阅读[文档](https://d.io)。', repaired: [] });
    expect(answer(display, '运行<x1></x1>，然后阅读<M1>文档</ m1 >。'))
      .toEqual({ ok: true, text: '运行`npm i`，然后阅读[文档](https://d.io)。', repaired: [] });
    expect(answer(display, '运行＜ｘ１／＞，<m1>文档</m1>。')).toEqual({ ok: true, text: '运行`npm i`，[文档](https://d.io)。', repaired: [] });
  });

  it('folds model line breaks into joiners and trims the answer', () => {
    expect(answer('Read `a` now.', '  第一句\n第二句 <x1/>\r\n  ')).toEqual({ ok: true, text: '第一句第二句 `a`', repaired: [] });
    expect(answer('Lis `a`.', 'first\nsecond <x1/>', { target: 'en' })).toEqual({ ok: true, text: 'first second `a`', repaired: [] });
    expect(answer('Ein `a`.', 'Satz\n\n中文 <x1/>', { target: 'en' })).toEqual({ ok: true, text: 'Satz 中文 `a`', repaired: [] });
  });

  it('drops unknown ids', () => {
    expect(answer('Say *hi* to `a`.', '<x9/>向<m1>你好</m1><m7>致意</m7> <x1/>。'))
      .toEqual({ ok: true, text: '向*你好*致意 `a`。', repaired: [] });
  });

  it('appends missing atoms on the final attempt and fails a non-final one within the budget rules', () => {
    const display = 'Run `npm i` now.';
    expect(answer(display, '现在运行。')).toEqual({ ok: false, reason: 'markup' });
    expect(answer(display, '现在运行。', { final: true })).toEqual({ ok: true, text: '现在运行。 `npm i`', repaired: ['code'] });
    expect(answer('Read https://x.io now', 'Lies jetzt', { final: true, target: 'de' }))
      .toEqual({ ok: true, text: 'Lies jetzt https://x.io', repaired: ['url'] });
    expect(answer('Use <b>this</b>, $x$, &amp; and[^1]', '用这个', { final: true }))
      .toEqual({ ok: true, text: '用这个 <b> </b> $x$ &amp; [^1]', repaired: ['url', 'html', 'math', 'other'] });
  });

  it('allows at most two repaired atoms and 30% of all atoms on a non-final attempt', () => {
    const codes = 'abcdefghij'.split('').map(c => `\`${c}\``);
    const display = `${codes.join(' ')} text`;
    const all = codes.map((_, k) => `<x${k + 1}/>`);
    expect(answer(display, `${all.slice(2).join(' ')} 文本`)).toMatchObject({ ok: true, repaired: ['code'] });
    expect(answer(display, `${all.slice(3).join(' ')} 文本`)).toEqual({ ok: false, reason: 'markup' });
    expect(answer(display, `${all.join(' ')} <x1/> <x2/> 文本`)).toMatchObject({ ok: true, repaired: ['code'] });
    expect(answer('`a` `b` `c` text', '<x1/> <x2/> 文本')).toEqual({ ok: false, reason: 'markup' });
    // Separators count towards the total; a repair in a table row goes before the closing separator.
    expect(answer('| `a` x | b | c | d |', '<x1/>甲<x3/>乙<x4/>丙<x5/>丁<x6/>', { kind: 'table_row' }))
      .toEqual({ ok: true, text: '| 甲 | 乙 | 丙 | 丁 `a` |', repaired: ['code'] });
  });

  it('keeps the first of duplicated atoms and pairs', () => {
    expect(answer('a `x` b `y` c `z` d `w` e', '甲<x1/>乙<x1/><x2/>丙<x3/>丁<x4/>戊'))
      .toEqual({ ok: true, text: '甲`x`乙`y`丙`z`丁`w`戊', repaired: ['code'] });
    expect(answer('say *hi* now', '<m1>甲</m1>和<m1>乙</m1>')).toEqual({ ok: true, text: '*甲*和乙', repaired: ['format'] });
  });

  it('accepts lost emphasis as a format repair', () => {
    expect(answer('Say *hello* now', '说你好')).toEqual({ ok: true, text: '说你好', repaired: ['format'] });
    expect(answer('Say *hello* now', '说</m1>你好')).toEqual({ ok: true, text: '说你好', repaired: ['format'] });
    expect(answer('Say *hello* now', '说<m1>你好')).toEqual({ ok: true, text: '说*你好*', repaired: ['format'] });
  });

  it('fails a lost link before the final attempt and appends it with its URL on the final one', () => {
    const display = 'See [the guide](https://x.y/g "G") for details.';
    expect(answer(display, '详见指南。')).toEqual({ ok: false, reason: 'markup' });
    expect(answer(display, '详见指南。', { final: true }))
      .toEqual({ ok: true, text: '详见指南。 [the guide](https://x.y/g "G")', repaired: ['link'] });
    expect(answer('An ![old map](map.png) here', 'Eine Karte', { final: true, target: 'de' }))
      .toEqual({ ok: true, text: 'Eine Karte ![old map](map.png)', repaired: ['link'] });
  });

  it('does not repeat an atom that an appended link carries', () => {
    const display = 'see [`cfg` docs](u) and `cfg` and `x`';
    expect(answer(display, '见<x3/>', { final: true }))
      .toEqual({ ok: true, text: '见`x` `cfg` [`cfg` docs](u)', repaired: ['code', 'link'] });
  });

  it('reorders crossed closes', () => {
    expect(answer('*a* and [b](u)', '<m1>甲<m2>乙</m1></m2>')).toEqual({ ok: true, text: '*甲[乙](u)*', repaired: ['format'] });
  });

  it('rewrites table separators by position and pads or trims them on the final attempt', () => {
    expect(answer('| a | b |', '<x1/>甲<x3/>乙<x2/>', { kind: 'table_row' })).toEqual({ ok: true, text: '| 甲 | 乙 |', repaired: [] });
    expect(answer('| a | b |', '<x1/>甲<x2/>乙', { kind: 'table_row' })).toEqual({ ok: false, reason: 'markup' });
    expect(answer('| a | b |', '<x1/>甲<x2/>乙', { kind: 'table_row', final: true })).toEqual({ ok: true, text: '| 甲 | 乙 |', repaired: ['table'] });
    expect(answer('| a | b |', '<x1/>甲<x2/>乙<x3/>丙<x2/>', { kind: 'table_row', final: true }))
      .toEqual({ ok: true, text: '| 甲 | 乙 |丙', repaired: ['table'] });
    // Literal pipes instead of the tokens: taken by position on the final attempt when they are as many.
    expect(answer('| a | b |', '| 甲 | 乙 |', { kind: 'table_row' })).toEqual({ ok: false, reason: 'markup' });
    expect(answer('| a | b |', '| 甲 | 乙 |', { kind: 'table_row', final: true })).toEqual({ ok: true, text: '| 甲 | 乙 |', repaired: ['table'] });
    expect(answer('a | b', '甲|乙', { kind: 'table_row', final: true })).toEqual({ ok: true, text: '甲 | 乙', repaired: ['table'] });
    // A different number of pipes keeps the padding fallback.
    expect(answer('| a | b |', '| 甲 | 乙 | 丙 |', { kind: 'table_row', final: true }))
      .toEqual({ ok: true, text: '\\| 甲 \\| 乙 \\| 丙 \\||  |  |', repaired: ['table'] });
  });

  it('escapes literal pipes in table rows', () => {
    expect(answer('| a | b |', '<x1/>甲|乙<x2/>丙 \\| 丁<x3/>', { kind: 'table_row' })).toEqual({ ok: true, text: '| 甲\\|乙 | 丙 \\| 丁 |', repaired: [] });
  });

  it('fails answers without text, also on the final attempt', () => {
    expect(answer('Run `npm i` now', '<x1/>')).toEqual({ ok: false, reason: 'empty' });
    expect(answer('Run `npm i` now', ' \n ', { final: true })).toEqual({ ok: false, reason: 'empty' });
    expect(answer('Run `npm i` now', '<m1></m1><x1/>', { final: true })).toEqual({ ok: false, reason: 'empty' });
  });

  it('accepts an answer of tokens when the source has nothing but markup', () => {
    const options: DecodeCase = { kind: 'line', format: 'txt' };
    expect(answer('https://example.com/a', '<x1/>', options)).toEqual({ ok: true, text: 'https://example.com/a', repaired: [] });
    expect(answer('https://example.com/a', '', options)).toEqual({ ok: false, reason: 'markup' });
    expect(answer('https://example.com/a', '', { ...options, final: true })).toEqual({ ok: true, text: 'https://example.com/a', repaired: ['url'] });
  });

  it('escapes block syntax the model starts a line with', () => {
    const cases: Array<[string, string]> = [
      ['# 标题', '\\# 标题'], ['- 列表', '\\- 列表'], ['+ 加', '\\+ 加'], ['1. 一', '1\\. 一'], ['12) 二', '12\\) 二'], ['> 引', '\\> 引'],
      ['| 竖线', '\\| 竖线'], ['```js', '\\```js'], ['~~~', '\\~~~'], ['--- 线', '\\--- 线'], ['#标签', '#标签'], ['-1 度', '-1 度'],
    ];
    for (const [model, expected] of cases) {
      for (const kind of ['paragraph', 'quote', 'list_item', 'footnote'] as const) {
        expect(answer('Hello world', model, { kind })).toEqual({ ok: true, text: expected, repaired: [] });
      }
    }
    expect(answer('first\nsecond', '第一<x1/>- 第二')).toEqual({ ok: true, text: '第一\n\\- 第二', repaired: [] });
    expect(answer('first\nsecond', '第一<x1/>  1. 第二')).toEqual({ ok: true, text: '第一\n  1\\. 第二', repaired: [] });
    expect(answer('Hello world', '# 标题', { kind: 'heading' })).toEqual({ ok: true, text: '# 标题', repaired: [] });
    expect(answer('Hello world', '# 标题', { format: 'txt' })).toEqual({ ok: true, text: '# 标题', repaired: [] });
    expect(answer('say *hi*', '<m1>- 嗨</m1>')).toEqual({ ok: true, text: '*- 嗨*', repaired: [] });
  });

  it('keeps block syntax the source itself starts a line with', () => {
    expect(answer('| not a table', '<x1/> 不是表格')).toEqual({ ok: true, text: '| 不是表格', repaired: [] });
    expect(answer('Steps:\n2. second', '步骤：<x1/><x2/> 第二')).toEqual({ ok: true, text: '步骤：\n2. 第二', repaired: [] });
  });

  it('moves whitespace the model put just inside emphasis out of the delimiters', () => {
    expect(answer('*Note*: read this.', '<m1> 注意</m1>：请阅读。')).toEqual({ ok: true, text: '*注意*：请阅读。', repaired: [] });
    expect(answer('*Item* start', '<m1> 项目</m1> 开始', { kind: 'list_item' })).toEqual({ ok: true, text: '*项目* 开始', repaired: [] });
    expect(answer('line one\n*Note* here', '第一行<x1/><m1> 注意</m1>这里')).toEqual({ ok: true, text: '第一行\n*注意*这里', repaired: [] });
    expect(answer('这是*重要*的东西', 'This is<m1> important </m1>stuff', { target: 'en' }))
      .toEqual({ ok: true, text: 'This is *important* stuff', repaired: [] });
    expect(answer('**a *b* c** d', '<m1><m2> 乙 </m2> 甲</m1> 丁')).toEqual({ ok: true, text: '***乙* 甲** 丁', repaired: [] });
    expect(answer('x **bold** y', 'x <m1> 粗 </m1> y', { target: 'en' })).toEqual({ ok: true, text: 'x **粗** y', repaired: [] });
    expect(answer('see `a` *b*', '见<x1/><m1> 乙</m1>')).toEqual({ ok: true, text: '见`a` *乙*', repaired: [] });
    // Link text may have spaces at its ends.
    expect(answer('see [the guide](u)', '见<m1> 指南 </m1>')).toEqual({ ok: true, text: '见[ 指南 ](u)', repaired: [] });
  });

  it('keeps the label of a translated shortcut or collapsed reference', () => {
    const refs = new Set([normalizeLabel('guide')]);
    expect(answer('see [guide] now', '见<m1>指南</m1>', { refs })).toEqual({ ok: true, text: '见[指南][guide]', repaired: [] });
    expect(answer('see [guide][] now', '见<m1>指南</m1>', { refs })).toEqual({ ok: true, text: '见[指南][guide]', repaired: [] });
    expect(answer('see [guide] now', 'see <m1>guide</m1>', { refs, target: 'en' })).toEqual({ ok: true, text: 'see [guide]', repaired: [] });
  });

  it('never loses a URL, code span or link destination on the final attempt', () => {
    const next = random(7);
    const display = 'Use `cfg`, see [the docs](https://d.io/x) and ![a map](m.png), mail <me@x.org> or https://w.io; **note** $x$.';
    const projection = project(display, 'paragraph', 'markdown');
    const tokens = projection.text.match(/<\/?[xm]\d+\/?>/g)!;
    const required = ['`cfg`', '](https://d.io/x)', '](m.png)', '<me@x.org>', 'https://w.io', '$x$'];
    for (let n = 0; n < 500; n++) {
      const mutated = tokens.filter(() => next() > 0.4);
      if (next() > 0.5) mutated.push(tokens[Math.floor(next() * tokens.length)]);
      mutated.sort(() => next() - 0.5);
      const model = `译文 ${mutated.join(' 词 ')} 结束`;
      const result = decode(model, projection.marks, 'paragraph', { final: true, joinerTarget: 'zh-Hans', format: 'markdown', source: projection.text });
      expect(result.ok, model).toBe(true);
      if (result.ok) for (const raw of required) expect(result.text, model).toContain(raw);
    }
  });
});

describe('markupRaws', () => {
  it('lists atom raws and link and image closes once each', () => {
    const { marks } = project('a `x` [l](u) ![i](p.png) *f* `x` line\nbreak &amp;', 'paragraph', 'markdown');
    expect(markupRaws(marks)).toEqual(['`x`', '](u)', '](p.png)', '&amp;']);
    expect(markupRaws(project('| a | b |', 'table_row', 'markdown').marks)).toEqual(['|']);
    expect(markupRaws([])).toEqual([]);
  });
});
