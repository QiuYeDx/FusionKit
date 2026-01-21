# FusionKit 国际化最佳实践：i18next + react-i18next（含 i18n Ally 友好配置）

这篇文章基于 FusionKit 的最新国际化重构实践，目标是让你可以“复制即用”，快速搭建一个符合最佳实践、可维护、并且对 i18n Ally 等编辑器插件友好的国际化项目。

---

## 目标与原则

- **规范化目录**：语言与命名空间清晰分离，便于组织与拆分。
- **强可读性**：显式资源注册，避免“魔法加载”导致工具无法解析。
- **稳定持久化**：用户语言选择稳定保存，且避免边界异常。
- **一致的调用方式**：前端组件、非组件逻辑都使用同一 i18n 实例。

---

## 目录结构（推荐）

```
src/
  locales/
    zh/
      common.json
      home.json
      tools.json
      about.json
      setting.json
      subtitle.json
    en/
      ...
    ja/
      ...
  i18n/
    constants.ts
    resources.ts
    index.ts
```

命名空间（namespace）按页面/模块拆分，`common.json` 作为默认命名空间。

---

## 1) 常量统一：语言、命名空间、持久化 Key

`src/i18n/constants.ts`

```ts
import { LangEnum } from "@/type/lang";

export const LANGUAGE_STORAGE_KEY = "lang";
export const DEFAULT_LANGUAGE = LangEnum.ZH;
export const FALLBACK_LANGUAGE = LangEnum.ZH;
export const SUPPORTED_LANGUAGES = Object.values(LangEnum) as LangEnum[];

export const NAMESPACES = [
  "common",
  "home",
  "tools",
  "about",
  "setting",
  "subtitle",
] as const;

export type Namespace = (typeof NAMESPACES)[number];
export const DEFAULT_NAMESPACE: Namespace = "common";

export const normalizeLanguage = (lng?: string | null): LangEnum => {
  if (!lng) return DEFAULT_LANGUAGE;
  const base = lng.split("-")[0] as LangEnum;
  return SUPPORTED_LANGUAGES.includes(base) ? base : DEFAULT_LANGUAGE;
};

export const resolveInitialLanguage = (): LangEnum => {
  if (typeof window === "undefined") return DEFAULT_LANGUAGE;
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored);
  } catch {
    return DEFAULT_LANGUAGE;
  }
};
```

**要点：**

- `normalizeLanguage` 处理 `zh-CN` / `en-US` 之类的地区语言。
- 所有命名空间显式声明，避免 “动态扫描” 隐式推断。

---

## 2) 资源显式注册（i18n Ally 友好）

`src/i18n/resources.ts`

```ts
import type { Resource } from "i18next";
import { LangEnum } from "@/type/lang";

import enAbout from "@/locales/en/about.json";
import enCommon from "@/locales/en/common.json";
import enHome from "@/locales/en/home.json";
import enSetting from "@/locales/en/setting.json";
import enSubtitle from "@/locales/en/subtitle.json";
import enTools from "@/locales/en/tools.json";

import jaAbout from "@/locales/ja/about.json";
import jaCommon from "@/locales/ja/common.json";
import jaHome from "@/locales/ja/home.json";
import jaSetting from "@/locales/ja/setting.json";
import jaSubtitle from "@/locales/ja/subtitle.json";
import jaTools from "@/locales/ja/tools.json";

import zhAbout from "@/locales/zh/about.json";
import zhCommon from "@/locales/zh/common.json";
import zhHome from "@/locales/zh/home.json";
import zhSetting from "@/locales/zh/setting.json";
import zhSubtitle from "@/locales/zh/subtitle.json";
import zhTools from "@/locales/zh/tools.json";

export const resources: Resource = {
  [LangEnum.EN]: {
    common: enCommon,
    home: enHome,
    tools: enTools,
    about: enAbout,
    setting: enSetting,
    subtitle: enSubtitle,
  },
  [LangEnum.JA]: {
    common: jaCommon,
    home: jaHome,
    tools: jaTools,
    about: jaAbout,
    setting: jaSetting,
    subtitle: jaSubtitle,
  },
  [LangEnum.ZH]: {
    common: zhCommon,
    home: zhHome,
    tools: zhTools,
    about: zhAbout,
    setting: zhSetting,
    subtitle: zhSubtitle,
  },
};
```

**为什么不使用 `import.meta.glob`？**

- 动态加载的文件结构对 i18n Ally 不友好，插件无法静态解析真实资源。
- 显式导入能让工具和 IDE 更准确地读取、补全、跳转和预览。

---

## 3) i18n 初始化与持久化

`src/i18n/index.ts`

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resources } from "./resources";
import {
  DEFAULT_NAMESPACE,
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  NAMESPACES,
  normalizeLanguage,
  resolveInitialLanguage,
  SUPPORTED_LANGUAGES,
} from "./constants";

const initialLanguage = resolveInitialLanguage();

i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES,
  ns: NAMESPACES,
  defaultNS: DEFAULT_NAMESPACE,
  load: "languageOnly",
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

i18n.on("languageChanged", (lng) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, normalizeLanguage(lng));
  } catch {
    // 忽略存储失败
  }
});

export default i18n;
```

**要点：**

- `supportedLngs` 和 `load: "languageOnly"` 可避免地区语言的误判。
- `useSuspense: false` 避免默认 Suspense 行为引入额外处理。
- 初始化与持久化逻辑集中，避免重复与不一致。

---

## 4) 入口统一加载（确保全局可用）

`src/main.tsx`

```ts
import "@/i18n";
```

无论组件内还是非组件内（比如 store、工具函数）使用 `i18n.t(...)`，都应从统一入口导入：`import i18n from "@/i18n"`。

---

## 5) 语言切换 Hook（统一状态）

`src/hook/useLanguage.ts`

```ts
import { useState, useEffect, useCallback } from "react";
import i18n from "@/i18n";
import { LangEnum } from "@/type/lang";
import { normalizeLanguage } from "@/i18n/constants";

const useLanguage = () => {
  const [language, setLanguage] = useState<LangEnum>(() =>
    normalizeLanguage(i18n.resolvedLanguage || i18n.language)
  );

  useEffect(() => {
    const handleLanguageChange = (lng: string) => {
      setLanguage(normalizeLanguage(lng));
    };

    i18n.on("languageChanged", handleLanguageChange);
    return () => {
      i18n.off("languageChanged", handleLanguageChange);
    };
  }, []);

  const changeLanguage = useCallback((lng: LangEnum) => {
    i18n.changeLanguage(lng);
  }, []);

  return { language, changeLanguage };
};

export default useLanguage;
```

**要点：**

- Hook 不直接触碰本地存储，避免重复状态源。
- 以 i18n 事件为唯一可信来源。

---

## 6) i18n Ally 插件配置（关键）

`.vscode/settings.json`

```json
{
  "i18n-ally.localesPaths": ["src/locales"],
  "i18n-ally.pathMatcher": "{locale}/{namespace}.json",
  "i18n-ally.namespace": true,
  "i18n-ally.defaultNamespace": "common",
  "i18n-ally.keystyle": "nested",
  "i18n-ally.enabledFrameworks": ["react-i18next"],
  "i18n-ally.sourceLanguage": "zh"
}
```

**必须确保：**

- `pathMatcher` 与真实文件结构一致。
- `namespace` 与 `keystyle` 设置一致（本项目是嵌套结构）。

---

## 7) 组件内使用规范

```ts
const { t } = useTranslation();

t("home:welcome");
t("common:app_name", { defaultValue: "FusionKit" });
```

建议始终使用 `namespace:key` 格式，避免不同命名空间的 key 冲突。

---

## 常见坑与规避

- **动态 import 导致 i18n Ally 失效**：改成显式导入资源。
- **未声明命名空间**：插件无法判断所有可用 key。
- **多处初始化 i18n**：统一入口，避免实例不一致。
- **语言值不标准**：通过 `normalizeLanguage` 统一处理。

---

## 快速复用清单

- [ ] 规范目录结构 `src/locales/{locale}/{namespace}.json`
- [ ] 统一常量与命名空间 `src/i18n/constants.ts`
- [ ] 显式资源注册 `src/i18n/resources.ts`
- [ ] 初始化入口 `src/i18n/index.ts`
- [ ] 入口注入 `src/main.tsx`
- [ ] `useLanguage` 统一状态
- [ ] i18n Ally 配置齐全

---

## 结语

这套结构能显著提升可维护性，同时让工具链（尤其是 i18n Ally）稳定工作。如果你未来新增语言或命名空间，只需新增 JSON 文件并在 `resources.ts` 中注册即可，不需要额外改动初始化逻辑。
