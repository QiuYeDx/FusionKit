import type { ReactNode } from 'react';
import { StudioDocumentList } from './StudioDocumentList';
import './StudioBatch.css';

export function StudioBatchItems({ children }: { children: ReactNode }) {
  return <div className="studio-batch-results"><StudioDocumentList>{children}</StudioDocumentList></div>;
}
