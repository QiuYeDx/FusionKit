import React from "react";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { showToast } from "@/utils/toast";
import { Button } from "@/components/ui/button";
import {
  ScrollableDialog,
  ScrollableDialogHeader,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  DialogTitle,
} from "@/components/qiuye-ui/scrollable-dialog";

interface ErrorDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  taskName: string;
  errorMessage: string;
  errorDetails: string;
  errorLogs?: string[];
  timestamp?: string;
}

const ErrorDetailModal: React.FC<ErrorDetailModalProps> = ({
  isOpen,
  onClose,
  taskName,
  errorMessage,
  errorDetails,
  errorLogs = [],
  timestamp,
}) => {
  const { t } = useTranslation();

  // 复制错误信息到剪贴板
  const copyToClipboard = () => {
    const errorInfo = [
      `${t("common:error.task_name")}: ${taskName}`,
      `${t("common:error.time")}: ${timestamp || new Date().toLocaleString()}`,
      `${t("common:error.message")}: ${errorMessage}`,
      `${t("common:error.detail")}: ${errorDetails}`,
      "",
      `${t("common:error.logs")}:`,
      ...errorLogs.map((log, index) => `${index + 1}. ${log}`),
    ].join("\n");

    navigator.clipboard
      .writeText(errorInfo)
      .then(() => {
        showToast(t("common:info.copy_success"), "success");
      })
      .catch(() => {
        showToast(t("common:error.copy_failed"), "error");
      });
  };

  return (
    <ScrollableDialog
      open={isOpen}
      onOpenChange={onClose}
      maxWidth="sm:max-w-4xl"
    >
      <ScrollableDialogHeader>
        <DialogTitle className="text-xl">
          {t("common:error.detail_title")} - {taskName}
        </DialogTitle>
      </ScrollableDialogHeader>

      <ScrollableDialogContent fadeMasks={true} fadeMaskHeight={40}>
        <div className="space-y-4">
          {timestamp && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t("common:error.time")}
              </label>
              <div className="text-sm text-muted-foreground">{timestamp}</div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("common:error.message")}
            </label>
            <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-lg p-3 text-sm">
              {errorMessage}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("common:error.detail")}
            </label>
            <div className="bg-muted rounded-lg p-3 text-sm text-muted-foreground font-mono break-all">
              {errorDetails}
            </div>
          </div>

          {errorLogs.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t("common:error.logs_with_count").replace(
                  "{count}",
                  String(errorLogs.length)
                )}
              </label>
              <div className="bg-muted rounded-lg p-4 space-y-2">
                {errorLogs.map((log, index) => (
                  <div
                    key={index}
                    className="text-sm text-muted-foreground font-mono border-l-2 border-border pl-3"
                  >
                    <span className="text-muted-foreground/50 mr-2">
                      #{index + 1}
                    </span>
                    {log}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollableDialogContent>

      <ScrollableDialogFooter className="flex justify-between items-center">
        <Button variant="outline" onClick={copyToClipboard}>
          <Copy className="w-4 h-4 mr-2" />
          {t("common:action.copy_error")}
        </Button>
        <Button variant="default" onClick={onClose}>
          {t("common:action.close")}
        </Button>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
};

export default ErrorDetailModal;
