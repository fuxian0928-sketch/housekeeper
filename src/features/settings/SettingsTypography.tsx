import type {ReactNode} from 'react';
import {ChevronDown,Info} from 'lucide-react';

export function SettingsPaneHeading({title,description,children}:{title:string;description:string;children?:ReactNode}){
  return <header className="settings-pane-heading"><div><h2>{title}</h2><p>{description}</p></div>{children}</header>;
}

export function SettingsGroup({title,note,children}:{title:string;note?:string;children:ReactNode}){
  return <section className="settings-field-group" aria-label={title}><header><h3>{title}</h3>{note?<span>{note}</span>:null}</header><div className="settings-field-grid">{children}</div></section>;
}

export function SettingsHelp({title,children}:{title:string;children:ReactNode}){
  return <details className="settings-help"><summary><Info size={12} aria-hidden="true"/><span>{title}</span><ChevronDown size={12} aria-hidden="true"/></summary><div>{children}</div></details>;
}
