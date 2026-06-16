#!/usr/bin/env node

/**
 * i18n 完整性检查脚本
 *
 * 以 src/locales/ 目录结构为准，自动发现语言和命名空间，
 * 检查四类问题：
 *   1. Key 缺失 / 多余
 *   2. 空值
 *   3. 值与源语言(zh)完全相同（疑似未翻译，仅提示）
 *   4. 各语言命名空间文件是否齐全
 *
 * 用法：pnpm run i18n:check
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "../src/locales");
const SOURCE_LANG = "zh";

// ── helpers ──────────────────────────────────────────────

function flattenEntries(obj, prefix = "") {
  const entries = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      entries.push(...flattenEntries(v, fullKey));
    } else {
      entries.push([fullKey, v]);
    }
  }
  return entries;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function discoverLangs() {
  return fs
    .readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => (a === SOURCE_LANG ? -1 : b === SOURCE_LANG ? 1 : a.localeCompare(b)));
}

function discoverNamespaces(lang) {
  return fs
    .readdirSync(path.join(LOCALES_DIR, lang))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

// CJK 共用汉字在日语中可能完全一致，不算未翻译
function isCjkShared(value) {
  return /^[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\s·]+$/.test(value);
}

// 纯 ASCII / Latin 值（品牌名、技术术语、状态词等）在所有语言中一致属于设计意图
function isAsciiOrTechnical(value) {
  return /^[\x20-\x7e]+$/.test(value);
}

// ── main ─────────────────────────────────────────────────

const langs = discoverLangs();
const allNamespaces = new Set(langs.flatMap(discoverNamespaces));
const errors = [];
const warnings = [];

let totalKeys = 0;

console.log("╔══════════════════════════════════════════════════╗");
console.log("║          i18n Completeness Check                ║");
console.log("╚══════════════════════════════════════════════════╝");
console.log();
console.log(`  Source lang : ${SOURCE_LANG}`);
console.log(`  Languages   : ${langs.join(", ")}`);
console.log(`  Namespaces  : ${[...allNamespaces].join(", ")}`);
console.log();

// ── Check 1: namespace file existence ────────────────────

for (const lang of langs) {
  const nsSet = new Set(discoverNamespaces(lang));
  for (const ns of allNamespaces) {
    if (!nsSet.has(ns)) {
      errors.push(`[MISSING FILE] ${lang}/${ns}.json does not exist`);
    }
  }
}

// ── Check 2 & 3 & 4: key diff, empty values, same-as-source ──

for (const ns of allNamespaces) {
  const langEntries = {};
  const langKeySet = {};

  for (const lang of langs) {
    const filePath = path.join(LOCALES_DIR, lang, `${ns}.json`);
    if (!fs.existsSync(filePath)) continue;
    const entries = flattenEntries(readJson(filePath));
    langEntries[lang] = new Map(entries);
    langKeySet[lang] = new Set(entries.map(([k]) => k));
  }

  if (!langKeySet[SOURCE_LANG]) continue;
  const sourceKeys = langKeySet[SOURCE_LANG];
  totalKeys += sourceKeys.size;

  // key diff
  const unionKeys = new Set(Object.values(langKeySet).flatMap((s) => [...s]));
  for (const lang of langs) {
    if (!langKeySet[lang]) continue;
    for (const key of unionKeys) {
      if (!langKeySet[lang].has(key)) {
        errors.push(`[MISSING KEY]  ${lang}/${ns}: ${key}`);
      }
    }
    if (lang !== SOURCE_LANG) {
      for (const key of langKeySet[lang]) {
        if (!sourceKeys.has(key)) {
          errors.push(`[EXTRA KEY]    ${lang}/${ns}: ${key}  (not in ${SOURCE_LANG})`);
        }
      }
    }
  }

  // empty values
  for (const lang of langs) {
    if (!langEntries[lang]) continue;
    for (const [key, val] of langEntries[lang]) {
      if (typeof val === "string" && val.trim() === "") {
        errors.push(`[EMPTY VALUE]  ${lang}/${ns}: ${key}`);
      }
    }
  }

  // same-as-source (warning only, skip CJK-shared for ja)
  const sourceMap = langEntries[SOURCE_LANG];
  if (sourceMap) {
    for (const lang of langs) {
      if (lang === SOURCE_LANG || lang === "zh-Hant" || !langEntries[lang]) continue;
      for (const [key, val] of langEntries[lang]) {
        const srcVal = sourceMap.get(key);
        if (
          srcVal &&
          val === srcVal &&
          typeof val === "string" &&
          val.length > 2 &&
          !(lang === "ja" && isCjkShared(val)) &&
          !isAsciiOrTechnical(val)
        ) {
          warnings.push(`[SAME AS ${SOURCE_LANG}]  ${lang}/${ns}: ${key} = "${val}"`);
        }
      }
    }
  }
}

// ── summary ──────────────────────────────────────────────

const keyTable = [];
for (const ns of allNamespaces) {
  const row = { namespace: ns };
  for (const lang of langs) {
    const fp = path.join(LOCALES_DIR, lang, `${ns}.json`);
    row[lang] = fs.existsSync(fp) ? flattenEntries(readJson(fp)).length : 0;
  }
  keyTable.push(row);
}

console.log("  Namespace        " + langs.map((l) => l.padStart(8)).join(""));
console.log("  ─────────────────" + langs.map(() => "────────").join(""));
for (const row of keyTable) {
  const ns = row.namespace.padEnd(17);
  const counts = langs.map((l) => String(row[l]).padStart(8)).join("");
  console.log(`  ${ns}${counts}`);
}
const totals = langs.map((l) => String(keyTable.reduce((s, r) => s + r[l], 0)).padStart(8)).join("");
console.log("  ─────────────────" + langs.map(() => "────────").join(""));
console.log(`  ${"TOTAL".padEnd(17)}${totals}`);
console.log();

if (errors.length === 0 && warnings.length === 0) {
  console.log("  ✅ All checks passed. No issues found.\n");
  process.exit(0);
}

if (warnings.length > 0) {
  console.log(`  ⚠  ${warnings.length} warning(s) (same value as source, may be fine):\n`);
  for (const w of warnings) console.log(`     ${w}`);
  console.log();
}

if (errors.length > 0) {
  console.log(`  ❌ ${errors.length} error(s) found:\n`);
  for (const e of errors) console.log(`     ${e}`);
  console.log();
  process.exit(1);
}

process.exit(0);
