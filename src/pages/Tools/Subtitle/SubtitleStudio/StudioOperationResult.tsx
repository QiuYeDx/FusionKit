import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { ArrowUpRight, Check, ChevronDown, CircleAlert, FileText, Minus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogTitle, ScrollableDialogContent, ScrollableDialogFooter, ScrollableDialogHeader } from '@/components/qiuye-ui/scrollable-dialog';
import { StudioFileName } from './StudioControls';
import './StudioOperationResult.css';

export const STUDIO_RESULT_DIALOG_CLASS = 'studio-result-dialog';
export const STUDIO_RESULT_DIALOG_WIDTH = 'sm:max-w-[420px]';
export type StudioOperationResultItem = {
  id: string; name: string; state: 'success' | 'failed' | 'skipped';
  outputName?: string; detail?: ReactNode; actions?: ReactNode;
};
type Operation = 'export' | 'source' | 'import' | 'translation' | 'delete' | 'resume' | 'cancel';
type Props = {
  operation: Operation;
  items: readonly StudioOperationResultItem[];
  onClose: () => void;
  closeButtonId?: string;
  primaryAction?: { label: string; onClick: () => void };
  titleRef?: Ref<HTMLHeadingElement>;
  testId?: string;
};
const operationKeys = {
  export: { success: 'studio:operation_result.export.title', partial: 'studio:operation_result.export.partial', failed: 'studio:operation_result.export.failed', count: 'studio:operation_result.export.count' },
  source: { success: 'studio:operation_result.source.title', partial: 'studio:operation_result.source.partial', failed: 'studio:operation_result.source.failed', count: 'studio:operation_result.source.count' },
  import: { success: 'studio:operation_result.import.title', partial: 'studio:operation_result.import.partial', failed: 'studio:operation_result.import.failed', count: 'studio:operation_result.import.count' },
  translation: { success: 'studio:operation_result.translation.title', partial: 'studio:operation_result.translation.partial', failed: 'studio:operation_result.translation.failed', count: 'studio:operation_result.translation.count' },
  delete: { success: 'studio:operation_result.delete.title', partial: 'studio:operation_result.delete.partial', failed: 'studio:operation_result.delete.failed', count: 'studio:operation_result.delete.count' },
  resume: { success: 'studio:operation_result.resume.title', partial: 'studio:operation_result.resume.partial', failed: 'studio:operation_result.resume.failed', count: 'studio:operation_result.resume.count' },
  cancel: { success: 'studio:operation_result.cancel.title', partial: 'studio:operation_result.cancel.partial', failed: 'studio:operation_result.cancel.failed', count: 'studio:operation_result.cancel.count' },
} as const;
const stateKeys = { success: 'studio:operation_result.item_success', failed: 'studio:operation_result.item_failed', skipped: 'studio:operation_result.item_skipped' } as const;
const stateIcons = { success: Check, failed: CircleAlert, skipped: Minus };
const stateOrder = { failed: 0, skipped: 1, success: 2 };

/** Complete result surface inside the existing dialog, without restarting its controller. */
export function StudioOperationResult({ operation, items, onClose, closeButtonId, primaryAction, titleRef, testId = 'studio-operation-result' }: Props) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  const [expanded, setExpanded] = useState(false);
  const succeeded = items.filter(item => item.state === 'success').length;
  const failed = items.filter(item => item.state === 'failed').length;
  const skipped = items.length - succeeded - failed;
  const outcome = !items.length ? 'empty' : succeeded === items.length ? 'success' : succeeded ? 'partial' : failed ? 'failed' : 'skipped';
  const requested = operation === 'translation' || operation === 'resume' || operation === 'cancel';
  const keys = operationKeys[operation];
  const title = outcome === 'empty' ? t('studio:operation_result.empty') : outcome === 'skipped' ? t('studio:operation_result.none_processed') : t(keys[outcome]);
  const summary = [
    succeeded ? t(keys.count, { count: succeeded }) : '',
    failed ? t('studio:operation_result.failed_count', { count: failed }) : '',
    skipped ? t('studio:operation_result.skipped_count', { count: skipped }) : '',
  ].filter(Boolean).join(t('studio:operation_result.separator'));
  const StatusIcon = outcome === 'failed' || outcome === 'partial' ? CircleAlert : outcome === 'empty' || outcome === 'skipped' ? Minus : requested ? ArrowUpRight : Check;
  const singleSuccess = items.length === 1 && outcome === 'success';
  useEffect(() => {
    const frame = requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);
  return <section className="studio-operation-result" data-testid={testId} data-operation={operation} data-outcome={outcome} data-request={requested || undefined}>
    <ScrollableDialogHeader className="studio-result-header">
      <span className="studio-result-emblem" aria-hidden="true"><StatusIcon strokeWidth={1.8} /></span>
      <DialogTitle className="studio-result-title" tabIndex={-1} ref={node => {
        heading.current = node;
        if (typeof titleRef === 'function') titleRef(node);
        else if (titleRef) titleRef.current = node;
      }}>{title}</DialogTitle>
      <DialogDescription className="studio-result-description">{summary || t('studio:operation_result.empty_description')}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="studio-result-content" fadeMaskHeight={16}>
      {singleSuccess ? <div className="studio-result-file" data-result-id={items[0].id} data-state="success">
        <FileText aria-hidden="true" />
        <StudioFileName name={items[0].outputName ?? items[0].name} focusable />
        {items[0].actions}
      </div> : items.length > 0 && <details className="studio-result-details" data-result-details onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary><span>{t('studio:operation_result.details_count', { count: items.length })}</span><ChevronDown aria-hidden="true" /></summary>
        {expanded && <ul className="studio-result-files">
          {[...items].sort((a, b) => stateOrder[a.state] - stateOrder[b.state]).map(item => {
            const ItemIcon = item.state === 'success' && requested ? ArrowUpRight : stateIcons[item.state];
            return <li className="studio-result-item" data-result-id={item.id} data-state={item.state} key={item.id}>
              <ItemIcon className="studio-result-item-icon" aria-hidden="true" />
              <div className="studio-result-item-body">
                <StudioFileName name={item.outputName ?? item.name} focusable />
                <span className="sr-only">{t(item.state === 'success' && requested ? 'studio:operation_result.item_requested' : stateKeys[item.state])}</span>
                {item.state !== 'success' && item.detail && <div className="studio-result-item-detail">{item.detail}</div>}
                {item.actions && <div className="studio-result-item-actions">{item.actions}</div>}
              </div>
            </li>;
          })}
        </ul>}
      </details>}
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="studio-result-footer">
      <Button id={closeButtonId} variant={primaryAction ? 'outline' : 'default'} onClick={onClose}>{t('studio:operation_result.done')}</Button>
      {primaryAction && <Button onClick={primaryAction.onClick}>{primaryAction.label}<ArrowUpRight aria-hidden="true" /></Button>}
    </ScrollableDialogFooter>
  </section>;
}
