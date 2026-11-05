// Finds viewpoints from each generated city (spire, rooftop, boulevard, hill, shore) and renders them. usage: OUT=dir CHROME_DIR=dir node tools/viewpoints.mjs 2160x2700 128 name,name
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT=process.env.OUT; mkdirSync(OUT,{recursive:true});
const SIZE=process.argv[2]?.split('x').map(Number)??[648,810]; const SAMPLES=+(process.argv[3]??40);
const port=9349;
const chrome=spawn('chromium',['--headless=new','--remote-debugging-port='+port,'--use-angle=vulkan','--ignore-gpu-blocklist','--window-size=640,480','--user-data-dir='+process.env.CHROME_DIR,'about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const tabs=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let id=0;const pend=new Map();const logs=[];
ws.onmessage=m=>{const d=JSON.parse(m.data);if(d.id){pend.get(d.id)?.(d);pend.delete(d.id)}else if(d.method==='Runtime.exceptionThrown')logs.push(JSON.stringify(d.params.exceptionDetails).slice(0,500))};
const send=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}))});
const ev=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true})).result.result?.value;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await send('Runtime.enable');await send('Page.enable');
const P='population=7500000&density=45000&maxFloors=90&centres=3&danji=0.9&slopeLimit=24&riverWiden=0&seed=1&hour=14';
// In-page finders: real features of each generated city, so viewpoints come from the data.
const FIND=`(()=>{
 const m=__mc,c=m.state.city,N=m.state.domain.w,CELL=25,low=m.state.lowest;
 const f=new Float32Array(c.buildings),u=new Uint8Array(c.buildings);
 const ground=(x,z)=>m.groundAt(x,z);
 let spire=null,towers=[];
 for(let k=0;k<c.count;k++){const kind=u[k*28+25];if(kind===6)spire={x:f[k*7],z:f[k*7+2],top:f[k*7+1]+f[k*7+5]};if(kind===3&&f[k*7+5]>90)towers.push({x:f[k*7],z:f[k*7+2],top:f[k*7+1]+f[k*7+5],h:f[k*7+5]});}
 if(!spire){towers.sort((a,b)=>b.top-a.top);spire=towers[0]}
 const bearing=(a,b)=>(Math.atan2(b.x-a.x,-(b.z-a.z))*180/Math.PI+360)%360;
 const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
 // Rooftop: a tower 500-1100 m from the spire.
 const roofs=towers.filter(t=>{const d=dist(t,spire);return d>500&&d<1100&&t.h<spire.top*0.6}).sort((a,b)=>b.h-a.h);
 const roof=roofs[0]??null;
 // Boulevard: the arterial stretch 900-1800 m out that points most directly at the spire.
 let blvd=null,best=25;
 for(const l of c.roads){if(l.level!==1||l.real)continue;for(let q=2;q+1<l.points.length;q+=2){const a={x:l.points[q-2],z:l.points[q-1]},b={x:l.points[q],z:l.points[q+1]};const d=dist(a,spire);if(d<900||d>1800)continue;for(const [from,to] of [[a,b],[b,a]]){let off=Math.abs(((bearing(from,to)-bearing(from,spire))+540)%360-180);if(off<best){best=off;blvd={x:from.x,z:from.z,heading:bearing(from,to),toSpire:bearing(from,spire)}}}}}
 // Hill: highest open ground 2.5-7 km from the spire, on the side away from the given bearing.
 const hillFor=(want)=>{let h=null,hi=-1e9;for(let j=4;j<N-4;j+=2)for(let i=4;i<N-4;i+=2){const x=(i+.5-N/2)*CELL,z=(j+.5-N/2)*CELL;const d=Math.hypot(x-spire.x,z-spire.z);if(d<2500||d>7000)continue;const off=Math.abs(((bearing({x,z},spire)-want)+540)%360-180);if(off>35)continue;const y=c.bed[j*N+i]-low;if(y>hi&&!c.urban[j*N+i]){hi=y;h={x,z,y,toSpire:bearing({x,z},spire)}}}return h};
 // Shore: from the spire outward along each compass step, the first water at least 500 m wide.
 let shore=null;for(let a=0;a<360&&!shore;a+=15){const r=a*Math.PI/180;let wet=0;for(let t=100;t<6000;t+=25){const x=spire.x+Math.sin(r)*t,z=spire.z-Math.cos(r)*t;const i=Math.floor(x/CELL+N/2),j=Math.floor(z/CELL+N/2);if(i<0||j<0||i>=N||j>=N)break;if(c.water[j*N+i]){wet+=25;if(wet>=600){shore={x,z,level:c.bed[j*N+i],toSpire:(a+180)%360,dist:t};break}}else wet=0}}
 return {spire,roof,blvd,hills:{n:hillFor(0),e:hillFor(90),s:hillFor(180),w:hillFor(270),se:hillFor(147)},shore,base:m.renderer.terrain.base,stats:{b:c.stats.buildings,t:c.stats.tallestM,h:c.stats.housed}};
})()`;
const NIGHT={sunEl:-5,night:1,lit:0.27,cloudCover:0.32,haze:5e-5,exposure:1.9,nightSky:[0.01,0.016,0.04],moonE:0.06,moonAz:200,moonEl:35,underglow:[0.1,0.05,0.02]};
const FOG=(base)=>({cloudCover:0.2,fogTop:base+280,fogSoft:70,fogRelief:200,fogDensity:0.005,exposure:0.42});
const places=[
 ['Flawil','e=2731000&n=1254000&maxRise=0',(p)=>[
  ['fl_blvd_gold',{sunAz:p.blvd.toSpire+6,sunEl:5,exposure:0.45,eye:{x:p.blvd.x,y:g(p.blvd)+26,z:p.blvd.z,heading:p.blvd.toSpire,down:1,fov:0.62}}],
  ['fl_blvd_night',{...NIGHT,sunAz:p.blvd.toSpire+170,eye:{x:p.blvd.x,y:g(p.blvd)+26,z:p.blvd.z,heading:p.blvd.toSpire,down:1,fov:0.62}}],
  p.roof&&['fl_roof_gold',{sunAz:bear(p.roof,p.spire)+75,sunEl:6,eye:{...past(p.roof,p.spire,34),y:p.roof.top+5,heading:bear(p.roof,p.spire),down:3,fov:0.7}}],
  p.roof&&['fl_roof_night',{...NIGHT,sunAz:bear(p.roof,p.spire)+150,eye:{...past(p.roof,p.spire,34),y:p.roof.top+5,heading:bear(p.roof,p.spire),down:3,fov:0.7}}],
  p.roof&&['fl_roof_fog',{...FOG(p.base),sunAz:bear(p.roof,p.spire)-40,sunEl:7,eye:{...past(p.roof,p.spire,34),y:p.roof.top+5,heading:bear(p.roof,p.spire),down:2,fov:0.7}}],
  p.hills.se&&['fl_hill_se',{sunAz:290,sunEl:4,eye:{x:p.hills.se.x,y:p.hills.se.y+14,z:p.hills.se.z,heading:p.hills.se.toSpire,down:1.5,fov:0.3,ahead:1800}}],
  p.hills.w&&['fl_hill_w',{sunAz:p.hills.w.toSpire+160,sunEl:5,eye:{x:p.hills.w.x,y:p.hills.w.y+14,z:p.hills.w.z,heading:p.hills.w.toSpire,down:1.5,fov:0.34,ahead:1800}}],
  p.hills.e&&['fl_hill_e_gegen',{sunAz:p.hills.e.toSpire+4,sunEl:3,exposure:0.42,eye:{x:p.hills.e.x,y:p.hills.e.y+14,z:p.hills.e.z,heading:p.hills.e.toSpire,down:1.5,fov:0.34,ahead:1800}}],
  ['fl_plan_gold',{sunAz:285,sunEl:9,cirrus:0,eye:{x:p.spire.x,y:p.spire.top+700,z:p.spire.z+380,heading:0,down:68,fov:0.75,ahead:900}}],
  ['fl_plan_night',{...NIGHT,sunAz:300,eye:{x:p.spire.x,y:p.spire.top+700,z:p.spire.z+380,heading:0,down:68,fov:0.75,ahead:900}}],
 ]],
 ['Rorschach','e=2754800&n=1260675&maxRise=330',(p)=>p.shore?[
  ['ro_shore_low',{sunAz:p.shore.toSpire+125,sunEl:6,mirrorElev:p.shore.level,exposure:0.55,eye:{x:p.shore.x,y:p.shore.level-p.base+7,z:p.shore.z,heading:p.shore.toSpire,down:-1,fov:0.42,ahead:1400}}],
  ['ro_shore_night',{...NIGHT,sunAz:p.shore.toSpire+170,mirrorElev:p.shore.level,eye:{x:p.shore.x,y:p.shore.level-p.base+7,z:p.shore.z,heading:p.shore.toSpire,down:-1,fov:0.42,ahead:1400}}],
 ]:[]],
 ['Rapperswil','e=2704000&n=1231500&maxRise=0',(p)=>p.shore?[
  ['ra_shore_low',{sunAz:p.shore.toSpire+150,sunEl:4,mirrorElev:p.shore.level,eye:{x:p.shore.x,y:p.shore.level-p.base+7,z:p.shore.z,heading:p.shore.toSpire,down:-1,fov:0.42,ahead:1400}}],
 ]:[]],
 ['Walenstadt','e=2742350&n=1220950&maxRise=500',(p)=>p.shore?[
  ['wa_shore_low',{sunAz:p.shore.toSpire+150,sunEl:7,land:0.8,exposure:0.46,mirrorElev:p.shore.level,eye:{x:p.shore.x,y:p.shore.level-p.base+7,z:p.shore.z,heading:p.shore.toSpire,down:-5,fov:0.62,ahead:1400}}],
 ]:[]],
 ['Nesslau','e=2733350&n=1231825&maxRise=550',(p)=>[
  p.blvd&&['ne_blvd',{sunAz:p.blvd.toSpire+60,sunEl:9,eye:{x:p.blvd.x,y:g(p.blvd)+20,z:p.blvd.z,heading:p.blvd.toSpire,down:-3,fov:0.7}}],
  p.roof&&['ne_roof',{sunAz:bear(p.roof,p.spire)+70,sunEl:7,eye:{...past(p.roof,p.spire,34),y:p.roof.top+5,heading:bear(p.roof,p.spire),down:-2,fov:0.7}}],
 ]],
];
const past=(a,b,m)=>{const d=Math.hypot(b.x-a.x,b.z-a.z);return {x:a.x+(b.x-a.x)/d*m,z:a.z+(b.z-a.z)/d*m}};
let groundFn;const g=(q)=>groundFn(q);const bear=(a,b)=>(Math.atan2(b.x-a.x,-(b.z-a.z))*180/Math.PI+360)%360;
const only=process.argv[4]?.split(',');
const used={};
for(const [name,loc,list] of places){
 if(only&&!only.some(n=>n.startsWith(name.slice(0,2).toLowerCase())))continue;
 await send('Page.navigate',{url:'about:blank'});await sleep(300);
 await send('Page.navigate',{url:'http://127.0.0.1:8820/index.html#'+loc+'&name='+name+'&'+P+'&still'});
 await sleep(800);for(let i=0;i<200;i++){if(await ev('window.__mc?.ready===true&&!!__mc.renderer.outer'))break;await sleep(500)}
 const p=await ev(FIND);console.log(name,JSON.stringify({spire:p.spire,roof:p.roof,blvd:p.blvd,shore:p.shore,hills:p.hills,stats:p.stats}));
 const grounds={};
 if(p.blvd)grounds.b=await ev('__mc.groundAt('+p.blvd.x+','+p.blvd.z+')');
 groundFn=()=>grounds.b;
 for(const shot of list(p).filter(Boolean)){const [n,o]=shot;if(only&&!only.includes(n))continue;
  const opt={...o,w:SIZE[0],h:SIZE[1],samples:SAMPLES};used[n]={place:name,...o};
  await ev('window.__b=null;__mc.beauty('+JSON.stringify(opt)+').then(r=>window.__b=r).catch(e=>{console.error(e.stack||e);window.__b={failed:String(e)}});0');
  for(let i=0;i<300;i++){await sleep(400);if(await ev('!!window.__b'))break}
  console.log(n,JSON.stringify(await ev('({ms:__b.ms,e:__b.error,f:__b.failed})')));
  const len=await ev('window.__b.url?.length??0');let url='';for(let a=0;a<len;a+=2000000)url+=await ev('window.__b.url.slice('+a+','+(a+2000000)+')');
  if(url)writeFileSync(OUT+'/'+n+'.png',Buffer.from(url.split(',')[1],'base64'));
 }
}
writeFileSync(OUT+'/used.json',JSON.stringify(used,null,1));
console.log(logs.join('\n')||'no errors');chrome.kill();process.exit(0);
