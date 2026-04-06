import React, { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  User,
  Bot,
  Wrench,
  PackageCheck,
  AlertCircle,
  Ban,
  RotateCcw,
  Coins,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import useAgentStore from "@/store/agent/useAgentStore";
import type { AgentLogEntry, AgentLogEntryType } from "@/agent/types";
import { cn } from "@/lib/utils";
import {
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import { Badge } from "@/components/ui/badge";

interface SessionLogViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ICON_MAP: Record<AgentLogEntryType, React.ReactNode> = {
  user_message: <User className="h-3.5 w-3.5" />,
  assistant_message: <Bot className="h-3.5 w-3.5" />,
  status_change: <ArrowRightLeft className="h-3.5 w-3.5" />,
  tool_call: <Wrench className="h-3.5 w-3.5" />,
  tool_result: <PackageCheck className="h-3.5 w-3.5" />,
  usage: <Coins className="h-3.5 w-3.5" />,
  error: <AlertCircle className="h-3.5 w-3.5" />,
  abort: <Ban className="h-3.5 w-3.5" />,
  session_reset: <RotateCcw className="h-3.5 w-3.5" />,
};

const COLOR_MAP: Record<AgentLogEntryType, string> = {
  user_message: "text-blue-500",
  assistant_message: "text-emerald-500",
  status_change: "text-muted-foreground/60",
  tool_call: "text-amber-500",
  tool_result: "text-purple-500",
  usage: "text-sky-500",
  error: "text-destructive",
  abort: "text-orange-500",
  session_reset: "text-muted-foreground/60",
};

const BG_MAP: Record<AgentLogEntryType, string> = {
  user_message: "bg-blue-500/5 border-blue-500/15",
  assistant_message: "bg-emerald-500/5 border-emerald-500/15",
  status_change: "bg-muted/30 border-border/30",
  tool_call: "bg-amber-500/5 border-amber-500/15",
  tool_result: "bg-purple-500/5 border-purple-500/15",
  usage: "bg-sky-500/5 border-sky-500/15",
  error: "bg-destructive/5 border-destructive/20",
  abort: "bg-orange-500/5 border-orange-500/15",
  session_reset: "bg-muted/30 border-border/30",
};

export default function SessionLogViewer({
  open,
  onOpenChange,
}: SessionLogViewerProps) {
  const { t, i18n } = useTranslation();
  const sessionLog = useAgentStore((s) => s.sessionLog);
  const bottomRef = useRef<HTMLDivElement>(null);

  const locale = i18n.resolvedLanguage || i18n.language || "en-US";

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() =>
        bottomRef.current?.scrollIntoView({ behavior: "smooth" }),
      );
    }
  }, [open, sessionLog.length]);

  return (
    <ScrollableDialog
      maxWidth="sm:max-w-2xl"
      open={open}
      onOpenChange={onOpenChange}
    >
      <ScrollableDialogHeader className="px-6 pt-6 pb-3">
        <DialogTitle className="text-base">
          {t("home:session_log_title")}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {t("home:session_log_description", { count: sessionLog.length })}
        </DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent
        className="max-h-[80vh] flex flex-col p-0 gap-0"
        fadeMasks={true}
        fadeMaskHeight={40}
      >
        {sessionLog.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground/50">
            {t("home:session_log_empty")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {sessionLog.map((entry) => (
              <LogEntryRow key={entry.id} entry={entry} locale={locale} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </ScrollableDialogContent>
    </ScrollableDialog>
  );
}

function LogEntryRow({
  entry,
  locale,
}: {
  entry: AgentLogEntry;
  locale: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasData = entry.data && Object.keys(entry.data).length > 0;

  const typeLabel = t(`home:log_type_${entry.type}`);

  return (
    <div className={cn("rounded-lg border px-3 py-2", BG_MAP[entry.type])}>
      <div
        className={cn(
          "flex items-start gap-2 text-xs",
          hasData && "cursor-pointer select-none",
        )}
        onClick={() => hasData && setExpanded(!expanded)}
      >
        {/* icon */}
        <span className={cn("shrink-0", COLOR_MAP[entry.type])}>
          {ICON_MAP[entry.type]}
        </span>

        {/* type badge */}
        <Badge
          variant="outline"
          className={cn(
            "shrink-0",
            "text-[10px] leading-none",
            COLOR_MAP[entry.type],
          )}
        >
          {typeLabel}
        </Badge>

        {/* timestamp */}
        <span className="inline-block h-[14px] leading-[16px] shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
          {new Date(entry.timestamp).toLocaleTimeString(locale, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>

        {/* summary */}
        <span className="flex-1 text-foreground/80 text-[10px] leading-[14px] break-all leading-relaxed">
          {entry.summary}
        </span>

        {/* expand toggle */}
        {hasData && (
          <span className="shrink-0 text-muted-foreground/40">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        )}
      </div>

      {/* expanded data */}
      {expanded && hasData && <LogDataBlock data={entry.data!} />}
    </div>
  );
}

function LogDataBlock({ data }: { data: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(data, null, 2);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="mt-2 relative group">
      <pre className="text-[11px] font-mono text-foreground/60 bg-background/60 rounded-md border border-border/30 px-3 py-2 max-h-60 overflow-auto whitespace-pre-wrap break-all">
        {json}
      </pre>
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-1 right-1 h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald-500" />
        ) : (
          <Copy className="h-3 w-3 text-muted-foreground" />
        )}
      </Button>
    </div>
  );
}
