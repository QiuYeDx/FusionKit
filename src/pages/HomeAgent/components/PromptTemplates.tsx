import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { create } from "zustand";
import { AnimatePresence, motion } from "motion/react";
import {
  AudioLines, Bot, ChevronRight, Copy, FileStack, FolderOpen, History, Languages, LayoutTemplate, Replace, Send, SquareSplitVertical, TextCursorInput,
} from "lucide-react";
import {
  findPromptTemplate, isFieldShown, missingTemplateFields, PROMPT_TEMPLATES, readTemplateValues, writeTemplateValues,
  type PromptTemplate, type TemplateField, type TemplateIcon, type TemplateTarget, type TemplateValues,
} from "@/agent/prompt-templates";
import { submitUserMessage } from "@/agent/orchestrator";
import { fillSessionDraft } from "@/agent/session-drafts";
import { isAgentProfileApiFormatSupported } from "@/agent/api-format-capability";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import { settingPath } from "@/pages/Setting/settingNavigation";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { getFilePathFromFile } from "@/utils/filePath";
import { showToast } from "@/utils/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import {
  DialogDescription, DialogTitle, ScrollableDialog, ScrollableDialogContent, ScrollableDialogFooter, ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Workflow templates in the interface: the gallery on the home page, the menu by
// the composers, and the one dialog that fills a template in and hands the prompt
// to FusionKit's agent or, copied, to an external agent.
// ---------------------------------------------------------------------------

const ICONS: Record<TemplateIcon, typeof AudioLines> = {
  media: AudioLines, convert: Replace, names: TextCursorInput, translate: Languages, extract: SquareSplitVertical, resume: History,
};

export function TemplateGlyph({ icon, className }: { icon: TemplateIcon; className?: string }) {
  const Icon = ICONS[icon] ?? FileStack;
  return <Icon aria-hidden className={className} />;
}

/** Which template the dialog shows; one dialog serves every place that offers templates. */
const useTemplateDialog = create<{ templateId: string | null; target: TemplateTarget; open: (id: string, target?: TemplateTarget) => void; close: () => void }>((set) => ({
  templateId: null,
  target: "fusionkit",
  open: (templateId, target = "fusionkit") => set({ templateId, target }),
  close: () => set({ templateId: null }),
}));

export const openPromptTemplate = (id: string, target?: TemplateTarget) => useTemplateDialog.getState().open(id, target);

function useAgentReady(): boolean {
  const profile = useModelStore((state) => state.getAgentProfile());
  return !!profile?.apiKey?.trim() && isAgentProfileApiFormatSupported(profile);
}

/** A template as a card: what the job is, in a line or two. */
function TemplateCard({ template, onPick, index }: { template: PromptTemplate; onPick: () => void; index: number }) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  return <motion.li initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.36, delay: reduceMotion ? 0 : 0.04 * index, ease: [0.23, 1, 0.32, 1] }} className="min-w-0">
    <SmoothCorners asChild radius={16} smoothing={0.72}>
      <button type="button" onClick={onPick} data-testid="agent-template-card" data-template={template.id}
        className="group/template flex h-full w-full min-w-0 items-start gap-2.5 border bg-background p-3 text-left outline-none transition-[background-color,border-color] duration-200 hover:border-border hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring/50 border-border/60">
        <SmoothCorners radius={9} smoothing={0.72} className="flex size-7 shrink-0 items-center justify-center bg-muted text-foreground/70 transition-colors group-hover/template:bg-background group-hover/template:text-foreground">
          <TemplateGlyph icon={template.icon} className="size-3.5" />
        </SmoothCorners>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-5 font-medium">{t(`home:templates.${template.id}.title`)}</span>
          <span className="line-clamp-2 text-xs leading-[18px] text-muted-foreground">{t(`home:templates.${template.id}.summary`)}</span>
        </span>
      </button>
    </SmoothCorners>
  </motion.li>;
}

/** The home page's workflows, under the composer of an empty conversation. */
export function TemplateGallery({ className }: { className?: string }) {
  const { t } = useTranslation();
  return <section className={cn("w-full max-w-2xl", className)} aria-labelledby="agent-templates-heading" data-testid="agent-template-gallery">
    <div className="mb-2 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
      <LayoutTemplate aria-hidden className="size-3.5" />
      <h2 id="agent-templates-heading" className="font-medium">{t("home:templates.gallery_title")}</h2>
      <span className="text-muted-foreground/70">· {t("home:templates.gallery_hint")}</span>
    </div>
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {PROMPT_TEMPLATES.map((template, index) => <TemplateCard key={template.id} template={template} index={index} onPick={() => openPromptTemplate(template.id)} />)}
    </ul>
  </section>;
}

/** A compact row, for the menu and the floating panel's empty state. */
export function TemplateRow({ template, onPick, testId = "agent-template-row" }: { template: PromptTemplate; onPick: () => void; testId?: string }) {
  const { t } = useTranslation();
  return <SmoothCorners asChild radius={12} smoothing={0.72}>
    <button type="button" onClick={onPick} data-testid={testId} data-template={template.id}
      className="group/row flex w-full min-w-0 items-center gap-2.5 px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted/70">
      <SmoothCorners radius={8} smoothing={0.72} className="flex size-6 shrink-0 items-center justify-center bg-muted text-foreground/70 group-hover/row:bg-background">
        <TemplateGlyph icon={template.icon} className="size-3.5" />
      </SmoothCorners>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-5">{t(`home:templates.${template.id}.title`)}</span>
        <span className="block truncate text-[11.5px] leading-4 text-muted-foreground">{t(`home:templates.${template.id}.summary`)}</span>
      </span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover/row:text-muted-foreground" />
    </button>
  </SmoothCorners>;
}

/** The templates button by a composer: every workflow in a short list. */
export function TemplateMenuButton({ className, side = "top", align = "end", compact }: {
  className?: string; side?: "top" | "bottom"; align?: "start" | "end"; compact?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="sm" data-testid="agent-templates-trigger" aria-label={t("home:templates.menu_label")} title={t("home:templates.menu_label")}
        className={cn("h-7 gap-1 rounded-full px-2 text-xs text-muted-foreground/80 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground", className)}>
        <LayoutTemplate className="size-3.5" />{!compact && t("home:templates.menu_short")}
      </Button>
    </PopoverTrigger>
    <PopoverContent side={side} align={align} sideOffset={8} className="w-80 p-1.5" data-testid="agent-templates-menu">
      <div className="px-2 pt-1 pb-1.5 text-[11.5px] font-medium text-muted-foreground">{t("home:templates.gallery_title")}</div>
      <div className="flex flex-col">
        {PROMPT_TEMPLATES.map((template) => <TemplateRow key={template.id} template={template} onPick={() => { setOpen(false); openPromptTemplate(template.id); }} />)}
      </div>
    </PopoverContent>
  </Popover>;
}

function FolderField({ field, value, onChange, invalid }: { field: TemplateField; value: string; onChange: (value: string) => void; invalid: boolean }) {
  const { t } = useTranslation();
  const [dragOver, setDragOver] = useState(false);
  const pick = async () => {
    try {
      const result = await window.ipcRenderer.invoke("select-output-directory", { title: t("home:templates.pick_folder_title"), buttonLabel: t("home:templates.pick_folder_button") }) as { canceled?: boolean; filePaths?: string[] };
      if (!result?.canceled && result?.filePaths?.[0]) onChange(result.filePaths[0]);
    } catch { /* the user can still type the path */ }
  };
  return <div className="flex gap-1.5"
    onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragOver(true); } }}
    onDragLeave={() => setDragOver(false)}
    onDrop={(event) => {
      event.preventDefault(); setDragOver(false);
      const path = event.dataTransfer.files[0] && getFilePathFromFile(event.dataTransfer.files[0]);
      if (path) onChange(path);
    }}>
    <Input id={`template-${field.key}`} value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false}
      placeholder={t("home:templates.field.folder_placeholder")} aria-invalid={invalid || undefined} data-testid="agent-template-path"
      className={cn("h-9 min-w-0 flex-1 font-mono text-[12.5px] md:text-[12.5px]", dragOver && "border-primary/50 bg-primary/5")} />
    <Button type="button" variant="outline" className="h-9 shrink-0 gap-1.5 px-3 text-[13px]" onClick={() => void pick()} data-testid="agent-template-pick">
      <FolderOpen className="size-3.5" />{t("home:templates.pick_folder")}
    </Button>
  </div>;
}

function FieldControl({ field, values, setValue, showMissing }: {
  field: TemplateField; values: TemplateValues; setValue: (key: string, value: string | boolean) => void; showMissing: boolean;
}) {
  const { t } = useTranslation();
  const value = values[field.key];
  if (field.kind === "toggle") {
    return <label htmlFor={`template-${field.key}`} className="flex cursor-pointer items-start justify-between gap-4 py-1">
      <span className="min-w-0">
        <span className="block text-[13px] leading-5">{t(field.labelKey)}</span>
        {field.hintKey && <span className="block text-xs leading-[18px] text-muted-foreground">{t(field.hintKey)}</span>}
      </span>
      <Switch id={`template-${field.key}`} checked={!!value} onCheckedChange={(checked) => setValue(field.key, checked)} className="mt-0.5" data-testid={`agent-template-${field.key}`} />
    </label>;
  }
  return <div className="flex min-w-0 flex-col gap-1.5">
    <label htmlFor={`template-${field.key}`} className="text-xs font-medium text-muted-foreground">{t(field.labelKey)}</label>
    {field.kind === "folder"
      ? <FolderField field={field} value={String(value ?? "")} onChange={(next) => setValue(field.key, next)} invalid={showMissing && !String(value ?? "").trim()} />
      : <Select value={String(value)} onValueChange={(next) => setValue(field.key, next)}>
        <SelectTrigger id={`template-${field.key}`} className="h-9 w-full min-w-0 text-[13px]" data-testid={`agent-template-${field.key}`}><SelectValue /></SelectTrigger>
        <SelectContent>
          {field.options?.map((option) => <SelectItem key={option.value} value={option.value}>{t(option.labelKey)}</SelectItem>)}
        </SelectContent>
      </Select>}
    {field.kind === "folder" && field.hintKey && <p className="text-xs leading-[18px] text-muted-foreground">{t(field.hintKey)}</p>}
  </div>;
}

/** FusionKit's agent or an external one: the same job, two prompts. */
function TargetSwitch({ value, onChange, targets }: { value: TemplateTarget; onChange: (target: TemplateTarget) => void; targets: readonly TemplateTarget[] }) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  return <div role="radiogroup" aria-label={t("home:templates.target_label")} className="grid grid-cols-2 rounded-full bg-muted p-0.5" data-testid="agent-template-target">
    {(["fusionkit", "external"] as const).map((target) => {
      const disabled = !targets.includes(target);
      const selected = value === target;
      return <button key={target} type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={() => onChange(target)}
        data-value={target}
        className={cn("relative flex h-7 items-center justify-center gap-1.5 rounded-full px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40",
          selected ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
        {selected && <motion.span layoutId="template-target-pill" className="absolute inset-0 rounded-full bg-background shadow-sm ring-1 ring-foreground/5"
          transition={reduceMotion ? { duration: 0 } : { type: "spring", duration: 0.32, bounce: 0 }} />}
        <span className="relative flex items-center gap-1.5">
          {target === "fusionkit" ? <LayoutTemplate className="size-3.5" /> : <Bot className="size-3.5" />}
          {t(`home:templates.target_${target}`)}
        </span>
      </button>;
    })}
  </div>;
}

/**
 * Fills a template in. The prompt below the form is exactly what will be sent; the agent then asks only
 * what the form did not settle. Values are remembered per template, so a repeated job is the folder and a click.
 */
export function PromptTemplateHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { templateId, target: requestedTarget, close } = useTemplateDialog();
  const template = templateId ? findPromptTemplate(templateId) : undefined;
  // Kept while the dialog closes, so its content does not vanish during the exit animation.
  const [shown, setShown] = useState<PromptTemplate | undefined>(template);
  const [values, setValues] = useState<TemplateValues>({});
  const [target, setTarget] = useState<TemplateTarget>("fusionkit");
  const [showMissing, setShowMissing] = useState(false);
  const ready = useAgentReady();
  const busy = useAgentStore((state) => state.isStreaming);
  useEffect(() => {
    if (!template) return;
    setShown(template);
    setValues(readTemplateValues(template));
    setTarget(template.targets.includes(requestedTarget) ? requestedTarget : template.targets[0]);
    setShowMissing(false);
  }, [template, requestedTarget]);

  const current = template ?? shown;
  const prompt = useMemo(() => current ? current.build(values, target, t) : "", [current, values, target, t]);
  const missing = current ? missingTemplateFields(current, values) : [];
  if (!current) return null;

  const setValue = (key: string, value: string | boolean) => setValues((previous) => ({ ...previous, [key]: value }));
  const guard = () => {
    if (missing.length) { setShowMissing(true); document.getElementById(`template-${missing[0]}`)?.focus(); return false; }
    writeTemplateValues(current, values);
    return true;
  };
  const copy = async () => {
    if (!guard()) return;
    try {
      await navigator.clipboard.writeText(prompt);
      showToast(t("home:templates.copied"), "success");
      if (target === "external") close();
    } catch { showToast(t("home:templates.copy_failed"), "error"); }
  };
  const fill = () => {
    if (!guard()) return;
    fillSessionDraft(useAgentStore.getState().activeSessionId, prompt);
    close();
  };
  const send = () => {
    if (!guard() || !ready) return;
    submitUserMessage(prompt);
    close();
  };

  const fields = current.fields.filter((field) => isFieldShown(field, values));
  const external = target === "external";
  return <ScrollableDialog open={!!template} onOpenChange={(next) => { if (!next) close(); }} maxWidth="sm:max-w-xl">
    <ScrollableDialogHeader className="pb-3">
      <div className="flex items-start gap-3 pr-8" data-testid="agent-template-dialog" data-template={current.id}>
        <SmoothCorners radius={11} smoothing={0.72} className="flex size-9 shrink-0 items-center justify-center bg-muted text-foreground/75">
          <TemplateGlyph icon={current.icon} className="size-4" />
        </SmoothCorners>
        <div className="min-w-0 flex-1 space-y-1">
          <DialogTitle className="text-[15px] leading-6">{t(`home:templates.${current.id}.title`)}</DialogTitle>
          <DialogDescription className="text-xs leading-[18px]">{t(`home:templates.${current.id}.description`)}</DialogDescription>
        </div>
      </div>
      <div className="pt-2"><TargetSwitch value={target} onChange={setTarget} targets={current.targets} /></div>
    </ScrollableDialogHeader>
    <ScrollableDialogContent fadeMasks fadeMaskHeight={24}>
      <div className="flex flex-col gap-4">
        <AnimatePresence initial={false} mode="popLayout">
          {external && <motion.p key="external-note" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            className="rounded-smooth-lg bg-muted/60 px-3 py-2 text-xs leading-[18px] text-muted-foreground" data-testid="agent-template-external-note">
            {t("home:templates.external_note")}{" "}
            <button type="button" className="text-foreground/85 underline-offset-2 hover:underline" onClick={() => { close(); navigate(settingPath("external")); }}>
              {t("home:templates.external_setup")}
            </button>
          </motion.p>}
        </AnimatePresence>
        <div className="grid grid-cols-1 gap-x-3 gap-y-3.5 sm:grid-cols-2">
          {fields.map((field) => <div key={field.key} className={cn(field.kind !== "select" && "sm:col-span-2")}>
            <FieldControl field={field} values={values} setValue={setValue} showMissing={showMissing} />
          </div>)}
        </div>
        <section className="flex flex-col gap-1.5" aria-label={t("home:templates.preview")}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t("home:templates.preview")}</span>
            <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11.5px] text-muted-foreground" onClick={() => void copy()} data-testid="agent-template-copy-inline">
              <Copy className="size-3" />{t("home:templates.copy")}
            </Button>
          </div>
          <SmoothCorners radius={12} smoothing={0.72} className="border bg-muted/40">
            <ScrollArea className="max-h-44" viewportProps={{ className: "max-h-44 [&>div]:!block" }}>
              <p className="px-3 py-2.5 text-[12.5px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85" data-testid="agent-template-preview">{prompt}</p>
            </ScrollArea>
          </SmoothCorners>
        </section>
      </div>
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2">
      {showMissing && missing.length > 0 && <span role="alert" className="mr-auto text-xs text-destructive">{t("home:templates.missing_folder")}</span>}
      {!external && !ready && !(showMissing && missing.length) && <span className="mr-auto text-xs text-muted-foreground">{t("home:templates.agent_not_ready")}</span>}
      {external ? <Button type="button" className="h-9 gap-1.5" onClick={() => void copy()} data-testid="agent-template-copy"><Copy className="size-3.5" />{t("home:templates.copy_external")}</Button>
        : <>
          <Button type="button" variant="outline" className="h-9" onClick={fill} data-testid="agent-template-fill">{t("home:templates.fill")}</Button>
          <Button type="button" className="h-9 gap-1.5" onClick={send} disabled={!ready} data-testid="agent-template-send">
            <Send className="size-3.5" />{t(busy ? "home:templates.queue" : "home:templates.send")}
          </Button>
        </>}
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
