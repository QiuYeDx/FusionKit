import React from "react";
import useTheme from "@/hook/useTheme";

const Setting: React.FC = () => {
  // 使用 useTheme Hook 获取当前主题和设置主题的函数
  const { theme, setTheme } = useTheme();

  return (
    <div className="p-6">
      <div className="text-2xl font-bold mb-4">设置</div>
      <div className="mb-6">这是设置页面。</div>

      <div className="bg-base-200 p-6 rounded-lg">
        <div className="text-xl font-semibold mb-4">主题设置</div>

        <div className="join">
          <input
            className="join-item btn btn-sm bg-base-100"
            type="radio"
            name="theme"
            aria-label="浅色模式"
            checked={theme === "light"}
            onChange={() => setTheme("light")}
          />
          <input
            className="join-item btn btn-sm bg-base-100 mt-[3px]"
            type="radio"
            name="theme"
            aria-label="深色模式"
            checked={theme === "dark"}
            onChange={() => setTheme("dark")}
          />
          <input
            className="join-item btn btn-sm bg-base-100 mt-[3px]"
            type="radio"
            name="theme"
            aria-label="跟随系统"
            checked={theme === "system"}
            onChange={() => setTheme("system")}
          />
        </div>
      </div>
    </div>
  );
};

export default Setting;