import { useTranslation } from 'react-i18next';
import { Library } from 'lucide-react';
import { DialogFrame } from './dialogs/DialogFrame';
import { DocumentRows } from './DocumentLibrary';
import { useLongTextPage } from './page-context';

/** The library as a 540px dialog in narrow windows (design §3.4 N-G); choosing a document closes it. */
export function LibraryDialog() {
  const { t } = useTranslation('text');
  const page = useLongTextPage();
  const open = page.dialog?.kind === 'library';
  return <DialogFrame open={open} width={540} testId="long-text-library-dialog" icon={<Library />} title={`${t('library.title')} · ${page.documents.length}`}
    initialFocus={() => document.querySelector<HTMLElement>('[role=dialog] :is([data-testid=long-text-library-search], [data-testid=long-text-library-row])')}>
    {/* DialogFrame takes no content class; the wrapper keeps the library's dialog insets. */}
    <div className="lt-library-dialog-content"><DocumentRows fill={false} onChosen={page.closeDialog} /></div>
  </DialogFrame>;
}
