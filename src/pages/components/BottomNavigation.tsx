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
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2">
      {/* 底部导航栏 */}
      <ul className="menu bg-base-200 menu-horizontal rounded-box ring ring-base-100 gap-1">
        <li>
          <a
            className={location.pathname === "/" ? "active" : ""}
            onClick={() => navigate("/")}
          >
            <HomeIcon className="size-5" />
            {t("home")}
          </a>
        </li>
        <li>
          <a
            className={location.pathname === "/tools" ? "active" : ""}
            onClick={() => navigate("/tools")}
          >
            <WrenchScrewdriverIcon className="size-5" />
            {t("tools")}
          </a>
        </li>
        <li>
          <a
            className={location.pathname === "/about" ? "active" : ""}
            onClick={() => navigate("/about")}
          >
            <InformationCircleIcon className="size-5" />
            {t("about")}
          </a>
        </li>
        <li>
          <a
            className={location.pathname === "/setting" ? "active" : ""}
            onClick={() => navigate("/setting")}
          >
            <Cog6ToothIcon className="size-5" />
            {t("setting")}
          </a>
        </li>
      </ul>
    </div>
  );
};

export default BottomNavigation;