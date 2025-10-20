import React from "react";
import { X, Copy } from "lucide-react";
import { useTransition, animated, config, useTrail } from "@react-spring/web";
import { useTranslation } from "react-i18next";
import { showToast } from "@/utils/toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

  // 背景遮罩动画
  const backdropTransition = useTransition(isOpen, {
    from: { opacity: 0, backdropFilter: "blur(0px)" },
    enter: { opacity: 1, backdropFilter: "blur(4px)" },
    leave: { opacity: 0, backdropFilter: "blur(0px)" },
    config: { duration: 250, easing: (t) => t * (2 - t) }, // 自定义缓动函数
  });

  // 模态框内容动画 - 使用弹性缓动效果
  const modalTransition = useTransition(isOpen, {
    from: {
      opacity: 0,
      transform: "scale(0.92) translateY(-20px)",
      filter: "blur(4px)",
    },
    enter: {
      opacity: 1,
      transform: "scale(1) translateY(0px)",
      filter: "blur(0px)",
    },
    leave: {
      opacity: 0,
      transform: "scale(0.96) translateY(-10px)",
      filter: "blur(2px)",
    },
    config: {
      tension: 280,
      friction: 35,
      mass: 0.9,
    },
    delay: isOpen ? 80 : 0, // 进入时略微延迟，让背景先显示
  });

  // 日志条目的交错动画
  const logTrail = useTrail(errorLogs.length, {
    from: {
      opacity: 0,
      transform: "translateX(-20px) scale(0.95)",
    },
    to: {
      opacity: isOpen ? 1 : 0,
      transform: isOpen
        ? "translateX(0px) scale(1)"
        : "translateX(-10px) scale(0.98)",
    },
    config: {
      tension: 640,
      friction: 28,
      mass: 0.2,
    },
    delay: isOpen ? 300 : 0, // 等模态框显示后再开始日志动画
  });

  return (
    <>
      {/* 背景遮罩层动画 */}
      {backdropTransition(
        (styles, item) =>
          item && (
            <animated.div
              style={styles}
              className="fixed inset-0 z-50 bg-black/50"
              onClick={onClose}
            />
          )
      )}

      {/* 模态框内容动画 */}
      {modalTransition(
        (styles, item) =>
          item && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none">
              <animated.div
                style={styles}
                className="relative bg-card rounded-xl shadow-2xl ring-1 ring-border max-w-4xl w-full mx-4 max-h-[80vh] flex flex-col pointer-events-auto"
              >
                {/* 头部 */}
                <div className="flex items-center justify-between px-6 pt-2 border-b border-border bg-card/80 backdrop-blur-sm rounded-t-xl">
                  <h2 className="text-xl font-semibold text-foreground">
                    {t("common:error.detail_title")} - {taskName}
                  </h2>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={copyToClipboard}
                      className="tooltip"
                      data-tip={t("common:action.copy_error")}
                    >
                      <Copy className="w-5 h-5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                      <X className="w-5 h-5" />
                    </Button>
                  </div>
                </div>

                {/* 内容 */}
                <div className="flex-1 px-6 pb-4 overflow-y-auto">
                  {/* 基本信息 */}
                  <div className="space-y-4">
                    {timestamp && (
                      <div>
                        <label className="block text-sm font-medium text-foreground mb-1">
                          {t("common:error.time")}
                        </label>
                        <div className="text-sm text-muted-foreground">
                          {timestamp}
                        </div>
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
                      <div className="bg-muted rounded-lg p-3 text-sm text-muted-foreground font-mono">
                        {errorDetails}
                      </div>
                    </div>

                    {errorLogs.length > 0 && (
                      <div>
                        <label className="block text-sm font-medium text-foreground mb-1">
                          {t("common:error.logs_with_count").replace("{count}", String(errorLogs.length))}
                        </label>
                        <div className="bg-muted rounded-lg p-4 space-y-2 max-h-64 overflow-y-auto">
                          {logTrail.map((styles, index) => (
                            <animated.div
                              key={index}
                              style={styles}
                              className="text-sm text-muted-foreground font-mono border-l-2 border-border pl-3"
                            >
                              <span className="text-muted-foreground/50 mr-2">
                                #{index + 1}
                              </span>
                              {errorLogs[index]}
                            </animated.div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </animated.div>
            </div>
          )
      )}
    </>
  );
};

export default ErrorDetailModal;
