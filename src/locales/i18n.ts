import { LangEnum } from "@/type/lang";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// 从 localStorage 中读取用户设置的语言
const savedLanguage: LangEnum = (localStorage.getItem("lang") ||
  "zh") as LangEnum;

// 使用 Vite 的 import.meta.glob 动态加载所有翻译文件
const translations = import.meta.glob("./**/*.json", { eager: true });

// 将加载的翻译文件转换为 i18next 需要的格式
const resources: { [key in LangEnum]: any } = Object.keys(translations).reduce(
  (acc: any, path) => {
    // acc: { [key in LangEnum]: any }
    const ans = path.match(/\.\/(.*)\/(.*)\.json/);
    if (!ans) return acc;
    const [_, language, namespace] = ans; // 提取语言和命名空间
    const key: LangEnum = language as LangEnum;
    if (!acc[key]) {
      acc[key] = {};
    }
    acc[key][namespace] = (translations[path] as any).default; // 加载的翻译文件内容
    return acc;
  },
  {}
);

i18n.use(initReactI18next).init({
  resources, // 添加翻译资源
  ns: Object.keys(resources[savedLanguage] || {}), // 动态设置命名空间
  defaultNS: "common", // 默认命名空间
  lng: savedLanguage, // 使用用户设置的语言
  fallbackLng: "zh", // 如果没有匹配的语言，则使用此语言
  interpolation: {
    escapeValue: false, // React 已经对 XSS 进行了处理
  },
});

export default i18n;
