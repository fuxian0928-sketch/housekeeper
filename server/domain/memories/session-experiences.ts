import { randomUUID } from 'node:crypto';

export type ExperienceEvidence = {
  sourceMessageId: string; sourceText: string; observedAt: string;
  projectId: string | null;
};
export type SessionExperience = {
  id: string; conversationId: string; eventId: string; content: string;
  sourceMessageId: string; excerpt: string; observedAt: string;
  projectId: string | null; validUntil: string;
};
type Ticket = { conversationId: string; revision: string };
type Session = { revision: string; touched: number; enabled: boolean; records: Map<string,SessionExperience> };

/** Session-only RAM storage. Trusted orchestration supplies verified user-message evidence.
 * Tickets prevent late extraction from reviving corrected, removed or evicted data.
 * There is deliberately no persistence, vector index, inferred personality or preference promotion.
 */
export class SessionExperienceStore {
  private sessions = new Map<string,Session>();
  constructor(private readonly now = Date.now, private readonly ttlMs = 30 * 60_000) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 24*60*60_000) throw Error('EXPERIENCE_TTL_INVALID');
  }
  private prune() {
    for (const [id,session] of this.sessions) {
      if (this.now()-session.touched >= this.ttlMs) this.sessions.delete(id);
      else for (const [eventId,row] of session.records) if (Date.parse(row.validUntil)<=this.now()) session.records.delete(eventId);
    }
  }
  begin(conversationId:string):Ticket {
    if (!conversationId || conversationId.length>200) throw Error('EXPERIENCE_SCOPE_INVALID');
    this.prune();
    let session=this.sessions.get(conversationId);
    if (!session) {
      if (this.sessions.size>=128) this.sessions.delete(this.sessions.keys().next().value!);
      session={revision:randomUUID(),touched:this.now(),enabled:true,records:new Map()};
      this.sessions.set(conversationId,session);
    }
    // A later final utterance invalidates extraction still running for an earlier one.
    session.revision=randomUUID();session.touched=this.now();
    return {conversationId,revision:session.revision};
  }
  apply(ticket:Ticket, evidence:ExperienceEvidence, observations:readonly {eventId:string;content:string;excerpt:string;explicit:boolean}[]):boolean {
    this.prune();
    const session=this.sessions.get(ticket.conversationId);
    if (!session || !session.enabled || session.revision!==ticket.revision) return false;
    if (!evidence.sourceMessageId || evidence.sourceMessageId.length>200 || !Number.isFinite(Date.parse(evidence.observedAt)) || Date.parse(evidence.observedAt)>this.now()+1000 || this.now()-Date.parse(evidence.observedAt)>=this.ttlMs) return false;
    if (observations.length>8) return false;
    // Validate the complete batch first; never partially accept malformed extraction.
    if (observations.some(item=>item.explicit!==true || !item.eventId || item.eventId.length>200 || !item.content.trim() || item.content.length>500 || !item.excerpt.trim() || item.excerpt.length>500 || !evidence.sourceText.includes(item.excerpt))) return false;
    for (const item of observations) {
      session.records.delete(item.eventId);
      session.records.set(item.eventId,{id:randomUUID(),conversationId:ticket.conversationId,eventId:item.eventId,content:item.content.trim(),sourceMessageId:evidence.sourceMessageId,excerpt:item.excerpt,observedAt:evidence.observedAt,projectId:evidence.projectId,validUntil:new Date(Date.parse(evidence.observedAt)+this.ttlMs).toISOString()});
      while(session.records.size>32)session.records.delete(session.records.keys().next().value!);
    }
    session.revision=randomUUID(); // A ticket cannot be replayed after successful application.
    return true;
  }
  list(conversationId:string,projectIds:readonly string[]):SessionExperience[] {
    this.prune();const session=this.sessions.get(conversationId);
    if (!session?.enabled)return [];
    return [...session.records.values()].filter(row=>row.projectId===null || projectIds.includes(row.projectId)).map(row=>({...row}));
  }
  invalidate(conversationId:string,eventId?:string) {
    const session=this.sessions.get(conversationId);if(!session)return;
    session.revision=randomUUID();
    if(eventId===undefined)session.records.clear();else session.records.delete(eventId);
  }
  setEnabled(conversationId:string,enabled:boolean) {
    this.begin(conversationId);const session=this.sessions.get(conversationId)!;
    session.enabled=enabled;if(!enabled)session.records.clear();
  }
  end(conversationId:string) {this.sessions.delete(conversationId);}
}
