import React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowRight, BookOpenText, Sparkles } from "lucide-react";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { cn } from "@/lib/utils";
import ToolBadge from "./_shared/ToolBadge";
import { TOOL_META, type ToolKey, toneCss } from "./_shared/toolMeta";
import { FeaturedToolArtwork } from "./FeaturedToolArtwork";
import "./tools.css";

type CardItem = {
  id: ToolKey;
  titleKey: string;
  descKey: string;
  /** Localized short feature chips */
  chips?: string[];
  chipKeys?: string[];
};

const CLASSIC_TOOLS: CardItem[] = [
  {
    id: "translator",
    titleKey: "tools:fields.subtitle_translator",
    descKey: "tools:field_desc.subtitle_translator",
    chips: ["LRC · SRT", "DeepSeek · OpenAI"],
  },
  {
    id: "converter",
    titleKey: "tools:fields.subtitle_formatter",
    descKey: "tools:field_desc.subtitle_formatter",
    chips: ["SRT · VTT · LRC"],
  },
  {
    id: "extractor",
    titleKey: "tools:fields.subtitle_language_extractor",
    descKey: "tools:field_desc.subtitle_language_extractor",
    chips: ["LRC · SRT"],
  },
  {
    id: "localSubtitleTranscriber",
    titleKey: "tools:fields.local_subtitle_transcriber",
    descKey: "tools:field_desc.local_subtitle_transcriber",
    chipKeys: [
      "tools:chips.local_offline",
      "tools:chips.local_batch_formats",
    ],
  },
];

const EXPERIMENTAL_TOOLS: CardItem[] = [
  {
    id: "music",
    titleKey: "tools:coming_soon.title",
    descKey: "tools:coming_soon.music_desc",
  },
  {
    id: "nameTranslator",
    titleKey: "tools:fields.name_translator",
    descKey: "tools:field_desc.name_translator",
    chipKeys: [
      "tools:chips.name_translator_files",
      "tools:chips.name_translator_safe",
    ],
  },
  {
    id: "textTranslator",
    titleKey: "tools:fields.text_translator",
    descKey: "tools:field_desc.text_translator",
    chipKeys: [
      "tools:chips.text_translator_txt",
      "tools:chips.text_translator_markdown",
    ],
  },
  {
    id: "audioTranscriber",
    titleKey: "tools:fields.audio_transcriber",
    descKey: "tools:field_desc.audio_transcriber",
    chipKeys: [
      "tools:chips.audio_file",
      "tools:chips.openai_mimo",
    ],
  },
  {
    id: "speechSynthesizer",
    titleKey: "tools:fields.speech_synthesizer",
    descKey: "tools:field_desc.speech_synthesizer",
    chipKeys: [
      "tools:chips.tts_stream",
      "tools:chips.mimo_voice",
    ],
  },
  {
    id: "realtimeCaptions",
    titleKey: "tools:fields.realtime_captions",
    descKey: "tools:field_desc.realtime_captions",
    chipKeys: [
      "tools:chips.microphone",
      "tools:chips.realtime",
    ],
  },
  {
    id: "realtimeVoice",
    titleKey: "tools:fields.realtime_voice",
    descKey: "tools:field_desc.realtime_voice",
    chipKeys: [
      "tools:chips.webrtc",
      "tools:chips.duplex",
    ],
  },
];

const FEATURED_TOOLS = [
  {
    id: "subtitleStudio",
    kind: "studio",
    titleKey: "studio:title",
    descKey: "tools:field_desc.subtitle_studio",
    chipKeys: ["tools:chips.studio_transcription", "tools:chips.studio_translation", "tools:chips.studio_formats"],
    details: [
      ["tools:catalog.workflow_label", "tools:catalog.workflow_value"],
      ["tools:catalog.formats_label", "tools:catalog.formats_value"],
      ["tools:catalog.output_label", "tools:catalog.output_value"],
    ],
  },
  {
    id: "translationKnowledge",
    kind: "knowledge",
    titleKey: "knowledge:title",
    descKey: "tools:catalog.knowledge_description",
    chipKeys: ["tools:catalog.terms", "tools:catalog.references", "tools:catalog.background", "tools:catalog.file_sharing"],
    details: [
      ["tools:catalog.organize_label", "tools:catalog.organize_value"],
      ["tools:catalog.reuse_label", "tools:catalog.reuse_value"],
      ["tools:catalog.share_label", "tools:catalog.share_value"],
    ],
  },
] as const;

const Tools: React.FC = () => {
  const { t } = useTranslation();

  return (
    <main className="tools-catalog mx-auto max-w-7xl px-4 pb-[100px] pt-5 sm:px-8" data-testid="tools-catalog">
      <header className="mb-7 flex items-center justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight">{t("tools:title")}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("tools:catalog.intro")}</p>
        </div>
        <p aria-hidden="true" className="catalog-signature hidden shrink-0 text-right sm:block">Good tools.<br />Better creation.</p>
      </header>

      <section aria-label={t("tools:catalog.featured")} className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {FEATURED_TOOLS.map(item => (
          <SmoothCorners key={item.id} asChild radius={20} smoothing={0.72}>
            <Link
              to={TOOL_META[item.id].route!}
              data-tool-card={item.id}
              aria-labelledby={`tool-title-${item.id}`}
              className={`featured-tool featured-tool--${item.kind} group`}
            >
              <FeaturedToolArtwork kind={item.kind} />
              <div className="featured-tool-copy">
                <span className="featured-tool-eyebrow">{item.kind === "studio" ? <Sparkles /> : <BookOpenText />}{t("tools:catalog.featured")}</span>
                <div className="mt-4 flex items-center gap-3">
                  <h2 id={`tool-title-${item.id}`} className="min-w-0 text-[28px] font-semibold leading-tight tracking-tight">{t(item.titleKey)}</h2>
                  <span className="featured-tool-arrow"><ArrowRight aria-hidden="true" className="size-5" /></span>
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{t(item.descKey)}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {item.chipKeys.map(key => <span key={key} className="featured-tool-chip">{t(key)}</span>)}
                </div>
              </div>
              <dl className="featured-tool-details">
                {item.details.map(([label, value]) => <div key={label}>
                  <dt>{t(label)}</dt>
                  <dd>{t(value)}</dd>
                </div>)}
              </dl>
            </Link>
          </SmoothCorners>
        ))}
      </section>

      <section className="mt-8" aria-labelledby="classic-tools-title">
        <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 id="classic-tools-title" className="text-lg font-semibold">{t("tools:catalog.classic")}</h2>
          <p className="text-xs leading-5 text-muted-foreground">{t("tools:catalog.classic_description")}</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {CLASSIC_TOOLS.map(item => <ToolCard key={item.id} item={item} />)}
        </div>
      </section>

      <section className="mt-10 pt-6" aria-labelledby="experimental-tools-title" aria-describedby="experimental-tools-description">
        <div className="mb-4 space-y-2">
          <div className="flex items-center gap-2.5">
            <h2 id="experimental-tools-title" className="text-lg font-semibold">{t("tools:catalog.experimental")}</h2>
            <span className="rounded-md border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Beta</span>
          </div>
          <p id="experimental-tools-description" className="max-w-3xl text-xs leading-5 text-muted-foreground">{t("tools:catalog.experimental_description")}</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {EXPERIMENTAL_TOOLS.map(item => <ToolCard key={item.id} item={item} />)}
        </div>
      </section>
      <p aria-hidden="true" className="mt-8 font-mono text-[10px] tracking-wide text-muted-foreground/60">FusionKit · More tools, a more creative you.</p>
    </main>
  );
};

function ToolCard({ item }: { item: CardItem }) {
  const { t } = useTranslation();
  const meta = TOOL_META[item.id];
  const isSoon = meta.status === "soon";
  const tone = toneCss(meta);
  const title = item.id === "music" ? t("tools:subtitle.music_tools") : t(item.titleKey);
  const content = <>
    <ToolBadge icon={meta.icon} tone={tone} size={44} />
    <div className="min-w-0 flex-1">
      <div className="flex items-start justify-between gap-2">
        <h3 id={`tool-title-${item.id}`} className="text-sm font-semibold leading-6">{title}</h3>
        {!isSoon && <ArrowRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />}
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(item.descKey)}</p>
      {isSoon ? <span className="tool-coming-soon mt-3 inline-flex rounded-md border px-2 py-1 text-[11px] text-muted-foreground">{t("tools:coming_soon.title")}</span> :
        <div data-slot="tool-card-chips" className="mt-3 flex flex-wrap gap-1.5">
          {(item.chipKeys ?? item.chips ?? []).map(chip => <span key={chip} className="tool-chip">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
            {item.chipKeys ? t(chip) : chip}
          </span>)}
        </div>}
    </div>
  </>;
  const props = {
    "data-tool-card": item.id,
    className: cn("catalog-tool-card group flex items-start gap-4 border bg-card p-4", isSoon && "catalog-tool-card--soon"),
    style: { "--tool-tone": tone } as React.CSSProperties,
  };
  return <SmoothCorners asChild radius={16} smoothing={0.72}>
    {isSoon ? <div {...props}>{content}</div> : <Link {...props} to={meta.route!} aria-labelledby={`tool-title-${item.id}`}>{content}</Link>}
  </SmoothCorners>;
}

export default Tools;
