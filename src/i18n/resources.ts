import type { Resource } from "i18next";
import { LangEnum } from "@/type/lang";

import enAbout from "@/locales/en/about.json";
import enCommon from "@/locales/en/common.json";
import enHome from "@/locales/en/home.json";
import enSetting from "@/locales/en/setting.json";
import enSubtitle from "@/locales/en/subtitle.json";
import enTools from "@/locales/en/tools.json";
import enRename from "@/locales/en/rename.json";

import jaAbout from "@/locales/ja/about.json";
import jaCommon from "@/locales/ja/common.json";
import jaHome from "@/locales/ja/home.json";
import jaSetting from "@/locales/ja/setting.json";
import jaSubtitle from "@/locales/ja/subtitle.json";
import jaTools from "@/locales/ja/tools.json";
import jaRename from "@/locales/ja/rename.json";

import zhAbout from "@/locales/zh/about.json";
import zhCommon from "@/locales/zh/common.json";
import zhHome from "@/locales/zh/home.json";
import zhSetting from "@/locales/zh/setting.json";
import zhSubtitle from "@/locales/zh/subtitle.json";
import zhTools from "@/locales/zh/tools.json";
import zhRename from "@/locales/zh/rename.json";

import zhHantAbout from "@/locales/zh-Hant/about.json";
import zhHantCommon from "@/locales/zh-Hant/common.json";
import zhHantHome from "@/locales/zh-Hant/home.json";
import zhHantSetting from "@/locales/zh-Hant/setting.json";
import zhHantSubtitle from "@/locales/zh-Hant/subtitle.json";
import zhHantTools from "@/locales/zh-Hant/tools.json";
import zhHantRename from "@/locales/zh-Hant/rename.json";

export const resources: Resource = {
  [LangEnum.EN]: {
    common: enCommon,
    home: enHome,
    tools: enTools,
    about: enAbout,
    setting: enSetting,
    subtitle: enSubtitle,
    rename: enRename,
  },
  [LangEnum.JA]: {
    common: jaCommon,
    home: jaHome,
    tools: jaTools,
    about: jaAbout,
    setting: jaSetting,
    subtitle: jaSubtitle,
    rename: jaRename,
  },
  [LangEnum.ZH]: {
    common: zhCommon,
    home: zhHome,
    tools: zhTools,
    about: zhAbout,
    setting: zhSetting,
    subtitle: zhSubtitle,
    rename: zhRename,
  },
  [LangEnum.ZH_HANT]: {
    common: zhHantCommon,
    home: zhHantHome,
    tools: zhHantTools,
    about: zhHantAbout,
    setting: zhHantSetting,
    subtitle: zhHantSubtitle,
    rename: zhHantRename,
  },
};
