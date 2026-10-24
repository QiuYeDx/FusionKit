import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, BookOpenText, ClipboardPaste, FileText, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToolFilePickerSurface } from '../../_shared/ui/ToolFilePickerSurface';
import { ToolPanel } from '../../_shared/ui/ToolPanel';
import { StudioNotice } from '../../Subtitle/SubtitleStudio/StudioControls';
import { MODEL_PROBLEM_LABELS } from './labels';
import { MODEL_SETTINGS_ROUTE, useLongTextPage } from './page-context';

/** The empty state: the file picker, the privacy note and the model new documents will use (design §2 F1). */
export function StartPanel({ dragging }: { dragging: boolean }) {
  const { t } = useTranslation('text');
  const navigate = useNavigate();
  const page = useLongTextPage();
  const model = page.runModel;
  return <ToolPanel title={t('import.start_title')} icon={BookOpenText} bodyClassName="lt-start-body">
    <div className="lt-start" data-testid="long-text-start">
      <ToolFilePickerSurface data-testid="long-text-picker" layout={page.wide ? 'stacked' : 'horizontal'}
        icon={<FileText className="h-5 w-5" />} title={t('import.drop_title')} description={t('import.drop_hint')} actionLabel={t('import.choose')}
        disabled={page.importBusy} dragging={dragging} onSelect={page.pickFiles}
        secondaryAction={<Button data-testid="long-text-picker-paste" type="button" variant="outline" size="sm" disabled={page.importBusy}
          onClick={event => { event.stopPropagation(); page.openDialog({ kind: 'paste', text: '' }); }}>
          <ClipboardPaste className="h-3.5 w-3.5" />{t('import.paste')}
        </Button>} />
      <div className="lt-start-notes">
        <p><ShieldCheck aria-hidden="true" />{t('import.privacy')}</p>
        {!('problem' in model) && <p data-testid="long-text-model-line">
          <span>{t('import.model_line', { name: model.profile.name })}</span>
          <span aria-hidden="true">·</span>
          <Link to={MODEL_SETTINGS_ROUTE}>{t('import.model_change')}</Link>
        </p>}
      </div>
      {'problem' in model && <StudioNotice role="status" data-testid="long-text-notice-model" className="lt-notice">
        <AlertCircle className="text-amber-600 dark:text-amber-400" />
        <span>{model.problem === 'no_profile' ? t('notices.model_missing') : t(MODEL_PROBLEM_LABELS[model.problem])}</span>
        <Button size="sm" variant="ghost" onClick={() => navigate(MODEL_SETTINGS_ROUTE)}>{t('notices.model_settings')}</Button>
      </StudioNotice>}
    </div>
  </ToolPanel>;
}
