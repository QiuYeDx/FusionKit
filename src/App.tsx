import { useEffect } from "react";
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
import useModelStore from "@/store/useModelStore";
import SubtitleTranslator from "./pages/Tools/Subtitle/SubtitleTranslator";
import SubtitleConverter from "./pages/Tools/Subtitle/SubtitleConverter";
import SubtitleLanguageExtractor from "./pages/Tools/Subtitle/SubtitleLanguageExtractor";
import { Toaster } from "react-hot-toast";

function App() {
  // 初始化主题, 并添加系统深色模式监听
  const initializeTheme = useThemeStore((state) => state.initializeTheme);
  // 初始化模型配置
  const { initializeModel } = useModelStore();

  useEffect(() => {
    initializeTheme();
    initializeModel();
  }, []);

  return (
    <div className="app bg-base-100">
      <AppTitleBar />
      {/* 占位用, 防止 AppTitleBar 遮挡有效内容 */}
      {/* TODO: Windows 下的高度待确认, 可能需要为动态高度 */}
      <div className="h-6"></div>

      <Routes>
        {/* 一级页面 */}
        <Route path="/" element={<Home />} />
        <Route path="/tools" element={<Tools />} />
        <Route path="/about" element={<About />} />
        <Route path="/setting" element={<Setting />} />

        {/* 二级页面 */}
        <Route
          path="/tools/subtitle/translator"
          element={<SubtitleTranslator />}
        />
        <Route
          path="/tools/subtitle/converter"
          element={<SubtitleConverter />}
        />
        <Route
          path="/tools/subtitle/extractor"
          element={<SubtitleLanguageExtractor />}
        />
      </Routes>

      {/* 底部导航栏 */}
      <BottomNavigation />

      {/* 全局 Toast */}
      <Toaster position="top-right" reverseOrder={false} />

      {/* 全局过渡遮罩层 */}
      <FadeMaskLayer />
    </div>
  );
}

export default App;
