import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import "@/App.css";
import About from "@/pages/About";
import Setting from "@/pages/Setting";
import Home from "@/pages/Home";
import Tools from "@/pages/Tools";
import BottomNavigation from "@/pages/components/BottomNavigation";
import AppTitleBar from "@/pages/components/AppTitleBar";
import useThemeStore from "@/store/useThemeStore";
import FadeMaskLayer from "@/pages/components/FadeMaskLayer";
import { useEffect } from "react";

function App() {
  // 初始化主题, 并添加系统深色模式监听
  const initializeTheme = useThemeStore((state) => state.initializeTheme);

  useEffect(() => {
    initializeTheme();
  }, []);

  return (
    <div className="app bg-base-100">
      <AppTitleBar />
      {/* 占位用, 防止 AppTitleBar 遮挡有效内容 */}
      {/* TODO: Windows 下的高度待确认, 可能需要为动态高度 */}
      <div className="h-6"></div>

      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/tools" element={<Tools />} />
        <Route path="/about" element={<About />} />
        <Route path="/setting" element={<Setting />} />
      </Routes>

      {/* 底部导航栏 */}
      <BottomNavigation />

      {/* 全局过渡遮罩层 */}
      <FadeMaskLayer />
    </div>
  );
}

export default App;
