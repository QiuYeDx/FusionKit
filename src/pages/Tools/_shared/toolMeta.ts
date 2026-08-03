import type { LucideIcon } from "lucide-react";
import {
  BookOpenText,
  Languages,
  RefreshCw,
  FileText,
  Music,
  Edit,
  FileAudio,
  Volume2,
  Captions,
  Radio,
  Clapperboard,
} from "lucide-react";
import { LOCAL_SUBTITLE_TRANSCRIBER_ROUTE } from "@/constants/router";

export type ToolKey =
  | "translator"
  | "converter"
  | "extractor"
  | "localSubtitleTranscriber"
  | "music"
  | "nameTranslator"
  | "textTranslator"
  | "audioTranscriber"
  | "speechSynthesizer"
  | "realtimeCaptions"
  | "realtimeVoice";

export type ToolMeta = {
  id: ToolKey;
  /** CSS variable name (without var()) — defined in index.css */
  toneVar: string;
  icon: LucideIcon;
  category: "subtitle" | "music" | "rename" | "text" | "audio";
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
  localSubtitleTranscriber: {
    id: "localSubtitleTranscriber",
    toneVar: "--tool-local-subtitle",
    icon: Clapperboard,
    category: "subtitle",
    status: "stable",
    route: LOCAL_SUBTITLE_TRANSCRIBER_ROUTE,
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
  textTranslator: {
    id: "textTranslator",
    toneVar: "--tool-text",
    icon: BookOpenText,
    category: "text",
    status: "stable",
    route: "/tools/text/translator",
  },
  audioTranscriber: {
    id: "audioTranscriber",
    toneVar: "--tool-audio-transcriber",
    icon: FileAudio,
    category: "audio",
    status: "stable",
    route: "/tools/audio/transcriber",
  },
  speechSynthesizer: {
    id: "speechSynthesizer",
    toneVar: "--tool-speech-synthesizer",
    icon: Volume2,
    category: "audio",
    status: "stable",
    route: "/tools/audio/speech-synthesis",
  },
  realtimeCaptions: {
    id: "realtimeCaptions",
    toneVar: "--tool-realtime-captions",
    icon: Captions,
    category: "audio",
    status: "stable",
    route: "/tools/audio/realtime-captions",
  },
  realtimeVoice: {
    id: "realtimeVoice",
    toneVar: "--tool-realtime-voice",
    icon: Radio,
    category: "audio",
    status: "stable",
    route: "/tools/audio/realtime-voice",
  },
};

export const toneCss = (meta: ToolMeta) => `var(${meta.toneVar})`;
