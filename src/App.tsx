import { useEffect, useRef } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
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

const ROUTE_ORDER: Record<string, number> = {
  "/": 0,
  "/home-classic": 0,
  "/tools": 1,
  "/about": 2,
  "/setting": 3,
};

function getRouteIndex(pathname: string): number {
  if (ROUTE_ORDER[pathname] !== undefined) return ROUTE_ORDER[pathname];
  if (pathname.startsWith("/tools/")) return ROUTE_ORDER["/tools"] + 0.5;
  return -1;
}

const SLIDE_OFFSET = 60;

const pageVariants = {
  enter: (direction: number) => ({
    x: direction * SLIDE_OFFSET,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    x: -direction * SLIDE_OFFSET,
    opacity: 0,
  }),
};

const pageTransition = {
  type: "spring" as const,
  duration: 0.3,
  bounce: 0,
};

function App() {
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);
  const directionRef = useRef(1);

  if (prevPathRef.current !== location.pathname) {
    const prevIndex = getRouteIndex(prevPathRef.current);
    const nextIndex = getRouteIndex(location.pathname);
    directionRef.current = nextIndex > prevIndex ? 1 : -1;
    prevPathRef.current = location.pathname;
  }

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
        <div className="pt-10 w-screen overflow-x-clip">
          <AnimatePresence
            mode="wait"
            custom={directionRef.current}
            initial={false}
          >
            <motion.div
              key={location.pathname}
              custom={directionRef.current}
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={pageTransition}
            >
              <Routes location={location}>
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
            </motion.div>
          </AnimatePresence>
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
