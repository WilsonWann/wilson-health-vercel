// One request at a time; a tab owns its short-lived login attempt.
export function createLineAuthFlow({kind='login',request,onChange,onComplete,storage,openWindow=(...args)=>window.open(...args),now=()=>Date.now(),timers=globalThis}){
  const key='wilson-line-'+kind;
  const paths=kind==='login'?{start:'/api/line/login/start',status:'/api/line/login/status'}:{start:'/api/line/bind/start',status:'/api/line/bind/status'};
  if(storage===undefined){try{storage=globalThis.sessionStorage;}catch{storage=null;}}
  let attempt=null,popup=null,generation=0,pollTimer=null,tickTimer=null,controller=null,inFlight=false,starting=false,failures=0,completed=null;
  let stage='idle',message='',popupBlocked=false;
  const stored=value=>{try{if(value)storage?.setItem(key,JSON.stringify(value));else storage?.removeItem(key);}catch{}};
  function emit(next,text){stage=next;message=text;onChange({stage,message,hasAttempt:!!attempt,authorizeUrl:attempt?.authorizeUrl||'',remaining:attempt?Math.max(0,Math.ceil((attempt.deadline-now())/1000)):0});}
  function clearTimers(){timers.clearTimeout(pollTimer);timers.clearInterval(tickTimer);pollTimer=tickTimer=null;}
  function closePopup(){try{if(popup&&!popup.closed)popup.close();}catch{}popup=null;}
  function stop({close=false,forget=true}={}){generation++;clearTimers();controller?.abort();controller=null;inFlight=false;starting=false;if(forget)stored(null);if(close)closePopup();}
  function terminal(next,text){stop();attempt=null;emit(next,text);}
  function schedule(delay=1800){timers.clearTimeout(pollTimer);pollTimer=timers.setTimeout(check,delay);}
  function countdown(){timers.clearInterval(tickTimer);tickTimer=timers.setInterval(()=>{emit(stage,message);if(attempt&&now()>=attempt.deadline&&!inFlight)check();},1000);}
  async function finish(result){
    stop({close:true});attempt=null;completed=result;emit('loading','LINE 身分已確認，正在載入你的健康資料…');
    const current=generation;
    try{await onComplete(result);if(current===generation){completed=null;emit('complete',kind==='login'?'登入完成。':'LINE 收件人已綁定。');}}
    catch{if(current===generation)emit('load-error',kind==='login'?'身分已確認，但資料暫時無法載入。請按「重試載入」，不需要重新掃碼。':'LINE 收件人已綁定，但設定暫時無法載入。請按「重試載入」，不需要重新綁定。');}
  }
  async function check(){
    if(!attempt||inFlight||starting)return;
    timers.clearTimeout(pollTimer);inFlight=true;const current=generation,a=attempt;
    controller=new AbortController();
    try{
      const result=await request(kind==='login'?paths.status:paths.status+'?state='+encodeURIComponent(a.state),kind==='login'?{state:a.state,pollToken:a.pollToken}:undefined,controller.signal);
      if(current!==generation)return;
      failures=0;
      if(result.status==='complete'){await finish(result);return;}
      if(result.status==='failed'){terminal('error',result.error||'LINE 授權未完成，請重新產生 QR Code 再試一次。');return;}
      if(result.status==='expired'||now()>=a.deadline){terminal('expired','本次登入已逾時。請重新產生 QR Code，再用手機掃描。');return;}
      if(result.status==='consumed'){terminal('error','此登入已結束，請重新產生 QR Code。');return;}
      const waiting=popupBlocked?'瀏覽器未開啟 LINE 視窗，請按「開啟 LINE 掃碼視窗」。':popup?.closed?'LINE 視窗已關閉。請重新開啟，或重新產生 QR Code。':'請在 LINE 視窗掃描 QR Code，並在手機完成確認。';
      emit(result.status==='processing'?'processing':'waiting',result.status==='processing'?'已收到 LINE 授權，正在確認身分…':waiting);
      schedule();
    }catch(error){
      if(current!==generation)return;
      if(now()>=a.deadline){terminal('expired','本次登入已逾時，請重新產生 QR Code。');return;}
      if(error.status&&error.status<500&&![408,429].includes(error.status)){terminal('error',error.message||'這次登入無法繼續，請重新開始。');return;}
      failures++;emit('reconnecting','連線暫時中斷，正在自動重試；不需要重新掃碼。');schedule(Math.min(1500*2**Math.min(failures-1,3),8000));
    }finally{if(current===generation){inFlight=false;controller=null;}}
  }
  function reservePopup(){try{popup=openWindow('',kind==='login'?'lineLogin':'lineBind','popup,width=520,height=760');}catch{popup=null;}popupBlocked=!popup;return popup;}
  function directPopup(){try{if(popup&&!popup.closed){popup.location.href=attempt.authorizeUrl;return true;}}catch{}return false;}
  async function start(){
    if(starting)return;
    stop({close:true});attempt=null;completed=null;starting=true;failures=0;
    const current=generation;reservePopup();emit('starting','正在準備 LINE 登入…');controller=new AbortController();
    try{
      const result=await request(paths.start,{},controller.signal);
      if(current!==generation)return;
      const url=new URL(result.authorizeUrl),expires=Date.parse(result.expiresAt),serverTime=Date.parse(result.serverTime);
      if(url.origin!=='https://access.line.me'||!Number.isFinite(expires))throw new Error('LINE 登入連結無效，請重新開始。');
      const remaining=Number.isFinite(serverTime)?expires-serverTime:expires-now();
      if(remaining<=0)throw new Error('登入連結已逾時，請重新開始。');
      attempt={state:result.state,pollToken:result.pollToken,authorizeUrl:url.href,deadline:now()+remaining};stored(attempt);
      const opened=directPopup();starting=false;controller=null;
      emit('waiting',opened?'LINE 視窗已開啟，請用手機掃碼並完成確認。':'瀏覽器未開啟 LINE 視窗，請按「開啟 LINE 掃碼視窗」。');
      countdown();check();
    }catch(error){if(current!==generation)return;stop({close:true});attempt=null;emit('error',error.message||'無法開啟 LINE 登入，請稍後重試。');}
  }
  function reopen(){
    if(!attempt||now()>=attempt.deadline){start();return;}
    reservePopup();const opened=directPopup();
    emit(stage,opened?'LINE 視窗已重新開啟。若 QR Code 已失效，請按「重新產生 QR Code」。':'請允許此網站開啟彈出式視窗，再按一次「開啟 LINE 掃碼視窗」。');check();
  }
  function resume(){
    let saved;try{saved=JSON.parse(storage?.getItem(key)||'null');}catch{}
    if(!saved)return false;
    if(typeof saved.state!=='string'||typeof saved.pollToken!=='string'||!Number.isFinite(saved.deadline)||saved.deadline<=now()){stored(null);emit('expired','上次登入已逾時，請重新產生 QR Code。');return true;}
    try{if(new URL(saved.authorizeUrl).origin!=='https://access.line.me')throw new Error();}catch{stored(null);return false;}
    attempt=saved;emit('waiting','已接續上次登入。請完成手機確認；需要掃碼時可重新開啟 LINE 視窗。');countdown();check();return true;
  }
  return {start,reopen,resume,wake:()=>check(),matches:(source,state)=>source===popup&&state===attempt?.state,cancel(){stop({close:true});attempt=null;completed=null;emit('idle','');},retryComplete(){if(completed)return finish(completed);}};
}
