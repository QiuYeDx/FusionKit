import { useRef } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import "@/App.css";
import About from "@/pages/About";
import Help from "@/pages/Help";
import { HELP_ROUTE } from "@/pages/Help/helpNavigation";
import Setting from "@/pages/Setting";
import Home from "@/pages/Home";
import HomeAgent from "@/pages/HomeAgent";
import useAgentStore from "@/store/agent/useAgentStore";
import AgentDock from "@/pages/AgentDock";
import ClassicPageContexts from "@/pages/AgentDock/ClassicPageContexts";
import ExternalAgentHost from "@/pages/AgentDock/ExternalAgentHost";
import { PromptTemplateHost } from "@/pages/HomeAgent/components/PromptTemplates";
import Tools from "@/pages/Tools";
import BottomNavigation from "@/pages/components/BottomNavigation";
import AppTitleBar from "@/pages/components/AppTitleBar";
import SubtitleTranslator from "./pages/Tools/Subtitle/SubtitleTranslator";
import SubtitleStudio from "./pages/Tools/Subtitle/SubtitleStudio";
import TranslationKnowledge from "./pages/TranslationKnowledge";
import SubtitleConverter from "./pages/Tools/Subtitle/SubtitleConverter";
import SubtitleLanguageExtractor from "./pages/Tools/Subtitle/SubtitleLanguageExtractor";
import LocalSubtitleTranscriber from "./pages/Tools/Subtitle/LocalSubtitleTranscriber";
import NameTranslator from "./pages/Tools/Rename/NameTranslator";
import TextTranslator from "./pages/Tools/Text/TextTranslator";
import ExternalAgentActivity from "./pages/ExternalAgentActivity";
import { EXTERNAL_ACTIVITY_ROUTE } from "./pages/ExternalAgentActivity/route";
import { Toaster } from "@/components/ui/sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import Update from "@/components/update";
import WelcomeWizard from "@/components/onboarding/WelcomeWizard";
import { VcRuntimePageNotice } from "@/components/system-setup/VcRuntimeNotice";
import LocalSubtitleOverwriteRecoveryPrompt from "@/components/local-subtitle/LocalSubtitleOverwriteRecoveryPrompt";
import { LOCAL_SUBTITLE_TRANSCRIBER_ROUTE } from "@/constants/router";
import { ToolFileDropScope } from "@/pages/Tools/_shared/ui/ToolFileDropScope";


const ROUTE_ORDER: Record<string, number> = {
  "/": 0,
  "/home-classic": 0,
  "/tools": 1,
  [HELP_ROUTE]: 2,
  "/about": 3,
  "/setting": 4,
};

function getRouteIndex(pathname: string): number {
  if (ROUTE_ORDER[pathname] !== undefined) return ROUTE_ORDER[pathname];
  if (pathname.startsWith("/tools/")) return ROUTE_ORDER["/tools"] + 0.5;
  if (pathname === EXTERNAL_ACTIVITY_ROUTE) return ROUTE_ORDER["/setting"] + 0.5;
  return -1;
}

const SLIDE_OFFSET = 60;

// Avoid transform-based route motion: transformed ancestors make fixed
// descendants position against the page wrapper instead of the viewport.
const pageVariants = {
  enter: (direction: number) => ({
    left: direction * SLIDE_OFFSET,
    opacity: 0,
  }),
  center: {
    left: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    left: -direction * SLIDE_OFFSET,
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

  // With a conversation, home and the floating panel hand over to each other:
  // the page only fades so that it does not slide against the panel's flight.
  const conversationActive = useAgentStore((state) => state.session.messages.length > 0 || state.isStreaming);
  if (prevPathRef.current !== location.pathname) {
    const prevIndex = getRouteIndex(prevPathRef.current);
    const nextIndex = getRouteIndex(location.pathname);
    const handoff = conversationActive && (prevPathRef.current === "/" || location.pathname === "/");
    directionRef.current = handoff ? 0 : nextIndex > prevIndex ? 1 : -1;
    prevPathRef.current = location.pathname;
  }

  return (
    <div className="app bg-background text-foreground h-screen flex flex-col overflow-hidden">
      <AppTitleBar />

      {/* 使用 ScrollArea 替代 HTML 滚动 */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="w-screen overflow-x-clip">
          {/* 占位随内容滚动，让页面能从透明标题栏下方经过。 */}
          <div className="h-10" aria-hidden="true" />
          <AnimatePresence
            mode="wait"
            custom={directionRef.current}
            initial={false}
          >
            <motion.div
              key={location.pathname}
              custom={directionRef.current}
              className="relative"
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={pageTransition}
            >
              <ToolFileDropScope
                enabled={location.pathname.startsWith('/tools/')}
                className={location.pathname === '/tools' || location.pathname.startsWith('/tools/') || location.pathname === EXTERNAL_ACTIVITY_ROUTE ? undefined : 'pt-10'}
              >
              <Routes location={location}>
                {/* 一级页面 */}
                <Route path="/" element={<HomeAgent />} />
                <Route path="/home-classic" element={<Home />} />
                <Route path="/tools" element={<Tools />} />
                <Route path={HELP_ROUTE} element={<Help />} />
                <Route path="/about" element={<About />} />
                <Route path="/setting" element={<Setting />} />
                <Route path={EXTERNAL_ACTIVITY_ROUTE} element={<ExternalAgentActivity />} />

                {/* 二级页面 */}
                <Route path="/tools/subtitle/studio" element={<SubtitleStudio />} />
                <Route path="/tools/translation-knowledge" element={<TranslationKnowledge />} />
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
                <Route
                  path={LOCAL_SUBTITLE_TRANSCRIBER_ROUTE}
                  element={
                    <>
                      {/* 经典转写页已冻结：缺少微软运行库时的提示放在页面上方 */}
                      <VcRuntimePageNotice />
                      <LocalSubtitleTranscriber />
                    </>
                  }
                />
                <Route
                  path="/tools/rename/name-translator"
                  element={<NameTranslator />}
                />
                <Route
                  path="/tools/text/translator"
                  element={<TextTranslator />}
                />
              </Routes>
              </ToolFileDropScope>
            </motion.div>
          </AnimatePresence>
        </div>
      </ScrollArea>

      {/* 底部导航栏 */}
      <BottomNavigation />

      {/* 各页面的悬浮 Agent（首页本身即完整 Agent） */}
      <AgentDock />
      <ClassicPageContexts />
      {/* 外部 Agent（MCP）的工具调用在此窗口执行 */}
      <ExternalAgentHost />
      <PromptTemplateHost />

      {/* 全局 Toast */}
      {/* Below the title bar's top-right capsule; its panel pushes them further down while open. */}
      <Toaster position="top-right" offset={{ top: "calc(44px + var(--titlebar-panel-push, 0px))", right: 16 }} />

      {/* 自动更新检测 */}
      <Update autoCheck showTrigger={false} />

      {/* 首次启动的新手引导（设置中可重新打开） */}
      <WelcomeWizard />

      <LocalSubtitleOverwriteRecoveryPrompt />

    </div>
  );
}

export default App;
