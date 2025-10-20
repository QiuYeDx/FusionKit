import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useSpring, animated, useTrail } from "@react-spring/web";
import {
  Subtitles,
  FileText,
  Music,
  Sparkles,
  Zap,
  Shield,
  ArrowRight,
  Monitor,
  Cpu,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import FusionKitLogo from "@/assets/FusionKit.png";

function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [hoveredCard, setHoveredCard] = useState<number | null>(null);

  // 标题动画
  const titleSpring = useSpring({
    from: { opacity: 0, transform: "translateY(-30px)" },
    to: { opacity: 1, transform: "translateY(0px)" },
    config: { tension: 280, friction: 60 },
  });

  // Logo 动画
  const logoSpring = useSpring({
    from: { opacity: 0, transform: "scale(0.8) rotate(-10deg)" },
    to: { opacity: 1, transform: "scale(1) rotate(0deg)" },
    config: { tension: 280, friction: 60 },
    delay: 100,
  });

  // 描述文字动画
  const descSpring = useSpring({
    from: { opacity: 0 },
    to: { opacity: 1 },
    config: { duration: 800 },
    delay: 200,
  });

  // 工具特性数据
  const features = [
    {
      icon: Subtitles,
      title: t("home:subtitle_tool_title"),
      description: t("home:subtitle_tool_description"),
      gradient: "from-blue-500 to-cyan-500",
      lightGradient: "from-blue-50 to-cyan-50",
      action: () => navigate("/tools"),
    },
    {
      icon: FileText,
      title: t("home:rename_tool_title"),
      description: t("home:rename_tool_description"),
      gradient: "from-purple-500 to-pink-500",
      lightGradient: "from-purple-50 to-pink-50",
      action: () => navigate("/tools"),
    },
    {
      icon: Music,
      title: t("home:music_tool_title"),
      description: t("home:music_tool_description"),
      gradient: "from-orange-500 to-red-500",
      lightGradient: "from-orange-50 to-red-50",
      action: () => navigate("/tools"),
    },
  ];

  return (
    <div className="p-6 pb-20 overflow-visible relative">
      {/* 背景装饰 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 right-20 w-96 h-96 bg-gradient-to-br from-blue-400/10 to-purple-400/10 rounded-full blur-3xl" />
        <div className="absolute bottom-20 left-20 w-96 h-96 bg-gradient-to-br from-pink-400/10 to-orange-400/10 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10">
        {/* Hero 区域 */}
        <div className="text-center mb-16 mt-8">
          {/* Logo */}
          <animated.div style={logoSpring} className="flex justify-center mb-6">
            <div className="relative">
              <img
                src={FusionKitLogo}
                alt="FusionKit Logo"
                className="w-24 h-24 drop-shadow-2xl"
              />
              <div className="absolute inset-0 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-full blur-xl animate-pulse" />
            </div>
          </animated.div>

          {/* 标题 */}
          <animated.h1
            style={titleSpring}
            className="text-5xl md:text-6xl font-bold mb-6 bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 dark:from-blue-400 dark:via-purple-400 dark:to-pink-400 bg-clip-text text-transparent"
          >
            {t("home:welcome")}
          </animated.h1>

          {/* 描述 */}
          <animated.p
            style={descSpring}
            className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed"
          >
            {t("home:home_description")}
          </animated.p>

          {/* 装饰性闪光图标 */}
          <animated.div
            style={descSpring}
            className="flex justify-center gap-2 mt-6"
          >
            <Sparkles className="w-5 h-5 text-yellow-500 animate-pulse" />
            <Sparkles className="w-4 h-4 text-blue-500 animate-pulse delay-100" />
            <Sparkles className="w-5 h-5 text-purple-500 animate-pulse delay-200" />
          </animated.div>
        </div>

        {/* CTA 区域 */}
        <animated.div
          style={useSpring({
            from: { opacity: 0 },
            to: { opacity: 1 },
            delay: 900,
          })}
          className="text-center mt-16"
        >
          <div className="inline-flex gap-4">
            <Button
              size="lg"
              className="text-lg px-8 shadow-lg hover:shadow-xl transition-all duration-300 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
              onClick={() => navigate("/tools")}
            >
              <Cpu className="w-5 h-5 mr-2" />
              {t("home:get_started")}
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="text-lg px-8 shadow-lg hover:shadow-xl transition-all duration-300"
              onClick={() => navigate("/about")}
            >
              {t("home:learn_more")}
            </Button>
          </div>
        </animated.div>
      </div>
    </div>
  );
}

export default Home;
