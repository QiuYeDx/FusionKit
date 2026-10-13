import type { LucideIcon } from "lucide-react";
import {
  BookOpenText,
  Languages,
  RefreshCw,
  FileText,
  Edit,
  Captions,
  Clapperboard,
} from "lucide-react";
import { LOCAL_SUBTITLE_TRANSCRIBER_ROUTE } from "@/constants/router";

export type ToolKey =
  | "translationKnowledge"
  | "subtitleStudio"
  | "translator"
  | "converter"
  | "extractor"
  | "localSubtitleTranscriber"
  | "nameTranslator"
  | "textTranslator";

export type ToolMeta = {
  id: ToolKey;
  /** CSS variable name (without var()) — defined in index.css */
  toneVar: string;
  icon: LucideIcon;
  category: "subtitle" | "rename" | "text";
  status: "stable";
  route?: string;
};

export const TOOL_META: Record<ToolKey, ToolMeta> = {
  translationKnowledge: {
    id: "translationKnowledge",
    toneVar: "--tool-text",
    icon: BookOpenText,
    category: "subtitle",
    status: "stable",
    route: "/tools/translation-knowledge",
  },
  subtitleStudio: {
    id: "subtitleStudio",
    toneVar: "--tool-text",
    icon: Captions,
    category: "subtitle",
    status: "stable",
    route: "/tools/subtitle/studio",
  },
  translator: {
    id: "translator",
    toneVar: "--tool-translator",
    icon: Languages,
    category: "subtitle",
    status: "stable",
    route: "/tools/subtitle/translator",
  },
  converter: {
    id: "converter",
    toneVar: "--tool-converter",
    icon: RefreshCw,
    category: "subtitle",
    status: "stable",
    route: "/tools/subtitle/converter",
  },
  extractor: {
    id: "extractor",
    toneVar: "--tool-extractor",
    icon: FileText,
    category: "subtitle",
    status: "stable",
    route: "/tools/subtitle/extractor",
  },
  localSubtitleTranscriber: {
    id: "localSubtitleTranscriber",
    toneVar: "--tool-local-subtitle",
    icon: Clapperboard,
    category: "subtitle",
    status: "stable",
    route: LOCAL_SUBTITLE_TRANSCRIBER_ROUTE,
  },
  nameTranslator: {
    id: "nameTranslator",
    toneVar: "--tool-rename",
    icon: Edit,
    category: "rename",
    status: "stable",
    route: "/tools/rename/name-translator",
  },
  textTranslator: {
    id: "textTranslator",
    toneVar: "--tool-text",
    icon: BookOpenText,
    category: "text",
    status: "stable",
    route: "/tools/text/translator",
  },
};

export const toneCss = (meta: ToolMeta) => `var(${meta.toneVar})`;
