import React, { useEffect, useState, MouseEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Cog6ToothIcon,
  HomeIcon,
  InformationCircleIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import useThemeStore from "@/store/useThemeStore";
import useFadeMaskLayerStore from "@/store/useFadeMaskLayer";
import { useWindowSize } from "react-use";
import * as htmlToImage from "html-to-image";
import { toPng, toJpeg, toBlob, toPixelData, toSvg } from "html-to-image";

const BottomNavigation: React.FC = () => {
  const { width, height } = useWindowSize();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { isDark, setTheme } = useThemeStore();

  const {
    showMaskLayer,
    setVisible,
    setShowInner,
    setCenterXY,
    setRectSize,
    setShowMaskLayer,
    setBackgroundImage,
  } = useFadeMaskLayerStore();

  const handleToggleDarkMode = (e: MouseEvent<HTMLLabelElement>) => {
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

        const appElement = document.querySelector(".app");
        if (appElement) {
          appElement.scrollTo({
            top: 0,
          });
        }
        // * 在真正切换 theme 之前截图并显示过渡动效
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

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full flex justify-center items-center">
      {/* 底部导航栏 */}
      <ul className="bg-opacity-50 my-2 glass mx-2 menu bg-base-200 menu-horizontal rounded-box ring ring-base-100 gap-1 justify-center flex-nowrap">
        <li>
          <a
            className={location.pathname === "/" ? "active" : ""}
            onClick={() => navigate("/")}
          >
            <HomeIcon className="size-5" />
            {t("menu.home")}
          </a>
        </li>
        <li>
          <a
            className={location.pathname === "/tools" ? "active" : ""}
            onClick={() => navigate("/tools")}
          >
            <WrenchScrewdriverIcon className="size-5" />
            {t("menu.tools")}
          </a>
        </li>
        <li>
          <a
            className={location.pathname === "/about" ? "active" : ""}
            onClick={() => navigate("/about")}
          >
            <InformationCircleIcon className="size-5" />
            {t("menu.about")}
          </a>
        </li>
        <li>
          <a
            className={location.pathname === "/setting" ? "active" : ""}
            onClick={() => navigate("/setting")}
          >
            <Cog6ToothIcon className="size-5" />
            {t("menu.setting")}
          </a>
        </li>
      </ul>

      <div className="absolute right-6">
        <label
          className={`swap swap-rotate ${isDark ? "" : "swap-active"}`}
          onClick={handleToggleDarkMode}
        >
          {/* sun icon */}
          <svg
            className="swap-on h-6 w-6 fill-current"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
          >
            <path d="M5.64,17l-.71.71a1,1,0,0,0,0,1.41,1,1,0,0,0,1.41,0l.71-.71A1,1,0,0,0,5.64,17ZM5,12a1,1,0,0,0-1-1H3a1,1,0,0,0,0,2H4A1,1,0,0,0,5,12Zm7-7a1,1,0,0,0,1-1V3a1,1,0,0,0-2,0V4A1,1,0,0,0,12,5ZM5.64,7.05a1,1,0,0,0,.7.29,1,1,0,0,0,.71-.29,1,1,0,0,0,0-1.41l-.71-.71A1,1,0,0,0,4.93,6.34Zm12,.29a1,1,0,0,0,.7-.29l.71-.71a1,1,0,1,0-1.41-1.41L17,5.64a1,1,0,0,0,0,1.41A1,1,0,0,0,17.66,7.34ZM21,11H20a1,1,0,0,0,0,2h1a1,1,0,0,0,0-2Zm-9,8a1,1,0,0,0-1,1v1a1,1,0,0,0,2,0V20A1,1,0,0,0,12,19ZM18.36,17A1,1,0,0,0,17,18.36l.71.71a1,1,0,0,0,1.41,0,1,1,0,0,0,0-1.41ZM12,6.5A5.5,5.5,0,1,0,17.5,12,5.51,5.51,0,0,0,12,6.5Zm0,9A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z" />
          </svg>

          {/* moon icon */}
          <svg
            className="swap-off h-6 w-6 fill-current"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
          >
            <path d="M21.64,13a1,1,0,0,0-1.05-.14,8.05,8.05,0,0,1-3.37.73A8.15,8.15,0,0,1,9.08,5.49a8.59,8.59,0,0,1,.25-2A1,1,0,0,0,8,2.36,10.14,10.14,0,1,0,22,14.05,1,1,0,0,0,21.64,13Zm-9.5,6.69A8.14,8.14,0,0,1,7.08,5.22v.27A10.15,10.15,0,0,0,17.22,15.63a9.79,9.79,0,0,0,2.1-.22A8.11,8.11,0,0,1,12.14,19.73Z" />
          </svg>
        </label>
      </div>
    </div>
  );
};

export default BottomNavigation;
