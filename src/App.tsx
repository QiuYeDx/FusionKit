import { useEffect } from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import "@/App.css";
import About from "@/pages/About";
import Setting from "@/pages/Setting";
import Home from "@/pages/Home";
import HomeAgent from "@/pages/HomeAgent";
import Tools from "@/pages/Tools";
import BottomNavigation from "@/pages/components/BottomNavigation";
import AppTitleBar from "@/pages/components/AppTitleBar";
import useThemeStore from "@/store/useThemeStore";
import FadeMaskLayer from "@/pages/components/FadeMaskLayer";
import useModelStore from "@/store/useModelStore";
import useProxyStore from "@/store/useProxyStore";
import SubtitleTranslator from "./pages/Tools/Subtitle/SubtitleTranslator";
import SubtitleConverter from "./pages/Tools/Subtitle/SubtitleConverter";
import SubtitleLanguageExtractor from "./pages/Tools/Subtitle/SubtitleLanguageExtractor";
import { Toaster } from "@/components/ui/sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import Update from "@/components/update";

function App() {
  // 初始化主题, 并添加系统深色模式监听
  const initializeTheme = useThemeStore((state) => state.initializeTheme);
  // 初始化模型配置
  const { initializeModel } = useModelStore();
  // 初始化代理配置
  const { initializeProxy } = useProxyStore();

  useEffect(() => {
    initializeTheme();
    initializeModel();
    initializeProxy();
  }, []);

  return (
    <div className="app bg-background text-foreground h-screen flex flex-col overflow-hidden">
      <AppTitleBar />
      {/* 占位用, 防止 AppTitleBar 遮挡有效内容 */}
      <div className="h-10"></div>

      {/* 使用 ScrollArea 替代 HTML 滚动 */}
      <ScrollArea className="flex-1 h-full">
        <div className="pt-10">
          {/* pb-20 为底部导航栏留出空间 */}
          <Routes>
            {/* 一级页面 */}
            <Route path="/" element={<HomeAgent />} />
            <Route path="/home-classic" element={<Home />} />
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
        </div>
      </ScrollArea>

      {/* 底部导航栏 */}
      <BottomNavigation />

      {/* 全局 Toast */}
      <Toaster position="top-right" />

      {/* 自动更新检测 */}
      <Update autoCheck showTrigger={false} />

      {/* 全局过渡遮罩层 */}
      <FadeMaskLayer />
    </div>
  );
}

export default App;
