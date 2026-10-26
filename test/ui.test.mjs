import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');

test('metric cards are interactive and accessible',()=>{
  assert.match(app,/selectedMetric='step_count'/);
  assert.match(app,/el\('button',null,'card metric-card'\)/);
  assert.match(app,/aria-pressed/);
  assert.match(app,/card\.onclick=.*selectMetric/);
});

test('metric trend panel is dynamic rather than hard-coded to steps',()=>{
  assert.match(html,/id="trendEyebrow"/);
  assert.match(html,/id="metricSummary"/);
  assert.match(html,/id="metricCoverage"/);
  assert.match(app,/\$\('#trendEyebrow'\)\.textContent=label\+'趨勢'/);
});

test('selected metric card has visible focus and selected styles',()=>{
  assert.match(css,/\.metric-card:focus-visible/);
  assert.match(css,/\.metric-card\.selected/);
});

test('login supports passwordless guest submission without native browser blocking',()=>{
  assert.match(html,/id="loginForm" novalidate/);
  assert.match(html,/id="username"/);assert.match(html,/autocomplete="username"/);
  const passwordTag=html.match(/<input id="password"[^>]*>/)?.[0]||'';
  assert.ok(passwordTag);assert.doesNotMatch(passwordTag,/\srequired(?:\s|=|>)/);
  assert.match(app,/loginForm\.noValidate=true/);assert.match(app,/passwordInput\.required=false/);
  assert.match(app,/if\(!username\)/);assert.match(app,/username,password/);
});

test('guest UI disables private admin panels and advertises mock data',()=>{
  assert.match(html,/id="guestBanner"/);assert.match(html,/data-admin-only/);assert.match(app,/role==='guest'/);assert.match(app,/guest-disabled/);assert.match(css,/\.guest-disabled::after/);
});

test('date select uses an inset custom arrow',()=>{
  assert.match(css,/background-position:right 1rem center/);
});


test('LINE Login QR is available at login and in admin binding UI without exposing token fields',()=>{
  assert.match(html,/id="showLineLogin"/);assert.match(html,/id="loginQrPanel"/);assert.match(html,/id="loginQr"/);
  assert.match(html,/id="lineQrLink"/);assert.match(html,/LINE Login 綁定/);assert.match(html,/LINE_CHANNEL_ACCESS_TOKEN/);
  assert.doesNotMatch(html,/id="userId"/);assert.doesNotMatch(html,/id="token"/);
  assert.match(app,/\/api\/line\/login\/start/);assert.match(app,/\/api\/line\/login\/status/);
  assert.match(app,/\/api\/line\/bind\/start/);assert.match(app,/renderQr/);assert.doesNotMatch(app,/window\.open\('about:blank'/);
});


test('operation history is a dedicated paginated admin page',()=>{
  const logsHtml=readFileSync(new URL('../public/logs.html',import.meta.url),'utf8');
  const logsJs=readFileSync(new URL('../public/logs.js',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="history"/);
  assert.match(html,/href="\/logs"[^>]*>操作紀錄/);
  assert.match(logsHtml,/id="events"/);
  assert.match(logsHtml,/id="prevPage"/);
  assert.match(logsHtml,/id="nextPage"/);
  assert.match(logsHtml,/每頁 10 筆/);
  assert.match(logsJs,/\/api\/events\?page=/);
  assert.match(logsJs,/第 \$\{page\} \/ \$\{totalPages\} 頁/);
});
