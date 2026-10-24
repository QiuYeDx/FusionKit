import { useEffect, useState } from 'react';
import { useLongTextPage } from './page-context';

const CLEAR_MS = 50;

/**
 * Screen reader announcements ("已导入 2 篇文档", "第 88 段已保存", …). The text is cleared first so
 * the same sentence twice in a row is still read out.
 */
export function LiveRegion() {
  const { announcement } = useLongTextPage();
  const [text, setText] = useState('');
  useEffect(() => {
    if (!announcement.id) return;
    setText('');
    const timer = setTimeout(() => setText(announcement.text), CLEAR_MS);
    return () => clearTimeout(timer);
  }, [announcement]);
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="long-text-live">{text}</div>;
}
