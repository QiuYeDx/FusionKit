import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, CircleAlert, Minus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { StudioDocumentList, StudioDocumentRow } from './StudioDocumentList';
import './StudioOperationResult.css';

export type StudioOperationResultItem = {
  id: string; name: string; state: 'success' | 'failed' | 'skipped'; detail?: ReactNode; actions?: ReactNode;
};
type Props = {
  items: readonly StudioOperationResultItem[];
  successLabel?: (count: number) => ReactNode;
  failureLabel?: (count: number) => ReactNode;
  skippedLabel?: (count: number) => ReactNode;
  testId?: string;
  children?: ReactNode;
};
const detailsKeys = { success: 'studio:operation_result.success_details', failed: 'studio:operation_result.failure_details', skipped: 'studio:operation_result.skipped_details' } as const;

/** Results stay compact; individual files are rendered only on explicit expansion. */
export function StudioOperationResult({ items, successLabel, failureLabel, skippedLabel, testId = 'studio-operation-result', children }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState({ success: false, failed: false, skipped: false });
  const groups = { success: items.filter(item => item.state === 'success'), failed: items.filter(item => item.state === 'failed'), skipped: items.filter(item => item.state === 'skipped') };
  return <section className="studio-operation-result" data-testid={testId} aria-live="polite">
    <div className="studio-operation-result-summary">
      {!!groups.success.length && <p><Check aria-hidden="true" />{successLabel ? successLabel(groups.success.length) : t('studio:operation_result.success', { count: groups.success.length })}</p>}
      {!!groups.failed.length && <p className="studio-operation-result-failed"><CircleAlert aria-hidden="true" />{failureLabel ? failureLabel(groups.failed.length) : t('studio:operation_result.failed', { count: groups.failed.length })}</p>}
      {!!groups.skipped.length && <p><Minus aria-hidden="true" />{skippedLabel ? skippedLabel(groups.skipped.length) : t('studio:operation_result.skipped', { count: groups.skipped.length })}</p>}
      {!items.length && <p>{t('studio:operation_result.empty')}</p>}
    </div>
    {children}
    {(['failed', 'skipped', 'success'] as const).filter(state => groups[state].length).map(state => <details className="studio-operation-result-details" data-result-group={state} key={state} onToggle={event => {
      const open = event.currentTarget.open;
      setExpanded(previous => previous[state] === open ? previous : { ...previous, [state]: open });
    }}>
      <summary>{t(detailsKeys[state])}<ChevronDown aria-hidden="true" /></summary>
      {expanded[state] && <StudioDocumentList maxHeight="min(240px, 38vh)">{groups[state].map(item => <StudioDocumentRow key={item.id} data-result-id={item.id} data-state={item.state} name={item.name} actions={item.actions}>{item.detail}</StudioDocumentRow>)}</StudioDocumentList>}
    </details>)}
  </section>;
}
