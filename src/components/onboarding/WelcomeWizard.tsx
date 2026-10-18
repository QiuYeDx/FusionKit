import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  ExternalLink,
  HardDrive,
  Loader2,
  Plug,
  Sparkles,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  DialogDescription,
  DialogTitle,
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ApiKeyInput } from "@/components/model-setup/ApiKeyInput";
import { ConnectionTestStatus, type ConnectionTestState } from "@/components/model-setup/ConnectionTestStatus";
import { ModelProfileDialog } from "@/pages/Setting/components/ModelProfileDialog";
import { settingPath } from "@/pages/Setting/settingNavigation";
import { studioNavigationPath, studioResourcesPath } from "@/pages/Tools/Subtitle/SubtitleStudio/navigation";
import { VcRuntimeNotice } from "@/components/system-setup/VcRuntimeNotice";
import { getLocalPreparation, type LocalPreparationState } from "@/services/subtitle-studio/local-preparation";
import {
  DEEPSEEK_API_KEYS_URL,
  DEEPSEEK_TOP_UP_URL,
  DEFAULT_MODEL_API_FORMAT_MAP,
  DEFAULT_MODEL_BASE_URL_MAP,
  DEFAULT_MODEL_KEY_MAP,
  DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP,
  DEFAULT_TOKEN_PRICING_MAP,
} from "@/constants/model";
import { openExternalPage } from "@/services/ai-error-guide";
import { normalizeModelEndpoint } from "@/lib/model-endpoint";
import { isAgentProfileApiFormatSupported } from "@/agent/api-format-capability";
import { fillSessionDraft } from "@/agent/session-drafts";
import useModelStore from "@/store/useModelStore";
import useAgentStore from "@/store/agent/useAgentStore";
import useOnboardingStore, { shouldOpenOnboarding } from "@/store/useOnboardingStore";
import type { ModelSetupLaunchConfig } from "@/model-setup/contract";
import { Model } from "@/type/model";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Welcome wizard: how to use FusionKit, a DeepSeek key tested and saved for
// both roles, local transcription, and three tasks to try.
// ---------------------------------------------------------------------------

type Step = "choose" | "deepseek" | "local" | "done";
const STEPS: readonly Step[] = ["choose", "deepseek", "local", "done"];

/** Below this much free space the local step warns; its advice names the same amount. */
const LOW_SPACE_BYTES = 2 * 1024 ** 3;
/** How long the "back to the guide" notice stays after a next-step button led elsewhere. */
const RESUME_NOTICE_MS = 30_000;

/** Example tasks, the same ones the home page suggests; without an AI model they open the tool instead. */
const EXAMPLES = [
  { label: "home:suggestion_studio", prompt: "home:suggestion_studio_prompt", route: "/tools/subtitle/studio" },
  { label: "home:suggestion_lrc_to_srt", prompt: "home:suggestion_lrc_to_srt_prompt", route: "/tools/subtitle/converter" },
  { label: "home:suggestion_extract_chinese", prompt: "home:suggestion_extract_chinese_prompt", route: "/tools/subtitle/extractor" },
] as const;

const DEFAULT_LAUNCH: ModelSetupLaunchConfig = { onboarding: "auto" };

/** What the done page follows up with after "prepare" on the local step. */
type LocalPreparation = "none" | "started";

/**
 * Starts one-click prepare: the recommended model and voice detection download in the background
 * (the same run as "One-click prepare" in Subtitle Studio's resource manager), after the VC++
 * runtime check on Windows. The done page follows its progress.
 */
function prepareLocalTranscription(): LocalPreparation {
  void getLocalPreparation().start({ origin: "wizard" });
  return "started";
}

function formatGigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** Opens itself once for people with nothing set up; the settings can open it again. */
export function WelcomeWizard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const open = useOnboardingStore((state) => state.open);
  const openWizard = useOnboardingStore((state) => state.openWizard);
  const closeWizard = useOnboardingStore((state) => state.closeWizard);
  const leaveWizard = useOnboardingStore((state) => state.leaveWizard);
  const [launch, setLaunch] = useState<ModelSetupLaunchConfig>(DEFAULT_LAUNCH);
  const [step, setStep] = useState<Step>("choose");
  const [apiKey, setApiKey] = useState("");
  const [test, setTest] = useState<ConnectionTestState>({ status: "idle" });
  const [otherServiceOpen, setOtherServiceOpen] = useState(false);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [localPreparation, setLocalPreparation] = useState<LocalPreparation>("none");
  /** "Claude Code, Codex or Cursor" was chosen: no key here, but local transcription and the connection settings follow. */
  const [external, setExternal] = useState(false);
  const preparationRun = getLocalPreparation();
  const preparation = useSyncExternalStore(preparationRun.subscribe, preparationRun.getState);
  const testRun = useRef(0);
  const testInFlight = useRef(false);

  // One-click prepare runs in the background; say when it has finished, wherever the user is.
  const reported = useRef({ run: 0, phase: preparation.phase });
  useEffect(() => {
    const previous = reported.current;
    reported.current = { run: preparation.run, phase: preparation.phase };
    if (previous.run !== preparation.run || previous.phase !== "installing") return;
    if (preparation.phase === "completed") {
      toast.success(t("common:local_preparation.done_toast"), {
        id: "local-preparation", description: t("common:local_preparation.done_toast_description"),
        action: { label: t("common:local_preparation.open"), onClick: () => navigate(studioNavigationPath("transcription")) },
      });
    } else if (preparation.phase === "failed" || preparation.phase === "runtime_needed") {
      // A download that failed its load check because the Microsoft runtime is missing waits for the repair.
      toast.error(t("common:local_preparation.failed_toast"), {
        id: "local-preparation", description: t("common:local_preparation.failed_toast_description"),
        action: { label: t("common:local_preparation.open"), onClick: () => navigate(studioResourcesPath()) },
      });
    }
  }, [preparation.run, preparation.phase, navigate, t]);

  // Decide once at launch whether to open by itself.
  useEffect(() => {
    let cancelled = false;
    const api = window.modelSetup;
    void (api ? api.getLaunchConfig().catch(() => DEFAULT_LAUNCH) : Promise.resolve(DEFAULT_LAUNCH)).then((config) => {
      if (cancelled) return;
      setLaunch(config);
      const onboarding = useOnboardingStore.getState();
      if (shouldOpenOnboarding({
        status: onboarding.status,
        profiles: useModelStore.getState().profiles,
        launch: config.onboarding,
        testBuild: import.meta.env.MODE === "test",
      })) openWizard();
    });
    return () => { cancelled = true; };
  }, [openWizard]);

  // Each opening starts from the first step, or where a next-step button left off.
  useEffect(() => {
    if (!open) return;
    const resume = useOnboardingStore.getState().takeResume();
    setStep(resume ? "deepseek" : "choose");
    setApiKey(resume?.apiKey ?? "");
    setTest({ status: "idle" });
    setLocalPreparation("none");
    setExternal(false);
    if (resume?.otherService) setOtherServiceOpen(true);
  }, [open]);

  useEffect(() => {
    testRun.current += 1;
    setTest({ status: "idle" });
  }, [apiKey]);

  useEffect(() => {
    if (step !== "local" || !window.modelSetup) return;
    let cancelled = false;
    void window.modelSetup.getFreeDiskSpace().then((value) => { if (!cancelled) setFreeBytes(value); }, () => undefined);
    return () => { cancelled = true; };
  }, [step]);

  const deepseekBaseUrl = launch.deepseekBaseUrl ?? DEFAULT_MODEL_BASE_URL_MAP[Model.DeepSeek];
  const conversationActive = () => {
    const agent = useAgentStore.getState();
    return agent.isStreaming || agent.session.messages.length > 0;
  };

  /**
   * The profile becomes the model for tasks and for the Agent. During a conversation the Agent keeps
   * a model that works; one without a key is replaced. Returns whether the Agent uses it now.
   */
  const assignToBothRoles = (id: string): boolean => {
    const store = useModelStore.getState();
    const profile = store.getProfileById(id);
    store.setAssignment("taskExecution", id);
    if (!profile || !isAgentProfileApiFormatSupported(profile)) return false;
    const current = store.getAgentProfile();
    const currentWorks = !!current?.apiKey?.trim() && isAgentProfileApiFormatSupported(current);
    if (current && current.id !== id && currentWorks && conversationActive()) return false;
    store.setAssignment("agent", id);
    return true;
  };

  /** A DeepSeek profile with this key that is already saved (a second "test and save", or a later opening). */
  const savedDeepSeekProfile = (key: string) => {
    const address = normalizeModelEndpoint(deepseekBaseUrl).baseUrl;
    return useModelStore.getState().profiles.find((profile) => profile.provider === Model.DeepSeek
      && profile.apiKey.trim() === key && normalizeModelEndpoint(profile.baseUrl).baseUrl === address);
  };

  const testAndSave = async () => {
    const key = apiKey.trim();
    if (!key || testInFlight.current) return;
    testInFlight.current = true;
    try {
      await runTestAndSave(key);
    } finally {
      testInFlight.current = false;
    }
  };

  const runTestAndSave = async (key: string) => {
    const run = ++testRun.current;
    setTest({ status: "testing" });
    const request = {
      baseUrl: deepseekBaseUrl,
      apiFormat: DEFAULT_MODEL_API_FORMAT_MAP[Model.DeepSeek],
      modelKey: DEFAULT_MODEL_KEY_MAP[Model.DeepSeek],
      apiKey: key,
      outputTokenParameter: DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP[Model.DeepSeek],
    };
    const result = window.modelSetup
      ? await window.modelSetup.testConnection(request).catch(() => ({ ok: false, latencyMs: 0, category: "unknown" as const }))
      : { ok: false, latencyMs: 0, category: "unknown" as const };
    if (run !== testRun.current) return;
    setTest({ status: "done", result });
    if (!result.ok) return;
    const id = savedDeepSeekProfile(key)?.id ?? useModelStore.getState().addProfile({
      name: "DeepSeek",
      provider: Model.DeepSeek,
      apiKey: key,
      baseUrl: deepseekBaseUrl,
      modelKey: request.modelKey,
      apiFormat: request.apiFormat,
      outputTokenParameter: request.outputTokenParameter,
      tokenPricing: { ...DEFAULT_TOKEN_PRICING_MAP[Model.DeepSeek] },
    });
    const agentUsesIt = assignToBothRoles(id);
    toast.success(t(agentUsesIt ? "common:onboarding.deepseek.saved" : "common:onboarding.deepseek.saved_tasks_only"));
    setStep("local");
  };

  const finish = (status: "completed" | "dismissed") => closeWizard(status);
  const leaveTo = (to: string) => { finish("completed"); navigate(to); };

  /**
   * A next-step button (the network settings) leads away from the DeepSeek step: keep the pasted
   * key, do not count the wizard as seen, and offer the way back.
   */
  const leaveForFix = (otherService: boolean) => {
    leaveWizard({ apiKey, otherService });
    toast(t("common:onboarding.left_notice"), {
      id: "welcome-wizard-resume",
      duration: RESUME_NOTICE_MS,
      action: { label: t("common:onboarding.resume"), onClick: openWizard },
    });
  };

  const agentReady = useModelStore((state) => !!state.getAgentProfile()?.apiKey?.trim());
  const tryExample = (example: (typeof EXAMPLES)[number]) => {
    finish("completed");
    if (!agentReady) { navigate(example.route); return; }
    fillSessionDraft(useAgentStore.getState().activeSessionId, t(example.prompt));
    navigate("/");
  };

  const stepIndex = STEPS.indexOf(step);
  const testing = test.status === "testing";
  const lowSpace = freeBytes !== null && freeBytes < LOW_SPACE_BYTES;
  const description = step === "done" && !agentReady ? "common:onboarding.done.description_no_model" : `common:onboarding.${step}.description`;

  return (
    <>
      <ScrollableDialog
        open={open && !otherServiceOpen}
        onOpenChange={(next) => { if (!next && !testing) finish(step === "done" ? "completed" : "dismissed"); }}
        maxWidth="sm:max-w-[560px]"
        animateSize
        transitionKey={step}
        contentClassName="welcome-wizard"
      >
        <ScrollableDialogHeader className="pr-12">
          <p className="text-xs font-medium text-muted-foreground" data-testid="welcome-wizard-step">
            {t("common:onboarding.step", { current: stepIndex + 1, total: STEPS.length })}
          </p>
          <DialogTitle>{t(`common:onboarding.${step}.title`)}</DialogTitle>
          <DialogDescription>{t(description)}</DialogDescription>
        </ScrollableDialogHeader>

        <ScrollableDialogContent fadeMasks>
          <div data-testid="welcome-wizard" data-step={step} className="space-y-3">
            {step === "choose" && (
              <div className="grid gap-2" role="list">
                <ChoiceCard
                  icon={Sparkles}
                  title={t("common:onboarding.choose.ai_title")}
                  description={t("common:onboarding.choose.ai_description")}
                  badge={t("common:onboarding.recommended")}
                  testId="welcome-choice-ai"
                  onClick={() => { setExternal(false); setStep("deepseek"); }}
                />
                <ChoiceCard
                  icon={Plug}
                  title={t("common:onboarding.choose.external_title")}
                  description={t("common:onboarding.choose.external_description")}
                  testId="welcome-choice-external"
                  onClick={() => { setExternal(true); setStep("local"); }}
                />
                <ChoiceCard
                  icon={AudioLines}
                  title={t("common:onboarding.choose.local_title")}
                  description={t("common:onboarding.choose.local_description")}
                  testId="welcome-choice-local"
                  onClick={() => { setExternal(false); setStep("local"); }}
                />
              </div>
            )}

            {step === "deepseek" && (
              <div className="space-y-4">
                <div className="space-y-2 rounded-smooth-lg border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">DeepSeek</span>
                    <span className="rounded-full bg-emerald-500/15 px-1.5 text-[10px] leading-4 text-emerald-700 dark:text-emerald-400">
                      {t("common:onboarding.recommended")}
                    </span>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">{t("common:onboarding.deepseek.intro")}</p>
                  <ol className="list-decimal space-y-0.5 pl-4 text-xs leading-5 text-muted-foreground">
                    <li>{t("common:onboarding.deepseek.step_key")}</li>
                    <li>{t("common:onboarding.deepseek.step_top_up")}</li>
                    <li>{t("common:onboarding.deepseek.step_paste")}</li>
                  </ol>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <Button type="button" variant="outline" size="sm" data-testid="welcome-deepseek-keys" data-href={DEEPSEEK_API_KEYS_URL}
                      onClick={() => openExternalPage(DEEPSEEK_API_KEYS_URL)}>
                      <ExternalLink />{t("common:onboarding.deepseek.get_key")}
                    </Button>
                    <Button type="button" variant="outline" size="sm" data-testid="welcome-deepseek-top-up" data-href={DEEPSEEK_TOP_UP_URL}
                      onClick={() => openExternalPage(DEEPSEEK_TOP_UP_URL)}>
                      <Wallet />{t("common:onboarding.deepseek.top_up")}
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="welcome-deepseek-key">{t("setting:fields.apikey")}</Label>
                  <ApiKeyInput
                    id="welcome-deepseek-key"
                    data-testid="welcome-deepseek-key"
                    placeholder={t("common:onboarding.deepseek.key_placeholder")}
                    value={apiKey}
                    onValueChange={setApiKey}
                    onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && !testing) void testAndSave(); }}
                  />
                </div>
                <DialogTransition transitionKey={test.status === "done" ? `done-${test.result.category}` : test.status}>
                  {test.status !== "idle" && (
                    <ConnectionTestStatus
                      state={test}
                      profile={{ provider: Model.DeepSeek, baseUrl: deepseekBaseUrl }}
                      context="wizard"
                      excludeActions={["open_model_settings"]}
                      onBeforeAction={() => leaveForFix(false)}
                    />
                  )}
                </DialogTransition>
                <button
                  type="button"
                  data-testid="welcome-other-service"
                  className="cursor-pointer text-xs text-muted-foreground underline-offset-3 hover:text-foreground hover:underline"
                  onClick={() => setOtherServiceOpen(true)}
                >
                  {t("common:onboarding.deepseek.other_service")}
                </button>
              </div>
            )}

            {step === "local" && (
              <div className="space-y-3">
                <dl className="grid gap-2 rounded-smooth-lg border bg-card p-3 text-xs leading-5">
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-muted-foreground">{t("common:onboarding.local.model")}</dt>
                    <dd className="text-right">{t("common:onboarding.local.model_value")}</dd>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-muted-foreground">{t("common:onboarding.local.vad")}</dt>
                    <dd className="text-right">{t("common:onboarding.local.vad_value")}</dd>
                  </div>
                  {freeBytes !== null && (
                    <div className="flex items-start justify-between gap-3" data-testid="welcome-free-space">
                      <dt className="text-muted-foreground">{t("common:onboarding.local.free_space")}</dt>
                      <dd className={cn("text-right", lowSpace && "text-amber-600 dark:text-amber-400")}>
                        {t("common:onboarding.local.free_space_value", { size: formatGigabytes(freeBytes) })}
                      </dd>
                    </div>
                  )}
                </dl>
                {lowSpace && (
                  <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="welcome-low-space">
                    {t("common:onboarding.local.low_space", { size: LOW_SPACE_BYTES / 1024 ** 3 })}
                  </p>
                )}
                <p className="text-xs leading-5 text-muted-foreground">{t("common:onboarding.local.note")}</p>
                {external && <p className="text-xs leading-5 text-muted-foreground" data-testid="welcome-local-external-note">{t("common:onboarding.local.external_note")}</p>}
              </div>
            )}

            {step === "done" && (
              <div className="space-y-2">
                {external && (
                  <button
                    type="button"
                    data-testid="welcome-open-external"
                    onClick={() => leaveTo(settingPath("external"))}
                    className="group flex w-full cursor-pointer items-start gap-2.5 rounded-smooth-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-left transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <Plug className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{t("common:onboarding.done.external_title")}</span>
                      <span className="block text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{t("common:onboarding.done.external_description")}</span>
                    </span>
                    <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </button>
                )}
                {localPreparation === "started" && (
                  <LocalPreparationCard state={preparation} onOpen={leaveTo} />
                )}
                {/* Each list item holds a button, so screen readers still announce buttons. */}
                <div className="grid gap-2" role="list" aria-label={t("common:onboarding.done.examples_label")}>
                  {EXAMPLES.map((example) => (
                    <div key={example.label} role="listitem">
                      <button
                        type="button"
                        data-testid="welcome-example"
                        onClick={() => tryExample(example)}
                        className="group flex w-full cursor-pointer items-start gap-2.5 rounded-smooth-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{t(example.label)}</span>
                          <span className="block text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                            {agentReady ? t(example.prompt) : t("common:onboarding.done.open_tool")}
                          </span>
                        </span>
                        <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                      </button>
                    </div>
                  ))}
                </div>
                {!agentReady && <p className="text-xs leading-5 text-muted-foreground">{t("common:onboarding.done.no_model")}</p>}
              </div>
            )}
          </div>
        </ScrollableDialogContent>

        <ScrollableDialogFooter className="flex flex-wrap items-center justify-between gap-2">
          {step === "choose" || step === "done" ? (
            <span />
          ) : (
            <Button type="button" variant="ghost" disabled={testing} onClick={() => setStep("choose")}>
              <ArrowLeft />{t("common:onboarding.back")}
            </Button>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            {step === "choose" && (
              <Button type="button" variant="ghost" data-testid="welcome-skip" onClick={() => finish("dismissed")}>
                {t("common:onboarding.skip")}
              </Button>
            )}
            {step === "deepseek" && (
              <Button type="button" data-testid="welcome-deepseek-save" disabled={!apiKey.trim() || testing} onClick={() => void testAndSave()}>
                {testing && <Loader2 className="animate-spin" />}
                {t("common:onboarding.deepseek.test_and_save")}
              </Button>
            )}
            {step === "local" && (
              <>
                <Button type="button" variant="ghost" data-testid="welcome-local-later" onClick={() => setStep("done")}>
                  {t("common:onboarding.local.later")}
                </Button>
                <Button type="button" data-testid="welcome-local-prepare" onClick={() => { setLocalPreparation(prepareLocalTranscription()); setStep("done"); }}>
                  <HardDrive />{t("common:onboarding.local.prepare")}
                </Button>
              </>
            )}
            {step === "done" && (
              <Button type="button" data-testid="welcome-finish" onClick={() => (external ? leaveTo(settingPath("external")) : finish("completed"))}>
                {t(external ? "common:onboarding.done.open_external" : "common:onboarding.done.start")}
              </Button>
            )}
          </div>
        </ScrollableDialogFooter>
      </ScrollableDialog>

      <ModelProfileDialog
        open={otherServiceOpen}
        onOpenChange={setOtherServiceOpen}
        profile={null}
        draftOwner="wizard"
        onLeave={() => leaveForFix(true)}
        onSaved={(id) => { assignToBothRoles(id); setStep("local"); }}
      />
    </>
  );
}

/**
 * The done page's view of one-click prepare: progress while it downloads, the outcome when it is
 * done, and the VC++ runtime repair when Windows needs it first. Each opens the matching place.
 */
function LocalPreparationCard({ state, onOpen }: { state: LocalPreparationState; onOpen: (to: string) => void }) {
  const { t } = useTranslation();
  if (state.phase === "runtime_needed") {
    return (
      <div className="space-y-1.5">
        <VcRuntimeNotice
          testId="welcome-vc-runtime"
          description={t("common:onboarding.done.prepare_runtime")}
          onRepaired={() => void getLocalPreparation().start({ origin: "wizard" })}
        />
        <button
          type="button"
          data-testid="welcome-open-resources"
          data-phase={state.phase}
          className="cursor-pointer text-xs text-muted-foreground underline-offset-3 hover:text-foreground hover:underline"
          onClick={() => onOpen(studioResourcesPath())}
        >
          {t("common:onboarding.done.open_resources")}
        </button>
      </div>
    );
  }
  const running = state.phase === "checking" || state.phase === "installing";
  const percent = Math.round(state.progress);
  const [title, description] = running
    ? [t("common:onboarding.done.prepare_running", { percent }), t("common:onboarding.done.prepare_running_description")]
    : state.phase === "completed"
      ? [t("common:onboarding.done.prepare_done"), t("common:onboarding.done.prepare_done_description")]
      : state.phase === "failed"
        ? [t("common:onboarding.done.prepare_failed"), t("common:onboarding.done.prepare_failed_description")]
        : [t("common:onboarding.done.resources_title"), t("common:onboarding.done.resources_description")];
  const warning = state.phase === "failed";
  return (
    <button
      type="button"
      data-testid="welcome-open-resources"
      data-phase={state.phase}
      onClick={() => onOpen(state.phase === "completed" ? studioNavigationPath("transcription") : studioResourcesPath())}
      className={cn(
        "group flex w-full cursor-pointer items-start gap-2.5 rounded-smooth-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        warning ? "border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10" : "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10",
      )}
    >
      {running
        ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-emerald-700 dark:text-emerald-400" />
        : <HardDrive className={cn("mt-0.5 size-3.5 shrink-0", warning ? "text-amber-600 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400")} />}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{description}</span>
        {state.phase === "installing" && (
          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={title}
            className="mt-1.5 block h-1 overflow-hidden rounded-full bg-emerald-500/15"
          >
            <span className="block h-full rounded-full bg-emerald-500 transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </span>
        )}
      </span>
      <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function ChoiceCard({ icon: Icon, title, description, badge, testId, onClick }: {
  icon: LucideIcon;
  title: string;
  description: string;
  badge?: string;
  testId: string;
  onClick: () => void;
}) {
  // The list item wraps the button, so screen readers still announce a button.
  return (
    <div role="listitem">
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        className="group flex w-full cursor-pointer items-start gap-3 rounded-smooth-lg border bg-card px-3 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-smooth-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {title}
            {badge && (
              <span className="rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-normal leading-4 text-emerald-700 dark:text-emerald-400">{badge}</span>
            )}
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{description}</span>
        </span>
        <ArrowRight className="mt-2 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </button>
    </div>
  );
}

export default WelcomeWizard;
