# Unicode 16.0.0 matching data

`data.ts` is derived from the official Unicode Character Database, version **16.0.0**. It retains default full case-fold mappings (`C` and `F`; excludes simple-only `S` and locale-specific Turkic `T`), coalesced general-category ranges for letters (`L*`), marks (`M*`), numbers (`N*`) and connector punctuation (`Pc`), and all assigned ranges to freeze normalization. `UnicodeData.txt` First/Last ranges are expanded before coalescing; they must not be treated as just two assigned characters.

| Source | SHA-256 of original bytes |
| --- | --- |
| https://www.unicode.org/Public/16.0.0/ucd/CaseFolding.txt | `6f1f9c588eb4a5c718d9e8f93b782685e5c7fec872cf05e8e6878053599e09bb` |
| https://www.unicode.org/Public/16.0.0/ucd/UnicodeData.txt | `ff58e5823bd095166564a006e47d111130813dcf8bf234ef79fa51a870edb48f` |
| https://www.unicode.org/license.txt (retrieved 2026-09-14) | `e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96` |

The original data is © Unicode, Inc., distributed under **Unicode License V3**, reproduced in `LICENSE.txt`. Generated data remains subject to that notice. No network access or package dependency is needed at runtime.

An exact copy of `LICENSE.txt` is kept at `public/licenses/Unicode-16.0.0.txt`. Vite copies that notice into `dist/licenses/Unicode-16.0.0.txt`, so the existing Electron `dist` packaging rule distributes it with the compiled matching data. Keep the source and public notice byte-identical when updating these data.

Reproduce with a supported Node runtime after downloading the two exact source files:

```sh
node src/translation-knowledge/unicode/16.0.0/generate.mjs /path/CaseFolding.txt /path/UnicodeData.txt
```

The generator rejects source hashes other than those above. It produces 1,557 fold mappings, 825 word-category ranges and 731 assigned ranges. A Unicode-data upgrade requires a new matching policy version and must not reinterpret stored plans.

`normalizeForMatching` produces **Unicode 16.0 NFC**. It applies ECMAScript NFC only within runs of Unicode 16.0 assigned code points. Code points unassigned in Unicode 16.0 remain identity characters with canonical combining class zero; they form barriers between those runs. A newer runtime therefore cannot reinterpret them using newly assigned normalization properties. Existing assigned characters follow Unicode normalization stability; the shipped runtime must support Unicode 16.0 normalization or later. This uses the runtime's normalization implementation without borrowing its evolving assignment, case-folding or word-category tables.

Case folding does not apply NFKC, locale-specific lowercasing, whitespace removal or punctuation removal. Code points unassigned in Unicode 16.0 have identity folds and are not word-category characters, regardless of a newer runtime's Unicode tables.

Offsets refer to `normalizeForMatching(source)`, use UTF-16 indexing and have an exclusive end. Full case-fold expansions remain indivisible: `ss` can match one `ß`, but `s` cannot match half of it. Whole-term boundaries inspect the original NFC source code points, not folded expansion characters. The policy returns all overlapping occurrences so the compiler can report incompatible terms instead of silently choosing a longest match.
