// i18n 配置文件
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

i18n.use(initReactI18next).init({
  resources: {
    en: {
      translation: {
        welcome: "Welcome to FusionKit",
        home: "Home",
        tools: "Tools",
        setting: "Setting",
        about: "About",
      },
    },
    chs: {
      translation: {
        welcome: "欢迎使用 FusionKit",
        home: "主页",
        tools: "工具",
        setting: "设置",
        about: "关于",
      },
    },
  },
  lng: "chs", // 默认语言
  fallbackLng: "en", // 如果没有匹配的语言，则使用此语言
  interpolation: {
    escapeValue: false, // React 已经对 XSS 进行了处理
  },
});

export default i18n;
