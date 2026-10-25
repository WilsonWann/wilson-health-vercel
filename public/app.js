const $=s=>document.querySelector(s);
let csrf='',state=null,preview='',selectedMetric='step_count';
const metadata={step_count:['步數','步',0],sleep_analysis:['睡眠','小時',2],heart_rate:['平均心率','bpm',1],resting_heart_rate:['靜止心率','bpm',0],active_energy:['活動熱量','kcal',1],apple_exercise_time:['運動時間','分鐘',0],height:['身高','cm',1],'weight_&_body_mass':['體重','kg',1],body_mass_index:['BMI','',1]};
const bodyMetrics=new Set(['height','weight_&_body_mass','body_mass_index']);
function fmtTime(s){if(!s)return '未提供';const d=new Date(s);return new Date(d.getTime()+8*3600000).toISOString().slice(0,19).replace('T',' ')+'（UTC+8）';}
function el(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function notify(text,error=false){$('#notice').hidden=false;$('#notice').textContent=text;$('#notice').classList.toggle('error',error);}
async function api(path,data){const r=await fetch(path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:data===undefined?undefined:JSON.stringify(data)});const v=await r.json();if(!r.ok){if(r.status===401){$('#workspace').hidden=true;$('#login').hidden=false;}throw new Error(v.error||'請求失敗');}return v;}
async function busy(button,fn){button.disabled=true;try{await fn();}catch(e){notify(e.message,true);}finally{button.disabled=false;}}
function fillSettings(s){$('#displayName').value=s.displayName;$('#reportTime').value=s.reportTime;$('#autoSend').checked=s.autoSend;$('#userId').value=s.userId;$('#verifyLine').disabled=!s.lineConfigured;$('#testLine').disabled=!s.lineConfigured;$('#lineBadge').textContent=s.lineVerified?'權杖已驗證':s.lineConfigured?'已儲存，尚未驗證':'尚未設定';$('#scheduleBadge').textContent=s.autoSend?`每日 ${s.reportTime} 後排程發送`:'自動發送未啟用';$('#ingestUrl').value=location.origin+s.ingestPath;$('#reportTime').disabled=!!s.fixedReportTime;if(s.fixedReportTime)$('#reportTime').value=s.fixedReportTime;}
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
  try{const r=await api('/api/report/preview?date='+encodeURIComponent(date));preview=r.text;$('#report').textContent=preview;$('#sendReport').disabled=!state.settings.lineConfigured;$('#copyReport').disabled=false;}catch(e){$('#report').textContent=e.message;}
}
async function load(resetSettings=false){
  const params=new URLSearchParams();if($('#from').value)params.set('from',$('#from').value);if($('#to').value)params.set('to',$('#to').value);
  state=await api('/api/state?'+params);$('#from').value=state.from;$('#to').value=state.to;
  if(resetSettings)fillSettings(state.settings);else{$('#scheduleBadge').textContent=state.settings.autoSend?`每日 ${state.settings.reportTime} 後排程發送`:'自動發送未啟用';}
  const last=$('#reportDate').value,days=[...new Set(state.rows.map(r=>r.date))].sort().reverse();$('#reportDate').replaceChildren(...days.map(d=>{const o=el('option',d);o.value=d;return o;}));if(days.includes(last))$('#reportDate').value=last;
  await renderDay();selectMetric(selectedMetric);$('#events').replaceChildren(...state.events.map(x=>{const box=el('div',null,'event');box.append(el('time',fmtTime(x.created_at)));const msg=el('div',null,'msg');msg.append(el('strong',x.event),document.createTextNode(x.message));box.append(msg);return box;}));
  if(!state.events.length)$('#events').append(el('p','尚無操作紀錄','muted'));
}
async function enter(){ $('#login').hidden=true;$('#workspace').hidden=false;await load(true); }
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{const r=await api('/api/login',{password:$('#password').value});csrf=r.csrf;$('#password').value='';await enter();}catch(err){$('#loginError').textContent=err.message;}finally{b.disabled=false;}});
$('#logout').onclick=()=>busy($('#logout'),async()=>{await api('/api/logout',{});location.reload();});
$('#refresh').onclick=()=>busy($('#refresh'),()=>load(false));$('#reportDate').onchange=()=>renderDay().catch(e=>notify(e.message,true));
$('#jsonFile').onchange=async()=>{const f=$('#jsonFile').files[0];if(!f)return;if(f.size>4*1024*1024)return notify('檔案超過 4 MB',true);$('#jsonText').value=await f.text();};
$('#importButton').onclick=()=>busy($('#importButton'),async()=>{let data;try{data=JSON.parse($('#jsonText').value);}catch{throw new Error('JSON 格式有誤，請貼完整內容');}const r=await api('/api/import',data);const message=`已驗證 ${r.received} 筆；更新 ${r.changed} 筆；${r.unchanged} 筆內容相同；略過 ${r.rejected||0} 筆。\n${r.warnings.join('\n')}`;$('#importResult').textContent=message;notify('資料已匯入；沒有發送 LINE。');await load(false);});
$('#settingsForm').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{const r=await api('/api/settings',{displayName:$('#displayName').value,reportTime:$('#reportTime').value,autoSend:$('#autoSend').checked,lineToken:$('#token').value,userId:$('#userId').value});$('#token').value='';fillSettings(r.settings);notify('設定已儲存。接著可驗證 LINE 權杖。');await load(false);});};
$('#verifyLine').onclick=()=>busy($('#verifyLine'),async()=>{const r=await api('/api/line/verify',{});notify(`${r.name}：${r.message}`);await load(true);});
$('#testLine').onclick=()=>{if(!confirm('發送一則不含健康資料的 LINE 測試訊息？這會使用一則推播額度。'))return;busy($('#testLine'),async()=>{await api('/api/line/test',{confirm:true});notify('測試訊息已由 LINE API 受理，請確認手機是否收到。');await load(false);});};
$('#sendReport').onclick=()=>{if(!confirm(`將 ${$('#reportDate').value} 的健康日報傳給已設定的個人 LINE 收件人？`))return;busy($('#sendReport'),async()=>{const r=await api('/api/report/send',{date:$('#reportDate').value,confirm:true});notify(r.status==='accepted'?'日報已由 LINE API 受理。':r.reason==='already_sent'?'這一天已發送，不會重複傳送。':'發送正在處理，沒有重複提交。');await load(false);});};
$('#copyReport').onclick=()=>busy($('#copyReport'),async()=>{await navigator.clipboard.writeText(preview);notify('已複製日報文字。');});
try{const s=await api('/api/session');if(s.authenticated){csrf=s.csrf;await enter();}}catch(e){$('#loginError').textContent=e.message;}
