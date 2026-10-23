import { encode } from 'gpt-tokenizer';
import { describe, expect, it } from 'vitest';
import { countScripts, estimateTokens, isCjk, joinerBetween, scriptOf } from '../../src/long-text/text-stats';

const SAMPLES = {
  zh: '那年冬天来得特别早。父亲站在院子里，望着远处被雪覆盖的山脊，半天没有说话。我知道他在想什么：地里的麦子还没来得及收完，粮仓也只装了一半。母亲从厨房里探出头来，喊我们进屋喝粥。炉火烧得正旺，屋里暖洋洋的，窗户上结了一层薄薄的水汽。父亲坐下以后，终于开口：“明年开春，我们去城里看看吧。”',
  en: 'The winter came early that year. My father stood in the yard, looking at the snow-covered ridge in the distance, and said nothing for a long time. I knew what he was thinking: the wheat in the field had not been harvested in time, and the granary was only half full. My mother leaned out of the kitchen and called us in for porridge. The fire was burning bright, the room was warm, and a thin mist had formed on the windows. When my father finally sat down, he said, "Next spring, let\'s go and have a look at the city."',
  ja: 'その年の冬は、いつもより早くやって来た。父は庭に立ち、遠くの雪に覆われた山の稜線を眺めたまま、長いあいだ何も言わなかった。畑の麦はまだ刈り終わっておらず、倉庫も半分しか埋まっていないことを、私は知っていた。母が台所から顔を出して、お粥ができたから家に入りなさいと呼んだ。囲炉裏の火は勢いよく燃え、部屋の中は暖かく、窓には薄い曇りができていた。',
  mixed: '他把信交给了艾伦，艾伦看完以后，把信折好放进口袋里，对玛丽说：“我们明天就出发去伦敦。”Mary 点点头，没有再问。“Who is there?” she whispered. 窗外传来一阵脚步声，接着是敲门声。“It\'s me, Tom,” 门外的人回答。她松了一口气，打开了门。',
};

describe('estimateTokens', () => {
  it.each(Object.entries(SAMPLES))('stays within 30%% of gpt-tokenizer for %s text', (_name, text) => {
    const actual = encode(text).length;
    const estimate = estimateTokens(text);
    expect(Math.abs(estimate - actual) / actual).toBeLessThanOrEqual(0.3);
  });

  it('weighs each class of character', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);           // 4 × 0.25
    expect(estimateTokens('ab12 ')).toBe(3);          // 1 + 0.15
    expect(estimateTokens('中')).toBe(3);             // 1.05
    expect(estimateTokens('かナ한')).toBe(5);          // 3 × 1.05
    expect(estimateTokens('，。')).toBe(3);            // 2 × 1
    expect(estimateTokens('　 ')).toBe(2);   // 2 × 0.15
    expect(estimateTokens('é!')).toBe(2);             // 2 × 0.5
    expect(estimateTokens('𠀀𠀁')).toBe(4);            // a surrogate pair is one Han character
    expect(estimateTokens('中'.repeat(100))).toBe(106);
  });
});

describe('joinerBetween', () => {
  it('joins CJK without a space and everything else with one', () => {
    expect(joinerBetween('中文', '继续')).toBe('');
    expect(joinerBetween('です。', 'それから')).toBe('');
    expect(joinerBetween('他说，', '好')).toBe('');
    expect(joinerBetween('word', 'next')).toBe(' ');
    expect(joinerBetween('中文', 'English')).toBe(' ');
    expect(joinerBetween('English', '中文')).toBe(' ');
    expect(joinerBetween('한국어', '문장')).toBe(' ');
  });

  it('looks past punctuation shared by both kinds of text', () => {
    expect(joinerBetween('他说：“你好', '世界。”')).toBe('');
    expect(joinerBetween('“你好”', '他说')).toBe('');
    expect(joinerBetween('……', '他走了')).toBe('');
    expect(joinerBetween('——', '——')).toBe('');
    expect(joinerBetween('so—', 'then')).toBe(' ');
    expect(joinerBetween('“Hello”', 'she said')).toBe(' ');
  });

  it('adds nothing at an empty side or next to whitespace', () => {
    expect(joinerBetween('', 'next')).toBe('');
    expect(joinerBetween('word', '')).toBe('');
    expect(joinerBetween('word ', 'next')).toBe('');
    expect(joinerBetween('word', '\tnext')).toBe('');
  });
});

describe('character classes', () => {
  it('tells CJK characters apart', () => {
    for (const char of ['中', 'あ', 'ア', 'ｱ', '，', '。', '「', 'Ａ', '𠀀']) expect(isCjk(char), char).toBe(true);
    for (const char of ['a', 'é', '한', '—', '“', ' ', '']) expect(isCjk(char), char).toBe(false);
  });

  it('classifies letters by writing system', () => {
    expect(scriptOf('中')).toBe('han');
    expect(scriptOf('々')).toBe('han');
    expect(scriptOf('ー')).toBe('kana');
    expect(scriptOf('ｶ')).toBe('kana');
    expect(scriptOf('한')).toBe('hangul');
    expect(scriptOf('é')).toBe('latin');
    expect(scriptOf('я')).toBe('cyrillic');
    expect(scriptOf('α')).toBe('other');
    for (const char of ['1', '，', ' ', '—']) expect(scriptOf(char), char).toBeNull();
  });

  it('counts letters per writing system', () => {
    expect(countScripts('東京タワーへ行く。Tokyo Мир 1!')).toEqual({
      han: 3, kana: 5, hangul: 0, latin: 5, cyrillic: 3, other: 0, letters: 16,
    });
  });
});
