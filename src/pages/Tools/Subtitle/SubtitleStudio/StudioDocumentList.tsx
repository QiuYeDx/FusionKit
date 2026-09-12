import { Children, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from 'react';
import { StudioFileName } from './StudioControls';
import { StudioScrollFade } from './StudioScrollFade';
import './StudioDocumentList.css';

/** Use scroll=false when the surrounding dialog already owns the scroll viewport. */
export function StudioDocumentList({ children, label, scroll = true, maxHeight, className = '', ...props }: ComponentPropsWithoutRef<'ul'> & {
  label?: string; scroll?: boolean; maxHeight?: CSSProperties['maxHeight'];
}) {
  const list = <ul {...props} aria-label={label ?? props['aria-label']} className={`studio-document-list ${className}`}>{children}</ul>;
  return scroll ? <StudioScrollFade maxHeight={maxHeight}>{list}</StudioScrollFade> : list;
}

export function StudioDocumentRow({ name, title, index, metadata, status, actions, children, density = 'compact', className = '', ...props }: Omit<ComponentPropsWithoutRef<'li'>, 'title'> & {
  name?: string; title?: ReactNode; index?: number; metadata?: ReactNode; status?: ReactNode; actions?: ReactNode; density?: 'compact' | 'detail';
}) {
  return <li {...props} className={`studio-document-row ${className}`} data-density={density}>
    {index !== undefined && <span className="studio-document-row-number" aria-hidden="true">{index}</span>}
    <div className="studio-document-row-body">
      <div className="studio-document-row-heading">
        <div className="studio-document-row-name">{name !== undefined ? <StudioFileName name={name} focusable /> : title}</div>
        {status && <div className="studio-document-row-status">{status}</div>}
        {actions && <div className="studio-document-row-actions">{actions}</div>}
      </div>
      {metadata && <div className="studio-document-row-meta">{metadata}</div>}
      {Children.toArray(children).length > 0 && <div className="studio-document-row-details">{children}</div>}
    </div>
  </li>;
}
