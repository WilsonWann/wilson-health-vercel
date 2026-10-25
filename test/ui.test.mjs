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
