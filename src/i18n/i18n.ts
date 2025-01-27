import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// 从 localStorage 中读取用户设置的语言
const savedLanguage = localStorage.getItem("lang") || "zh";

i18n.use(initReactI18next).init({
  resources: {
    en: {
      translation: {
        // 欢迎语
        welcome: "Welcome to FusionKit",
        home_description: "A cross-platform desktop toolbox for efficient and convenient workflows.",
        // 功能介绍
        subtitle_tool_title: "Subtitle Tools",
        subtitle_tool_description: "AI translation, format conversion, and more for subtitles.",
        rename_tool_title: "Batch Rename",
        rename_tool_description: "Easily rename multiple files in bulk.",
        music_tool_title: "Music Decryption",
        music_tool_description: "Convert paid music to FLAC/MP3 formats.",
        // 跨平台支持
        cross_platform_title: "Cross-Platform Support",
        cross_platform_description: "Available on Windows, macOS, and Linux.",
        // 操作按钮
        get_started: "Get Started",
        learn_more: "Learn More",
        // 菜单
        home: "Home",
        tools: "Tools",
        setting: "Setting",
        about: "About",
        // 各级标题
        theme_config: "Theme Settings",
        language_config: "Language Settings",
        // 描述文本
        setting_description:
          "Customize your experience by adjusting the theme and language settings.",
        // 主题选项
        light_mode: "Light Mode",
        dark_mode: "Dark Mode",
        system_mode: "Follow System",
      },
    },
    zh: {
      translation: {
        // 欢迎语
        welcome: "欢迎使用 FusionKit",
        home_description: "一个跨平台的桌面工具箱，为您提供高效、便捷的工作流。",
        // 功能介绍
        subtitle_tool_title: "字幕处理",
        subtitle_tool_description: "AI 翻译、格式转换等字幕处理功能。",
        rename_tool_title: "文件批量重命名",
        rename_tool_description: "轻松批量重命名多个文件。",
        music_tool_title: "付费音乐解密",
        music_tool_description: "将付费音乐转换为 FLAC/MP3 格式。",
        // 跨平台支持
        cross_platform_title: "跨平台支持",
        cross_platform_description: "支持 Windows、macOS 和 Linux。",
        // 操作按钮
        get_started: "开始使用",
        learn_more: "了解更多",
        // 菜单
        home: "主页",
        tools: "工具",
        setting: "设置",
        about: "关于",
        // 各级标题
        theme_config: "主题设置",
        language_config: "语言设置",
        // 描述文本
        setting_description: "通过调整主题和语言设置，定制您的使用体验。",
        // 主题选项
        light_mode: "浅色模式",
        dark_mode: "深色模式",
        system_mode: "跟随系统",
      },
    },
    ja: {
      translation: {
        // 欢迎语
        welcome: "FusionKitへようこそ",
        home_description: "効率的で便利なワークフローのためのクロスプラットフォームデスクトップツールボックスです。",
        // 功能介绍
        subtitle_tool_title: "字幕ツール",
        subtitle_tool_description: "AI翻訳、フォーマット変換などの字幕処理機能。",
        rename_tool_title: "バッチリネーム",
        rename_tool_description: "複数のファイルを簡単に一括リネーム。",
        music_tool_title: "音楽復号化",
        music_tool_description: "有料音楽をFLAC/MP3形式に変換。",
        // 跨平台支持
        cross_platform_title: "クロスプラットフォーム対応",
        cross_platform_description: "Windows、macOS、Linuxで利用可能。",
        // 操作按钮
        get_started: "始める",
        learn_more: "もっと見る",
        // 菜单
        home: "ホーム",
        tools: "ツール",
        setting: "設定",
        about: "について",
        // 各级标题
        theme_config: "テーマ設定",
        language_config: "言語設定",
        // 描述文本
        setting_description:
          "テーマと言語設定を調整して、あなたの体験をカスタマイズしてください。",
        // 主题选项
        light_mode: "ライトモード",
        dark_mode: "ダークモード",
        system_mode: "システムに従う",
      },
    },
  },
  lng: savedLanguage, // 使用用户设置的语言
  fallbackLng: "zh", // 如果没有匹配的语言，则使用此语言
  interpolation: {
    escapeValue: false, // React 已经对 XSS 进行了处理
  },
});

export default i18n;
