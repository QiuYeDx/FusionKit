import React, { useMemo } from "react";
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
import { ToolNameMap } from "@/constants/router";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import { ThemeTransitionToggle } from "@/components/qiuye-ui/theme-transition-toggle";
import { cn } from "@/lib/utils";

const BottomNavigation: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { isDark, setTheme } = useThemeStore();

  const currentToolName = useMemo(() => {
    return ToolNameMap[location.pathname] || "menu.tools";
  }, [location.pathname]);

  // 判断当前是否为主菜单
  const isMainMenu = ["/", "/about", "/setting", "/tools"].includes(
    location.pathname
  );

  const mainNavItems = [
    { path: "/", icon: Home, label: "menu.home" },
    { path: "/tools", icon: Wrench, label: "menu.tools" },
    { path: "/about", icon: Info, label: "menu.about" },
    { path: "/setting", icon: Settings, label: "menu.setting" },
  ];

  const springTransition = {
    type: "spring" as const,
    duration: 0.5,
    bounce: 0
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
            className="my-2 mx-2 flex gap-1 justify-center flex-nowrap pointer-events-auto backdrop-blur-md bg-card/80 border border-border rounded-full p-1 shadow-lg"
          >
            {mainNavItems.map(({ path, icon: Icon, label }) => (
              <Button
                key={path}
                variant="ghost"
                size="sm"
                onClick={() => navigate(path)}
                className={cn("gap-2 rounded-full relative hover:bg-transparent dark:hover:bg-transparent text-muted-foreground/70 hover:text-foreground transition-colors", location.pathname === path && "text-foreground")}
              >
                {location.pathname === path && (
                  <motion.div
                    layoutId="nav-highlight"
                    className="absolute inset-0 bg-secondary rounded-full"
                    transition={{
                      type: "spring", duration: 0.5, bounce: 0
                    }}
                  />
                )}
                <Icon className="size-5 relative z-1" />
                <span className="relative z-1">{t(label)}</span>
              </Button>
            ))}
          </motion.div>
        ) : (
          <motion.div
            key="sub-menu"
            initial={{ opacity: 0, y: 68 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 68 }}
            transition={springTransition}
            className="my-2 mx-2 flex gap-1 justify-center flex-nowrap pointer-events-auto backdrop-blur-md bg-card/80 border border-border rounded-full p-1 shadow-lg"
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/tools")}
              className="gap-2 rounded-full"
            >
              <RotateCcw className="size-5" />
              {t("menu.back")}
            </Button>
            <Button variant="secondary" size="sm" className="gap-2 rounded-full">
              <Wrench className="size-5" />
              {t(currentToolName)}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dark Mode 快捷切换 */}
      <div className="absolute right-6 pointer-events-auto">
        <ThemeTransitionToggle
          variant="outline"
          size="icon"
          isDark={isDark}
          onToggle={(nextDark) => setTheme(nextDark ? "dark" : "light")}
          buttonShape="circle"
          lightIcon={<Sun className="size-5" />}
          darkIcon={<Moon className="size-5" />}
          lightLabel="切换到深色主题"
          darkLabel="切换到浅色主题"
          shape="circle"
          className="h-9 w-9 rounded-full dark:bg-background dark:hover:bg-accent"
        />
      </div>
    </div>
  );
};

export default BottomNavigation;
