import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, BookOpen, Check, CircleCheck, Copy, Folder, Info, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import type { Entry } from '@/translation-knowledge/schemas';
import type { KnowledgeErrorCode, LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { Diagnostic } from '@/translation-knowledge/validation';
import { ErrorNotice } from './Controls';
import { RecordDetails } from './Exchange';
import { KnowledgeDisclosure } from './KnowledgeDisclosure';
import { KnowledgeFormSection, KnowledgeRecordDialog, KnowledgeRecordMenu } from './KnowledgeRecordDialog';
import { entryStatus, needsReview } from './model';
import { languagePairLabel } from './labels';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function EntryContent({ entry }: { entry: Entry }) {
  const { t } = useTranslation('knowledge');
  return <KnowledgeFormSection title={t('record.content')}>
    {(entry.kind === 'term' || entry.kind === 'memory') && <dl className="knowledge-entry-pair">
      <div><dt>{t('fields.source_text')}</dt><dd>{entry.payload.source}</dd></div>
      <div><dt>{t('fields.target_text')}</dt><dd>{entry.payload.target}</dd></div>
    </dl>}
    {entry.kind === 'term' && <dl className="knowledge-entry-facts">
      {entry.payload.sense && <Fact label={t('record.sense')}>{entry.payload.sense}</Fact>}
      <Fact label={t('fields.strength')}>{t(`strength.${entry.payload.strength}`)}</Fact>
      <Fact label={t('fields.match')}>{t(`match.${entry.payload.match.mode}`)} · {t(entry.payload.match.caseSensitive ? 'record.case_sensitive' : 'record.case_insensitive')}</Fact>
      {entry.payload.aliases.length > 0 && <Fact label={t('record.aliases')}><span className="knowledge-entry-aliases">{entry.payload.aliases.map((alias, i) => <span key={i}>{alias}</span>)}</span></Fact>}
    </dl>}
    {entry.kind === 'context' && <>
      <p className="knowledge-entry-text">{entry.payload.text}</p>
      <dl className="knowledge-entry-facts"><Fact label={t('fields.assertion')}>{t(`assertion.${entry.payload.assertion}`)}{entry.payload.core && ` · ${t('record.core')}`}</Fact></dl>
    </>}
    {entry.kind === 'rule' && <>
      <p className="knowledge-entry-text">{entry.payload.text}</p>
      <dl className="knowledge-entry-facts"><Fact label={t('fields.dimension')}>{t(`dimension.${entry.payload.dimension}`)}</Fact><Fact label={t('fields.strength')}>{t(`strength.${entry.payload.strength}`)}</Fact></dl>
    </>}
    {entry.kind === 'expression' && <>
      <dl className="knowledge-entry-pair"><div><dt>{t('fields.source_phrase')}</dt><dd>{entry.payload.sourcePhrase}</dd></div><div><dt>{t('fields.interpretation')}</dt><dd>{entry.payload.interpretation}</dd></div></dl>
      {entry.payload.targetExamples.length > 0 && <dl className="knowledge-entry-facts"><Fact label={t('record.examples')}><ul className="space-y-1">{entry.payload.targetExamples.map((example, i) => <li key={i}>{example}</li>)}</ul></Fact></dl>}
      <p className="knowledge-editor-help">{t('editor.expression_help')}</p>
    </>}
    {entry.kind === 'memory' && <>
      <dl className="knowledge-entry-facts">
        {entry.payload.beforeSource && <Fact label={t('fields.before_source')}>{entry.payload.beforeSource}</Fact>}
        {entry.payload.afterSource && <Fact label={t('fields.after_source')}>{entry.payload.afterSource}</Fact>}
        <Fact label={t('fields.alignment')}>{t(`alignment.${entry.payload.alignment}`)}</Fact>
      </dl>
      <p className="knowledge-editor-help">{t('editor.memory_help')}</p>
    </>}
  </KnowledgeFormSection>;
}

export function EntryDetails({ entry, snapshot, busy, blocked, error, diagnostics, onClose, onEdit, onCopy, onReview, onMaintain }: {
  entry: Entry; snapshot: LibrarySnapshot; busy: boolean; blocked: boolean;
  error: KnowledgeErrorCode | 'unexpected' | null; diagnostics: Diagnostic[];
  onClose: () => void; onEdit: () => void; onCopy: () => void;
  onReview: (action: 'adopt' | 'reject') => void; onMaintain: (action: 'archive' | 'restore' | 'purge') => void;
}) {
  const { t, i18n } = useTranslation('knowledge');
  const status = entryStatus(entry, snapshot), reviewable = needsReview(entry, snapshot), archived = entry.state === 'archived';
  const disabled = busy || blocked;
  const collection = snapshot.data.collections.find(item => item.id === entry.collectionId);
  const subjectName = (id: string) => snapshot.data.subjects.find(item => item.id === id)?.name ?? id;
  return <KnowledgeRecordDialog title={t('workspace.entry_details')} icon={<BookOpen />} description={entry.title}
    testId="knowledge-entry-detail" pending={busy} error={error} onClose={onClose}
    notice={<ErrorNotice error={error} diagnostics={diagnostics} stageClassName="pt-4" />}
    footerStart={<KnowledgeRecordMenu testId="knowledge-entry-actions" disabled={disabled}>
      <DropdownMenuItem data-testid="knowledge-entry-copy" onSelect={onCopy}><Copy />{t('actions.copy')}</DropdownMenuItem>
      {reviewable && <DropdownMenuItem data-testid="knowledge-entry-reject" onSelect={() => onReview('reject')}><X />{t('actions.reject')}</DropdownMenuItem>}
      <DropdownMenuSeparator />
      {archived ? <DropdownMenuItem data-testid="knowledge-entry-purge" variant="destructive" onSelect={() => onMaintain('purge')}><Trash2 />{t('maintenance.preview_purge')}</DropdownMenuItem>
        : <DropdownMenuItem data-testid="knowledge-entry-maintenance" onSelect={() => onMaintain('archive')}><Archive />{t('maintenance.preview_archive')}</DropdownMenuItem>}
    </KnowledgeRecordMenu>}
    footer={<>
      <Button data-testid="knowledge-entry-edit" variant={reviewable || archived ? 'outline' : 'default'} size="sm" disabled={disabled} onClick={onEdit}><Pencil />{t('actions.edit')}</Button>
      {reviewable && <Button data-testid="knowledge-entry-adopt" size="sm" disabled={disabled} onClick={() => onReview('adopt')}><Check />{t('actions.adopt')}</Button>}
      {archived && <Button data-testid="knowledge-entry-maintenance" size="sm" disabled={disabled} onClick={() => onMaintain('restore')}><RotateCcw />{t('maintenance.preview_restore')}</Button>}
    </>}>
    <div className="knowledge-entry-identity">
      <div className="knowledge-entry-meta"><span>{t(`kind.${entry.kind}`)}</span><span aria-hidden>·</span><span>{languagePairLabel(t, entry.scope.languagePair)}</span><span className="knowledge-entry-status" data-state={status}>{status === 'ready' && <CircleCheck />}{t(`status.${status}`)}</span></div>
      <h2>{entry.title}</h2>
      <p className="knowledge-entry-origin"><Folder /><span>{collection?.name ?? entry.collectionId}<span className="mx-2" aria-hidden>·</span>{t('record.revision', { revision: entry.revision })}</span></p>
    </div>
    <EntryContent entry={entry} />
    <div data-testid="knowledge-entry-scope" className="knowledge-form-section border-t pt-4">
      <div className="knowledge-section-heading"><h3>{t('editor.scope')}</h3></div>
      {entry.scope.requiredSubjects.length ? <dl className="knowledge-entry-facts">{entry.scope.requiredSubjects.map(item => <Fact key={`${item.subjectId}-${item.role}`} label={t(`role.${item.role}`)}>{subjectName(item.subjectId)}</Fact>)}</dl>
        : <p className="knowledge-editor-help">{t('scope.general_help')}</p>}
      {entry.scope.condition.mode !== 'none' && <div className="knowledge-entry-condition"><strong>{t(`condition.${entry.scope.condition.mode}`)}</strong><p>{entry.scope.condition.text}</p></div>}
      {entry.aboutSubjectIds.length > 0 && <dl className="knowledge-entry-facts"><Fact label={t('fields.about_subjects')}>{entry.aboutSubjectIds.map(subjectName).join(' · ')}</Fact></dl>}
    </div>
    {(reviewable || archived || entry.kind === 'memory' || entry.kind === 'expression') && <div className="knowledge-entry-note"><Info /><p>{t(archived ? 'maintenance.restore_help' : entry.kind === 'memory' || entry.kind === 'expression' ? 'guide.storage_only_help' : 'record.review_help')}</p></div>}
    <div className="knowledge-entry-secondary">
      <KnowledgeDisclosure data-testid="knowledge-entry-sources" variant="inline" title={t('detail.sources')} description={t('record.source_count', { count: entry.evidence.length })}>
        {entry.evidence.map((evidence, index) => {
          const source = snapshot.data.sources.find(item => item.id === evidence.sourceId);
          return source ? <article className="knowledge-entry-evidence" key={index}>
            <h4>{source.title}</h4>
            <div className="knowledge-entry-meta"><span>{t(`source.${source.kind}`)}</span><span aria-hidden>·</span><span>{t(`support.${evidence.support}`)}</span></div>
            <blockquote>{source.excerpt}</blockquote>
            {evidence.note && <p>{evidence.note}</p>}
            {source.url && <p className="text-muted-foreground">{source.url}</p>}
            {(source.attribution || source.accessedAt) && <p className="text-muted-foreground">{[source.attribution, source.accessedAt && new Date(source.accessedAt).toLocaleDateString(i18n.language)].filter(Boolean).join(' · ')}</p>}
          </article> : <p className="knowledge-editor-help" key={index}>{t('record.source_missing')}</p>;
        })}
      </KnowledgeDisclosure>
      <KnowledgeDisclosure data-testid="knowledge-entry-all-fields" variant="inline" title={t('detail.all_fields')}><RecordDetails record={entry} /></KnowledgeDisclosure>
    </div>
  </KnowledgeRecordDialog>;
}
