import { useState, useEffect, useCallback } from "react";
import i18n from "@/i18n";
import { LangEnum } from "@/type/lang";
import { normalizeLanguage } from "@/i18n/constants";

const useLanguage = () => {
  const [language, setLanguage] = useState<LangEnum>(() =>
    normalizeLanguage(i18n.resolvedLanguage || i18n.language)
  );

  // 监听语言变化
  useEffect(() => {
    const handleLanguageChange = (lng: string) => {
      setLanguage(normalizeLanguage(lng));
    };

    // 监听 i18n 语言变化事件
    i18n.on("languageChanged", handleLanguageChange);

    // 清理监听器
    return () => {
      i18n.off("languageChanged", handleLanguageChange);
    };
  }, []);

  // 切换语言
  const changeLanguage = useCallback((lng: LangEnum) => {
    i18n.changeLanguage(lng);
  }, []);

  return {
    language,
    changeLanguage,
  };
};

export default useLanguage;
