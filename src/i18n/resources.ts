import type { Resource } from "i18next";
import { LangEnum } from "@/type/lang";

import enAbout from "@/locales/en/about.json";
import enCommon from "@/locales/en/common.json";
import enHome from "@/locales/en/home.json";
import enSetting from "@/locales/en/setting.json";
import enSubtitle from "@/locales/en/subtitle.json";
import enTools from "@/locales/en/tools.json";

import jaAbout from "@/locales/ja/about.json";
import jaCommon from "@/locales/ja/common.json";
import jaHome from "@/locales/ja/home.json";
import jaSetting from "@/locales/ja/setting.json";
import jaSubtitle from "@/locales/ja/subtitle.json";
import jaTools from "@/locales/ja/tools.json";

import zhAbout from "@/locales/zh/about.json";
import zhCommon from "@/locales/zh/common.json";
import zhHome from "@/locales/zh/home.json";
import zhSetting from "@/locales/zh/setting.json";
import zhSubtitle from "@/locales/zh/subtitle.json";
import zhTools from "@/locales/zh/tools.json";

export const resources: Resource = {
  [LangEnum.EN]: {
    common: enCommon,
    home: enHome,
    tools: enTools,
    about: enAbout,
    setting: enSetting,
    subtitle: enSubtitle,
  },
  [LangEnum.JA]: {
    common: jaCommon,
    home: jaHome,
    tools: jaTools,
    about: jaAbout,
    setting: jaSetting,
    subtitle: jaSubtitle,
  },
  [LangEnum.ZH]: {
    common: zhCommon,
    home: zhHome,
    tools: zhTools,
    about: zhAbout,
    setting: zhSetting,
    subtitle: zhSubtitle,
  },
};
