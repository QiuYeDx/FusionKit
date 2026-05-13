import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings as SettingsIcon, Globe, Cpu, LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import GeneralConfig from "./components/GeneralConfig";
import ModelConfig from "./components/ModelConfig";
import ProxyConfig from "./components/ProxyConfig";

type TabKey = "general" | "proxy" | "model";

interface NavItem {
  key: TabKey;
  labelKey: string;
  hintKey: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { key: "general", labelKey: "setting:nav.general.label", hintKey: "setting:nav.general.hint", icon: SettingsIcon },
  { key: "proxy",   labelKey: "setting:nav.proxy.label",   hintKey: "setting:nav.proxy.hint",   icon: Globe },
  { key: "model",   labelKey: "setting:nav.model.label",   hintKey: "setting:nav.model.hint",   icon: Cpu },
];

const Setting: React.FC = () => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>("general");

  return (
    <div className="px-4 sm:px-8 pt-6 pb-[80px] max-w-5xl mx-auto">
      {/* Page header */}
      <div className="mb-5">
        <div className="text-2xl font-semibold tracking-tight">
          {t("setting:title")}
        </div>
        <div className="text-sm text-muted-foreground mt-1">
          {t("setting:description")}
        </div>
      </div>

      <div className="grid grid-cols-[200px_1fr] gap-5 items-start max-md:grid-cols-1">
        {/* SubNav rail */}
        <nav className="sticky top-2 flex flex-col gap-1 max-md:static max-md:flex-row max-md:overflow-x-auto">
          {NAV.map((item) => {
            const active = item.key === tab;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={cn(
                  "group flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors",
                  "max-md:shrink-0 max-md:min-w-[160px]",
                  active
                    ? "bg-accent border-foreground/15 text-foreground"
                    : "bg-transparent border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <Icon className="h-[15px] w-[15px] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium leading-tight">
                    {t(item.labelKey)}
                  </div>
                  <div
                    className={cn(
                      "text-[11px] mt-0.5 truncate",
                      active ? "text-foreground/60" : "text-muted-foreground/80"
                    )}
                  >
                    {t(item.hintKey)}
                  </div>
                </div>
              </button>
            );
          })}
        </nav>

        {/* Panel */}
        <div className="flex flex-col gap-4 min-w-0">
          {tab === "general" && <GeneralConfig />}
          {tab === "proxy" && <ProxyConfig />}
          {tab === "model" && <ModelConfig />}
        </div>
      </div>
    </div>
  );
};

export default Setting;
