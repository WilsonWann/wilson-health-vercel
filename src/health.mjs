/** Daily summaries only. Never add overlapping devices or raw samples together. */
export class InputError extends Error { constructor(message, status = 422) { super(message); this.status = status; } }
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const METRICS = {
  step_count: { label: '步數', unit: '步', digits: 0 },
  sleep_analysis: { label: '睡眠', unit: '小時', digits: 2 },
  heart_rate: { label: '平均心率', unit: 'bpm', digits: 1 },
  resting_heart_rate: { label: '靜止心率', unit: 'bpm', digits: 0 },
  active_energy: { label: '活動熱量', unit: 'kcal', digits: 1 },
  apple_exercise_time: { label: '運動時間', unit: '分鐘', digits: 0 },
  height: { label: '身高', unit: 'cm', digits: 1, body: true },
  'weight_&_body_mass': { label: '體重', unit: 'kg', digits: 1, body: true },
  body_mass_index: { label: 'BMI', unit: '', digits: 1, body: true }
};
export const BODY_METRIC_NAMES = Object.freeze(Object.entries(METRICS).filter(([,v])=>v.body).map(([k])=>k));
const METRIC_ALIASES = Object.freeze({ weight:'weight_&_body_mass', body_mass:'weight_&_body_mass', weight_body_mass:'weight_&_body_mass' });
const canonicalMetric = name => METRIC_ALIASES[name] || name;
export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s+'T00:00:00Z')) && new Date(s+'T00:00:00Z').toISOString().slice(0,10) === s;
}
export function taipeiParts(input = new Date()) {
  const d = new Date(input);
  if (!Number.isFinite(d.getTime())) throw new InputError('無效時間');
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0,19).replace('T',' ');
}
export const taipeiDate = input => taipeiParts(input).slice(0,10);
export const formatTime = input => input ? `${taipeiParts(input)}（UTC+8）` : '未提供';
export function shiftDate(day, delta) {
  if (!isDate(day)) throw new InputError('日期必須為 YYYY-MM-DD');
  return new Date(Date.parse(day+'T00:00:00Z') + delta * 86400000).toISOString().slice(0,10);
}
function timestamp(s) {
  if (typeof s !== 'string') throw new InputError('缺少日期字串');
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?\s*(Z|[+-]\d{2}:?\d{2})$/.exec(s);
  if (!m || !isDate(m[1]) || +m[2] > 23 || +m[3] > 59 || +m[4] > 59) throw new InputError('日期需包含明確時區，例如 2026-10-24 00:00:00 +0800');
  let zone = m[6];
  if (zone !== 'Z') {
    zone = zone.replace(':','');
    if (+zone.slice(1,3)>23 || +zone.slice(3)>59) throw new InputError('無效時區');
    zone = zone.slice(0,3)+':'+zone.slice(3);
  }
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5]||''}${zone}`);
  if (!Number.isFinite(ms)) throw new InputError('無效日期');
  return ms;
}
function bucket(row) {
  const label = row.start ?? row.date;
  let day, start;
  if (isDate(label)) { day = label; start = Date.parse(label+'T00:00:00+08:00'); }
  else {
    start = timestamp(label); const local = taipeiParts(start);
    if (!local.endsWith('00:00:00') || start % 1000 !== 0) throw new InputError('僅接受從台北時間 00:00 開始的每日彙總；請開啟 Summarize / Day，不接受逐筆明細');
    day = local.slice(0,10);
  }
  if (row.start != null && row.date != null) {
    const dateDay = isDate(row.date) ? row.date : taipeiDate(timestamp(row.date));
    if (dateDay !== day) throw new InputError('start 與 date 不一致');
  }
  let partial = false;
  if (row.end != null) {
    const end = timestamp(row.end), delta = end - start;
    if (delta <= 0 || delta > 86400000) throw new InputError('start/end 必須位於同一個台北日，且從 00:00 開始');
    // Health Auto Export can send today's running daily aggregate (00:00 -> now).
    // Keep it as a temporary value; a later full-day export safely overwrites it via the date+metric primary key.
    partial = delta < 86399000;
  }
  return { day, partial };
}
function measurementBucket(row) {
  const label = row.date ?? row.start;
  if (isDate(label)) return { day: label, at: Date.parse(label+'T00:00:00+08:00'), partial: false };
  const at = timestamp(label);
  return { day: taipeiDate(at), at, partial: false };
}
function number(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new InputError('數值必須是有效的非負 number；小數可以，空值或字串不可');
  return value; // Preserve decimals; round only when presenting.
}
function positive(value,label) {
  const v=number(value); if(v<=0)throw new InputError(`${label} 必須大於 0`); return v;
}
function extractValue(metricName, metric, row) {
  const unit = String(metric.units ?? '').toLowerCase().trim().replaceAll('²','2');
  let value;
  switch (metricName) {
    case 'step_count':
      if (unit !== 'count') throw new InputError('step_count 單位需為 count');
      return number(row.qty);
    case 'sleep_analysis':
      if (!['hr','h','hour','hours'].includes(unit)) throw new InputError('睡眠單位需為 hr');
      value = number(row.totalSleep);
      if (value > 24) throw new InputError('每日睡眠超過 24 小時；需檢查是否重疊來源');
      return value;
    case 'heart_rate': case 'resting_heart_rate':
      if (!['bpm','count/min'].includes(unit)) throw new InputError('心率單位需為 bpm 或 count/min');
      return number(metricName === 'heart_rate' ? (row.Avg ?? row.qty) : row.qty);
    case 'active_energy':
      if (!['kcal','kj'].includes(unit)) throw new InputError('活動熱量單位需為 kcal 或 kJ');
      return number(row.qty) / (unit === 'kj' ? 4.184 : 1);
    case 'apple_exercise_time':
      if (!['min','minute','minutes'].includes(unit)) throw new InputError('運動時間單位需為 min');
      return number(row.qty);
    case 'height': {
      const v=positive(row.qty,'身高');
      if(['cm','centimeter','centimeters'].includes(unit)) value=v;
      else if(['m','meter','meters'].includes(unit)) value=v*100;
      else if(['mm','millimeter','millimeters'].includes(unit)) value=v/10;
      else if(['in','inch','inches'].includes(unit)) value=v*2.54;
      else if(['ft','foot','feet'].includes(unit)) value=v*30.48;
      else throw new InputError('身高單位需為 cm、m、mm、in 或 ft');
      if(value>300)throw new InputError('身高超出合理顯示範圍');
      return value;
    }
    case 'weight_&_body_mass': {
      const v=positive(row.qty,'體重');
      if(['kg','kilogram','kilograms'].includes(unit)) value=v;
      else if(['g','gram','grams'].includes(unit)) value=v/1000;
      else if(['lb','lbs','pound','pounds'].includes(unit)) value=v*0.45359237;
      else throw new InputError('體重單位需為 kg、g 或 lb');
      if(value>1000)throw new InputError('體重超出合理顯示範圍');
      return value;
    }
    case 'body_mass_index': {
      if(!['','count','bmi','kg/m2','kg/m^2'].includes(unit)) throw new InputError('BMI 單位格式不支援');
      value=positive(row.qty,'BMI');
      if(value>100)throw new InputError('BMI 超出合理顯示範圍');
      return value;
    }
  }
}
function getMetrics(payload) {
  if (!object(payload)) throw new InputError('JSON 必須為物件');
  const b = object(payload.data) ? payload.data : payload;
  const metrics = Array.isArray(b.metrics) ? b.metrics : typeof b.name === 'string' ? [b] : [];
  if (!metrics.length) throw new InputError('找不到指標。支援 {data:{name,units,data}} 或 {data:{metrics:[...]}}');
  return metrics;
}
export function parseHealth(payload) {
  const records = new Map(); const warnings = []; const warningSet = new Set(); const present = new Set(); let rejected = 0;
  const warn = message => { if (!warningSet.has(message)) { warningSet.add(message); warnings.push(message); } };
  for (const metric of getMetrics(payload)) {
    if (!object(metric) || typeof metric.name !== 'string') { rejected++; warn('略過無效指標物件'); continue; }
    const originalName = metric.name.slice(0,80), metricName=canonicalMetric(originalName);
    if (!Object.hasOwn(METRICS, metricName)) { warn(`略過不支援指標：${originalName}`); continue; }
    present.add(metricName);
    if (!Array.isArray(metric.data)) { rejected++; warn(`${originalName}.data 必須是陣列；已略過此指標`); continue; }
    if (!metric.data.length) warn(`${originalName} 沒有資料；既有數值不會清空`);
    const isBody=BODY_METRIC_NAMES.includes(metricName);
    for (let i = 0; i < metric.data.length; i++) {
      try {
        const row = metric.data[i]; if (!object(row)) throw new InputError('紀錄必須是物件');
        const b = isBody ? measurementBucket(row) : bucket(row);
        const { day: date, partial } = b; const value = extractValue(metricName,metric,row);
        if (partial) warn(`${metricName} ${date} 為當日暫時值；完整日資料同步後會覆蓋，不會累加`);
        const rawSource = row.source ?? row.sources;
        const source = typeof rawSource === 'string' ? rawSource.trim().slice(0,300) : Array.isArray(rawSource) ? rawSource.filter(s=>typeof s==='string').sort().join('、').slice(0,300) : '';
        const item = { date, metric: metricName, value, source: source || null, _at: b.at ?? Date.parse(date+'T00:00:00+08:00') };
        const key = `${date}:${metricName}`; const old = records.get(key);
        if (old && (old.value !== value || old.source !== item.source)) {
          if(isBody){
            if(item._at>=old._at){records.set(key,item);warn(`${metricName} ${date} 有多筆量測；採用較晚一筆`);}
            continue;
          }
          throw new InputError('同日期出現不同彙總或多個來源；不能直接相加，已保留先收到的每日彙總');
        }
        records.set(key,item);
      } catch (e) {
        rejected++;
        warn(`${originalName} 第 ${i+1} 筆已略過：${e instanceof Error ? e.message : '無法解析'}`);
      }
    }
  }
  if (!present.has('step_count')) warn('這次未包含步數；既有步數不會被當作 0 或清空');
  if (!records.size) throw new InputError('沒有可匯入的每日資料。'+warnings.join('；'));
  return { records: [...records.values()].map(({_at,...r})=>r), warnings, rejected };
}
export function metricText(name, value) {
  if (value === null || value === undefined) return '未提供';
  const m = METRICS[name];
  const text=new Intl.NumberFormat('zh-TW',{minimumFractionDigits:m.digits,maximumFractionDigits:m.digits}).format(value);
  return m.unit ? `${text} ${m.unit}` : text;
}
export function rawTotal(values) {
  const v = values.filter(x=>x != null); if (!v.length) return null;
  let sum=0, correction=0;
  for (const x of v) { const y=x-correction; const next=sum+y; correction=(next-sum)-y; sum=next; }
  if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) throw new InputError('合計超過安全數值範圍');
  return sum;
}
export function report(day, rows, displayName='') {
  if (!isDate(day)) throw new InputError('日期格式錯誤');
  const data = rows.filter(r=>r.date===day); if (!data.length) throw new InputError('該日期尚未匯入資料',404);
  const values = Object.fromEntries(data.map(r=>[r.metric,r.value]));
  const latest = data.map(r=>r.updated_at).sort().at(-1);
  const sources = [...new Set(data.map(r=>r.source).filter(Boolean))];
  const title=String(displayName||'').trim()?`⌚ ${String(displayName).trim()}的每日健康紀錄`:'⌚ 每日健康紀錄';
  return [title, `資料日期：${day}（台北）`, ...Object.keys(METRICS).map(k=>{const r=data.find(x=>x.metric===k);const carried=r?.carried_from?`（最近量測 ${r.carried_from}）`:'';return `${METRICS[k].label}：${metricText(k,values[k])}${carried}`;}), `來源：${sources.join('、') || '未提供（不影響數值）'}`, `更新：${formatTime(latest)}`, '依已同步資料整理；身體測量可沿用截至該日最近一次量測。未提供不代表 0。'].join('\n');
}
