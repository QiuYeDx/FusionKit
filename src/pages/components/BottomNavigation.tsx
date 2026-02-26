import React, { useEffect, useState, MouseEvent, useMemo, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Home,
  Wrench,
  Info,
  Settings,
  RotateCcw,
  Moon,
  Sun,
} from "lucide-react";
import useThemeStore from "@/store/useThemeStore";
import useFadeMaskLayerStore from "@/store/useFadeMaskLayer";
import { useWindowSize } from "@reactuses/core";
import * as htmlToImage from "html-to-image";
import { toPng, toJpeg, toBlob, toPixelData, toSvg } from "html-to-image";
import { ToolNameMap } from "@/constants/router";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const BottomNavigation: React.FC = () => {
  const { width, height } = useWindowSize();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { isDark, setTheme } = useThemeStore();

  const currentToolName = useMemo(() => {
    return ToolNameMap[location.pathname] || "-";
  }, [location.pathname]);

  const {
    showMaskLayer,
    setVisible,
    setShowInner,
    setCenterXY,
    setRectSize,
    setShowMaskLayer,
    setBackgroundImage,
  } = useFadeMaskLayerStore();

  const handleToggleDarkMode = (e: MouseEvent<HTMLButtonElement>) => {
    // 截取当前内容
    const node = document.getElementById("root");

    htmlToImage
      .toPng(node as any, {
        filter: (el: any) => {
          if (!el) return false;
          if (el.classList && el.classList.contains("fade-mask-layer"))
            return false;
          return true;
        },
      })
      .then((dataUrl: any) => {
        // 获取到图片的 Base64 数据
        setBackgroundImage(dataUrl);

        // * 执行后续步骤
        if (isDark) {
          setShowInner(true);
          setShowMaskLayer(true);
        } else {
          setShowInner(false);
        }
        setVisible(true);
        setRectSize(width, height);
        setCenterXY(e.clientX, e.clientY);
        setShowMaskLayer(!showMaskLayer);

        // * 在真正切换 theme 之前截图并显示过渡动效
        // 注意：页面滚动重置逻辑已移至 FadeMaskLayer 组件中统一处理
        if (isDark) {
          setTheme("light");
        } else {
          setTheme("dark");
        }
      })
      .catch((error: any) => {
        console.error("Error generating image:", error);
      });
  };

  // 判断当前是否为主菜单
  const isMainMenu = ["/", "/about", "/setting", "/tools"].includes(
    location.pathname
  );

  const springTransition = {
    type: "spring" as const,
    stiffness: 200,
    damping: 15,
  };

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full flex justify-center items-center pointer-events-none z-40">
      {/* 底部导航栏 */}
      <AnimatePresence mode="popLayout">
        {isMainMenu ? (
          <motion.div
            key="main-menu"
            initial={{ opacity: 0, y: 68 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 68 }}
            transition={springTransition}
            className="my-2 mx-2 flex gap-1 justify-center flex-nowrap pointer-events-auto backdrop-blur-md bg-card/80 border border-border rounded-lg p-1 shadow-lg"
          >
            <Button
              variant={location.pathname === "/" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => navigate("/")}
              className="gap-2"
            >
              <Home className="size-5" />
              {t("menu.home")}
            </Button>
            <Button
              variant={location.pathname === "/tools" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => navigate("/tools")}
              className="gap-2"
            >
              <Wrench className="size-5" />
              {t("menu.tools")}
            </Button>
            <Button
              variant={location.pathname === "/about" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => navigate("/about")}
              className="gap-2"
            >
              <Info className="size-5" />
              {t("menu.about")}
            </Button>
            <Button
              variant={location.pathname === "/setting" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => navigate("/setting")}
              className="gap-2"
            >
              <Settings className="size-5" />
              {t("menu.setting")}
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="sub-menu"
            initial={{ opacity: 0, y: 68 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 68 }}
            transition={springTransition}
            className="my-2 mx-2 flex gap-1 justify-center flex-nowrap pointer-events-auto backdrop-blur-md bg-card/80 border border-border rounded-lg p-1 shadow-lg"
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/tools")}
              className="gap-2"
            >
              <RotateCcw className="size-5" />
              {t("menu.back")}
            </Button>
            <Button variant="secondary" size="sm" className="gap-2">
              <Wrench className="size-5" />
              {t(currentToolName)}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dark Mode 快捷切换 */}
      <div className="absolute right-6 pointer-events-auto">
        <Button
          variant="outline"
          size="icon"
          onClick={handleToggleDarkMode}
          className="h-9 w-9 rounded-full"
        >
          {isDark ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
          <span className="sr-only">切换主题</span>
        </Button>
      </div>
    </div>
  );
};

export default BottomNavigation;
