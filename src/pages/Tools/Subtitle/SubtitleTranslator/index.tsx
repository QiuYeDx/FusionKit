import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import {
  SubtitleFileType,
  SubtitleSliceType,
  TaskStatus,
  type SubtitleTranslatorTask,
} from "@/type/subtitle";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import {
  ArrowPathIcon,
  FolderIcon,
  FolderOpenIcon,
  PlayCircleIcon,
  XMarkIcon,
  TrashIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { showToast } from "@/utils/toast";
import useModelStore from "@/store/useModelStore";
import ErrorDetailModal from "@/components/ErrorDetailModal";

function SubtitleTranslator() {
  const { t } = useTranslation();
  const {
    // fileType,
    sliceType,
    sliceLengthMap,
    notStartedTaskQueue,
    waitingTaskQueue,
    pendingTaskQueue,
    resolvedTaskQueue,
    failedTaskQueue,
    // setFileType,
    setSliceType,
    setCustomSliceLength,
    addTask,
    startTask,
    retryTask,
    startAllTasks,
    removeAllResolvedTask,
    cancelTask,
    deleteTask,
  } = useSubtitleTranslatorStore();
  const { model, getApiKeyByType, getModelKeyByType, getModelUrlByType } =
    useModelStore();

  const [customLengthInput, setCustomLengthInput] = useState(
    sliceLengthMap?.[SubtitleSliceType.CUSTOM]?.toString() || "500"
  );

  const [isDragging, setIsDragging] = useState(false);

  // 保存用户选择的文件输出路径
  const [outputURL, setOutputURL] = useState<string>("");

  // 错误详情模态框状态
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [selectedErrorTask, setSelectedErrorTask] = useState<SubtitleTranslatorTask | null>(null);

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

        // 创建任务
        const newTask: SubtitleTranslatorTask = {
          fileName: file.name,
          fileContent, // 设置文件内容
          sliceType,
          originFileURL: URL.createObjectURL(file),
          targetFileURL: outputURL,
          status: TaskStatus.NOT_STARTED,
          progress: 0,

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
        <div className="bg-base-200 p-4 rounded-lg">
          <div className="text-xl font-semibold mb-2">
            {t("subtitle:translator.config_title")}
          </div>

          {/* 分片模式选择 */}
          <div className="form-control -ml-1">
            <label className="label -mb-2">
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
                  {t("subtitle:translator.fields.custom_slice_length")} (chars)
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
      </div>

      {/* 输出设置区块 */}
      <div className="mb-4">
        <div className="bg-base-200 p-4 rounded-lg">
          <div className="text-xl font-semibold mb-4">
            {t("subtitle:translator.output_path_section")}
          </div>
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
                      <span className="ml-4">
                        {t(
                          `subtitle:translator.slice_types.${task.sliceType.toLowerCase()}`
                        )}
                      </span>
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
          errorLogs={selectedErrorTask.extraInfo?.errorLogs || selectedErrorTask.errorLog || []}
          timestamp={selectedErrorTask.extraInfo?.timestamp}
        />
      )}
    </div>
  );
}

export default SubtitleTranslator;
