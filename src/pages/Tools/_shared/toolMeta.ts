import type { LucideIcon } from "lucide-react";
import { Languages, RefreshCw, FileText, Music, Edit } from "lucide-react";

export type ToolKey =
  | "translator"
  | "converter"
  | "extractor"
  | "music"
  | "nameTranslator";

export type ToolMeta = {
  id: ToolKey;
  /** CSS variable name (without var()) — defined in index.css */
  toneVar: string;
  icon: LucideIcon;
  category: "subtitle" | "music" | "rename";
  status: "stable" | "soon";
  route?: string;
};

export const TOOL_META: Record<ToolKey, ToolMeta> = {
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
  music: {
    id: "music",
    toneVar: "--tool-music",
    icon: Music,
    category: "music",
    status: "soon",
  },
  nameTranslator: {
    id: "nameTranslator",
    toneVar: "--tool-rename",
    icon: Edit,
    category: "rename",
    status: "stable",
    route: "/tools/rename/name-translator",
  },
};

export const toneCss = (meta: ToolMeta) => `var(${meta.toneVar})`;
