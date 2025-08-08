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
  ArrowPathIcon,
  FolderIcon,
  FolderOpenIcon,
  PlayCircleIcon,
  XMarkIcon,
  TrashIcon,
  ExclamationTriangleIcon,
  CpuChipIcon,
  ChevronDownIcon,
} from "@heroicons/react/24/outline";
import { showToast } from "@/utils/toast";
import useModelStore from "@/store/useModelStore";
import ErrorDetailModal from "@/components/ErrorDetailModal";
import {
  estimateSubtitleTokens,
  formatTokens,
  formatCost,
} from "@/utils/tokenEstimate";

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
      const result = await window.ipcRenderer.invoke("select-output-directory");

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
        console.error("读取文件失败:", error);
        showToast(`读取文件 ${file.name} 失败`, "error");
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
      <div className="mb-6 text-gray-600 dark:text-gray-300">
        {t("subtitle:translator.description")}
      </div>

      {/* 配置区块 */}
      <div className="flex flex-col gap-4 mb-4">
        <div className="bg-base-200 rounded-lg">
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsConfigOpen((v) => !v)}
          >
            <div className="text-xl font-semibold">
              {t("subtitle:translator.config_title")}
            </div>
            <ChevronDownIcon
              className={`h-5 w-5 transition-transform ${
                isConfigOpen ? "rotate-180" : ""
              }`}
            />
          </div>
          {isConfigOpen && (
            <div className="-mt-2 p-4 pt-0">
              {/* 分片模式选择 */}
              <div className="form-control -ml-1">
                <label className="label -mb-2 pt-0">
                  <span className="label-text">
                    {t("subtitle:translator.fields.subtitle_slice_mode")}
                  </span>
                </label>
                <div className="join -ml-0.5">
                  {Object.values(SubtitleSliceType).map((type, index) => (
                    <input
                      type="radio"
                      checked={sliceType === type}
                      name="subtitle_slice_type"
                      aria-label={t(
                        `subtitle:translator.slice_types.${type.toLowerCase()}`
                      )}
                      key={type}
                      className={`join-item btn btn-sm bg-base-100 ${
                        index > 0 ? "mt-[3px]" : ""
                      }`}
                      onChange={() => {}} // 防止显示控制台警告
                      onClick={() => setSliceType(type)}
                    ></input>
                  ))}
                </div>
              </div>

              {/* 自定义分片长度输入 */}
              {sliceType === SubtitleSliceType.CUSTOM && (
                <div className="form-control mt-2">
                  <label className="label -ml-1 -mb-1">
                    <span className="label-text">
                      {t("subtitle:translator.fields.custom_slice_length")}{" "}
                      (chars)
                    </span>
                  </label>
                  <input
                    type="number"
                    className="input input-sm input-bordered box-border w-32"
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
            </div>
          )}
        </div>
      </div>

      {/* 输出设置区块 */}
      <div className="mb-4">
        <div className="bg-base-200 rounded-lg">
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsOutputOpen((v) => !v)}
          >
            <div className="text-xl font-semibold">
              {t("subtitle:translator.output_path_section")}
            </div>
            <ChevronDownIcon
              className={`h-5 w-5 transition-transform ${
                isOutputOpen ? "rotate-180" : ""
              }`}
            />
          </div>
          {isOutputOpen && (
            <div className="-mt-2 p-4 pt-0">
              <div className="flex items-center gap-4">
                <div className="join grow">
                  <button
                    onClick={handleSelectOutputPath}
                    className="btn btn-primary btn-sm join-item"
                  >
                    {t("subtitle:translator.fields.select_output_path")}
                  </button>
                  <input
                    type="text"
                    placeholder={t(
                      "subtitle:translator.fields.no_output_path_selected"
                    )}
                    value={outputURL}
                    onChange={() => {}} // 防止显示控制台警告
                    className="join-item input input-sm input-bordered box-border grow shrink-0"
                  />
                </div>
              </div>

              {/* TODO: 输出文件前缀、后缀设置 */}
            </div>
          )}
        </div>
      </div>

      {/* 定时开始设置 */}
      <div className="mb-4">
        <div className="bg-base-200 rounded-lg">
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsScheduleOpen((v) => !v)}
          >
            <div className="text-xl font-semibold">定时开始</div>
            <ChevronDownIcon
              className={`h-5 w-5 transition-transform ${
                isScheduleOpen ? "rotate-180" : ""
              }`}
            />
          </div>
          {isScheduleOpen && (
            <div className="-mt-2 p-4 pt-0">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div className="form-control">
                  <label className="label -ml-1 -mb-1">
                    <span className="label-text">开始时间</span>
                  </label>
                  <input
                    type="datetime-local"
                    className="input input-sm input-bordered"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                    min={new Date(Date.now() + 60_000)
                      .toISOString()
                      .slice(0, 16)}
                  />
                </div>
                <div className="form-control">
                  <label className="label cursor-pointer space-x-2">
                    <span className="label-text">防止系统睡眠直到开始</span>
                    <input
                      type="checkbox"
                      className="toggle toggle-sm"
                      checked={preventSleep}
                      onChange={(e) => setPreventSleep(e.target.checked)}
                    />
                  </label>
                  <span className="text-xs text-gray-500">
                    仅防止因空闲触发的睡眠，不阻止手动睡眠或合盖
                  </span>
                </div>
                <div className="flex gap-2">
                  {!scheduleEnabled ? (
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={
                        !scheduleTime || !Number.isFinite(targetEpochMs)
                      }
                      onClick={async () => {
                        if (!scheduleTime || !Number.isFinite(targetEpochMs))
                          return;
                        if (targetEpochMs <= Date.now()) {
                          showToast("请选择未来的时间", "default");
                          return;
                        }
                        hasTriggeredRef.current = false;
                        setScheduleEnabled(true);
                        if (preventSleep)
                          await startPowerBlockerUntil(targetEpochMs);
                        showToast("已设置定时开始", "success");
                      }}
                    >
                      启用定时
                    </button>
                  ) : (
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => cancelSchedule()}
                    >
                      取消定时
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-2 text-sm text-gray-600">
                <span className="mr-2">状态：</span>
                {scheduleEnabled ? (
                  <span>
                    已启用，倒计时 {formatRemaining(remainingMs)}
                    {blockerId != null && (
                      <span className="ml-2 text-xs text-green-600">
                        已防睡眠
                      </span>
                    )}
                  </span>
                ) : (
                  <span>未启用</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Token消耗预估配置显示 */}
      <div className="mb-4">
        <div className="bg-base-200 rounded-lg">
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsNewTaskConfigOpen((v) => !v)}
          >
            <div className="text-xl font-semibold">新任务配置</div>
            <ChevronDownIcon
              className={`h-5 w-5 transition-transform ${
                isNewTaskConfigOpen ? "rotate-180" : ""
              }`}
            />
          </div>
          {isNewTaskConfigOpen && (
            <div className="-mt-2 p-4 pt-0">
              <div className="text-sm text-gray-600 dark:text-gray-300 mb-3">
                当前分片模式配置，将应用于新添加的任务。已存在的任务保持创建时的配置不变。
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div className="bg-base-100 rounded p-3">
                  <div className="text-gray-500 text-xs mb-1">当前分片模式</div>
                  <div className="font-medium">
                    {t(
                      `subtitle:translator.slice_types.${sliceType.toLowerCase()}`
                    )}
                    {sliceType === SubtitleSliceType.CUSTOM && (
                      <span className="ml-1 text-gray-500">
                        ({sliceLengthMap[SubtitleSliceType.CUSTOM]}字符)
                      </span>
                    )}
                  </div>
                </div>
                <div className="bg-base-100 rounded p-3">
                  <div className="text-gray-500 text-xs mb-1">
                    费率 (输入/输出)
                  </div>
                  <div className="font-mono text-sm">
                    $
                    {getTokenPricingByType(model).inputTokensPerMillion.toFixed(
                      2
                    )}
                    /$
                    {getTokenPricingByType(
                      model
                    ).outputTokensPerMillion.toFixed(2)}{" "}
                    per 1M tokens
                  </div>
                </div>
                <div className="bg-base-100 rounded p-3">
                  <div className="text-gray-500 text-xs mb-1">任务总数</div>
                  <div className="font-medium">
                    {tokenStats.taskCount} 个任务
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 文件上传区域 */}
      <div className="mb-4">
        <div className="bg-base-200 p-4 rounded-lg">
          <div className="text-xl font-semibold mb-4">
            {t("subtitle:translator.upload_section")}
          </div>
          <label
            className={`flex flex-col items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 cursor-pointer transition-colors file-drop-zone ${
              isDragging
                ? "border-blue-500 bg-blue-50 dark:bg-blue-700 dark:bg-opacity-30"
                : "hover:bg-base-300"
            }`}
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
                <FolderOpenIcon className="h-10" />
              ) : (
                <FolderIcon className="h-10" />
              )}
            </div>
            <div className="text-center pointer-events-none">
              <p className="font-medium">
                {t("subtitle:translator.fields.upload_tips")}
              </p>
              <p className="text-sm text-gray-500 mt-1">
                {t("subtitle:translator.fields.files_only").replace(
                  "{formats}",
                  ".lrc, .srt"
                )}
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* 任务管理区域 */}
      <div className="bg-base-200 p-4 rounded-lg mb-12">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xl font-semibold">
            {t("subtitle:translator.task_management")}
          </div>
          <div className="flex gap-2">
            {/* 全部开始 */}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => startAllTasks()}
              disabled={notStartedTaskQueue.length === 0}
            >
              {t("subtitle:translator.fields.start_all")}
            </button>
            {/* 清空完成 */}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => removeAllResolvedTask()}
              disabled={resolvedTaskQueue.length === 0}
            >
              {t("subtitle:translator.fields.remove_all_resolved_task")}
            </button>
          </div>
        </div>

        {/* Token统计信息 */}
        {tokenStats.taskCount > 0 && (
          <div className="bg-base-100 rounded-lg p-4 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <CpuChipIcon className="h-5 w-5" />
              <span className="font-semibold">Token消耗预估</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div className="bg-base-200 rounded p-3">
                <div className="text-gray-500 text-xs mb-1">总Token数</div>
                <div className="font-mono text-lg">
                  {formatTokens(tokenStats.totalTokens)}
                </div>
              </div>
              <div className="bg-base-200 rounded p-3">
                <div className="text-gray-500 text-xs mb-1">预估总费用</div>
                <div className="font-mono text-lg">
                  {formatCost(tokenStats.totalCost)}
                </div>
              </div>
              <div className="bg-base-200 rounded p-3">
                <div className="text-gray-500 text-xs mb-1">待处理Token</div>
                <div className="font-mono text-lg text-orange-600">
                  {formatTokens(tokenStats.pendingTokens)}
                </div>
              </div>
              <div className="bg-base-200 rounded p-3">
                <div className="text-gray-500 text-xs mb-1">待处理费用</div>
                <div className="font-mono text-lg text-orange-600">
                  {formatCost(tokenStats.pendingCost)}
                </div>
              </div>
            </div>
          </div>
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
            <div key={index} className="bg-base-100 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 flex-1">
                  <div
                    className={`w-3 h-3 rounded-full ${getTaskStatusColor(
                      task.status
                    )}`}
                  />
                  <div className="font-medium flex-1">
                    {task.fileName}
                    <div className="text-sm text-gray-500 mt-1">
                      {/* 显示任务状态 */}
                      {t(
                        `subtitle:translator.task_status.${task.status.toLowerCase()}`
                      )}
                      {task.status === TaskStatus.PENDING &&
                        ` ${Math.round(task.progress || 0)}% (${
                          task.resolvedFragments || 0
                        }/${task.totalFragments || 0})`}
                      {/* 显示分片模式 */}
                      <span className="ml-4 px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-xs">
                        {t(
                          `subtitle:translator.slice_types.${task.sliceType.toLowerCase()}`
                        )}
                      </span>
                      {/* 显示token预估信息 */}
                      {task.costEstimate && (
                        <span className="ml-4 font-mono">
                          Tokens: {formatTokens(task.costEstimate.totalTokens)}
                          <span className="ml-2 text-green-600">
                            ~{formatCost(task.costEstimate.estimatedCost)}
                          </span>
                        </span>
                      )}
                      {/* 显示输出路径（完成后） */}
                      {task.status === TaskStatus.RESOLVED && task.extraInfo?.outputFilePath && (
                        <span className="ml-4 font-mono text-xs text-green-600">
                          输出: {task.extraInfo.outputFilePath}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {/* 查看错误详情按钮 - 仅失败任务显示 */}
                  {task.status === TaskStatus.FAILED && (
                    <a
                      className="cursor-pointer tooltip text-error"
                      data-tip="查看错误详情"
                      onClick={() => openErrorModal(task)}
                    >
                      <ExclamationTriangleIcon className="size-6" />
                    </a>
                  )}

                  {/* 重试按钮 - 仅失败任务显示 */}
                  {task.status === TaskStatus.FAILED && (
                    <a
                      className="cursor-pointer tooltip"
                      data-tip={t("subtitle:translator.actions.retry")}
                      onClick={() => retryTask(task.fileName)}
                    >
                      <ArrowPathIcon className="size-6" />
                    </a>
                  )}

                  {/* 开始按钮 - 仅未开始任务显示 */}
                  {task.status === TaskStatus.NOT_STARTED && (
                    <a
                      className="cursor-pointer tooltip"
                      data-tip={t("subtitle:translator.actions.start")}
                      onClick={() => startTask(task.fileName)}
                    >
                      <PlayCircleIcon className="size-6" />
                    </a>
                  )}

                  {/* 取消按钮 - 仅进行中和等待中任务显示 */}
                  {(task.status === TaskStatus.PENDING ||
                    task.status === TaskStatus.WAITING) && (
                    <a
                      className="cursor-pointer tooltip"
                      data-tip={t("subtitle:translator.actions.cancel")}
                      onClick={() => cancelTask(task.fileName)}
                    >
                      <XMarkIcon className="size-6" />
                    </a>
                  )}

                  {/* 删除按钮 - 所有状态都可删除 */}
                  <a
                    className="cursor-pointer tooltip"
                    data-tip={t("subtitle:translator.actions.delete")}
                    onClick={() => deleteTask(task.fileName)}
                  >
                    <TrashIcon className="size-6" />
                  </a>
                </div>
              </div>

              {task.status === TaskStatus.PENDING && (
                <progress
                  className="progress progress-primary w-full mt-2"
                  value={task.progress}
                  max="100"
                />
              )}
            </div>
          ))}
        </div>

        {!notStartedTaskQueue.length &&
          !waitingTaskQueue.length &&
          !pendingTaskQueue.length &&
          !resolvedTaskQueue.length &&
          !failedTaskQueue.length && (
            <div className="text-center py-8 text-gray-500">
              {t("subtitle:translator.fields.no_tasks")}
            </div>
          )}
      </div>

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
