import type { CSSProperties, ReactNode } from 'react';
import { StudioScrollFade } from '@/pages/Tools/Subtitle/SubtitleStudio/StudioScrollFade';
import './KnowledgeScrollList.css';

/** Keep list edges tied to the viewport; headers and actions stay outside it. */
export function KnowledgeScrollList({ children, testId, maxHeight = 'min(32rem, 56vh)', contentClassName = 'space-y-1 p-2' }: {
  children: ReactNode; testId: string; maxHeight?: CSSProperties['maxHeight']; contentClassName?: string;
}) {
  return <div data-testid={testId} className="knowledge-scroll-list"><StudioScrollFade maxHeight={maxHeight} contentClassName={contentClassName}>{children}</StudioScrollFade></div>;
}
