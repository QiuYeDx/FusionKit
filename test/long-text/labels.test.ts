import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as labels from '../../src/pages/Tools/Text/LongTextTranslator/labels';

const LANGUAGES = ['zh', 'en', 'ja', 'zh-Hant'] as const;

function flatten(value: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object') flatten(child, full, out);
    else out.set(full, child);
  }
  return out;
}

const catalogs = Object.fromEntries(LANGUAGES.map(language => [
  language,
  flatten(JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../src/locales/${language}/text.json`), 'utf8'))),
])) as Record<(typeof LANGUAGES)[number], Map<string, unknown>>;

const placeholders = (value: unknown) => [...String(value).matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();

describe('text.json catalogs', () => {
  it('define the same keys with non-empty strings in every language', () => {
    const keys = [...catalogs.zh.keys()].sort();
    for (const language of LANGUAGES) {
      expect([...catalogs[language].keys()].sort()).toEqual(keys);
      for (const [key, value] of catalogs[language]) {
        expect(typeof value === 'string' && value.trim() !== '', `${language}: ${key}`).toBe(true);
      }
    }
  });

  it('use the same interpolation values in every language', () => {
    for (const [key, value] of catalogs.zh) {
      for (const language of LANGUAGES) {
        expect(placeholders(catalogs[language].get(key)), `${language}: ${key}`).toEqual(placeholders(value));
      }
    }
  });
});

describe('labels', () => {
  const maps = Object.entries(labels).filter(([, value]) => !Array.isArray(value)) as Array<[string, Record<string, string>]>;

  it('map every code to a key that exists in every language', () => {
    expect(maps.length).toBeGreaterThan(0);
    for (const [name, map] of maps) {
      for (const [code, key] of Object.entries(map)) {
        for (const language of LANGUAGES) {
          expect(catalogs[language].has(key), `${name}.${code} → ${language}: ${key}`).toBe(true);
        }
      }
    }
  });

  it('give every retranslate chip a label and a requirement sentence', () => {
    expect(Object.keys(labels.RETRANSLATE_CHIP_LABELS)).toEqual([...labels.RETRANSLATE_CHIPS]);
    expect(Object.keys(labels.RETRANSLATE_CHIP_TEXTS)).toEqual([...labels.RETRANSLATE_CHIPS]);
  });
});
