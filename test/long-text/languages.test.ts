import { describe, expect, it } from 'vitest';
import { LONG_TEXT_LANGUAGES, type LanguageTag } from '../../src/long-text/contract';
import { defaultTarget, detectSourceLanguage, isLanguageTag, LANGUAGE_INFO, labelKey } from '../../src/long-text/languages';

const SAMPLES: Record<LanguageTag, string[]> = {
  ja: ['その年の冬は、いつもより早くやって来た。', '父は庭に立ち、遠くの雪に覆われた山を眺めたまま、長いあいだ何も言わなかった。'],
  'zh-Hans': ['那年冬天来得特别早。', '父亲站在院子里，望着远处的山，半天没有说话。我知道他在想什么，地里的麦子还没有收完。'],
  'zh-Hant': ['那年冬天來得特別早。', '父親站在院子裡，望著遠處的山，半天沒有說話。我知道他在想什麼，地裡的麥子還沒有收完。'],
  ko: ['그해 겨울은 유난히 일찍 찾아왔다.', '아버지는 마당에 서서 멀리 보이는 산을 바라보며 한참 동안 아무 말도 하지 않았다.'],
  ru: ['В тот год зима пришла особенно рано.', 'Отец стоял во дворе, смотрел на далёкие горы и долго ничего не говорил.'],
  en: ['The winter came early that year.', 'My father stood in the yard and looked at the distant hills, and for a long time he said nothing. I knew what he was thinking about.'],
  fr: ["Cet hiver-là est arrivé plus tôt que d'habitude.", "Mon père se tenait dans la cour et regardait les collines au loin, sans rien dire pendant longtemps. Je savais à quoi il pensait : le blé n'était pas encore rentré."],
  de: ['In jenem Jahr kam der Winter besonders früh.', 'Mein Vater stand im Hof und sah lange auf die fernen Berge, ohne etwas zu sagen. Ich wusste, woran er dachte: Das Getreide war noch nicht eingebracht.'],
  es: ['Aquel año el invierno llegó muy pronto.', 'Mi padre estaba en el patio y miraba las montañas lejanas, sin decir nada durante mucho tiempo. Yo sabía en qué pensaba: el trigo todavía no se había recogido.'],
  pt: ['Naquele ano o inverno chegou muito cedo.', 'Meu pai estava no quintal e olhava as montanhas distantes, sem dizer nada durante muito tempo. Eu sabia em que ele pensava: o trigo ainda não tinha sido colhido.'],
};

describe('detectSourceLanguage', () => {
  it.each(LONG_TEXT_LANGUAGES)('recognizes %s', language => {
    expect(detectSourceLanguage(SAMPLES[language])).toBe(language);
  });

  it('keeps Japanese with many kanji Japanese', () => {
    expect(detectSourceLanguage(['東京都知事選挙の結果について、政府関係者は記者会見で慎重な見解を示した。'])).toBe('ja');
  });

  it('keeps Chinese technical text with English identifiers Chinese', () => {
    expect(detectSourceLanguage(['使用 pnpm install 安装依赖，然后运行 pnpm run dev 启动开发服务器。React 组件放在 src/components 目录下。'])).toBe('zh-Hans');
  });

  it('keeps English text that quotes a few Chinese characters English', () => {
    expect(detectSourceLanguage(['The sign above the door read 茶馆, which the guide translated as "tea house" before he walked on.'])).toBe('en');
  });

  it('reads only the first 20,000 characters', () => {
    const english = 'The house stood at the end of the road and it was quiet. '.repeat(400);
    expect(english.length).toBeGreaterThan(20_000);
    expect(detectSourceLanguage([english, '那年冬天来得特别早。'.repeat(5_000)])).toBe('en');
  });

  it('falls back to English without letters or on a stop word tie', () => {
    expect(detectSourceLanguage([])).toBe('en');
    expect(detectSourceLanguage(['12345 — 67890 !!!'])).toBe('en');
    expect(detectSourceLanguage(['der et'])).toBe('en');
  });
});

describe('defaultTarget', () => {
  it('derives the target from the interface language', () => {
    expect(defaultTarget('zh', 'ja')).toBe('zh-Hans');
    expect(defaultTarget('zh-Hant', 'ja')).toBe('zh-Hant');
    expect(defaultTarget('en', 'ja')).toBe('en');
    expect(defaultTarget('ja', 'en')).toBe('ja');
    expect(defaultTarget('it', 'en')).toBe('zh-Hans');
  });

  it('keeps a previously used target', () => {
    expect(defaultTarget('ko', 'en')).toBe('ko');
    expect(defaultTarget('zh-Hans', 'ja')).toBe('zh-Hans');
  });

  it('never targets the source language', () => {
    expect(defaultTarget('zh', 'zh-Hans')).toBe('en');
    expect(defaultTarget('zh-Hant', 'zh-Hant')).toBe('en');
    expect(defaultTarget('ja', 'ja')).toBe('en');
    expect(defaultTarget('en', 'en')).toBe('zh-Hans');
    expect(defaultTarget('fr', 'fr')).toBe('en');
  });
});

describe('language info', () => {
  it('describes all ten languages', () => {
    expect(Object.keys(LANGUAGE_INFO).sort()).toEqual([...LONG_TEXT_LANGUAGES].sort());
    expect(LANGUAGE_INFO['zh-Hans'].promptName).toBe('Simplified Chinese');
    expect(LANGUAGE_INFO.ja).toMatchObject({ family: 'cjk', script: 'han+kana', usesSpaces: false });
    expect(LANGUAGE_INFO.ko).toMatchObject({ family: 'ko', usesSpaces: true });
    expect(LANGUAGE_INFO.ru.script).toBe('cyrillic');
    for (const tag of LONG_TEXT_LANGUAGES) {
      expect(LANGUAGE_INFO[tag].fileTag).toBe(tag);
      expect(labelKey(tag)).toBe(`knowledge:languages.${tag}`);
    }
  });

  it('recognizes language tags', () => {
    expect(isLanguageTag('zh-Hant')).toBe(true);
    expect(isLanguageTag('zh')).toBe(false);
    expect(isLanguageTag('auto')).toBe(false);
    expect(isLanguageTag(undefined)).toBe(false);
  });
});
