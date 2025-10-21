import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import {
  SubtitleFileType,
  SubtitleSliceType,
  TaskStatus,
  type SubtitleTranslatorTask,
} from "@/type/subtitle";
import { useTranslation } from "react-i18next";
import { useState, useMemo, useEffect, useRef } from "react";
import {
  RotateCw,
  Folder,
  FolderOpen,
  PlayCircle,
  X,
  Trash2,
  AlertTriangle,
  Cpu,
  ChevronDown,
} from "lucide-react";
import { showToast } from "@/utils/toast";
import useModelStore from "@/store/useModelStore";
import ErrorDetailModal from "@/components/ErrorDetailModal";
import {
  estimateSubtitleTokens,
  formatTokens,
  formatCost,
} from "@/utils/tokenEstimate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function SubtitleTranslator() {
  const { t } = useTranslation();
  const {
    // fileType,
    sliceType,
    sliceLengthMap,
    outputURL,
    notStartedTaskQueue,
    waitingTaskQueue,
    pendingTaskQueue,
    resolvedTaskQueue,
    failedTaskQueue,
    // setFileType,
    setSliceType,
    setCustomSliceLength,
    setOutputURL,
    addTask,
    startTask,
    retryTask,
    startAllTasks,
    removeAllResolvedTask,
    cancelTask,
    deleteTask,
  } = useSubtitleTranslatorStore();
  const {
    model,
    getApiKeyByType,
    getModelKeyByType,
    getModelUrlByType,
    getTokenPricingByType,
  } = useModelStore();

  const [customLengthInput, setCustomLengthInput] = useState(
    sliceLengthMap?.[SubtitleSliceType.CUSTOM]?.toString() || "500"
  );

  const [isDragging, setIsDragging] = useState(false);

  // 错误详情模态框状态
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [selectedErrorTask, setSelectedErrorTask] =
    useState<SubtitleTranslatorTask | null>(null);

  // 定时开始相关状态
  const [scheduleTime, setScheduleTime] = useState<string>(""); // 本地时间，格式 YYYY-MM-DDTHH:mm
  const [scheduleDate, setScheduleDate] = useState<Date | undefined>(undefined);
  const [scheduleTimeValue, setScheduleTimeValue] = useState<string>("10:00");
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>(false);
  const [preventSleep, setPreventSleep] = useState<boolean>(false);
  const [blockerId, setBlockerId] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number>(0);
  const hasTriggeredRef = useRef<boolean>(false);
  const intervalRef = useRef<number | null>(null);
  const [isScheduleOpen, setIsScheduleOpen] = useState<boolean>(false);
  const [isConfigOpen, setIsConfigOpen] = useState<boolean>(true);
  const [isOutputOpen, setIsOutputOpen] = useState<boolean>(true);
  const [isNewTaskConfigOpen, setIsNewTaskConfigOpen] = useState<boolean>(true);

  const targetEpochMs = useMemo(() => {
    if (!scheduleTime) return NaN;
    const ms = new Date(scheduleTime).getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }, [scheduleTime]);

  // 同步日期和时间到 scheduleTime
  useEffect(() => {
    if (scheduleDate && scheduleTimeValue) {
      const year = scheduleDate.getFullYear();
      const month = String(scheduleDate.getMonth() + 1).padStart(2, "0");
      const day = String(scheduleDate.getDate()).padStart(2, "0");
      const dateTimeString = `${year}-${month}-${day}T${scheduleTimeValue}`;
      setScheduleTime(dateTimeString);
    } else {
      setScheduleTime("");
    }
  }, [scheduleDate, scheduleTimeValue]);

  const stopPowerBlocker = async () => {
    try {
      if (blockerId != null) {
        await window.ipcRenderer.invoke("power-blocker-stop", blockerId);
      }
    } catch {}
    setBlockerId(null);
  };

  const startPowerBlockerUntil = async (untilEpochMs: number) => {
    try {
      const res = await window.ipcRenderer.invoke("power-blocker-start", {
        type: "prevent-app-suspension",
        untilEpochMs,
      });
      if (res?.id != null) setBlockerId(res.id as number);
    } catch (e) {
      // 即便失败，不阻塞后续定时
    }
  };

  const resetInterval = () => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const cancelSchedule = async (showMsg = true) => {
    setScheduleEnabled(false);
    hasTriggeredRef.current = false;
    resetInterval();
    await stopPowerBlocker();
    if (showMsg) showToast("已取消定时任务", "success");
  };

  const tryTriggerStart = async () => {
    if (!scheduleEnabled) return;
    if (!Number.isFinite(targetEpochMs)) return;
    if (hasTriggeredRef.current) return;
    if (Date.now() >= targetEpochMs) {
      hasTriggeredRef.current = true;
      await stopPowerBlocker();
      if (notStartedTaskQueue.length > 0) {
        startAllTasks();
        showToast("已到达定时时间，开始全部任务", "success");
      } else {
        showToast("已到达定时时间，但没有可开始的任务", "default");
      }
      // 结束计划
      setScheduleEnabled(false);
      resetInterval();
    }
  };

  // 定时/倒计时与系统恢复补偿
  useEffect(() => {
    // 清理历史 interval
    resetInterval();

    if (!scheduleEnabled || !Number.isFinite(targetEpochMs)) {
      setRemainingMs(0);
      return;
    }

    // 初始剩余时间
    setRemainingMs(Math.max(0, targetEpochMs - Date.now()));

    // 每秒更新一次并尝试触发
    intervalRef.current = window.setInterval(() => {
      setRemainingMs(Math.max(0, targetEpochMs - Date.now()));
      tryTriggerStart();
    }, 1000);

    // 监听系统恢复事件，补偿睡眠期间错过的触发
    const resumeHandler = () => {
      tryTriggerStart();
    };
    window.ipcRenderer.on("system-resumed", resumeHandler);

    return () => {
      resetInterval();
      window.ipcRenderer.off("system-resumed", resumeHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleEnabled, targetEpochMs]);

  const formatRemaining = (ms: number) => {
    if (!scheduleEnabled || !Number.isFinite(targetEpochMs)) return "--";
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  };

  // 组件卸载清理防睡眠
  useEffect(() => {
    return () => {
      stopPowerBlocker();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 计算总的token统计
  const tokenStats = useMemo(() => {
    const allTasks = [
      ...notStartedTaskQueue,
      ...waitingTaskQueue,
      ...pendingTaskQueue,
      ...resolvedTaskQueue,
      ...failedTaskQueue,
    ];

    let totalTokens = 0;
    let totalCost = 0;
    let pendingTokens = 0;
    let pendingCost = 0;

    allTasks.forEach((task) => {
      if (task.costEstimate) {
        totalTokens += task.costEstimate.totalTokens || 0;
        totalCost += task.costEstimate.estimatedCost || 0;

        if (
          task.status === TaskStatus.NOT_STARTED ||
          task.status === TaskStatus.WAITING ||
          task.status === TaskStatus.PENDING
        ) {
          pendingTokens += task.costEstimate.totalTokens || 0;
          pendingCost += task.costEstimate.estimatedCost || 0;
        }
      }
    });

    return {
      totalTokens,
      totalCost,
      pendingTokens,
      pendingCost,
      taskCount: allTasks.length,
    };
  }, [
    notStartedTaskQueue,
    waitingTaskQueue,
    pendingTaskQueue,
    resolvedTaskQueue,
    failedTaskQueue,
  ]);

  // 打开错误详情模态框
  const openErrorModal = (task: SubtitleTranslatorTask) => {
    setSelectedErrorTask(task);
    setErrorModalOpen(true);
  };

  // 关闭错误详情模态框
  const closeErrorModal = () => {
    setErrorModalOpen(false);
    setSelectedErrorTask(null);
  };

  // 选择输出路径
  const handleSelectOutputPath = async () => {
    try {
      // 通过 IPC 调用主进程的目录选择对话框
      const result = await window.ipcRenderer.invoke(
        "select-output-directory",
        {
          title: t("subtitle:translator.dialog.select_output_title"),
          buttonLabel: t("subtitle:translator.dialog.select_output_confirm"),
        }
      );

      if (result && !result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        setOutputURL(selectedPath);
        showToast(
          t("subtitle:translator.infos.output_path_selected"),
          "success"
        );
      }
    } catch (error) {
      showToast(t("subtitle:translator.errors.path_selection_failed"), "error");
    }
  };

  // 处理文件拖入区域的拖拽事件
  const handleDragEnter = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault(); // 必须阻止默认行为以允许拖放
  };

  // 处理文件拖放事件
  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);

    // 获取拖放的文件
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      // 调用文件上传处理函数
      handleFileUpload({
        target: { files },
      } as React.ChangeEvent<HTMLInputElement>);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!outputURL) {
      showToast(
        t("subtitle:translator.errors.please_select_output_url"),
        "error"
      );
      return;
    }
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // 获取已有的任务文件路径列表
    const existingFileNames = [
      ...notStartedTaskQueue,
      ...waitingTaskQueue,
      ...pendingTaskQueue,
      ...resolvedTaskQueue,
      ...failedTaskQueue,
    ].map((task) => task.fileName);

    // 遍历所有选中的文件
    for (const file of Array.from(files)) {
      const extension = file.name.split(".").pop()?.toUpperCase();

      // 检查文件类型是否支持
      if (
        !Object.values(SubtitleFileType).includes(extension as SubtitleFileType)
      ) {
        showToast(
          t("subtitle:translator.errors.invalid_file_type").replace(
            "{types}",
            extension || " - "
          ),
          "error"
        );
        continue;
      }

      // 检查文件名称是否已存在
      if (existingFileNames.includes(file.name)) {
        showToast(
          t("subtitle:translator.errors.duplicate_file").replace(
            "{file}",
            file.name
          ),
          "error"
        );
        continue;
      }

      try {
        // 读取文件内容
        const fileContent = await file.text();

        // 计算token预估
        const tokenPricing = getTokenPricingByType(model);
        const tokenEstimate = await estimateSubtitleTokens(
          fileContent,
          sliceType,
          sliceType === SubtitleSliceType.CUSTOM
            ? sliceLengthMap[SubtitleSliceType.CUSTOM]
            : undefined,
          model,
          tokenPricing
        );

        // 创建任务
        const newTask: SubtitleTranslatorTask = {
          fileName: file.name,
          fileContent, // 设置文件内容
          sliceType,
          originFileURL: URL.createObjectURL(file),
          targetFileURL: outputURL,
          status: TaskStatus.NOT_STARTED,
          progress: 0,
          costEstimate: tokenEstimate,

          apiKey: getApiKeyByType(model),
          apiModel: getModelKeyByType(model),
          endPoint: getModelUrlByType(model),
        };
        addTask(newTask);
      } catch (error) {
        console.error(t("subtitle:translator.errors.read_file_failed"), error);
        showToast(
          t("subtitle:translator.errors.read_file_failed").replace(
            "{file}",
            file.name
          ),
          "error"
        );
      }
    }
  };

  const getTaskStatusColor = (status: TaskStatus) => {
    switch (status) {
      case TaskStatus.NOT_STARTED:
        return "bg-gray-500";
      case TaskStatus.WAITING:
        return "bg-blue-500";
      case TaskStatus.PENDING:
        return "bg-yellow-500";
      case TaskStatus.RESOLVED:
        return "bg-green-500";
      case TaskStatus.FAILED:
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  return (
    <div className="p-4">
      <div className="text-2xl font-bold mb-4">
        {t("subtitle:translator.title")}
      </div>
      <div className="mb-6 text-muted-foreground">
        {t("subtitle:translator.description")}
      </div>

      {/* 配置区块 */}
      <div className="flex flex-col gap-4 mb-4">
        <Card>
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsConfigOpen((v) => !v)}
          >
            <CardTitle className="text-xl">
              {t("subtitle:translator.config_title")}
            </CardTitle>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isConfigOpen && "rotate-180"
              )}
            />
          </div>
          {isConfigOpen && (
            <CardContent className="p-4 pt-0 space-y-4">
              {/* 分片模式选择 */}
              <div className="flex items-center gap-4">
                <Label className="text-sm font-medium min-w-[100px]">
                  {t("subtitle:translator.fields.subtitle_slice_mode")}
                </Label>
                <ButtonGroup>
                  {Object.values(SubtitleSliceType).map((type) => (
                    <Button
                      key={type}
                      size="sm"
                      variant={sliceType === type ? "default" : "outline"}
                      onClick={() => setSliceType(type as SubtitleSliceType)}
                    >
                      {t(
                        `subtitle:translator.slice_types.${type.toLowerCase()}`
                      )}
                    </Button>
                  ))}
                </ButtonGroup>
              </div>

              {/* 自定义分片长度输入 */}
              {sliceType === SubtitleSliceType.CUSTOM && (
                <div className="space-y-2 mt-4">
                  <Label htmlFor="custom-length">
                    {t("subtitle:translator.fields.custom_slice_length")}{" "}
                    (chars)
                  </Label>
                  <Input
                    id="custom-length"
                    type="number"
                    className="w-32"
                    value={customLengthInput}
                    min="100"
                    max="2000"
                    onChange={(e) => {
                      setCustomLengthInput(e.target.value);
                      setCustomSliceLength(Number(e.target.value));
                    }}
                  />
                </div>
              )}
            </CardContent>
          )}
        </Card>
      </div>

      {/* 输出设置区块 */}
      <div className="mb-4">
        <Card>
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsOutputOpen((v) => !v)}
          >
            <CardTitle className="text-xl">
              {t("subtitle:translator.output_path_section")}
            </CardTitle>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isOutputOpen && "rotate-180"
              )}
            />
          </div>
          {isOutputOpen && (
            <CardContent className="p-4 pt-0">
              <div className="flex items-center gap-4">
                <Button onClick={handleSelectOutputPath} size="sm">
                  {t("subtitle:translator.fields.select_output_path")}
                </Button>
                <Input
                  type="text"
                  placeholder={t(
                    "subtitle:translator.fields.no_output_path_selected"
                  )}
                  value={outputURL}
                  onChange={() => {}} // 防止显示控制台警告
                  className="grow"
                  readOnly
                />
              </div>

              {/* TODO: 输出文件前缀、后缀设置 */}
            </CardContent>
          )}
        </Card>
      </div>

      {/* 定时开始设置 */}
      <div className="mb-4">
        <Card>
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsScheduleOpen((v) => !v)}
          >
            <CardTitle className="text-xl">
              {t("subtitle:translator.schedule.title")}
            </CardTitle>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isScheduleOpen && "rotate-180"
              )}
            />
          </div>
          {isScheduleOpen && (
            <CardContent className="p-4 pt-0">
              <div className="space-y-4">
                {/* 第一行：日期时间选择和操作按钮 */}
                <div className="flex flex-col sm:flex-row sm:items-end gap-4">
                  <div className="flex flex-wrap gap-3 flex-1">
                    {/* 日期选择器 */}
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="schedule-date" className="px-1">
                        {t("subtitle:translator.schedule.date")}
                      </Label>
                      <Popover
                        open={datePopoverOpen}
                        onOpenChange={setDatePopoverOpen}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            id="schedule-date"
                            className="w-[180px] justify-between font-normal"
                          >
                            {scheduleDate
                              ? scheduleDate.toLocaleDateString()
                              : t("subtitle:translator.schedule.select_date")}
                            <ChevronDown className="h-4 w-4" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-auto overflow-hidden p-0"
                          align="start"
                        >
                          <Calendar
                            mode="single"
                            selected={scheduleDate}
                            captionLayout="dropdown"
                            onSelect={(date) => {
                              setScheduleDate(date);
                              setDatePopoverOpen(false);
                            }}
                            disabled={(date) =>
                              date < new Date(new Date().setHours(0, 0, 0, 0))
                            }
                          />
                        </PopoverContent>
                      </Popover>
                    </div>

                    {/* 时间选择器 */}
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="schedule-time" className="px-1">
                        {t("subtitle:translator.schedule.time")}
                      </Label>
                      <Input
                        type="time"
                        id="schedule-time"
                        value={scheduleTimeValue}
                        onChange={(e) => setScheduleTimeValue(e.target.value)}
                        className="w-[140px] bg-background appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                      />
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className="flex gap-2 sm:pb-0">
                    {!scheduleEnabled ? (
                      <Button
                        variant={
                          !scheduleTime || !Number.isFinite(targetEpochMs)
                            ? "outline"
                            : "default"
                        }
                        disabled={
                          !scheduleTime || !Number.isFinite(targetEpochMs)
                        }
                        onClick={async () => {
                          if (!scheduleTime || !Number.isFinite(targetEpochMs))
                            return;
                          if (targetEpochMs <= Date.now()) {
                            showToast(
                              t(
                                "subtitle:translator.schedule.choose_future_time"
                              ),
                              "default"
                            );
                            return;
                          }
                          hasTriggeredRef.current = false;
                          setScheduleEnabled(true);
                          if (preventSleep)
                            await startPowerBlockerUntil(targetEpochMs);
                          showToast(
                            t("subtitle:translator.schedule.scheduled_set"),
                            "success"
                          );
                        }}
                        className="min-w-[100px]"
                      >
                        {t("subtitle:translator.schedule.enable")}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="default"
                        onClick={() => cancelSchedule()}
                        className="min-w-[100px]"
                      >
                        {t("subtitle:translator.schedule.cancel")}
                      </Button>
                    )}
                  </div>
                </div>

                {/* 第二行：防止睡眠选项 */}
                <Label
                  htmlFor="prevent-sleep"
                  className="hover:bg-accent/50 flex items-start gap-3 rounded-lg border p-3 cursor-pointer has-[[aria-checked=true]]:border-primary has-[[aria-checked=true]]:bg-primary/5 dark:has-[[aria-checked=true]]:bg-primary/10"
                >
                  <Checkbox
                    id="prevent-sleep"
                    checked={preventSleep}
                    onCheckedChange={(checked) =>
                      setPreventSleep(checked as boolean)
                    }
                    className="data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
                  />
                  <div className="grid gap-1.5 font-normal">
                    <p className="text-sm leading-none font-medium">
                      {t(
                        "subtitle:translator.schedule.prevent_sleep_until_start"
                      )}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t("subtitle:translator.schedule.prevent_sleep_note")}
                    </p>
                  </div>
                </Label>

                {/* 状态显示 */}
                <Card>
                  <CardContent className="p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {t("subtitle:translator.schedule.status")}
                      </span>
                      <div className="h-4 w-px bg-border" />
                      {scheduleEnabled ? (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-foreground">
                            {t(
                              "subtitle:translator.schedule.enabled_countdown"
                            )}{" "}
                            <span className="font-mono font-semibold">
                              {formatRemaining(remainingMs)}
                            </span>
                          </span>
                          {blockerId != null && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                              {t(
                                "subtitle:translator.schedule.sleep_blocker_on"
                              )}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {t("subtitle:translator.schedule.disabled")}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* Token消耗预估配置显示 */}
      <div className="mb-4">
        <Card>
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsNewTaskConfigOpen((v) => !v)}
          >
            <CardTitle className="text-xl">
              {t("subtitle:translator.new_task_config.title")}
            </CardTitle>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isNewTaskConfigOpen && "rotate-180"
              )}
            />
          </div>
          {isNewTaskConfigOpen && (
            <CardContent className="p-4 pt-0">
              <div className="text-sm text-muted-foreground mb-3">
                {t("subtitle:translator.new_task_config.note")}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <Card className="border-muted">
                  <CardContent className="p-3">
                    <div className="text-muted-foreground text-xs mb-1">
                      {t(
                        "subtitle:translator.new_task_config.current_slice_mode"
                      )}
                    </div>
                    <div className="font-medium">
                      {t(
                        `subtitle:translator.slice_types.${sliceType.toLowerCase()}`
                      )}
                      {sliceType === SubtitleSliceType.CUSTOM && (
                        <span className="ml-1 text-muted-foreground">
                          ({sliceLengthMap[SubtitleSliceType.CUSTOM]}
                          {t(
                            "subtitle:translator.new_task_config.chars_suffix"
                          )}
                          )
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-muted">
                  <CardContent className="p-3">
                    <div className="text-muted-foreground text-xs mb-1">
                      {t("subtitle:translator.new_task_config.rate_in_out")}
                    </div>
                    <div className="font-mono text-sm">
                      $
                      {getTokenPricingByType(
                        model
                      ).inputTokensPerMillion.toFixed(2)}
                      /$
                      {getTokenPricingByType(
                        model
                      ).outputTokensPerMillion.toFixed(2)}{" "}
                      per 1M tokens
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-muted">
                  <CardContent className="p-3">
                    <div className="text-muted-foreground text-xs mb-1">
                      {t("subtitle:translator.new_task_config.total_tasks")}
                    </div>
                    <div className="font-medium">
                      {t(
                        "subtitle:translator.new_task_config.task_count"
                      ).replace("{count}", String(tokenStats.taskCount))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* 文件上传区域 */}
      <div className="mb-4">
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-xl">{t("subtitle:translator.upload_section")}</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <label
              className={cn(
                "flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-6 cursor-pointer transition-colors file-drop-zone",
                isDragging
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-muted/50"
              )}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              <input
                type="file"
                multiple
                className="hidden"
                accept=".lrc,.srt"
                onChange={handleFileUpload}
              />
              <div className="text-4xl -mb-2 pointer-events-none">
                {isDragging ? (
                  <FolderOpen className="h-10 w-10" />
                ) : (
                  <Folder className="h-10 w-10" />
                )}
              </div>
              <div className="mt-3 text-center pointer-events-none">
                <p className="font-medium">
                  {t("subtitle:translator.fields.upload_tips")}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {t("subtitle:translator.fields.files_only").replace(
                    "{formats}",
                    ".lrc, .srt"
                  )}
                </p>
              </div>
            </label>
          </CardContent>
        </Card>
      </div>

      {/* 任务管理区域 */}
      <Card className="mb-12">
        <CardHeader className="p-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl">{t("subtitle:translator.task_management")}</CardTitle>
            <div className="flex gap-2">
              {/* 全部开始 */}
              <Button
                variant={
                  notStartedTaskQueue.length === 0 ? "outline" : "default"
                }
                size="sm"
                onClick={() => startAllTasks()}
                disabled={notStartedTaskQueue.length === 0}
              >
                {t("subtitle:translator.fields.start_all")}
              </Button>
              {/* 清空完成 */}
              <Button
                variant={resolvedTaskQueue.length === 0 ? "outline" : "default"}
                size="sm"
                onClick={() => removeAllResolvedTask()}
                disabled={resolvedTaskQueue.length === 0}
              >
                {t("subtitle:translator.fields.remove_all_resolved_task")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {/* Token统计信息 */}
          {tokenStats.taskCount > 0 && (
            <Card className="mb-4">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Cpu className="h-5 w-5" />
                  <CardTitle className="text-lg">Token消耗预估</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <Card className="border-muted">
                    <CardContent className="p-3">
                      <div className="text-muted-foreground text-xs mb-1">
                        总Token数
                      </div>
                      <div className="font-mono text-lg">
                        {formatTokens(tokenStats.totalTokens)}
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="border-muted">
                    <CardContent className="p-3">
                      <div className="text-muted-foreground text-xs mb-1">
                        预估总费用
                      </div>
                      <div className="font-mono text-lg">
                        {formatCost(tokenStats.totalCost)}
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="border-muted">
                    <CardContent className="p-3">
                      <div className="text-muted-foreground text-xs mb-1">
                        待处理Token
                      </div>
                      <div className="font-mono text-lg text-orange-600">
                        {formatTokens(tokenStats.pendingTokens)}
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="border-muted">
                    <CardContent className="p-3">
                      <div className="text-muted-foreground text-xs mb-1">
                        待处理费用
                      </div>
                      <div className="font-mono text-lg text-orange-600">
                        {formatCost(tokenStats.pendingCost)}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </CardContent>
            </Card>
          )}

          {/* 任务列表 */}
          <div className="space-y-4">
            {[
              ...notStartedTaskQueue,
              ...waitingTaskQueue,
              ...pendingTaskQueue,
              ...resolvedTaskQueue,
              ...failedTaskQueue,
            ].map((task, index) => (
              <Card key={index}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4 flex-1">
                      <div
                        className={`w-3 h-3 rounded-full ${getTaskStatusColor(
                          task.status
                        )}`}
                      />
                      <div className="font-medium flex-1">
                        {task.fileName}
                        <div className="text-sm text-muted-foreground mt-1">
                          {/* 显示任务状态 */}
                          {t(
                            `subtitle:translator.task_status.${task.status.toLowerCase()}`
                          )}
                          {task.status === TaskStatus.PENDING &&
                            ` ${Math.round(task.progress || 0)}% (${
                              task.resolvedFragments || 0
                            }/${task.totalFragments || 0})`}
                          {/* 显示分片模式 */}
                          <span className="ml-4 px-2 py-1 bg-muted-foreground/20 rounded text-xs">
                            {t(
                              `subtitle:translator.slice_types.${task.sliceType.toLowerCase()}`
                            )}
                          </span>
                          {/* 显示token预估信息 */}
                          {task.costEstimate && (
                            <span className="ml-4 font-mono">
                              Tokens:{" "}
                              {formatTokens(task.costEstimate.totalTokens)}
                              <span className="ml-2 text-green-600">
                                ~{formatCost(task.costEstimate.estimatedCost)}
                              </span>
                            </span>
                          )}
                          {/* 显示输出路径（完成后） */}
                          {task.status === TaskStatus.RESOLVED &&
                            task.extraInfo?.outputFilePath && (
                              <span className="ml-4 font-mono text-xs text-green-600">
                                输出: {task.extraInfo.outputFilePath}
                              </span>
                            )}
                        </div>
                      </div>
                    </div>

                    <ButtonGroup>
                      {/* 查看错误详情按钮 - 仅失败任务显示 */}
                      {task.status === TaskStatus.FAILED && (
                        <Button
                          variant="outline"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => openErrorModal(task)}
                        >
                          <AlertTriangle className="h-5 w-5" />
                        </Button>
                      )}

                      {/* 重试按钮 - 仅失败任务显示 */}
                      {task.status === TaskStatus.FAILED && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => retryTask(task.fileName)}
                        >
                          <RotateCw className="h-5 w-5" />
                        </Button>
                      )}

                      {/* 开始按钮 - 仅未开始任务显示 */}
                      {task.status === TaskStatus.NOT_STARTED && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => startTask(task.fileName)}
                        >
                          <PlayCircle className="h-5 w-5" />
                        </Button>
                      )}

                      {/* 取消按钮 - 仅进行中和等待中任务显示 */}
                      {(task.status === TaskStatus.PENDING ||
                        task.status === TaskStatus.WAITING) && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => cancelTask(task.fileName)}
                        >
                          <X className="h-5 w-5" />
                        </Button>
                      )}

                      {/* 删除按钮 - 所有状态都可删除 */}
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => deleteTask(task.fileName)}
                      >
                        <Trash2 className="h-5 w-5" />
                      </Button>
                    </ButtonGroup>
                  </div>

                  {task.status === TaskStatus.PENDING && (
                    <Progress value={task.progress} className="w-full mt-2" />
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {!notStartedTaskQueue.length &&
            !waitingTaskQueue.length &&
            !pendingTaskQueue.length &&
            !resolvedTaskQueue.length &&
            !failedTaskQueue.length && (
              <div className="text-center py-8 text-muted-foreground">
                {t("subtitle:translator.fields.no_tasks")}
              </div>
            )}
        </CardContent>
      </Card>

      {/* 错误详情模态框 */}
      {selectedErrorTask && (
        <ErrorDetailModal
          isOpen={errorModalOpen}
          onClose={closeErrorModal}
          taskName={selectedErrorTask.fileName}
          errorMessage={selectedErrorTask.extraInfo?.message || "未知错误"}
          errorDetails={selectedErrorTask.extraInfo?.error || "无详细错误信息"}
          errorLogs={
            selectedErrorTask.extraInfo?.errorLogs ||
            selectedErrorTask.errorLog ||
            []
          }
          timestamp={selectedErrorTask.extraInfo?.timestamp}
        />
      )}
    </div>
  );
}

export default SubtitleTranslator;
