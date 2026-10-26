const $=s=>document.querySelector(s);
let csrf='',state=null,preview='',selectedMetric='step_count',role='admin';
const metadata={step_count:['步數','步',0],sleep_analysis:['睡眠','小時',2],heart_rate:['平均心率','bpm',1],resting_heart_rate:['靜止心率','bpm',0],active_energy:['活動熱量','kcal',1],apple_exercise_time:['運動時間','分鐘',0],height:['身高','cm',1],'weight_&_body_mass':['體重','kg',1],body_mass_index:['BMI','',1]};
const bodyMetrics=new Set(['height','weight_&_body_mass','body_mass_index']);
const loginForm=$('#loginForm'),usernameInput=$('#username'),passwordInput=$('#password');
loginForm.noValidate=true;usernameInput.required=false;passwordInput.required=false;
function fmtTime(s){if(!s)return '未提供';const d=new Date(s);return new Date(d.getTime()+8*3600000).toISOString().slice(0,19).replace('T',' ')+'（UTC+8）';}
function el(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function notify(text,error=false){$('#notice').hidden=false;$('#notice').textContent=text;$('#notice').classList.toggle('error',error);}

// Resolve navigation only to sections available to the current session role.
function navigationTarget(hash){
  let id;
  try{id=decodeURIComponent(hash.replace(/^#/,'')).toLowerCase();}catch{return null;}
  if(role==='user'&&id==='import')id='usersync';
  if(role==='user'&&id==='line')id='userline';
  for(const link of document.querySelectorAll('aside nav a[href^="#"]')){
    if(link.closest('[hidden]'))continue;
    const target=document.getElementById(link.getAttribute('href').slice(1));
    if(target&&target.id.toLowerCase()===id&&!target.closest('[hidden]'))return target;
  }
  return null;
}
function navigateToSection(hash,{replace=false,focus=false,smooth=false}={}){
  if($('#workspace').hidden)return;
  const target=navigationTarget(hash)||navigationTarget('#overview');
  if(!target)return;
  const canonical='#'+target.id;
  if(location.hash!==canonical)history[replace?'replaceState':'pushState'](null,'',canonical);
  for(const link of document.querySelectorAll('aside nav a[href^="#"]')){
    if(!link.closest('[hidden]')&&link.getAttribute('href')===canonical)link.setAttribute('aria-current','location');
    else link.removeAttribute('aria-current');
  }
  const behavior=smooth&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'instant';
  target.scrollIntoView({behavior,block:'start'});
  if(focus){
    const heading=target.querySelector('h1,h2')||target;
    heading.setAttribute('tabindex','-1');
    heading.focus({preventScroll:true});
  }
}
$('aside nav').addEventListener('click',event=>{
  const link=event.target.closest('a[href^="#"]');
  if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  if(link.closest('[hidden]'))return;
  event.preventDefault();
  // Explicit scrolling also handles clicking the same fragment a second time.
  navigateToSection(link.getAttribute('href'),{focus:true,smooth:true});
});
window.addEventListener('hashchange',()=>navigateToSection(location.hash,{replace:true}));

function applyRole(){
  const guest=role==='guest',user=role==='user',admin=role==='admin';
  document.body.classList.toggle('guest-mode',guest);document.body.classList.toggle('user-mode',user);$('#guestBanner').hidden=!guest;
  $('#workspaceMode').textContent=guest?'● Guest 展示模式':user?`● ${state?.user?.displayName||'LINE 會員'} · 私人資料`:'● 管理者工作區';
  document.querySelectorAll('[data-admin-only]').forEach(box=>{box.hidden=!admin;box.classList.toggle('guest-disabled',!admin);box.setAttribute('aria-disabled',String(!admin));box.querySelectorAll?.('input,textarea,button,select').forEach(x=>x.disabled=!admin);});
  document.querySelectorAll('[data-user-only]').forEach(box=>{box.hidden=!user;box.setAttribute('aria-disabled',String(!user));});
  const backup=$('#backupLink');if(!admin){backup.removeAttribute('href');backup.hidden=true;}else{backup.href='/api/backup';backup.hidden=false;}
  if(guest)$('#scheduleBadge').textContent='Guest Demo · 唯讀';
  if(user)$('#scheduleBadge').textContent=state?.user?.friendFlag?'LINE 會員 · 可接收個人訊息':'LINE 會員 · 尚未加入官方帳號好友';
}
async function api(path,data){const r=await fetch(path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:data===undefined?undefined:JSON.stringify(data)});const v=await r.json();if(!r.ok){if(r.status===401){$('#workspace').hidden=true;$('#login').hidden=false;}throw new Error(v.error||'請求失敗');}return v;}
async function busy(button,fn){button.disabled=true;try{await fn();}catch(e){notify(e.message,true);}finally{button.disabled=false;}}
function fillSettings(s){$('#displayName').value=s.displayName;$('#reportTime').value=s.reportTime;$('#autoSend').checked=s.autoSend;$('#lineTokenStatus').textContent=s.lineConfigured?'已由環境變數設定':'尚未設定 LINE_CHANNEL_ACCESS_TOKEN';$('#verifyLine').disabled=role==='guest'||!s.lineConfigured;$('#testLine').disabled=role==='guest'||!s.lineConfigured||!s.recipientConfigured;$('#lineQrLink').disabled=role==='guest'||!s.lineLoginConfigured;$('#lineQrLink').textContent=s.recipientConfigured?'重新用 LINE Login 綁定':'LINE Login 綁定';$('#lineRecipientName').textContent=s.recipientConfigured?'已綁定 LINE 收件人':'尚未綁定';$('#lineRecipientMeta').textContent=s.recipientConfigured?`${s.maskedUserId} · 可用測試訊息確認收件`:(s.lineLoginConfigured?'掃 QR Code 綁定 LINE 帳號。':'尚未設定 LINE Login Channel ID / Secret');$('#lineQrLink').closest('.line-link-box').classList.toggle('bound',!!s.recipientConfigured);$('#lineBadge').textContent=role==='guest'?'Guest 模式 · 不提供':s.lineVerified&&s.recipientConfigured?'權杖已驗證 · LINE 已綁定':s.lineVerified?'權杖已驗證 · 尚未綁定 LINE':s.lineConfigured?'權杖已設定，尚未驗證':'尚未設定';$('#scheduleBadge').textContent=role==='guest'?'Guest Demo · 唯讀':s.autoSend?`每日 ${s.reportTime} 後排程發送`:'自動發送未啟用';$('#ingestUrl').value=role==='guest'?'':location.origin+s.ingestPath;$('#reportTime').disabled=role==='guest'||!!s.fixedReportTime;if(s.fixedReportTime)$('#reportTime').value=s.fixedReportTime;}
async function fillUserSync(){
  if(role!=='user')return;const cfg=await api('/api/me/sync-config');
  $('#userIngestUrl').value=cfg.ingestUrl;$('#userIngestToken').value=cfg.ingestToken;$('#userIngestToken').type='password';$('#toggleUserToken').textContent='顯示金鑰';
  $('#userLineStatus').textContent=state?.user?.friendFlag?'已加入 LINE 官方帳號，可作為日報／週報收件人。':'LINE Login 已完成，但尚未確認加入官方帳號好友；可登入查看資料，但主動推播可能無法送達。';
}
function metricRows(metric){
  const source=bodyMetrics.has(metric)?(state.bodyRows||[]):state.rows;
  return source.filter(r=>r.metric===metric&&r.date<=state.to&&(bodyMetrics.has(metric)||r.date>=state.from));
}

function formatMetricValue(metric,value){
  if(value==null)return '未提供';
  const [,unit,digits]=metadata[metric];
  const number=new Intl.NumberFormat('zh-TW',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value);
  return unit?`${number} ${unit}`:number;
}
function metricSummary(metric,rows){
  const [label,unit,digits]=metadata[metric];
  if(!rows.length)return {value:'未提供',detail:`${state.from} ～ ${state.to} · 尚無${label}資料`,badge:'缺資料不補 0'};
  if(metric==='step_count')return {value:Math.round(rawSum(rows)).toLocaleString('zh-TW')+' 步',detail:`${state.from} ～ ${state.to} · ${rows.length} 天有資料`,badge:'先加總原值，再取整數'};
  if(metric==='active_energy'||metric==='apple_exercise_time'){
    const total=rawSum(rows);return {value:formatMetricValue(metric,total),detail:`${state.from} ～ ${state.to} · ${rows.length} 天合計`,badge:'區間合計'};
  }
  if(bodyMetrics.has(metric)){
    const row=rows.at(-1);return {value:formatMetricValue(metric,row.value),detail:`最近量測 ${row.date}${row.source?' · '+row.source:''}`,badge:'顯示實際量測點'};
  }
  const avg=rawSum(rows)/rows.length;return {value:formatMetricValue(metric,avg),detail:`${state.from} ～ ${state.to} · ${rows.length} 天平均`,badge:'區間平均'};
}
function rawSum(rows){return rows.reduce((sum,r)=>sum+Number(r.value||0),0);}
function selectMetric(metric){
  if(!metadata[metric])return;selectedMetric=metric;
  document.querySelectorAll('.metric-card').forEach(card=>{const on=card.dataset.metric===metric;card.classList.toggle('selected',on);card.setAttribute('aria-pressed',String(on));});
  drawChart();
}
function drawChart(){
  const metric=selectedMetric,[label,unit,digits]=metadata[metric],rows=metricRows(metric),summary=metricSummary(metric,rows),chartRows=bodyMetrics.has(metric)?rows.filter(r=>r.date>=state.from):rows;
  $('#trendEyebrow').textContent=label+'趨勢';$('#metricSummary').textContent=summary.value;$('#metricCoverage').textContent=summary.detail;$('#metricBadge').textContent=summary.badge;
  $('#chartHint').textContent=bodyMetrics.has(metric)?'只顯示實際量測日期；沒有量測的日期不會補值。':'缺資料不會補成 0；滑鼠移到柱狀圖可查看該日數值。';
  const svgNS='http://www.w3.org/2000/svg',svg=document.createElementNS(svgNS,'svg');svg.setAttribute('viewBox','0 0 780 190');svg.setAttribute('role','img');svg.setAttribute('aria-label',`${state.from} 到 ${state.to} 的${label}趨勢`);
  function node(name,attrs,text){const n=document.createElementNS(svgNS,name);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text)n.textContent=text;svg.append(n);return n;}
  const map=new Map(chartRows.map(r=>[r.date,r.value]));
  const days=[];for(let t=Date.parse(state.from+'T00:00:00Z');t<=Date.parse(state.to+'T00:00:00Z')&&days.length<366;t+=86400000)days.push(new Date(t).toISOString().slice(0,10));
  const values=days.map(d=>map.get(d)),numeric=values.filter(v=>v!=null),max=Math.max(...numeric,1),w=740/Math.max(days.length,1);
  node('line',{x1:20,y1:155,x2:760,y2:155,class:'base'});
  days.forEach((d,i)=>{const x=20+i*w,y=values[i];if(y==null){if(!bodyMetrics.has(metric))node('line',{x1:x+w*.3,y1:151,x2:x+w*.7,y2:151,class:'missing'});}else{const h=125*y/max;const rect=node('rect',{x:x+w*.2,y:155-h,width:Math.max(w*.6,1),height:Math.max(h,1),rx:3,class:'bar'});const title=document.createElementNS(svgNS,'title');title.textContent=d+'：'+formatMetricValue(metric,y);rect.append(title);}if(days.length<16||i%Math.ceil(days.length/12)===0)node('text',{x:x+w/2,y:180,'text-anchor':'middle'},d.slice(5));});
  $('#chart').replaceChildren(svg);
}
async function renderDay(){
  const date=$('#reportDate').value,rows=state.rows.filter(r=>r.date===date);$('#cards').replaceChildren();
  for(const[k,[label,unit,digits]]of Object.entries(metadata)){
    let row=rows.find(r=>r.metric===k),carried=false;
    if(!row&&bodyMetrics.has(k)){const candidates=(state.bodyRows||[]).filter(r=>r.metric===k&&r.date<=date);row=candidates.at(-1);carried=!!row;}
    const card=el('button',null,'card metric-card');card.type='button';card.dataset.metric=k;card.setAttribute('aria-pressed',String(k===selectedMetric));card.setAttribute('aria-label',`${label}：${row?formatMetricValue(k,row.value):'未提供'}，點擊查看趨勢`);card.classList.toggle('selected',k===selectedMetric);card.append(el('div',label,'label'));
    const value=el('div',row?new Intl.NumberFormat('zh-TW',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(row.value):'未提供','value');if(row&&unit)value.append(el('span',unit,'unit'));card.append(value);
    const detail=row?(k==='step_count'?`原值 ${row.value}`:carried?`最近量測 ${row.date}${row.source?' · '+row.source:''}`:row.source||'來源未標記'):'尚未匯入此指標';
    card.append(el('div',detail,'raw'));card.onclick=()=>{selectMetric(k);$('#metricDetail').scrollIntoView({behavior:'smooth',block:'nearest'});};$('#cards').append(card);
  }
  const latest=rows.map(r=>r.updated_at).sort().at(-1);$('#syncText').textContent=latest?'資料更新：'+fmtTime(latest):'尚未匯入資料';
  preview='';$('#report').textContent='此日期沒有資料。';$('#sendReport').disabled=true;$('#copyReport').disabled=true;
  if(!date)return;
  try{const r=await api('/api/report/preview?date='+encodeURIComponent(date));preview=r.text;$('#report').textContent=preview;$('#sendReport').disabled=role==='guest'||!state.settings.lineConfigured||!state.settings.recipientConfigured;$('#copyReport').disabled=false;}catch(e){$('#report').textContent=e.message;}
}
async function load(resetSettings=false){
  const params=new URLSearchParams();if($('#from').value)params.set('from',$('#from').value);if($('#to').value)params.set('to',$('#to').value);
  state=await api('/api/state?'+params);role=state.role||role;$('#from').value=state.from;$('#to').value=state.to;
  if(resetSettings&&role==='admin')fillSettings(state.settings);else if(role==='admin'){$('#scheduleBadge').textContent=state.settings.autoSend?`每日 ${state.settings.reportTime} 後排程發送`:'自動發送未啟用';}applyRole();if(role==='user')await fillUserSync();
  const last=$('#reportDate').value,days=[...new Set(state.rows.map(r=>r.date))].sort().reverse();$('#reportDate').replaceChildren(...days.map(d=>{const o=el('option',d);o.value=d;return o;}));if(days.includes(last))$('#reportDate').value=last;
  await renderDay();selectMetric(selectedMetric);
}
async function enter(){ $('#login').hidden=true;$('#workspace').hidden=false;await load(true);applyRole();requestAnimationFrame(()=>navigateToSection(location.hash||'#overview',{replace:true})); }
loginForm.addEventListener('submit',async e=>{e.preventDefault();const username=usernameInput.value.trim(),password=passwordInput.value;if(!username){$('#loginError').textContent='請輸入帳號';usernameInput.focus();return;}const b=e.submitter||loginForm.querySelector('button[type="submit"]');b.disabled=true;try{const r=await api('/api/login',{username,password});csrf=r.csrf;role=r.role||'admin';passwordInput.value='';$('#loginError').textContent='';await enter();}catch(err){$('#loginError').textContent=err.message;}finally{b.disabled=false;}});
$('#logout').onclick=()=>busy($('#logout'),async()=>{await api('/api/logout',{});location.reload();});
$('#refresh').onclick=()=>busy($('#refresh'),()=>load(false));$('#reportDate').onchange=()=>renderDay().catch(e=>notify(e.message,true));
$('#jsonFile').onchange=async()=>{const f=$('#jsonFile').files[0];if(!f)return;if(f.size>4*1024*1024)return notify('檔案超過 4 MB',true);$('#jsonText').value=await f.text();};
$('#importButton').onclick=()=>busy($('#importButton'),async()=>{let data;try{data=JSON.parse($('#jsonText').value);}catch{throw new Error('JSON 格式有誤，請貼完整內容');}const r=await api('/api/import',data);const message=`已驗證 ${r.received} 筆；更新 ${r.changed} 筆；${r.unchanged} 筆內容相同；略過 ${r.rejected||0} 筆。\n${r.warnings.join('\n')}`;$('#importResult').textContent=message;notify('資料已匯入；沒有發送 LINE。');await load(false);});
$('#settingsForm').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{const r=await api('/api/settings',{displayName:$('#displayName').value,reportTime:$('#reportTime').value,autoSend:$('#autoSend').checked});fillSettings(r.settings);notify('報告設定已儲存。');await load(false);});};

let lineLinkTimer=null,lineLoginTimer=null;
async function pollLineBind(stateId,expiresAt){
  clearInterval(lineLinkTimer);const end=Date.parse(expiresAt||'');
  async function check(){
    try{const r=await api('/api/line/bind/status?state='+encodeURIComponent(stateId));
      if(r.status==='complete'){clearInterval(lineLinkTimer);$('#lineLinkStatus').textContent=`綁定完成${r.displayName?'：'+r.displayName:''}${r.friendFlag===false?'；尚未確認已加入官方帳號好友':''}`;notify('LINE 帳號已綁定。之後可直接用 LINE Login QR 登入。');await load(true);return;}
      if(r.status==='failed'||r.status==='expired'){clearInterval(lineLinkTimer);$('#lineLinkStatus').textContent=r.error||'LINE 綁定已失效，請重新產生。';return;}
      $('#lineLinkStatus').textContent='等待手機完成 LINE Login 授權…';
    }catch(e){clearInterval(lineLinkTimer);$('#lineLinkStatus').textContent=e.message;}
    if(Number.isFinite(end)&&Date.now()>end){clearInterval(lineLinkTimer);$('#lineLinkStatus').textContent='QR Code 已逾時，請重新產生。';}
  }
  await check();lineLinkTimer=setInterval(check,1800);
}
$('#lineQrLink').onclick=()=>{const popup=window.open('','lineBind','popup,width=480,height=720');busy($('#lineQrLink'),async()=>{const r=await api('/api/line/bind/start',{});$('#bindQrPanel').hidden=false;$('#openLineBindLink').href=r.authorizeUrl;$('#openLineBindLink').hidden=false;if(popup)popup.location.href=r.authorizeUrl;$('#lineLinkStatus').textContent=popup?'LINE 官方 QR Login 已開啟，請用手機 LINE 掃描。':'瀏覽器擋住彈出視窗，請點下方連結開啟 LINE 官方 QR Login。';await pollLineBind(r.state,r.expiresAt);});};

async function pollLineLogin(stateId,pollToken,expiresAt){
  clearInterval(lineLoginTimer);const end=Date.parse(expiresAt||'');
  async function check(){
    try{const r=await api('/api/line/login/status',{state:stateId,pollToken});
      if(r.status==='complete'){clearInterval(lineLoginTimer);csrf=r.csrf;role=r.role||'user';$('#loginQrStatus').textContent=`LINE Login 成功${r.displayName?'：'+r.displayName:''}`;$('#loginError').textContent='';await enter();return;}
      if(r.status==='failed'||r.status==='expired'){clearInterval(lineLoginTimer);$('#loginQrStatus').textContent=r.error||'LINE Login 已失效，請重新產生 QR Code。';$('#loginQrStatus').classList.add('error');return;}
      $('#loginQrStatus').textContent='等待手機掃描並完成 LINE Login…';
    }catch(e){clearInterval(lineLoginTimer);$('#loginQrStatus').textContent=e.message;$('#loginQrStatus').classList.add('error');}
    if(Number.isFinite(end)&&Date.now()>end){clearInterval(lineLoginTimer);$('#loginQrStatus').textContent='QR Code 已逾時，請重新產生。';}
  }
  await check();lineLoginTimer=setInterval(check,1800);
}
$('#showLineLogin').onclick=()=>{const popup=window.open('','lineLogin','popup,width=480,height=720');busy($('#showLineLogin'),async()=>{const r=await api('/api/line/login/start',{});$('#loginQrPanel').hidden=false;loginForm.hidden=true;$('.login-divider').hidden=true;$('#openLineLoginLink').href=r.authorizeUrl;$('#openLineLoginLink').hidden=false;if(popup)popup.location.href=r.authorizeUrl;$('#loginQrStatus').classList.remove('error');$('#loginQrStatus').textContent=popup?'LINE 官方 QR Login 已開啟；請用手機 LINE 掃描。':'瀏覽器擋住彈出視窗，請點下方連結開啟 LINE 官方 QR Login。';await pollLineLogin(r.state,r.pollToken,r.expiresAt);});};
$('#cancelLineLogin').onclick=()=>{clearInterval(lineLoginTimer);$('#loginQrPanel').hidden=true;loginForm.hidden=false;$('.login-divider').hidden=false;$('#showLineLogin').disabled=false;};

$('#toggleUserToken').onclick=()=>{const input=$('#userIngestToken');input.type=input.type==='password'?'text':'password';$('#toggleUserToken').textContent=input.type==='password'?'顯示金鑰':'隱藏金鑰';};
$('#copyUserIngest').onclick=()=>busy($('#copyUserIngest'),async()=>{const text=`URL: ${$('#userIngestUrl').value}\nAuthorization: Bearer ${$('#userIngestToken').value}\nContent-Type: application/json`;await navigator.clipboard.writeText(text);notify('已複製你的 iPhone 同步設定。');});
$('#rotateUserToken').onclick=()=>{if(!confirm('重新產生同步金鑰後，舊金鑰會立即失效。確定繼續？'))return;busy($('#rotateUserToken'),async()=>{const r=await api('/api/me/ingest-token/rotate',{});$('#userIngestToken').value=r.ingestToken;$('#userIngestToken').type='password';notify('已重新產生同步金鑰，請同步更新 iPhone 的 Health Auto Export。');});};
$('#verifyLine').onclick=()=>busy($('#verifyLine'),async()=>{const r=await api('/api/line/verify',{});notify(`${r.name}：${r.message}`);await load(true);});
$('#testLine').onclick=()=>{if(!confirm('發送一則不含健康資料的 LINE 測試訊息？這會使用一則推播額度。'))return;busy($('#testLine'),async()=>{await api('/api/line/test',{confirm:true});notify('測試訊息已由 LINE API 受理，請確認手機是否收到。');await load(false);});};
$('#sendReport').onclick=()=>{if(!confirm(`將 ${$('#reportDate').value} 的健康日報傳給已設定的個人 LINE 收件人？`))return;busy($('#sendReport'),async()=>{const r=await api('/api/report/send',{date:$('#reportDate').value,confirm:true});notify(r.status==='accepted'?'日報已由 LINE API 受理。':r.reason==='already_sent'?'這一天已發送，不會重複傳送。':'發送正在處理，沒有重複提交。');await load(false);});};
$('#copyReport').onclick=()=>busy($('#copyReport'),async()=>{await navigator.clipboard.writeText(preview);notify('已複製日報文字。');});
try{const s=await api('/api/session');if(s.authenticated){csrf=s.csrf;role=s.role||'admin';await enter();}}catch(e){$('#loginError').textContent=e.message;}
