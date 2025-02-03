import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import {
  SubtitleFileType,
  SubtitleSliceType,
  TaskStatus,
  type SubtitleTranslatorTask,
} from "@/type/subtitle";
import { useTranslation } from "react-i18next";
import { useState } from "react";

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
  } = useSubtitleTranslatorStore();

  const [customLengthInput, setCustomLengthInput] = useState(
    sliceLengthMap?.[SubtitleSliceType.CUSTOM]?.toString() || "500"
  );

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // 遍历所有选中的文件
    Array.from(files).forEach((file) => {
      const extension = file.name.split(".").pop()?.toUpperCase();
      if (
        !Object.values(SubtitleFileType).includes(extension as SubtitleFileType)
      ) {
        // 如果文件类型不支持，显示错误提示
        alert(
          t("subtitle:translator.errors.invalid_file_type").replace(
            "{types}",
            extension || " - "
          )
        );
        return; // 跳过此文件
      }

      // 为每个文件生成 URL 并创建任务
      const fileUrl = URL.createObjectURL(file);
      const newTask: SubtitleTranslatorTask = {
        fileName: file.name,
        fileType: extension as SubtitleFileType,
        sliceType, // 使用当前配置的分片模式
        originFileURL: fileUrl,
        targetFileURL: "",
        status: TaskStatus.NOT_STARTED,
        progress: 0,
      };
      addTask(newTask); // 将任务添加到任务队列
    });
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

          {/* 文件类型选择 */}
          {/* <div className="form-control -mt-2">
            <label className="label -mb-2">
              <span className="label-text">
                {t("subtitle:translator.fields.subtitle_file_type")}
              </span>
            </label>
            <div className="join">
              {Object.values(SubtitleFileType).map((type, index) => (
                <input
                  key={type}
                  type="radio"
                  aria-label={type}
                  checked={fileType === type}
                  className={`join-item btn btn-sm bg-base-100 ${
                    index > 0 ? "mt-[3px]" : ""
                  }`}
                  onClick={() => setFileType(type)}
                ></input>
              ))}
            </div>
          </div> */}

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
                  onClick={() => setSliceType(type)}
                ></input>
              ))}
            </div>
          </div>

          {/* 自定义分片长度输入 */}
          {sliceType === SubtitleSliceType.CUSTOM && (
            <div className="form-control mt-4">
              <label className="label">
                <span className="label-text">
                  {t("subtitle:translator.fields.custom_slice_length")} (chars)
                </span>
              </label>
              <input
                type="number"
                className="input input-bordered input-sm w-32"
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

      {/* 文件上传区域 */}
      <div className="mb-4">
        <div className="bg-base-200 p-4 rounded-lg">
          <div className="text-xl font-semibold mb-4">
            {t("subtitle:translator.upload_section")}
          </div>
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 cursor-pointer hover:bg-base-300 transition-colors">
            <input
              type="file"
              multiple
              className="hidden"
              accept=".lrc,.srt"
              onChange={handleFileUpload}
            />
            <div className="text-4xl mb-2">📁</div>
            <div className="text-center">
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
          <button
            className="btn btn-primary btn-sm"
            onClick={() => startAllTasks()}
            disabled={notStartedTaskQueue.length === 0}
          >
            {t("subtitle:translator.fields.start_all")}
          </button>
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
                      {t(
                        `subtitle:translator.task_status.${task.status.toLowerCase()}`
                      )}
                      {task.status === TaskStatus.PENDING &&
                        ` (${Math.round(task.progress || 0)}%)`}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {task.status === TaskStatus.FAILED && (
                    <button
                      className="btn btn-error btn-xs"
                      onClick={() => retryTask(task.originFileURL)}
                    >
                      {t("common:retry")}
                    </button>
                  )}
                  {task.status === TaskStatus.NOT_STARTED && (
                    <button
                      className="btn btn-primary btn-xs"
                      onClick={() => startTask(task.originFileURL)}
                    >
                      {t("common:start")}
                    </button>
                  )}
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
    </div>
  );
}

export default SubtitleTranslator;
