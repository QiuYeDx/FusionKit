import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { KnowledgeErrorCode } from '@/translation-knowledge/ipc-contract';
import { ErrorNotice } from './Controls';

/** Exports only the bundled skill, independently of the user's library. */
export function KnowledgeSkillDownload() {
  const { t } = useTranslation('knowledge');
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<KnowledgeErrorCode | 'unexpected' | null>(null);
  const save = async () => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true); setError(null); setFileName('');
    try {
      const result = await window.translationKnowledge.exportSkill();
      if (!result.ok) setError(result.error);
      else if (result.value) setFileName(result.value.fileName);
    } catch { setError('unexpected'); }
    finally { pending.current = false; setSaving(false); }
  };
  return <div className="space-y-2 border-t p-3">
    <Button data-testid="knowledge-save-skill" variant="outline" size="sm" className="h-auto min-h-8 w-full whitespace-normal px-2 py-1.5 text-xs" disabled={saving} onClick={() => void save()}>
      {saving ? <LoaderCircle className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <Download className="size-3.5 shrink-0" />}
      {t(saving ? 'skill_export.saving' : 'skill_export.save')}
    </Button>
    <p role="status" className="text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
      {fileName ? t('skill_export.saved', { fileName }) : t('skill_export.help')}
    </p>
    <ErrorNotice error={error} />
  </div>;
}
