// The message only wakes the original tab's server-side verification poll.
const {authState:state,authStatus:status}=document.body.dataset;
try{
  if(window.opener&&!window.opener.closed){
    window.opener.postMessage({type:'wilson-line-auth',state,status},location.origin);
    document.querySelector('#callbackHint').textContent='請切回原本的健康日報視窗，系統會自動接續登入。此頁可以關閉。';
  }
}catch{}
