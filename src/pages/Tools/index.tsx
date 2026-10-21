import React from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { BookOpenText, Sparkles } from "lucide-react";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { TemplateMenuButton } from "@/pages/HomeAgent/components/PromptTemplates";
import { TOOL_META } from "./_shared/toolMeta";
import { FeaturedToolCard, type FeaturedKind } from "./FeaturedToolCard";
import { ToolTile, type ToolTileItem } from "./ToolTile";
import "./tools.css";

/**
 * The two AI tools come first, as wide tiles; the three single-purpose tools follow. On a wide window the
 * five fill two rows exactly (2 + 3), on a medium one the first spans the row and the rest pair up.
 */
const CLASSIC_TOOLS: (ToolTileItem & { span: string })[] = [
  { id: "translator", titleKey: "tools:fields.subtitle_translator", descKey: "tools:field_desc.subtitle_translator",
    chips: ["LRC · SRT", "DeepSeek · OpenAI"], templateId: "translate_subtitles", span: "sm:col-span-2 lg:col-span-3" },
  { id: "localSubtitleTranscriber", titleKey: "tools:fields.local_subtitle_transcriber", descKey: "tools:field_desc.local_subtitle_transcriber",
    chips: ["tools:chips.local_offline", "tools:chips.local_batch_formats"], translateChips: true, templateId: "media_bilingual", span: "lg:col-span-3" },
  { id: "converter", titleKey: "tools:fields.subtitle_formatter", descKey: "tools:field_desc.subtitle_formatter",
    chips: ["SRT · VTT · LRC", "ASS · SSA · SBV"], templateId: "convert_subtitles", span: "lg:col-span-2" },
  { id: "extractor", titleKey: "tools:fields.subtitle_language_extractor", descKey: "tools:field_desc.subtitle_language_extractor",
    chips: ["SRT · VTT · LRC", "ASS · SSA · SBV"], templateId: "extract_language", span: "lg:col-span-2" },
  { id: "nameTranslator", titleKey: "tools:fields.name_translator", descKey: "tools:field_desc.name_translator",
    chips: ["tools:chips.name_translator_files", "tools:chips.name_translator_safe"], translateChips: true, templateId: "bilingual_names", span: "lg:col-span-2" },
];

const EXPERIMENTAL_TOOLS: ToolTileItem[] = [
  { id: "textTranslator", titleKey: "tools:fields.text_translator", descKey: "tools:field_desc.text_translator",
    chips: ["tools:chips.text_translator_txt", "tools:chips.text_translator_markdown"], translateChips: true },
];

type FeaturedItem = { id: "subtitleStudio" | "translationKnowledge"; kind: FeaturedKind; titleKey: string; descKey: string; chipKeys: string[]; details: [string, string][]; ctaKey: string };

const FEATURED_TOOLS = [
  {
    id: "subtitleStudio", kind: "studio", titleKey: "studio:title", descKey: "tools:field_desc.subtitle_studio",
    chipKeys: ["tools:chips.studio_transcription", "tools:chips.studio_translation", "tools:chips.studio_formats"],
    details: [["tools:catalog.workflow_label", "tools:catalog.workflow_value"], ["tools:catalog.formats_label", "tools:catalog.formats_value"], ["tools:catalog.output_label", "tools:catalog.output_value"]],
    ctaKey: "tools:catalog.open_studio",
  },
  {
    id: "translationKnowledge", kind: "knowledge", titleKey: "knowledge:title", descKey: "tools:catalog.knowledge_description",
    chipKeys: ["tools:catalog.terms", "tools:catalog.requirements", "tools:catalog.background", "tools:catalog.file_sharing"],
    details: [["tools:catalog.organize_label", "tools:catalog.organize_value"], ["tools:catalog.reuse_label", "tools:catalog.reuse_value"], ["tools:catalog.share_label", "tools:catalog.share_value"]],
    ctaKey: "tools:catalog.open_knowledge",
  },
] satisfies FeaturedItem[];

function SectionHeading({ id, testId, title, count, description, badge }: {
  id: string; testId: string; title: string; count: number; description: string; badge?: string;
}) {
  return <div className="tools-section-heading">
    <div className="flex items-center gap-2.5">
      <h2 id={id} data-testid={testId} className="text-[17px] font-semibold tracking-tight">{title}</h2>
      <span className="tools-count" aria-hidden>{String(count).padStart(2, "0")}</span>
      {badge && <span className="tools-beta">{badge}</span>}
    </div>
    <p id={`${id}-description`} className="max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p>
  </div>;
}

const Tools: React.FC = () => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  return (
    <main className="tools-catalog mx-auto max-w-7xl px-4 pb-[104px] pt-5 sm:px-8" data-testid="tools-catalog">
      <motion.header className="tools-header" initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }}>
        <div className="min-w-0">
          <p className="tools-eyebrow">FusionKit · {t("tools:catalog.toolbox", { count: CLASSIC_TOOLS.length + EXPERIMENTAL_TOOLS.length + FEATURED_TOOLS.length })}</p>
          <h1 className="mt-2 text-[32px] font-semibold leading-tight tracking-tight">{t("tools:title")}</h1>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{t("tools:catalog.intro")}</p>
        </div>
        <div className="tools-header-agent">
          <p className="text-xs leading-5 text-muted-foreground">{t("tools:catalog.agent_hint")}</p>
          <TemplateMenuButton side="bottom" align="end" className="tools-template-button" />
        </div>
      </motion.header>

      <section data-testid="tools-featured-grid" aria-label={t("tools:catalog.featured")} className="tools-featured-grid">
        {FEATURED_TOOLS.map((item, index) => <FeaturedToolCard key={item.id} id={item.id} kind={item.kind} index={index} to={TOOL_META[item.id].route!}
          eyebrowIcon={item.kind === "studio" ? <Sparkles aria-hidden /> : <BookOpenText aria-hidden />}
          title={t(item.titleKey)} description={t(item.descKey)} chips={item.chipKeys.map((key) => t(key))}
          details={item.details.map(([label, value]) => [t(label), t(value)])} cta={t(item.ctaKey)} />)}
      </section>

      <section className="mt-10" aria-labelledby="classic-tools-title" aria-describedby="classic-tools-title-description">
        <SectionHeading id="classic-tools-title" testId="tools-classic-heading" title={t("tools:catalog.classic")} count={CLASSIC_TOOLS.length}
          description={t("tools:catalog.classic_description")} />
        <div data-testid="tools-classic-grid" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {CLASSIC_TOOLS.map((item, index) => <ToolTile key={item.id} item={item} index={index} className={item.span} />)}
        </div>
      </section>

      <section className="mt-10" aria-labelledby="experimental-tools-title" aria-describedby="experimental-tools-title-description">
        <SectionHeading id="experimental-tools-title" testId="tools-experimental-heading" title={t("tools:catalog.experimental")} count={EXPERIMENTAL_TOOLS.length}
          description={t("tools:catalog.experimental_description")} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {EXPERIMENTAL_TOOLS.map((item, index) => <ToolTile key={item.id} item={item} index={CLASSIC_TOOLS.length + index} className="lg:col-span-3" beta />)}
        </div>
      </section>
    </main>
  );
};

export default Tools;
