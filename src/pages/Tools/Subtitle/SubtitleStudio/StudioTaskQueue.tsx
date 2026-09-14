import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { StudioFileName } from './StudioControls';
import './StudioTaskQueue.css';

export function StudioTaskQueue({ className = '', ...props }: ComponentPropsWithoutRef<'ul'>) {
  return <ul {...props} className={`studio-task-list ${className}`} />;
}

/** Shared task presentation; callers retain ownership of status and available actions. */
export function StudioTaskQueueRow({ name, icon, actions, metadata, progress, children, className = '', ...props }: ComponentPropsWithoutRef<'li'> & {
  name: string; icon: ReactNode; actions: ReactNode; metadata: ReactNode;
  progress?: { value: number; max: number; label: string };
}) {
  return <li {...props} className={`studio-task-row ${className}`}>
    <div className="studio-task-heading">
      <div className="studio-task-name">{icon}<StudioFileName name={name} focusable /></div>
      <div className="studio-task-actions">{actions}</div>
    </div>
    <div className="studio-task-meta">{metadata}</div>
    {progress && <progress className="studio-task-progress" max={progress.max} value={progress.value} aria-label={progress.label} />}
    {children}
  </li>;
}
