const API='https://memory-anet-api-ggwahnbtst.cn-shenzhen.fcapp.run';
const PROJECT='memory-letter-platform';
const $=q=>document.querySelector(q);
const fields=['title','date','intro','letter','signature','musicTitle'];
let token=sessionStorage.getItem('letterAliyunToken')||'';
if(!token){try{token=JSON.parse(localStorage.getItem('photoMemoryGlobe.auth.v1')||'null')?.token||''}catch{}}
let record=null, content=null;
function status(s,error=false){$('#status').textContent=s;$('#status').classList.toggle('error',error)}
async function request(path,method='GET',body){
  const r=await fetch(API+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});
  const j=await r.json().catch(()=>({})); if(!r.ok)throw Error(j.error||'请求失败（'+r.status+'）'); return j;
}
function show(){
  $('#editor').hidden=false;$('#existing').hidden=false;$('#migration').hidden=false;
  fields.forEach(k=>$('#editor [name='+k+']').value=content[k]||'');
  const grid=$('#photos');grid.replaceChildren();
  (content.photos||[]).forEach((p,i)=>{
    const item=document.createElement('div'),img=document.createElement('img'),caption=document.createElement('small'),btn=document.createElement('button');
    img.src=p.src;img.alt=p.caption||'';caption.textContent=p.caption||'照片 '+(i+1);btn.textContent='移除';btn.type='button';
    btn.onclick=async()=>{if(!confirm('确定移除这张照片吗？'))return;const prior=content.photos;content.photos=prior.filter((_,n)=>n!==i);try{await save();show();status('照片已移除')}catch(e){content.photos=prior;status(e.message,true)}};
    item.append(img,caption,btn);grid.append(item);
  });
}
async function load(){
  record=await request('/projects/'+encodeURIComponent(PROJECT));
  if(record.userId && record.userId!==currentUserId)throw Error('这个信件属于另一个记忆宇宙账号');
  content=record.payload?.letterContent||{title:'',date:'',intro:'',letter:'',signature:'',musicTitle:'',hero:'',photos:[],music:'',voice:''};
  show();status('已连接阿里云。当前 '+content.photos.length+' 张照片。');
}
let currentUserId='';
async function connectExistingSession(){
  if(!token)return;
  try{
    const me=await request('/auth/me');if(!me.user)throw Error('登录已过期');
    currentUserId=me.user.userId;
    await load().catch(e=>{if(/404|not found/i.test(e.message)){record={payload:null};content={title:'',date:'',intro:'',letter:'',signature:'',musicTitle:'',hero:'',photos:[],music:'',voice:''};show()}else throw e});
    const quota=me.user.tierConfig||{};
    status('已使用记忆宇宙登录状态。当前档位：'+(quota.name||me.user.tier)+'；照片上限 '+(quota.maxPhotosPerPlanet||'?')+' 张，存储上限 '+(quota.maxStorageMb||'?')+' MB。');
  }catch(e){token='';status('请使用记忆宇宙账号登录：'+e.message,true)}
}
$('#login').onclick=async()=>{
  try{
    const login=await request('/auth/login','POST',{username:$('#username').value,password:$('#password').value});
    token=login.sessionToken;currentUserId=login.user?.userId||'';sessionStorage.setItem('letterAliyunToken',token);
    await load().catch(e=>{if(/404|not found/i.test(e.message)){record={payload:null};content={title:'',date:'',intro:'',letter:'',signature:'',musicTitle:'',hero:'',photos:[],music:'',voice:''};show();status('已登录。信件尚未迁移，保存后创建。')}else throw e});
    $('#password').value='';
  }catch(e){status(e.message,true)}
};
$('#logout').onclick=()=>{sessionStorage.removeItem('letterAliyunToken');token='';record=null;content=null;$('#editor').hidden=true;$('#existing').hidden=true;$('#migration').hidden=true;status('已退出')};
function payload(){
  const references=[...(content.photos||[]).map(p=>({url:p.src,name:p.caption||'照片'}))];
  if(content.hero&&!references.some(p=>p.url===content.hero))references.push({url:content.hero,name:'封面'});
  return {version:1,title:content.title,photos:references,letterContent:content};
}
async function save(){
  await request('/projects/'+encodeURIComponent(PROJECT),'PUT',{payload:payload()});
}
async function upload(file,kind){
  if(file.size>20*1024*1024)throw Error(file.name+' 超过阿里云单文件 20 MB 限制');
  const result=kind==='audio'
    ?await request('/music/prepare','POST',{planetId:PROJECT,filename:file.name,type:file.type||'audio/mpeg',size:file.size})
    :await request('/uploads/batch-tokens','POST',{planetId:PROJECT,files:[{filename:file.name,size:file.size}]});
  const ticket=kind==='audio'?result.ticket:result.tickets?.[0];if(!ticket)throw Error('未取得上传凭证');
  const form=new FormData();Object.entries(ticket.fields).forEach(([k,v])=>form.append(k,v));form.append('file',file);
  const res=await fetch(ticket.uploadUrl,{method:'POST',body:form});
  if(!res.ok)throw Error(file.name+' 上传失败（'+res.status+'）');
  return ticket.publicUrl;
}
$('#editor').onsubmit=async e=>{
  e.preventDefault();const btn=$('#editor button[type=submit]');btn.disabled=true;
  try{
    fields.forEach(k=>content[k]=$('#editor [name='+k+']').value);
    status('正在保存文字…');await save();
    const hero=$('#editor [name=hero]'),music=$('#editor [name=music]'),voice=$('#editor [name=voice]');
    for(const [input,key,kind] of [[hero,'hero','image'],[music,'music','audio'],[voice,'voice','audio']]){
      if(!input.files.length)continue;status('正在上传 '+input.files[0].name+'…');
      const next=await upload(input.files[0],kind);content[key]=next;await save();input.value='';
    }
    const input=$('#editor [name=photos]'),files=[...input.files],captions=$('#editor [name=captions]').value.split('\n');
    for(let i=0;i<files.length;i++){
      status('正在上传照片 '+(i+1)+' / '+files.length+'…');
      const src=await upload(files[i],'image');content.photos.push({src,caption:captions[i]?.trim()||''});await save();
    }
    input.value='';$('#editor [name=captions]').value='';show();status('保存成功，照片 '+content.photos.length+' 张。');
  }catch(err){status(err.message+'。已保存的部分会保留，请检查后继续。',true)}finally{btn.disabled=false}
};

// Read entries from a standard ZIP without sending the archive to another server.
function zipEntries(buffer){
  const view=new DataView(buffer),bytes=new Uint8Array(buffer),decoder=new TextDecoder();
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(view.getUint32(i,true)===0x06054b50){end=i;break}}
  if(end<0)throw Error('备份包格式不正确');
  const count=view.getUint16(end+10,true),entries=new Map();let pos=view.getUint32(end+16,true);
  for(let i=0;i<count;i++){
    if(view.getUint32(pos,true)!==0x02014b50)throw Error('备份包目录损坏');
    const method=view.getUint16(pos+10,true),size=view.getUint32(pos+20,true),nameLen=view.getUint16(pos+28,true),extra=view.getUint16(pos+30,true),comment=view.getUint16(pos+32,true),local=view.getUint32(pos+42,true);
    const name=decoder.decode(bytes.subarray(pos+46,pos+46+nameLen));
    if(view.getUint32(local,true)!==0x04034b50)throw Error('备份包文件损坏');
    const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
    entries.set(name,{method,data:bytes.subarray(start,start+size)});pos+=46+nameLen+extra+comment;
  }
  return entries;
}
async function entryBlob(entry,type){
  if(!entry)throw Error('备份包缺少文件');
  const raw=new Blob([entry.data]);
  if(entry.method===0)return new Blob([entry.data],{type});
  if(entry.method!==8)throw Error('备份包用了不支持的压缩格式');
  const decompressed=await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  return new Blob([decompressed],{type});
}
async function imageForUpload(blob,name){
  if(!$('#optimizePhotos').checked)return new File([blob],name,{type:'image/jpeg'});
  const bitmap=await createImageBitmap(blob),scale=Math.min(1,2000/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  const output=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.84));
  return new File([output],name,{type:'image/jpeg'});
}
function basename(path){return String(path||'').split('/').pop()}
$('#migrate').onclick=async()=>{
  const zip=$('#backupZip').files[0];if(!zip)return status('请先选择备份包',true);
  const button=$('#migrate');button.disabled=true;
  try{
    status('正在读取备份包…');const entries=zipEntries(await zip.arrayBuffer());
    const source=JSON.parse(await (await entryBlob(entries.get('letter/content.json'),'application/json')).text());
    if(!Array.isArray(source.photos)||!source.letter)throw Error('备份包内没有原信内容');
    if(content.letter && content.letter!==source.letter && !confirm('云端已有不同的正文。确定用备份包原文覆盖吗？'))return;
    // Keep successful uploads identifiable so a network interruption can resume.
    const prior=content;
    content={...source,hero:prior.heroSource===basename(source.hero)?prior.hero:'',music:prior.musicSource===basename(source.music)?prior.music:'',voice:prior.voiceSource===basename(source.voice)?prior.voice:'',photos:source.photos.map(p=>prior.photos?.find(old=>old.sourceName===basename(p.src))||{...p,src:'',sourceName:basename(p.src)}).filter(p=>p.src),heroSource:prior.heroSource,musicSource:prior.musicSource,voiceSource:prior.voiceSource};
    await save();
    async function transfer(path,kind){
      const name=basename(path),entry=entries.get('letter/assets/'+name);
      if(!entry)throw Error('备份包缺少 '+name);
      const blob=await entryBlob(entry,kind==='audio'?'audio/mpeg':'image/jpeg');
      const file=kind==='audio'?new File([blob],name,{type:'audio/mpeg'}):await imageForUpload(blob,name);
      return upload(file,kind);
    }
    if(source.hero&&!content.hero){status('上传封面…');content.hero=await transfer(source.hero,'image');content.heroSource=basename(source.hero);await save()}
    if(source.music&&!content.music){status('上传背景音乐…');content.music=await transfer(source.music,'audio');content.musicSource=basename(source.music);await save()}
    if(source.voice&&!content.voice){status('上传语音留言…');content.voice=await transfer(source.voice,'audio');content.voiceSource=basename(source.voice);await save()}
    for(let i=0;i<source.photos.length;i++){
      const p=source.photos[i],name=basename(p.src);
      if(content.photos.some(old=>old.sourceName===name))continue;
      status('上传照片 '+(i+1)+' / '+source.photos.length+'…');
      const src=await transfer(p.src,'image');content.photos.push({...p,src,sourceName:name});await save();
    }
    show();status('迁移完成：原信全文、封面、音乐和 '+content.photos.length+' 张照片已保存到阿里云。');
  }catch(e){show();status('迁移暂停：'+e.message+'。已完成的部分留在云端，检查配额或网络后可重新选择同一个包继续。',true)}finally{button.disabled=false}
};
connectExistingSession();
