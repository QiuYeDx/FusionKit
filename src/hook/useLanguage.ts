import { useState, useEffect } from 'react';
import i18n from 'i18next';

// 本地存储的键名
const LANGUAGE_KEY = 'lang';

const useLanguage = () => {
  // 从 localStorage 中读取用户设置的语言，如果没有则使用 i18n 的默认语言
  const [language, setLanguage] = useState(
    localStorage.getItem(LANGUAGE_KEY) || i18n.language
  );

  // 初始化时设置语言
  useEffect(() => {
    const savedLanguage = localStorage.getItem(LANGUAGE_KEY);
    if (savedLanguage) {
      i18n.changeLanguage(savedLanguage); // 设置 i18n 的语言
    }
  }, []);

  // 监听语言变化
  useEffect(() => {
    const handleLanguageChange = (lng) => {
      setLanguage(lng);
      localStorage.setItem(LANGUAGE_KEY, lng); // 将语言保存到 localStorage
    };

    // 监听 i18n 语言变化事件
    i18n.on('languageChanged', handleLanguageChange);

    // 清理监听器
    return () => {
      i18n.off('languageChanged', handleLanguageChange);
    };
  }, []);

  // 切换语言
  const changeLanguage = (lng) => {
    i18n.changeLanguage(lng);
  };

  return {
    language,
    changeLanguage,
  };
};

export default useLanguage;