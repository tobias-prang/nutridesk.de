'use strict';
require('dotenv').config();
const mysql=require('mysql2/promise'),fsp=require('fs/promises'),path=require('path');
const pool=mysql.createPool({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'nutridesk',password:process.env.DB_PASS,database:process.env.DB_NAME||'nutridesk',connectionLimit:1});
const strokes=[];
const add=(color,width,points)=>strokes.push({color,width,points:points.map(([x,y])=>`${Math.round(x*10)/10},${Math.round(y*10)/10}`).join(' ')});
const line=(color,width,x1,y1,x2,y2)=>add(color,width,[[x1,y1],[x2,y2]]);
const poly=(color,width,points)=>add(color,width,points);
const circle=(color,width,cx,cy,r,parts=44)=>{const p=[];for(let i=0;i<=parts;i++){const a=Math.PI*2*i/parts;p.push([cx+Math.cos(a)*r,cy+Math.sin(a)*r]);}add(color,width,p);};
const ellipse=(color,width,cx,cy,rx,ry,parts=44)=>{const p=[];for(let i=0;i<=parts;i++){const a=Math.PI*2*i/parts;p.push([cx+Math.cos(a)*rx,cy+Math.sin(a)*ry]);}add(color,width,p);};
const fillRect=(color,x1,y1,x2,y2,width=24)=>{for(let y=y1;y<=y2;y+=Math.max(6,width*.78))line(color,width,x1,y,x2,y);};
const fillTri=(color,a,b,c,width=20)=>{const minY=Math.ceil(Math.min(a[1],b[1],c[1])),maxY=Math.floor(Math.max(a[1],b[1],c[1]));for(let y=minY;y<=maxY;y+=Math.max(5,width*.72)){const hits=[];for(const [p,q] of [[a,b],[b,c],[c,a]]){if((y>=Math.min(p[1],q[1]))&&(y<=Math.max(p[1],q[1]))&&p[1]!==q[1]){const t=(y-p[1])/(q[1]-p[1]);if(t>=0&&t<=1)hits.push(p[0]+t*(q[0]-p[0]));}}if(hits.length>=2){hits.sort((x,z)=>x-z);line(color,width,hits[0],y,hits[hits.length-1],y);}}};
const heart=(color,width,cx,cy,size)=>{const p=[];for(let i=0;i<=64;i++){const t=Math.PI*2*i/64,x=16*Math.sin(t)**3,y=13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t);p.push([cx+x*size/18,cy-y*size/18]);}add(color,width,p);};

// Abendhimmel in ruhigen Farbbändern.
fillRect('#111827',0,8,900,150,32);
fillRect('#3b82f6',0,165,900,245,32);
fillRect('#06b6d4',0,252,900,286,28);
// Sonne und sanfte Lichtstrahlen.
circle('#f59e0b',26,735,82,33);circle('#eab308',7,735,82,46);
for(let i=0;i<12;i++){const a=Math.PI*2*i/12;line('#eab308',4,735+Math.cos(a)*55,82+Math.sin(a)*55,735+Math.cos(a)*70,82+Math.sin(a)*70);}
// Wolken.
for(const [x,y,s] of [[135,82,1],[465,60,.82]]){ellipse('#f8fafc',16,x,y,38*s,12*s);ellipse('#f8fafc',18,x+31*s,y+2,28*s,14*s);ellipse('#f8fafc',17,x-29*s,y+4,25*s,12*s);}
// Ferne Bergketten mit Schneekanten.
fillTri('#64748b',[0,286],[150,102],[315,286],25);fillTri('#8b5cf6',[195,286],[390,116],[560,286],25);fillTri('#64748b',[450,286],[625,125],[790,286],25);fillTri('#8b5cf6',[680,286],[810,154],[900,286],25);
poly('#f8fafc',5,[[86,181],[150,102],[210,177],[192,165],[173,181],[153,159],[135,181],[119,164],[101,183]]);
poly('#f8fafc',5,[[325,173],[390,116],[455,179],[435,165],[418,180],[395,155],[374,180],[352,164],[335,177]]);
poly('#f8fafc',5,[[562,187],[625,125],[690,190],[671,174],[651,190],[628,165],[607,188],[587,173],[570,186]]);
// Wiese und See im Vordergrund.
fillRect('#22c55e',0,292,900,460,32);fillRect('#84cc16',0,308,900,458,26);
for(let y=330;y<=452;y+=14)line(y%28?'#22c55e':'#84cc16',14,0,y,900,y);
fillRect('#06b6d4',500,332,900,448,24);for(let y=340;y<=444;y+=14)line(y%28?'#38bdf8':'#06b6d4',10,500,y,900,y);
for(let y=352;y<435;y+=18)line('#f8fafc',2,535+(y%36)*2,y,845-(y%45),y);
// Hauskörper mit warmem Holzton.
fillRect('#f97316',210,260,465,395,28);poly('#111827',5,[[210,248],[210,397],[465,397],[465,248]]);
// Dach und Kamin.
fillTri('#ef4444',[180,262],[337,145],[500,262],28);poly('#111827',7,[[176,263],[337,143],[503,263]]);
fillRect('#64748b',414,166,449,219,18);poly('#111827',4,[[414,220],[414,166],[449,166],[449,220]]);
// Tür, Fenster und Details.
fillRect('#111827',306,305,367,395,18);poly('#f8fafc',4,[[306,396],[306,304],[367,304],[367,396]]);circle('#eab308',5,353,352,3);
for(const x of [238,398]){fillRect('#38bdf8',x,286,x+43,335,12);poly('#f8fafc',4,[[x,337],[x,283],[x+43,283],[x+43,337],[x,337]]);line('#f8fafc',3,x+21.5,284,x+21.5,336);line('#f8fafc',3,x,310,x+43,310);}
// Rauchkringel.
ellipse('#f8fafc',5,447,143,17,9);ellipse('#f8fafc',4,464,119,23,11);ellipse('#f8fafc',3,485,91,28,13);
// Weg zum Haus.
poly('#f59e0b',25,[[336,397],[345,420],[370,460]]);poly('#eab308',8,[[336,397],[345,420],[370,460]]);
// Große Bäume mit mehreren Kronen.
for(const [x,y,s] of [[105,300,1],[585,292,.9],[845,288,1.05]]){line('#f97316',22,x,y,x,y+112*s);line('#111827',5,x,y,x,y+112*s);for(const [dx,dy,r] of [[0,-20,38],[-27,4,31],[28,6,33],[0,21,35]])circle('#22c55e',22,x+dx*s,y+dy*s,r*s);for(const [dx,dy,r] of [[0,-22,38],[-27,4,31],[28,6,33],[0,21,35]])circle('#84cc16',5,x+dx*s,y+dy*s,r*s);}
// Zaun entlang der Wiese.
for(let x=18;x<=190;x+=34){line('#f8fafc',7,x,366,x,420);poly('#f8fafc',7,[[x-5,370],[x,358],[x+5,370]]);}line('#f8fafc',6,12,384,198,384);line('#f8fafc',6,12,406,198,406);
// Blumen und kleine Naturdetails.
const flowers=[[42,438,'#ec4899'],[75,424,'#f59e0b'],[138,444,'#a78bfa'],[178,429,'#fb7185'],[475,433,'#f8fafc'],[620,449,'#ec4899'],[690,422,'#eab308']];
for(const [x,y,c] of flowers){line('#22c55e',3,x,y,x,y-18);for(let i=0;i<6;i++){const a=Math.PI*2*i/6;circle(c,5,x+Math.cos(a)*7,y-21+Math.sin(a)*7,2.2,10);}circle('#eab308',5,x,y-21,2.5,10);}
// Vögel über den Bergen.
for(const [x,y,s] of [[570,78,1],[613,92,.75],[275,79,.62]])poly('#111827',4,[[x-12*s,y],[x,y-7*s],[x+12*s,y]]);
// Persönliches Schild am Garten – dezent, aber klar erkennbar.
fillRect('#111827',112,324,190,350,14);poly('#f8fafc',3,[[111,316],[191,316],[191,357],[111,357],[111,316]]);line('#f97316',8,151,357,151,391);
// T, Herz und H als Linienzug.
line('#f8fafc',4,122,329,139,329);line('#f8fafc',4,130.5,329,130.5,344);heart('#ec4899',3,151,337,9);line('#f8fafc',4,168,329,168,344);line('#f8fafc',4,181,329,181,344);line('#f8fafc',4,168,336.5,181,336.5);

(async()=>{const conn=await pool.getConnection();try{const [[space]]=await conn.execute(`SELECT c.id,c.board_json,c.board_version,u1.name owner_name,u1.username owner_username,u2.name partner_name,u2.username partner_username FROM couple_spaces c JOIN users u1 ON u1.id=c.owner_id JOIN users u2 ON u2.id=c.partner_id WHERE (LOWER(u1.username)='tobiasprang' OR LOWER(u2.username)='tobiasprang') AND (LOWER(u1.name) LIKE '%huda%' OR LOWER(u2.name) LIKE '%huda%' OR LOWER(u1.username) LIKE '%huda%' OR LOWER(u2.username) LIKE '%huda%') LIMIT 1`);if(!space)throw new Error('Gemeinsamer Couple Space von Tobias und Huda nicht gefunden');const backupRoot=path.join(process.env.STORAGE_ROOT||'/home/nutridesk.de/storage','couple-board-backups');await fsp.mkdir(backupRoot,{recursive:true});const stamp=new Date().toISOString().replace(/[:.]/g,'-');const backup=path.join(backupRoot,`couple-${space.id}-${stamp}.json`);await fsp.writeFile(backup,space.board_json||'[]',{flag:'wx'});const json=JSON.stringify(strokes);if(strokes.length>800||Buffer.byteLength(json)>1500000)throw new Error('Zeichnung überschreitet das Board-Limit');await conn.execute('UPDATE couple_spaces SET board_json=?,board_version=board_version+1 WHERE id=?',[json,space.id]);console.log(JSON.stringify({ok:true,spaceId:space.id,owner:space.owner_name,partner:space.partner_name,strokes:strokes.length,bytes:Buffer.byteLength(json),backup}));}finally{conn.release();await pool.end();}})().catch(e=>{console.error(e.stack||e.message);process.exit(1);});
