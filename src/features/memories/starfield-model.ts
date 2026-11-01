export type StarNode = {
  id: string; kind: 'memory'|'event'|'group'; title: string; content: string;
  state: 'current'|'historical'|'recorded'; projectId: string|null; projectName: string;
  createdAt: string; updatedAt: string; memoryType?: string; revision?: number;
  source?: {kind: 'document'|'message'|'event'|'run'; id: string};
};
export type StarEdge = {id: string; source: string; target: string; kind: 'evidence'|'sequence'|'updates'|'conflict'|'belongs'; label: string};
export type StarGraph = {revision: string; updatedAt: string|null; nodes: StarNode[]; edges: StarEdge[]; projects: {id: string;name: string}[]; limited: boolean; stats: {totalMemories: number;memories: number;events: number;historical: number;connections: number}};
export type StarPoint = {x: number;y: number;radius: number};
const hash=(id: string)=>{let value=2166136261;for(const letter of id)value=Math.imul(value^letter.charCodeAt(0),16777619);value^=value>>>16;value=Math.imul(value,0x85ebca6b);value^=value>>>13;value=Math.imul(value,0xc2b2ae35);return((value^value>>>16)>>>0)/4294967295;};

/** Distant stars are decoration, separate from memory records, with no running simulation. */
export function ambientStars(width: number,height: number) {
  const count=Math.max(110,Math.min(650,Math.round(width*height/1450)));
  return Array.from({length:count},(_,index)=>{
    const depth=hash(`depth:${index}`);
    return {x:hash(`x:${index}`)*width,y:hash(`y:${index}`)*height,radius:depth>.985?1.15:.25+depth*.6,opacity:.13+depth*.55,warm:hash(`tone:${index}`)>.94,cross:depth>.989};
  });
}

/** Stable, bounded layout: no perpetual force loop competing with voice playback. */
export function layoutStarfield(graph: StarGraph,width: number,height: number): Map<string,StarPoint> {
  const groups=graph.nodes.filter(n=>n.kind==='group').sort((a,b)=>a.id.localeCompare(b.id));
  const centers=new Map<string,{x: number;y: number}>();
  groups.forEach((group,index)=>{
    const angle=-Math.PI/2+index*Math.PI*2/groups.length;
    centers.set(group.id,{x:groups.length===1?0:Math.cos(angle)*width*.27,y:groups.length===1?0:Math.sin(angle)*height*.27});
  });
  const positions=graph.nodes.map(node=>{
    const center=centers.get(node.kind==='group'?node.id:`group:${node.projectId??'personal'}`)??{x:0,y:0};
    const angle=hash(node.id)*Math.PI*2,r=node.kind==='group'?0:(node.kind==='memory'?42:88)+hash(node.id+'radius')*Math.min(width*.16,height*.19);
    return {id:node.id,node,x:center.x+Math.cos(angle)*r,y:center.y+Math.sin(angle)*r,targetX:center.x+Math.cos(angle)*r,targetY:center.y+Math.sin(angle)*r,radius:node.kind==='group'?3.3:node.state==='historical'?2.6:node.kind==='memory'?2.9:2.4};
  });
  const indexed=new Map(positions.map((p,i)=>[p.id,i]));
  for(let turn=0;turn<65;turn++){
    for(let i=0;i<positions.length;i++){
      const a=positions[i];
      for(let j=i+1;j<positions.length;j++){
        const b=positions[j],dx=b.x-a.x||.1,dy=b.y-a.y||.1,distance=Math.hypot(dx,dy);
        const labelled=a.node.kind!=='event'&&b.node.kind!=='event',desired=labelled?86:a.radius+b.radius+29;
        if(distance>=desired)continue;
        const push=(desired-distance)*.19,fx=dx/distance*push,fy=dy/distance*push;
        if(a.node.kind!=='group'){a.x-=fx;a.y-=fy;}if(b.node.kind!=='group'){b.x+=fx;b.y+=fy;}
      }
    }
    for(const edge of graph.edges){
      if(edge.kind==='belongs')continue;
      const a=positions[indexed.get(edge.source)??-1],b=positions[indexed.get(edge.target)??-1];if(!a||!b)continue;
      const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,force=(d-83)*.009;
      if(a.node.kind!=='group'){a.x+=dx/d*force;a.y+=dy/d*force;}if(b.node.kind!=='group'){b.x-=dx/d*force;b.y-=dy/d*force;}
    }
    for(const p of positions){
      p.x+=(p.targetX-p.x)*.035;p.y+=(p.targetY-p.y)*.035;
      p.x=Math.max(-width/2+44,Math.min(width/2-44,p.x));p.y=Math.max(-height/2+52,Math.min(height/2-52,p.y));
    }
  }
  return new Map(positions.map(p=>[p.id,{x:Math.round(p.x*10)/10,y:Math.round(p.y*10)/10,radius:p.radius}]));
}

export function placeStarLabels(nodes: StarNode[],points: Map<string,StarPoint>,wanted: Set<string>,spotlight: string|null) {
  const boxes:{left:number;top:number;right:number;bottom:number}[]=[],result=new Map<string,{x:number;y:number;anchor:'middle'|'start'|'end'}>();
  const priority=[...nodes].sort((a,b)=>Number(b.id===spotlight)-Number(a.id===spotlight)||Number(b.kind==='group')-Number(a.kind==='group'));
  for(const node of priority){
    if(!wanted.has(node.id)&&node.id!==spotlight)continue;
    const p=points.get(node.id);if(!p)continue;
    const length=Math.min(node.title.length,node.kind==='group'?15:12),width=Math.max(26,length*10.5);
    const candidates:{x:number;y:number;anchor:'middle'|'start'|'end'}[]=node.kind==='group'?[{x:0,y:-31,anchor:'middle'}]:[{x:0,y:p.radius+20,anchor:'middle'},{x:0,y:-p.radius-13,anchor:'middle'},{x:p.radius+10,y:4,anchor:'start'},{x:-p.radius-10,y:4,anchor:'end'}];
    for(const candidate of candidates){
      const left=p.x+candidate.x-(candidate.anchor==='middle'?width/2:candidate.anchor==='end'?width:0),top=p.y+candidate.y-12,box={left,top,right:left+width,bottom:top+18};
      if(boxes.some(other=>box.left<other.right+5&&box.right>other.left-5&&box.top<other.bottom+4&&box.bottom>other.top-4))continue;
      boxes.push(box);result.set(node.id,candidate);break;
    }
  }
  return result;
}
