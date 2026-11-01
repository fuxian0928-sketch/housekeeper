import type { Express } from 'express';
import type { SessionExperienceCoordinator } from '../domain/memories/session-experience-coordinator.js';

export function registerSessionExperienceRoutes(app:Express,dependencies:{coordinator:SessionExperienceCoordinator;enabled:()=>boolean;saveEnabled:(value:boolean)=>void}) {
  const snapshot=()=>({enabled:dependencies.enabled(),records:dependencies.coordinator.list(),storage:'session-memory',persistent:false});
  app.get('/api/voice/session-experiences',(_request,response)=>response.json(snapshot()));
  app.patch('/api/voice/session-experiences',(request,response)=>{
    if(typeof request.body?.enabled!=='boolean'){response.status(400).json({message:'请选择开启或关闭会话感受记忆。'});return;}
    dependencies.saveEnabled(request.body.enabled);
    if(!request.body.enabled)dependencies.coordinator.clear();
    response.json(snapshot());
  });
  app.delete('/api/voice/session-experiences/:conversationId/:sourceMessageId',(request,response)=>{
    const {conversationId,sourceMessageId}=request.params;
    if(![conversationId,sourceMessageId].every(id=>typeof id==='string'&&id.length>0&&id.length<=200)){response.status(400).json({message:'感受记录标识无效，请刷新后重试。'});return;}
    dependencies.coordinator.remove(conversationId,sourceMessageId);
    response.json(snapshot());
  });
  app.delete('/api/voice/session-experiences',(_request,response)=>{
    dependencies.coordinator.clear();response.json(snapshot());
  });
}
