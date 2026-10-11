import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * "History i/n" above a composer while Up / Down shows a sent message: how
 * many messages there are and which one is shown (the newest is n/n).
 */
export function InputHistoryHint({ position, className }: { position: { current: number; total: number } | null; className?: string }) {
  const { t } = useTranslation();
  return (
    <AnimatePresence>
      {position && (
        <motion.span
          key="input-history"
          role="status"
          aria-live="polite"
          data-testid="agent-input-history"
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 3 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          title={t("home:input_history_keys")}
          className={cn(
            "pointer-events-none absolute bottom-full right-3 z-20 mb-1.5 select-none rounded-full border bg-background px-2 py-0.5",
            "text-[11px] leading-4 tabular-nums text-muted-foreground shadow-xs",
            className,
          )}
        >
          {t("home:input_history_position", position)}
        </motion.span>
      )}
    </AnimatePresence>
  );
}
