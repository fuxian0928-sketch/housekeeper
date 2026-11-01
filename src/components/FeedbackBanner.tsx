import type {ReactNode} from 'react';
import {AlertTriangle, CheckCircle2, Info, X} from 'lucide-react';
import './feedback.css';

type FeedbackTone = 'info' | 'success' | 'warning' | 'error';

/** Shared action feedback; form dialogs and ongoing task states keep their own layout. */
export function FeedbackBanner({children, tone = 'info', action, onDismiss}: {
  children: ReactNode;
  tone?: FeedbackTone;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  return <div className="feedback-banner" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon className="feedback-banner-icon" size={16} aria-hidden="true"/>
    <div className="feedback-banner-copy">{children}</div>
    {action ? <div className="feedback-banner-action">{action}</div> : null}
    {onDismiss ? <button type="button" className="feedback-banner-close" aria-label="关闭提示" onClick={onDismiss}><X size={14} aria-hidden="true"/></button> : null}
  </div>;
}
