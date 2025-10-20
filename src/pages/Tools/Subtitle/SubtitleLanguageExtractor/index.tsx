import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  RotateCw,
  Folder,
  FolderOpen,
  PlayCircle,
  X,
  Trash2,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import { SubtitleFileType, TaskStatus } from "@/type/subtitle";
import { showToast } from "@/utils/toast";
import ErrorDetailModal from "@/components/ErrorDetailModal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface ExtractTask {
  fileName: string;
  fileContent: string;
  fileType: SubtitleFileType;
  originFileURL: string;
  targetFileURL: string;
  keep: "ZH" | "JA";
  status: TaskStatus;
  progress?: number;
  errorLog?: string[];
  extraInfo?: { [key: string]: any };
  outputFilePath?: string;
}

function SubtitleLanguageExtractor() {
  const { t } = useTranslation();
  // 折叠状态
  const [isConfigOpen, setIsConfigOpen] = useState<boolean>(true);
  const [isOutputOpen, setIsOutputOpen] = useState<boolean>(true);
  const [isSummaryOpen, setIsSummaryOpen] = useState<boolean>(true);

  // 配置
  const [keep, setKeep] = useState<"ZH" | "JA">("ZH");

  // 输出路径
  const [outputURL, setOutputURL] = useState<string>(
    localStorage.getItem("subtitle-extractor-output-url") || ""
  );

  // 拖拽
  const [isDragging, setIsDragging] = useState(false);

  // 任务
  const [tasks, setTasks] = useState<ExtractTask[]>([]);

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
    useState<ExtractTask | null>(null);

  const openErrorModal = (task: ExtractTask) => {
    setSelectedErrorTask(task);
    setErrorModalOpen(true);
  };
  const closeErrorModal = () => {
    setErrorModalOpen(false);
    setSelectedErrorTask(null);
  };

  const handleSelectOutputPath = async () => {
    try {
      const result = await window.ipcRenderer.invoke("select-output-directory", {
        title: t("subtitle:extractor.dialog.select_output_title"),
        buttonLabel: t("subtitle:extractor.dialog.select_output_confirm"),
      });
      if (result && !result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        setOutputURL(selectedPath);
        localStorage.setItem("subtitle-extractor-output-url", selectedPath);
        showToast(t("subtitle:extractor.infos.output_path_selected"), "success");
      }
    } catch (error) {
      showToast(t("subtitle:extractor.errors.path_selection_failed"), "error");
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
      showToast(t("subtitle:extractor:errors.please_select_output_url"), "error");
      return;
    }
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const existingNames = tasks.map((t) => t.fileName);

    for (const file of Array.from(files)) {
      const ext = file.name.split(".").pop()?.toUpperCase();
      if (!ext || ![SubtitleFileType.LRC, SubtitleFileType.SRT].includes(ext as any)) {
        showToast(t("subtitle:extractor:errors.invalid_file_type").replace("{types}", ext || "-"), "error");
        continue;
      }
      if (existingNames.includes(file.name)) {
        showToast(t("subtitle:extractor:errors.duplicate_file").replace("{file}", file.name), "error");
        continue;
      }

      try {
        const fileContent = await file.text();
        const fileType = ext as SubtitleFileType;
        const newTask: ExtractTask = {
          fileName: file.name,
          fileContent,
          fileType,
          originFileURL: URL.createObjectURL(file),
          targetFileURL: outputURL,
          keep,
          status: TaskStatus.NOT_STARTED,
          progress: 0,
        };
        setTasks((prev) => [...prev, newTask]);
      } catch (err) {
        showToast(t("subtitle:extractor:errors.read_file_failed").replace("{file}", file.name), "error");
      }
    }
  };

  const startTask = async (fileName: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.fileName === fileName ? { ...t, status: TaskStatus.PENDING, progress: 10 } : t
      )
    );

    const task = tasks.find((t) => t.fileName === fileName);
    if (!task) return;

    try {
      const res = await window.ipcRenderer.invoke("extract-subtitle-language", {
        fileName: task.fileName,
        fileContent: task.fileContent,
        fileType: task.fileType,
        keep: task.keep,
        outputDir: task.targetFileURL,
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
      showToast(t("subtitle:extractor:infos.task_extract_done").replace("{file}", fileName), "success");
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
      showToast(t("subtitle:extractor:errors.task_extract_failed").replace("{file}", fileName), "error");
    }
  };

  const startAllTasks = async () => {
    const targets = tasks.filter((t) => t.status === TaskStatus.NOT_STARTED);
    for (const t of targets) {
      // 顺序执行
      // eslint-disable-next-line no-await-in-loop
      await startTask(t.fileName);
    }
  };

  const retryTask = (fileName: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.fileName === fileName
          ? { ...t, status: TaskStatus.NOT_STARTED, progress: 0, extraInfo: undefined }
          : t
      )
    );
  };

  const removeAllResolvedTask = () => {
    setTasks((prev) => prev.filter((t) => t.status !== TaskStatus.RESOLVED));
  };

  const deleteTask = (fileName: string) => {
    setTasks((prev) => prev.filter((t) => t.fileName !== fileName));
    showToast(t("subtitle:extractor:infos.task_deleted"), "success");
  };

  const getTaskStatusColor = (status: TaskStatus) => {
    switch (status) {
      case TaskStatus.NOT_STARTED:
        return "bg-secondary";
      case TaskStatus.PENDING:
        return "bg-yellow-500";
      case TaskStatus.RESOLVED:
        return "bg-green-500";
      case TaskStatus.FAILED:
        return "bg-red-500";
      default:
        return "bg-secondary";
    }
  };

  return (
    <div className="p-4">
      <div className="text-2xl font-bold mb-4">{t("subtitle:extractor:title")}</div>
      <div className="mb-6 text-muted-foreground">
        {t("subtitle:extractor:description")}
      </div>

      {/* 配置选项 */}
      <div className="flex flex-col gap-4 mb-4">
        <Card>
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsConfigOpen((v) => !v)}
          >
            <CardTitle className="text-xl">{t("subtitle:extractor:config_title")}</CardTitle>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isConfigOpen && "rotate-180"
              )}
            />
          </div>
          {isConfigOpen && (
            <CardContent className="pt-0">
              <div className="flex items-center gap-4">
                <Label className="text-sm font-medium min-w-[100px]">
                  {t("subtitle:extractor:fields.keep_language")}
                </Label>
                <ButtonGroup>
                  <Button
                    size="sm"
                    variant={keep === "ZH" ? "default" : "outline"}
                    onClick={() => setKeep("ZH")}
                  >
                    {t("subtitle:extractor:fields.zh_only")}
                  </Button>
                  <Button
                    size="sm"
                    variant={keep === "JA" ? "default" : "outline"}
                    onClick={() => setKeep("JA")}
                  >
                    {t("subtitle:extractor:fields.ja_only")}
                  </Button>
                </ButtonGroup>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* 输出设置 */}
      <div className="mb-4">
        <Card>
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsOutputOpen((v) => !v)}
          >
            <CardTitle className="text-xl">{t("subtitle:extractor:output_path_section")}</CardTitle>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isOutputOpen && "rotate-180"
              )}
            />
          </div>
          {isOutputOpen && (
            <CardContent className="pt-0">
              <div className="flex items-center gap-4">
                <Button onClick={handleSelectOutputPath} size="sm">
                  {t("subtitle:extractor:fields.select_output_path")}
                </Button>
                <Input
                  type="text"
                  placeholder={t("subtitle:extractor:fields.no_output_path_selected")}
                  value={outputURL}
                  onChange={() => {}}
                  className="grow"
                  readOnly
                />
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* 配置摘要 */}
      <div className="mb-4">
        <Card>
          <div
            className="flex items-center justify-between p-4 cursor-pointer select-none"
            onClick={() => setIsSummaryOpen((v) => !v)}
          >
            <CardTitle className="text-xl">{t("subtitle:extractor:summary_title")}</CardTitle>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isSummaryOpen && "rotate-180"
              )}
            />
          </div>
          {isSummaryOpen && (
            <CardContent className="pt-0">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div className="bg-muted rounded p-3">
                  <div className="text-muted-foreground text-xs mb-1">{t("subtitle:extractor:fields.keep_language")}</div>
                  <div className="font-medium">{keep === "ZH" ? t("subtitle:extractor:fields.zh") : t("subtitle:extractor:fields.ja")}</div>
                </div>
                <div className="bg-muted rounded p-3">
                  <div className="text-muted-foreground text-xs mb-1">{t("subtitle:extractor:summary.total_tasks")}</div>
                  <div className="font-medium">{t("subtitle:extractor:summary.task_count").replace("{count}", String(tasks.length))}</div>
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* 文件上传 */}
      <div className="mb-4">
        <Card>
          <CardHeader>
            <CardTitle>{t("subtitle:extractor:upload_section")}</CardTitle>
          </CardHeader>
          <CardContent>
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
              <input type="file" multiple className="hidden" accept=".lrc,.srt" onChange={handleFileUpload} />
              <div className="text-4xl -mb-2 pointer-events-none">
                {isDragging ? <FolderOpen className="h-10 w-10" /> : <Folder className="h-10 w-10" />}
              </div>
              <div className="mt-3 text-center pointer-events-none">
                <p className="font-medium">{t("subtitle:extractor:fields.upload_tips")}</p>
                <p className="text-sm text-muted-foreground mt-1">{t("subtitle:extractor:fields.files_only")}</p>
              </div>
            </label>
          </CardContent>
        </Card>
      </div>

      {/* 任务管理 */}
      <Card className="mb-12">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t("subtitle:extractor:task_management")}</CardTitle>
            <div className="flex gap-2">
              <Button size="sm" onClick={startAllTasks} disabled={notStartedTasks.length === 0}>
                {t("subtitle:extractor:fields.start_all")}
              </Button>
              <Button
                size="sm"
                onClick={removeAllResolvedTask}
                disabled={resolvedTasks.length === 0}
              >
                {t("subtitle:extractor:fields.remove_all_resolved_task")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* 列表 */}
          <div className="space-y-4">
            {tasks.map((task, index) => (
              <div key={index} className="bg-muted rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4 flex-1">
                    <div className={`w-3 h-3 rounded-full ${getTaskStatusColor(task.status)}`} />
                    <div className="font-medium flex-1">
                      {task.fileName}
                      <div className="text-sm text-muted-foreground mt-1">
                        {task.status === TaskStatus.NOT_STARTED && t("subtitle:extractor:task_status.notstarted")}
                        {task.status === TaskStatus.PENDING && `${t("subtitle:extractor:task_status.pending")} ${Math.round(task.progress || 0)}%`}
                        {task.status === TaskStatus.RESOLVED && ` ${t("subtitle:extractor:task_status.resolved")}`}
                        {task.status === TaskStatus.FAILED && ` ${t("subtitle:extractor:task_status.failed")}`}
                        <span className="ml-4 px-2 py-1 bg-muted-foreground/20 rounded text-xs">
                          {task.fileType} · {task.keep === "ZH" ? t("subtitle:extractor:fields.zh") : t("subtitle:extractor:fields.ja")}
                        </span>
                        {task.outputFilePath && (
                          <span className="ml-4 font-mono text-xs text-green-600">{t("subtitle:extractor:labels.output")}: {task.outputFilePath}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {task.status === TaskStatus.FAILED && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => openErrorModal(task)}
                      >
                        <AlertTriangle className="h-5 w-5" />
                      </Button>
                    )}

                    {task.status === TaskStatus.FAILED && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => retryTask(task.fileName)}
                      >
                        <RotateCw className="h-5 w-5" />
                      </Button>
                    )}

                    {task.status === TaskStatus.NOT_STARTED && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => startTask(task.fileName)}
                      >
                        <PlayCircle className="h-5 w-5" />
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteTask(task.fileName)}
                    >
                      <Trash2 className="h-5 w-5" />
                    </Button>
                  </div>
                </div>

                {task.status === TaskStatus.PENDING && (
                  <Progress value={task.progress} className="w-full mt-2" />
                )}
              </div>
            ))}
          </div>

          {tasks.length === 0 && <div className="text-center py-8 text-muted-foreground">{t("subtitle:extractor:fields.no_tasks")}</div>}
        </CardContent>
      </Card>

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

export default SubtitleLanguageExtractor;
