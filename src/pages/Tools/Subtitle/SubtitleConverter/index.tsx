import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  OutputConflictPolicy,
  OutputPathMode,
  SubtitleFileType,
  TaskStatus,
} from "@/type/subtitle";
import { showToast } from "@/utils/toast";
import { getSourceDirFromFile } from "@/utils/filePath";
import ErrorDetailModal from "@/components/ErrorDetailModal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

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
  conflictPolicy?: OutputConflictPolicy;
}

function SubtitleConverter() {
  const { t } = useTranslation();

  // 折叠状态
  const [isConfigOpen, setIsConfigOpen] = useState<boolean>(true);
  const [isOutputOpen, setIsOutputOpen] = useState<boolean>(true);
  const [isSummaryOpen, setIsSummaryOpen] = useState<boolean>(true);

  // 配置
  const [toFormat, setToFormat] = useState<SubtitleFileType>(
    SubtitleFileType.SRT
  );
  const [defaultDurationSec, setDefaultDurationSec] = useState<string>("2");
  const [stripMediaExt, setStripMediaExt] = useState<boolean>(() => {
    const raw = localStorage.getItem("subtitle-converter-strip-media-ext");
    // 默认开启：避免 xxx.wav.vtt 转换后变成 xxx.wav.lrc
    if (raw === null) return true;
    return raw === "true";
  });

  // 输出路径
  const [outputURL, setOutputURL] = useState<string>(
    localStorage.getItem("subtitle-converter-output-url") || ""
  );
  const [outputMode, setOutputMode] = useState<OutputPathMode>(() => {
    const raw = localStorage.getItem("subtitle-converter-output-mode");
    return raw === "source" ? "source" : "custom";
  });
  const [conflictPolicy, setConflictPolicy] =
    useState<OutputConflictPolicy>(() => {
      const raw = localStorage.getItem("subtitle-converter-conflict-policy");
      return raw === "overwrite" ? "overwrite" : "index";
    });

  useEffect(() => {
    try {
      localStorage.setItem("subtitle-converter-output-url", outputURL);
    } catch { }
  }, [outputURL]);

  useEffect(() => {
    try {
      localStorage.setItem("subtitle-converter-output-mode", outputMode);
    } catch { }
  }, [outputMode]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "subtitle-converter-conflict-policy",
        conflictPolicy
      );
    } catch { }
  }, [conflictPolicy]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "subtitle-converter-strip-media-ext",
        String(stripMediaExt)
      );
    } catch { }
  }, [stripMediaExt]);

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
    if (outputMode === "custom" && !outputURL) {
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
        ![
          SubtitleFileType.LRC,
          SubtitleFileType.SRT,
          SubtitleFileType.VTT,
        ].includes(ext as any)
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

      const outputDir =
        outputMode === "source" ? getSourceDirFromFile(file) : outputURL;
      if (!outputDir) {
        showToast(
          t("subtitle:converter.errors.source_path_missing"),
          "error"
        );
        continue;
      }

      try {
        const fileContent = await file.text();
        const from = ext as SubtitleFileType;
        const to = toFormat;

        const newTask: SubtitleConverterTask = {
          fileName: file.name,
          fileContent,
          from,
          to,
          originFileURL: URL.createObjectURL(file),
          targetFileURL: outputDir,
          status: TaskStatus.NOT_STARTED,
          progress: 0,
          conflictPolicy,
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
        stripMediaExt,
        conflictPolicy: task.conflictPolicy ?? conflictPolicy,
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
        t("subtitle:converter.infos.task_convert_done").replace(
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
        t("subtitle:converter.errors.task_convert_failed").replace(
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
    showToast(t("subtitle:converter.infos.task_deleted"), "success");
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
        {t("subtitle:converter.title")}
      </div>
      <div className="mb-6 text-muted-foreground">
        {t("subtitle:converter.description")}
      </div>

      {/* 配置选项 */}
      <div className="flex flex-col space-y-4 mb-4">
        <Card>
          <CardHeader
            className="flex items-center justify-between cursor-pointer select-none"
            onClick={() => setIsConfigOpen((v) => !v)}
          >
            <CardTitle className="text-xl">
              {t("subtitle:converter.config_title")}
            </CardTitle>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isConfigOpen && "rotate-180"
              )}
            />
          </CardHeader>
          {isConfigOpen && (
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <Label className="text-sm font-medium min-w-[100px]">
                    {t("subtitle:converter.fields.target_format")}
                  </Label>
                  <Select
                    value={toFormat}
                    onValueChange={(value) =>
                      setToFormat(value as SubtitleFileType)
                    }
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SubtitleFileType.LRC}>LRC</SelectItem>
                      <SelectItem value={SubtitleFileType.SRT}>SRT</SelectItem>
                      <SelectItem value={SubtitleFileType.VTT}>VTT</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {toFormat !== SubtitleFileType.LRC && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-4">
                      <Label
                        htmlFor="duration"
                        className="text-sm font-medium min-w-[100px]"
                      >
                        {t("subtitle:converter.fields.default_duration_label")}
                      </Label>
                      <Input
                        id="duration"
                        type="number"
                        className="w-32"
                        value={defaultDurationSec}
                        min="1"
                        max="10"
                        onChange={(e) => setDefaultDurationSec(e.target.value)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground ml-[116px]">
                      {t("subtitle:converter.fields.duration_hint")}
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-start gap-4">
                    <Label
                      htmlFor="stripMediaExt"
                      className="text-sm font-medium min-w-[100px]"
                    >
                      {t("subtitle:converter.fields.strip_media_ext_label")}
                    </Label>
                    <Checkbox
                      id="stripMediaExt"
                      checked={stripMediaExt}
                      onCheckedChange={(v) => setStripMediaExt(Boolean(v))}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground ml-[116px]">
                    {t("subtitle:converter.fields.strip_media_ext_hint")}
                  </p>
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* 输出设置 */}
      <div className="mb-4">
        <Card>
          <CardHeader
            className="flex items-center justify-between cursor-pointer select-none"
            onClick={() => setIsOutputOpen((v) => !v)}
          >
            <CardTitle className="text-xl">
              {t("subtitle:converter.output_path_section")}
            </CardTitle>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isOutputOpen && "rotate-180"
              )}
            />
          </CardHeader>
          {isOutputOpen && (
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center gap-4">
                  <Label className="text-sm font-medium min-w-[100px]">
                    {t("subtitle:converter.fields.output_mode")}
                  </Label>
                  <ButtonGroup>
                    <Button
                      className="w-30"
                      size="sm"
                      variant={outputMode === "custom" ? "default" : "outline"}
                      onClick={() => setOutputMode("custom")}
                    >
                      {t("subtitle:converter.fields.output_mode_custom")}
                    </Button>
                    <Button
                      className="w-30"
                      size="sm"
                      variant={outputMode === "source" ? "default" : "outline"}
                      onClick={() => setOutputMode("source")}
                    >
                      {t("subtitle:converter.fields.output_mode_source")}
                    </Button>
                  </ButtonGroup>
                </div>

                {/* 选择输出目录 */}
                {outputMode === "custom" ? (
                  <div className="w-full">
                    <ButtonGroup className="flex items-center pl-[116px] w-full">
                      <Button className="w-30" onClick={handleSelectOutputPath} size="sm">
                        {t("subtitle:converter.fields.select_output_path")}
                      </Button>
                      <Input
                        type="text"
                        placeholder={t(
                          "subtitle:converter.fields.no_output_path_selected"
                        )}
                        value={outputURL}
                        onChange={() => { }}
                        onClick={handleSelectOutputPath}
                        className="grow"
                        readOnly
                      />
                    </ButtonGroup>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground ml-[116px]">
                    {t("subtitle:converter.fields.output_mode_source_hint")}
                  </p>
                )}

                {/* 重名处理方式 */}
                <div className="flex items-center gap-4">
                  <Label className="text-sm font-medium min-w-[100px]">
                    {t("subtitle:converter.fields.conflict_policy")}
                  </Label>
                  <ButtonGroup>
                    <Button
                      className="w-30"
                      size="sm"
                      variant={
                        conflictPolicy === "index" ? "default" : "outline"
                      }
                      onClick={() => setConflictPolicy("index")}
                    >
                      {t("subtitle:converter.fields.conflict_policy_index")}
                    </Button>
                    <Button
                      className="w-30"
                      size="sm"
                      variant={
                        conflictPolicy === "overwrite" ? "default" : "outline"
                      }
                      onClick={() => setConflictPolicy("overwrite")}
                    >
                      {t("subtitle:converter.fields.conflict_policy_overwrite")}
                    </Button>
                  </ButtonGroup>
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* 配置摘要 */}
      <div className="mb-4">
        <Card>
          <CardHeader
            className="flex items-center justify-between cursor-pointer select-none"
            onClick={() => setIsSummaryOpen((v) => !v)}
          >
            <CardTitle className="text-xl">
              {t("subtitle:converter.summary_title")}
            </CardTitle>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isSummaryOpen && "rotate-180"
              )}
            />
          </CardHeader>
          {isSummaryOpen && (
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <Card className="border-muted">
                  <CardContent>
                    <div className="text-muted-foreground text-xs mb-1">
                      {t("subtitle:converter.fields.target_format")}
                    </div>
                    <div className="font-medium">{toFormat}</div>
                  </CardContent>
                </Card>
                {toFormat !== SubtitleFileType.LRC && (
                  <Card className="border-muted">
                    <CardContent>
                      <div className="text-muted-foreground text-xs mb-1">
                        {t("subtitle:converter.summary.default_duration")}
                      </div>
                      <div className="font-medium">{defaultDurationSec}s</div>
                    </CardContent>
                  </Card>
                )}
                <Card className="border-muted">
                  <CardContent>
                    <div className="text-muted-foreground text-xs mb-1">
                      {t("subtitle:converter.summary.total_tasks")}
                    </div>
                    <div className="font-medium">
                      {t("subtitle:converter.summary.task_count").replace(
                        "{count}",
                        String(tasks.length)
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* 文件上传 */}
      <div className="mb-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{t("subtitle:converter.upload_section")}</CardTitle>
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
              <input
                type="file"
                multiple
                className="hidden"
                accept=".lrc,.srt,.vtt"
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
                  {t("subtitle:converter.fields.upload_tips")}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {t("subtitle:converter.fields.files_only")}
                </p>
              </div>
            </label>
          </CardContent>
        </Card>
      </div>

      {/* 任务管理 */}
      <Card className="mb-12">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl">{t("subtitle:converter.task_management")}</CardTitle>
            <div className="flex gap-2">
              <Button
                variant={notStartedTasks.length === 0 ? "outline" : "default"}
                size="sm"
                onClick={startAllTasks}
                disabled={notStartedTasks.length === 0}
              >
                {t("subtitle:converter.fields.start_all")}
              </Button>
              <Button
                variant={resolvedTasks.length === 0 ? "outline" : "default"}
                size="sm"
                onClick={removeAllResolvedTask}
                disabled={resolvedTasks.length === 0}
              >
                {t("subtitle:converter.fields.remove_all_resolved_task")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* 列表 */}
          <div className="space-y-4">
            {tasks.map((task, index) => (
              <Card key={index}>
                <CardContent>
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
                          {task.status === TaskStatus.NOT_STARTED &&
                            t("subtitle:converter.task_status.notstarted")}
                          {task.status === TaskStatus.PENDING &&
                            ` ${t(
                              "subtitle:converter.task_status.pending"
                            )} ${Math.round(task.progress || 0)}%`}
                          {task.status === TaskStatus.RESOLVED &&
                            ` ${t("subtitle:converter.task_status.resolved")}`}
                          {task.status === TaskStatus.FAILED &&
                            ` ${t("subtitle:converter.task_status.failed")}`}
                          <span className="ml-4 px-2 py-1 bg-muted-foreground/20 rounded text-xs">
                            {task.from} → {task.to}
                          </span>
                          {task.outputFilePath && (
                            <span className="ml-4 font-mono text-xs text-green-600">
                              {t("subtitle:converter.labels.output")}:{" "}
                              {task.outputFilePath}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <ButtonGroup>
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

                      {task.status === TaskStatus.FAILED && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => retryTask(task.fileName)}
                        >
                          <RotateCw className="h-5 w-5" />
                        </Button>
                      )}

                      {task.status === TaskStatus.NOT_STARTED && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => startTask(task.fileName)}
                        >
                          <PlayCircle className="h-5 w-5" />
                        </Button>
                      )}

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

          {tasks.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              {t("subtitle:converter.fields.no_tasks")}
            </div>
          )}
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

export default SubtitleConverter;
