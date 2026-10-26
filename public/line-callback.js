// The message only wakes the original tab's server-side verification poll.
const {authState:state,authStatus:status}=document.body.dataset;
try{
  if(window.opener&&!window.opener.closed){
    window.opener.postMessage({type:'wilson-line-auth',state,status},location.origin);
    document.querySelector('#callbackHint').textContent=status==='failed'?'本次登入未完成。請切回原本的健康日報視窗，按「重新產生 QR Code」再試一次。':'請切回原本的健康日報視窗，系統會接續處理。此頁可以關閉。';
    document.querySelector('#callbackReturn').addEventListener('click',event=>{
      if(window.opener&&!window.opener.closed){event.preventDefault();window.opener.focus();window.close();}
    });
  }
}catch{}
