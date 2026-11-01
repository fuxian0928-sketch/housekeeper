import {useEffect,useRef,useSyncExternalStore,type CSSProperties} from 'react';

export type MatrixOrbState='idle'|'listening'|'thinking'|'speaking';
type MatrixOrbProps={state:MatrixOrbState;level?:number;size?:number;dots?:number;color?:string};
type MatrixPoint={nx:number;ny:number;d:number;x:number;y:number;falloff:number};
const STATES:MatrixOrbState[]=['idle','listening','thinking','speaking'];
const SCALE:Record<MatrixOrbState,number>={idle:.88,listening:1,thinking:.92,speaking:1.04};
const ORBITERS=[{radius:.62,speed:2.2,phase:0,spread:.42},{radius:.4,speed:-1.7,phase:2.1,spread:.36},{radius:.8,speed:1.15,phase:4,spread:.34}];
const MOTION_QUERY='(prefers-reduced-motion: reduce)';
function subscribeDpr(listener:()=>void){window.addEventListener('resize',listener);return()=>window.removeEventListener('resize',listener);}
function subscribeMotion(listener:()=>void){const media=window.matchMedia(MOTION_QUERY);media.addEventListener('change',listener);return()=>media.removeEventListener('change',listener);}
const readDpr=()=>Math.min(window.devicePixelRatio||1,4);
const readMotion=()=>window.matchMedia(MOTION_QUERY).matches;
function envelope(t:number){const slow=.5+.5*Math.sin(t*.62+.4),fast=.5+.5*Math.sin(t*1.9+1.1);return .22+.78*(.45+.55*slow)*fast;}
function readColor(canvas:HTMLCanvasElement){return getComputedStyle(canvas).color.match(/[\d.]+/g)?.slice(0,3).map(Number)??[139,149,158];}

/** The user's matrix-dot visual, driven by companion state. `level` can accept a
 * measured 0–1 level; without one, the motion is a state cue, not an audio meter. */
export function MatrixOrb({state,level,size=240,dots=11,color}:MatrixOrbProps){
  const canvasRef=useRef<HTMLCanvasElement>(null),stateRef=useRef(state),levelRef=useRef(level);
  const colorRef=useRef([139,149,158]),redrawRef=useRef<(()=>void)|null>(null);
  const dpr=useSyncExternalStore(subscribeDpr,readDpr,()=>1),reduced=useSyncExternalStore(subscribeMotion,readMotion,()=>true);
  const dimension=Number.isFinite(size)?Math.min(480,Math.max(80,size)):240;
  const grid=Number.isFinite(dots)?Math.min(31,Math.max(3,Math.round(dots))):11;
  useEffect(()=>{stateRef.current=state;levelRef.current=level;if(canvasRef.current)colorRef.current=readColor(canvasRef.current);redrawRef.current?.();},[state,level,color]);
  useEffect(()=>{
    const canvas=canvasRef.current,ctx=canvas?.getContext('2d');if(!canvas||!ctx)return;
    const buffer=Math.round(dimension*dpr);canvas.width=canvas.height=buffer;ctx.setTransform(buffer/dimension,0,0,buffer/dimension,0,0);
    const half=(grid-1)/2,spacing=dimension*.74/(grid-1),maxRadius=spacing*.6,center=dimension/2;
    const points:MatrixPoint[]=[];
    for(let iy=0;iy<grid;iy++)for(let ix=0;ix<grid;ix++){
      const nx=(ix-half)/half,ny=(iy-half)/half,d=Math.hypot(nx,ny);
      if(d<=1.12)points.push({nx,ny,d,x:(ix-half)*spacing,y:(iy-half)*spacing,falloff:Math.exp(-d*d*1.7)});
    }
    const weights:Record<MatrixOrbState,number>={idle:0,listening:0,thinking:0,speaking:0};weights[stateRef.current]=1;
    let ink=[...colorRef.current],t=0,amplitude=0,scale=SCALE[stateRef.current],velocity=0,last=performance.now(),raf=0,intersecting=true,disposed=false;
    const levelAt=(time:number)=>{const value=levelRef.current;return value===undefined||!Number.isFinite(value)?envelope(time):Math.min(1,Math.max(0,value));};
    const draw=(time:number,strength:number,zoom:number)=>{
      ctx.clearRect(0,0,dimension,dimension);
      const tint=(amount:number)=>`rgb(${ink.map(value=>Math.round(value+(255-value)*amount)).join(',')})`;
      const pigment=ctx.createLinearGradient(dimension*.12,dimension*.12,dimension*.88,dimension*.88);
      pigment.addColorStop(0,tint(.28));pigment.addColorStop(.5,tint(0));pigment.addColorStop(1,tint(.18));ctx.fillStyle=pigment;
      const orbiters=ORBITERS.map(orb=>({x:Math.cos(time*orb.speed+orb.phase)*orb.radius,y:Math.sin(time*orb.speed+orb.phase)*orb.radius,spread:orb.spread*orb.spread}));
      for(const point of points){
        let intensity=0;
        if(weights.idle>.001)intensity+=weights.idle*(.62+.12*Math.sin(time*1.05-point.d*2.4));
        if(weights.listening>.001)intensity+=weights.listening*(.32+strength*(.34+.38*(.5+.5*Math.sin(point.d*4.2-time*3))));
        if(weights.thinking>.001){let heat=0;for(const orb of orbiters)heat+=Math.exp(-((point.nx-orb.x)**2+(point.ny-orb.y)**2)/orb.spread);intensity+=weights.thinking*(.26+.8*Math.min(1,heat));}
        if(weights.speaking>.001){const wave=.5+.5*Math.sin(point.nx*4.4-time*5.6),body=Math.exp(-point.ny*point.ny*2.3);intensity+=weights.speaking*(.28+strength*(.24+.65*wave*body));}
        const radius=maxRadius*point.falloff*Math.min(1,Math.max(0,intensity))*zoom;
        if(radius*dpr<.5)continue;
        ctx.globalAlpha=.56+.44*Math.max(0,1-point.d*.65);
        ctx.beginPath();ctx.arc(center+point.x*zoom,center+point.y*zoom,radius,0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=1;
    };
    const visible=()=>!document.hidden&&intersecting&&canvas.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
    const frame=(now:number)=>{
      raf=0;if(disposed||!visible())return;
      const dt=Math.min((now-last)/1000,.05);last=now;t+=dt;
      const target=levelAt(t),rate=target>amplitude ? .22 : .08,blend=1-Math.pow(1-.16,dt*60);
      amplitude+=(target-amplitude)*(1-Math.pow(1-rate,dt*60));
      for(const value of STATES)weights[value]+=((value===stateRef.current?1:0)-weights[value])*blend;
      ink=ink.map((value,index)=>value+(colorRef.current[index]-value)*blend);
      velocity+=(-180*(scale-SCALE[stateRef.current])-26*velocity)*dt;scale+=velocity*dt;
      draw(t,amplitude,scale);raf=requestAnimationFrame(frame);
    };
    const sync=()=>{
      if(disposed)return;cancelAnimationFrame(raf);raf=0;
      if(!visible())return;
      if(reduced){for(const value of STATES)weights[value]=value===stateRef.current?1:0;ink=[...colorRef.current];draw(0,levelAt(0),SCALE[stateRef.current]);}
      else{last=performance.now();raf=requestAnimationFrame(frame);}
    };
    // Draw a first frame even in an initially hidden tab. Later loops pause while
    // clipped, behind a compact detail pane, or in a background tab.
    draw(0,levelAt(0),scale);redrawRef.current=sync;
    const intersection=new IntersectionObserver(entries=>{intersecting=entries[0]?.isIntersecting??false;sync();});intersection.observe(canvas);
    const visibility=new MutationObserver(sync);
    for(let parent=canvas.parentElement;parent;parent=parent.parentElement)visibility.observe(parent,{attributes:true,attributeFilter:['hidden','inert','class','style']});
    document.addEventListener('visibilitychange',sync);sync();
    return()=>{disposed=true;cancelAnimationFrame(raf);redrawRef.current=null;intersection.disconnect();visibility.disconnect();document.removeEventListener('visibilitychange',sync);};
    // State/color changes retarget the existing spring and blend, not the clock.
  },[dimension,grid,dpr,reduced]);
  return <div className="matrix-orb" data-slot="matrix-orb" data-state={state} data-motion={reduced?'reduced':'full'} aria-hidden="true" style={{'--matrix-orb-size':`${dimension}px`,...(color?{color}:{})} as CSSProperties}><canvas ref={canvasRef}/></div>;
}
