const API='https://memory-anet-api-ggwahnbtst.cn-shenzhen.fcapp.run';
const PROJECT='memory-letter-platform';
const $=q=>document.querySelector(q);
const fields=['title','date','intro','letter','signature','musicTitle'];
let token=sessionStorage.getItem('letterAliyunToken')||'';
let record=null, content=null;
function status(s,error=false){$('#status').textContent=s;$('#status').classList.toggle('error',error)}
async function request(path,method='GET',body){
  const r=await fetch(API+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});
  const j=await r.json().catch(()=>({})); if(!r.ok)throw Error(j.error||'请求失败（'+r.status+'）'); return j;
}
function show(){
  $('#editor').hidden=false;$('#existing').hidden=false;
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
$('#login').onclick=async()=>{
  try{
    const login=await request('/auth/login','POST',{username:$('#username').value,password:$('#password').value});
    token=login.sessionToken;currentUserId=login.user?.userId||'';sessionStorage.setItem('letterAliyunToken',token);
    await load().catch(e=>{if(/404|not found/i.test(e.message)){record={payload:null};content={title:'',date:'',intro:'',letter:'',signature:'',musicTitle:'',hero:'',photos:[],music:'',voice:''};show();status('已登录。信件尚未迁移，保存后创建。')}else throw e});
    $('#password').value='';
  }catch(e){status(e.message,true)}
};
$('#logout').onclick=()=>{sessionStorage.removeItem('letterAliyunToken');token='';record=null;content=null;$('#editor').hidden=true;$('#existing').hidden=true;status('已退出')};
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
