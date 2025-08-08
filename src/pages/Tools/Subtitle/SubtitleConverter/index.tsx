import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { SubtitleFileType, TaskStatus } from "@/type/subtitle";
import { showToast } from "@/utils/toast";
import ErrorDetailModal from "@/components/ErrorDetailModal";

interface SubtitleConverterTask {
  fileName: string;
  fileContent: string;
  from: SubtitleFileType;
  to: SubtitleFileType;
  originFileURL: string;
  targetFileURL: string;
  status: TaskStatus;
  progress?: number;
  errorLog?: string[];
  extraInfo?: { [key: string]: any };
  outputFilePath?: string;
}

function SubtitleConverter() {
  const { t } = useTranslation();

  // 折叠状态
  const [isConfigOpen, setIsConfigOpen] = useState<boolean>(true);
  const [isOutputOpen, setIsOutputOpen] = useState<boolean>(true);
  const [isSummaryOpen, setIsSummaryOpen] = useState<boolean>(true);

  // 配置
  const [direction, setDirection] = useState<"LRC_TO_SRT" | "SRT_TO_LRC">(
    "LRC_TO_SRT"
  );
  const [defaultDurationSec, setDefaultDurationSec] = useState<string>("2");

  // 输出路径
  const [outputURL, setOutputURL] = useState<string>(
    localStorage.getItem("subtitle-converter-output-url") || ""
  );

  useEffect(() => {
    try {
      localStorage.setItem("subtitle-converter-output-url", outputURL);
    } catch {}
  }, [outputURL]);

  // 拖拽
  const [isDragging, setIsDragging] = useState(false);

  // 任务
  const [tasks, setTasks] = useState<SubtitleConverterTask[]>([]);

  const notStartedTasks = useMemo(
    () => tasks.filter((t) => t.status === TaskStatus.NOT_STARTED),
    [tasks]
  );
  const pendingTasks = useMemo(
    () => tasks.filter((t) => t.status === TaskStatus.PENDING),
    [tasks]
  );
  const resolvedTasks = useMemo(
    () => tasks.filter((t) => t.status === TaskStatus.RESOLVED),
    [tasks]
  );
  const failedTasks = useMemo(
    () => tasks.filter((t) => t.status === TaskStatus.FAILED),
    [tasks]
  );

  // 错误详情
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [selectedErrorTask, setSelectedErrorTask] =
    useState<SubtitleConverterTask | null>(null);

  const openErrorModal = (task: SubtitleConverterTask) => {
    setSelectedErrorTask(task);
    setErrorModalOpen(true);
  };
  const closeErrorModal = () => {
    setErrorModalOpen(false);
    setSelectedErrorTask(null);
  };

  const handleSelectOutputPath = async () => {
    try {
      const result = await window.ipcRenderer.invoke(
        "select-output-directory",
        {
          title: t("subtitle:converter.dialog.select_output_title"),
          buttonLabel: t("subtitle:converter.dialog.select_output_confirm"),
        }
      );
      if (result && !result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        setOutputURL(selectedPath);
        showToast(
          t("subtitle:converter.infos.output_path_selected"),
          "success"
        );
      }
    } catch (error) {
      showToast(t("subtitle:converter.errors.path_selection_failed"), "error");
    }
  };

  const handleDragEnter = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const handleDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
  };
  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload({
        target: { files },
      } as React.ChangeEvent<HTMLInputElement>);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!outputURL) {
      showToast(
        t("subtitle:converter.errors.please_select_output_url"),
        "error"
      );
      return;
    }
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const existingNames = tasks.map((t) => t.fileName);

    for (const file of Array.from(files)) {
      const ext = file.name.split(".").pop()?.toUpperCase();
      if (
        !ext ||
        ![SubtitleFileType.LRC, SubtitleFileType.SRT].includes(ext as any)
      ) {
        showToast(
          t("subtitle:converter.errors.invalid_file_type").replace(
            "{types}",
            ext || "-"
          ),
          "error"
        );
        continue;
      }
      if (existingNames.includes(file.name)) {
        showToast(
          t("subtitle:converter.errors.duplicate_file").replace(
            "{file}",
            file.name
          ),
          "error"
        );
        continue;
      }

      try {
        const fileContent = await file.text();
        const from = ext as SubtitleFileType;
        const to =
          from === SubtitleFileType.LRC
            ? SubtitleFileType.SRT
            : SubtitleFileType.LRC;

        const newTask: SubtitleConverterTask = {
          fileName: file.name,
          fileContent,
          from,
          to,
          originFileURL: URL.createObjectURL(file),
          targetFileURL: outputURL,
          status: TaskStatus.NOT_STARTED,
          progress: 0,
        };
        setTasks((prev) => [...prev, newTask]);
      } catch (err) {
        showToast(
          t("subtitle:converter.errors.read_file_failed").replace(
            "{file}",
            file.name
          ),
          "error"
        );
      }
    }
  };

  const startTask = async (fileName: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.fileName === fileName
          ? { ...t, status: TaskStatus.PENDING, progress: 10 }
          : t
      )
    );

    const task = tasks.find((t) => t.fileName === fileName);
    if (!task) return;

    try {
      const defaultDurationMs =
        Math.max(0, Math.floor(Number(defaultDurationSec) * 1000)) || 2000;
      const res = await window.ipcRenderer.invoke("convert-subtitle", {
        fileName: task.fileName,
        fileContent: task.fileContent,
        from: task.from,
        to: task.to,
        outputDir: task.targetFileURL,
        defaultDurationMs,
      });
      setTasks((prev) =>
        prev.map((t) =>
          t.fileName === fileName
            ? {
                ...t,
                status: TaskStatus.RESOLVED,
                progress: 100,
                outputFilePath: res?.outputFilePath,
              }
            : t
        )
      );
      showToast(
        t("subtitle:converter:infos.task_convert_done").replace(
          "{file}",
          fileName
        ),
        "success"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTasks((prev) =>
        prev.map((t) =>
          t.fileName === fileName
            ? {
                ...t,
                status: TaskStatus.FAILED,
                progress: 0,
                extraInfo: { message, error },
              }
            : t
        )
      );
      showToast(
        t("subtitle:converter:errors.task_convert_failed").replace(
          "{file}",
          fileName
        ),
        "error"
      );
    }
  };

  const startAllTasks = async () => {
    const targets = tasks.filter((t) => t.status === TaskStatus.NOT_STARTED);
    for (const t of targets) {
      // 顺序执行，避免磁盘抖动；转换轻量，速度可接受
      // 如需并发，可 Promise.all 或限制并发
      // eslint-disable-next-line no-await-in-loop
      await startTask(t.fileName);
    }
  };

  const retryTask = (fileName: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.fileName === fileName
          ? {
              ...t,
              status: TaskStatus.NOT_STARTED,
              progress: 0,
              extraInfo: undefined,
            }
          : t
      )
    );
  };

  const removeAllResolvedTask = () => {
    setTasks((prev) => prev.filter((t) => t.status !== TaskStatus.RESOLVED));
  };

  const deleteTask = (fileName: string) => {
    setTasks((prev) => prev.filter((t) => t.fileName !== fileName));
    showToast(t("subtitle:converter:infos.task_deleted"), "success");
  };

  const getTaskStatusColor = (status: TaskStatus) => {
    switch (status) {
      case TaskStatus.NOT_STARTED:
        return "bg-gray-500";
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
        {t("subtitle:converter:title")}
      </div>
      <div className="mb-6 text-gray-600 dark:text-gray-300">
        {t("subtitle:converter:description")}
      </div>

      {/* 配置选项 */}
      <div className="flex flex-col gap-4 mb-4">
        <div className="bg-base-200 rounded-lg">
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsConfigOpen((v) => !v)}
          >
            <div className="text-xl font-semibold">
              {t("subtitle:converter:config_title")}
            </div>
            <ChevronDownIcon
              className={`h-5 w-5 transition-transform ${
                isConfigOpen ? "rotate-180" : ""
              }`}
            />
          </div>
          {isConfigOpen && (
            <div className="-mt-2 p-4 pt-0">
              <div className="form-control -ml-1">
                <label className="label -mb-2 pt-0">
                  <span className="label-text">
                    {t("subtitle:converter:fields.convert_direction")}
                  </span>
                </label>
                <div className="join -ml-0.5">
                  <input
                    type="radio"
                    className="join-item btn btn-sm bg-base-100"
                    name="convert_dir"
                    aria-label={t("subtitle:converter:fields.lrc_to_srt")}
                    checked={direction === "LRC_TO_SRT"}
                    onChange={() => setDirection("LRC_TO_SRT")}
                  />
                  <input
                    type="radio"
                    className="join-item btn btn-sm bg-base-100 mt-[3px]"
                    name="convert_dir"
                    aria-label={t("subtitle:converter:fields.srt_to_lrc")}
                    checked={direction === "SRT_TO_LRC"}
                    onChange={() => setDirection("SRT_TO_LRC")}
                  />
                </div>
              </div>

              {direction === "LRC_TO_SRT" && (
                <div className="form-control mt-2">
                  <label className="label -ml-1 -mb-1">
                    <span className="label-text">
                      {t("subtitle:converter:fields.default_duration_label")}
                    </span>
                  </label>
                  <input
                    type="number"
                    className="input input-sm input-bordered box-border w-32"
                    value={defaultDurationSec}
                    min="1"
                    max="10"
                    onChange={(e) => setDefaultDurationSec(e.target.value)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 输出设置 */}
      <div className="mb-4">
        <div className="bg-base-200 rounded-lg">
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsOutputOpen((v) => !v)}
          >
            <div className="text-xl font-semibold">
              {t("subtitle:converter:output_path_section")}
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
                    {t("subtitle:converter:fields.select_output_path")}
                  </button>
                  <input
                    type="text"
                    placeholder={t(
                      "subtitle:converter:fields.no_output_path_selected"
                    )}
                    value={outputURL}
                    onChange={() => {}}
                    className="join-item input input-sm input-bordered box-border grow shrink-0"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 配置摘要 */}
      <div className="mb-4">
        <div className="bg-base-200 rounded-lg">
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsSummaryOpen((v) => !v)}
          >
            <div className="text-xl font-semibold">
              {t("subtitle:converter:summary_title")}
            </div>
            <ChevronDownIcon
              className={`h-5 w-5 transition-transform ${
                isSummaryOpen ? "rotate-180" : ""
              }`}
            />
          </div>
          {isSummaryOpen && (
            <div className="-mt-2 p-4 pt-0">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div className="bg-base-100 rounded p-3">
                  <div className="text-gray-500 text-xs mb-1">
                    {t("subtitle:converter:fields.convert_direction")}
                  </div>
                  <div className="font-medium">
                    {direction === "LRC_TO_SRT"
                      ? t("subtitle:converter:fields.lrc_to_srt")
                      : t("subtitle:converter:fields.srt_to_lrc")}
                  </div>
                </div>
                {direction === "LRC_TO_SRT" && (
                  <div className="bg-base-100 rounded p-3">
                    <div className="text-gray-500 text-xs mb-1">
                      {t("subtitle:converter:summary.default_duration")}
                    </div>
                    <div className="font-medium">{defaultDurationSec}s</div>
                  </div>
                )}
                <div className="bg-base-100 rounded p-3">
                  <div className="text-gray-500 text-xs mb-1">
                    {t("subtitle:converter:summary.total_tasks")}
                  </div>
                  <div className="font-medium">
                    {t("subtitle:converter:summary.task_count").replace(
                      "{count}",
                      String(tasks.length)
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 文件上传 */}
      <div className="mb-4">
        <div className="bg-base-200 p-4 rounded-lg">
          <div className="text-xl font-semibold mb-4">
            {t("subtitle:converter:upload_section")}
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
                {t("subtitle:converter:fields.upload_tips")}
              </p>
              <p className="text-sm text-gray-500 mt-1">
                {t("subtitle:converter:fields.files_only")}
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* 任务管理 */}
      <div className="bg-base-200 p-4 rounded-lg mb-12">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xl font-semibold">
            {t("subtitle:converter:task_management")}
          </div>
          <div className="flex gap-2">
            <button
              className="btn btn-primary btn-sm"
              onClick={startAllTasks}
              disabled={notStartedTasks.length === 0}
            >
              {t("subtitle:converter:fields.start_all")}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={removeAllResolvedTask}
              disabled={resolvedTasks.length === 0}
            >
              {t("subtitle:converter:fields.remove_all_resolved_task")}
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div className="space-y-4">
          {tasks.map((task, index) => (
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
                      {task.status === TaskStatus.NOT_STARTED &&
                        t("subtitle:converter:task_status.notstarted")}
                      {task.status === TaskStatus.PENDING &&
                        ` ${t(
                          "subtitle:converter:task_status.pending"
                        )} ${Math.round(task.progress || 0)}%`}
                      {task.status === TaskStatus.RESOLVED &&
                        ` ${t("subtitle:converter:task_status.resolved")}`}
                      {task.status === TaskStatus.FAILED &&
                        ` ${t("subtitle:converter:task_status.failed")}`}
                      <span className="ml-4 px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-xs">
                        {task.from} → {task.to}
                      </span>
                      {task.outputFilePath && (
                        <span className="ml-4 font-mono text-xs text-green-600">
                          {t("subtitle:converter:labels.output")}:{" "}
                          {task.outputFilePath}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {task.status === TaskStatus.FAILED && (
                    <a
                      className="cursor-pointer tooltip text-error"
                      data-tip={t(
                        "subtitle:converter:actions.view_error_detail"
                      )}
                      onClick={() => openErrorModal(task)}
                    >
                      <ExclamationTriangleIcon className="size-6" />
                    </a>
                  )}

                  {task.status === TaskStatus.FAILED && (
                    <a
                      className="cursor-pointer tooltip"
                      data-tip={t("subtitle:converter:actions.retry")}
                      onClick={() => retryTask(task.fileName)}
                    >
                      <ArrowPathIcon className="size-6" />
                    </a>
                  )}

                  {task.status === TaskStatus.NOT_STARTED && (
                    <a
                      className="cursor-pointer tooltip"
                      data-tip={t("subtitle:converter:actions.start")}
                      onClick={() => startTask(task.fileName)}
                    >
                      <PlayCircleIcon className="size-6" />
                    </a>
                  )}

                  <a
                    className="cursor-pointer tooltip"
                    data-tip={t("subtitle:converter:actions.delete")}
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

        {tasks.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            {t("subtitle:converter:fields.no_tasks")}
          </div>
        )}
      </div>

      {selectedErrorTask && (
        <ErrorDetailModal
          isOpen={errorModalOpen}
          onClose={closeErrorModal}
          taskName={selectedErrorTask.fileName}
          errorMessage={selectedErrorTask.extraInfo?.message || "未知错误"}
          errorDetails={selectedErrorTask.extraInfo?.error || "无详细错误信息"}
          errorLogs={selectedErrorTask.errorLog || []}
        />
      )}
    </div>
  );
}

export default SubtitleConverter;
