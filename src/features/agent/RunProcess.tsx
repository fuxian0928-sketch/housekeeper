import {ProcessRows} from './ProcessRows';
import {buildProcessRows} from './process-rows';
import type {RunView} from './types';

export function RunProcess({view}:{view:RunView}){
  return <ProcessRows key={view.run.id} rows={buildProcessRows(view)}/>;
}
