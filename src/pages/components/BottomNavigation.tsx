import React from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Cog6ToothIcon,
  HomeIcon,
  InformationCircleIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";

const BottomNavigation: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full flex justify-center">
      {/* 底部导航栏 */}
      <ul className="bg-opacity-50 glass mx-2 menu bg-base-200 menu-horizontal rounded-box ring ring-base-100 gap-1 justify-center">
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
    </div>
  );
};

export default BottomNavigation;