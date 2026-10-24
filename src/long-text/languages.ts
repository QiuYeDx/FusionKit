import { LONG_TEXT_LANGUAGES, type LanguageTag } from './contract';
import { countScripts } from './text-stats';

export interface LanguageInfo {
  /** English name used in prompts. */
  promptName: string;
  family: 'cjk' | 'ko' | 'alpha';
  script: 'han' | 'han+kana' | 'hangul' | 'latin' | 'cyrillic';
  usesSpaces: boolean;
  /** Language part of exported file names: `name.<fileTag>.txt`. */
  fileTag: string;
}

export const LANGUAGE_INFO: Readonly<Record<LanguageTag, LanguageInfo>> = Object.freeze({
  'zh-Hans': { promptName: 'Simplified Chinese', family: 'cjk', script: 'han', usesSpaces: false, fileTag: 'zh-Hans' },
  'zh-Hant': { promptName: 'Traditional Chinese', family: 'cjk', script: 'han', usesSpaces: false, fileTag: 'zh-Hant' },
  en: { promptName: 'English', family: 'alpha', script: 'latin', usesSpaces: true, fileTag: 'en' },
  ja: { promptName: 'Japanese', family: 'cjk', script: 'han+kana', usesSpaces: false, fileTag: 'ja' },
  ko: { promptName: 'Korean', family: 'ko', script: 'hangul', usesSpaces: true, fileTag: 'ko' },
  fr: { promptName: 'French', family: 'alpha', script: 'latin', usesSpaces: true, fileTag: 'fr' },
  de: { promptName: 'German', family: 'alpha', script: 'latin', usesSpaces: true, fileTag: 'de' },
  es: { promptName: 'Spanish', family: 'alpha', script: 'latin', usesSpaces: true, fileTag: 'es' },
  ru: { promptName: 'Russian', family: 'alpha', script: 'cyrillic', usesSpaces: true, fileTag: 'ru' },
  pt: { promptName: 'Portuguese', family: 'alpha', script: 'latin', usesSpaces: true, fileTag: 'pt' },
});

const LABEL_KEYS = {
  'zh-Hans': 'knowledge:languages.zh-Hans',
  'zh-Hant': 'knowledge:languages.zh-Hant',
  en: 'knowledge:languages.en',
  ja: 'knowledge:languages.ja',
  ko: 'knowledge:languages.ko',
  fr: 'knowledge:languages.fr',
  de: 'knowledge:languages.de',
  es: 'knowledge:languages.es',
  ru: 'knowledge:languages.ru',
  pt: 'knowledge:languages.pt',
} as const satisfies Record<LanguageTag, string>;

/** Translation key of a language name (shared with the translation materials). */
export function labelKey<T extends LanguageTag>(tag: T): (typeof LABEL_KEYS)[T] {
  return LABEL_KEYS[tag];
}

export function isLanguageTag(value: unknown): value is LanguageTag {
  return typeof value === 'string' && (LONG_TEXT_LANGUAGES as readonly string[]).includes(value);
}

/** Characters written differently in Simplified and Traditional Chinese, as "simplified traditional" pairs. */
const HANZI_PAIRS = (
  '这這 说說 时時 们們 会會 国國 来來 对對 后後 发發 个個 为為 过過 还還 没沒 样樣 么麼 现現 进進 动動 ' +
  '经經 长長 开開 关關 问問 间間 听聽 见見 觉覺 让讓 话話 认認 识識 应應 该該 实實 东東 头頭 两兩 门門 ' +
  '边邊 从從 无無 声聲 气氣 体體 学學 题題 种種 当當 将將 机機 电電 车車 马馬 鸟鳥 鱼魚 龙龍 书書 写寫 ' +
  '读讀 买買 卖賣 钱錢 银銀 铁鐵 万萬 与與 业業 专專 丝絲 严嚴 临臨 丽麗 举舉 乐樂 习習 乡鄉 亚亞 产產 ' +
  '亲親 亿億 仅僅 价價 众眾 优優 伟偉 传傳 伤傷 债債 儿兒 党黨 兰蘭 兴興 养養 内內 军軍 农農 冲衝 决決 ' +
  '况況 净淨 减減 凤鳳 击擊 刘劉 则則 刚剛 创創 别別 剧劇 剑劍 办辦 务務 劝勸 势勢 华華 协協 单單 卫衛 ' +
  '却卻 厂廠 厅廳 历歷 压壓 县縣 参參 双雙 变變 号號 吗嗎 员員 响響 团團 园園 围圍 图圖 圆圓 圣聖 场場 ' +
  '坏壞 块塊 坚堅 墙牆 壮壯 处處 备備 够夠 夺奪 奋奮 奖獎 妇婦 妈媽 孙孫 宁寧 宝寶 审審 宽寬 寻尋 导導 ' +
  '寿壽 尔爾 尘塵 层層 属屬 岁歲 岛島 师師 帮幫 带帶 广廣 庆慶 库庫 废廢 张張 弹彈 恳懇 归歸 录錄 彻徹 ' +
  '忆憶 忧憂 怀懷 态態 总總 恋戀 恶惡 惊驚 惯慣 愿願 戏戲 战戰 执執 扩擴 扫掃 扬揚 护護 报報 担擔 拥擁'
).split(' ');
const SIMPLIFIED_ONLY = new Set(HANZI_PAIRS.map(pair => pair[0]));
const TRADITIONAL_ONLY = new Set(HANZI_PAIRS.map(pair => pair[1]));

/** Frequent function words that tell the Latin-script languages apart; words shared by two of them are left out. */
const STOP_WORDS: Readonly<Record<'en' | 'fr' | 'de' | 'es' | 'pt', ReadonlySet<string>>> = {
  en: new Set('the and of to is that it for with be at by this had not are but from have they you he she which were his her would there been what or'.split(' ')),
  fr: new Set('des et est une dans qui pour pas sur au aux avec ce cette il elle nous vous ils sont mais plus été être fait comme ses leur je très tout'.split(' ')),
  de: new Set('der die das und ist nicht ein eine zu den dem mit sich auf für von im auch sie wir ich war wird werden dass aber oder wie noch nach bei einen einem sind'.split(' ')),
  es: new Set('el los las del y con una su sus al lo más pero fue muy también hay cuando ya eso'.split(' ')),
  pt: new Set('o os do da dos e é em um uma não com na nas ao mas foi são também muito ele ela isso já pelo pela'.split(' ')),
};

/** Characters of sample text the source language detection reads; the importer samples as many. */
export const DETECTION_CHARS = 20_000;
/** A Han, kana or Hangul character carries about as much text as three alphabetic letters. */
const ALPHABETIC_WEIGHT = 1 / 3;

function sampleText(samples: readonly string[]): string {
  const parts: string[] = [];
  let length = 0;
  for (const sample of samples) {
    if (length >= DETECTION_CHARS) break;
    const part = sample.slice(0, DETECTION_CHARS - length);
    parts.push(part);
    length += part.length;
  }
  return parts.join('\n');
}

function detectLatin(text: string): LanguageTag {
  const hits = { en: 0, fr: 0, de: 0, es: 0, pt: 0 };
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    for (const language of Object.keys(hits) as Array<keyof typeof hits>) {
      if (STOP_WORDS[language].has(word)) hits[language]++;
    }
  }
  const best = Math.max(...Object.values(hits));
  const leaders = (Object.keys(hits) as Array<keyof typeof hits>).filter(language => hits[language] === best);
  return leaders.length === 1 ? leaders[0] : 'en';
}

function detectChinese(text: string): LanguageTag {
  let simplified = 0;
  let traditional = 0;
  for (const char of text) {
    if (SIMPLIFIED_ONLY.has(char)) simplified++;
    else if (TRADITIONAL_ONLY.has(char)) traditional++;
  }
  return traditional > simplified ? 'zh-Hant' : 'zh-Hans';
}

/**
 * Source language of the first 20,000 characters of translatable display text: Japanese when kana
 * make up 5% of the letters, otherwise by the dominant writing system; Chinese by the count of
 * script-specific characters, Latin-script languages by stop words (a tie is English).
 */
export function detectSourceLanguage(samples: readonly string[]): LanguageTag {
  const text = sampleText(samples);
  const counts = countScripts(text);
  if (counts.letters === 0) return 'en';
  if (counts.kana >= counts.letters * 0.05) return 'ja';
  const weights: Array<['hangul' | 'han' | 'cyrillic' | 'latin', number]> = [
    ['hangul', counts.hangul], ['han', counts.han],
    ['cyrillic', counts.cyrillic * ALPHABETIC_WEIGHT], ['latin', counts.latin * ALPHABETIC_WEIGHT],
  ];
  const [dominant, weight] = weights.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  if (weight === 0) return 'en';
  if (dominant === 'hangul') return 'ko';
  if (dominant === 'han') return detectChinese(text);
  if (dominant === 'cyrillic') return 'ru';
  return detectLatin(text);
}

const UI_TARGETS: Readonly<Record<string, LanguageTag>> = { zh: 'zh-Hans' };

/**
 * Target language of a new document. `preferred` is the last used target or the UI language
 * (zh, zh-Hant, en, ja); when it equals the source, English is used, or Simplified Chinese for an
 * English source.
 */
export function defaultTarget(preferred: string, source: LanguageTag): LanguageTag {
  const target = isLanguageTag(preferred) ? preferred : UI_TARGETS[preferred] ?? 'zh-Hans';
  if (target !== source) return target;
  return source === 'en' ? 'zh-Hans' : 'en';
}
