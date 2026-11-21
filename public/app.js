/* ============ 基于气溶胶灭火原理的多功能智能插座 V1.0 前端逻辑 ============ */
'use strict';

const $ = (id) => document.getElementById(id);
const tokenKey = 'socket_token';

/* ---------------- 登录 ---------------- */
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('username').value.trim(),
        password: $('password').value,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      sessionStorage.setItem(tokenKey, data.token);
      sessionStorage.setItem('socket_user', data.user);
      showApp();
    } else {
      const err = $('login-error');
      err.hidden = false;
      err.textContent = data.message || '登录失败';
    }
  } catch {
    const err = $('login-error');
    err.hidden = false;
    err.textContent = '网络异常，请稍后重试';
  } finally {
    btn.disabled = false;
    btn.textContent = '登 录';
  }
});

$('logout-btn').addEventListener('click', () => {
  sessionStorage.removeItem(tokenKey);
  location.reload();
});

function authHeaders() {
  return { Authorization: 'Bearer ' + sessionStorage.getItem(tokenKey) };
}

/* ---------------- 视图切换 ---------------- */
function showApp() {
  $('user-name').textContent = sessionStorage.getItem('socket_user') || 'admin';
  $('login-view').style.display = 'none';
  $('app-view').hidden = false;
  refreshState();
  loadAlarms();
  loadHistory(currentRange);
  clearInterval(timer);
  timer = setInterval(refreshState, 3000); // 每 3 秒自动刷新（对应"数据随设备上报自动更新"）
}
let timer = null;

/* ---------------- 状态刷新 ---------------- */
async function api(url, opts) {
  const res = await fetch(url, Object.assign({ headers: authHeaders() }, opts));
  if (res.status === 401) {
    sessionStorage.removeItem(tokenKey);
    location.reload();
    throw new Error('unauthorized');
  }
  return res.json();
}

async function refreshState() {
  try {
    const r = await api('/api/state');
    if (!r.ok) return;
    renderState(r);
  } catch (e) { /* 静默 */ }
}

const LEVEL_TEXT = { 0: '运行正常', 1: '预警级', 2: '报警级', 3: '处置级' };

function renderState(r) {
  const d = r.data, s = r.status, dev = r.device;
  $('device-name').textContent = dev.name;
  $('device-model').textContent = dev.model;
  $('device-version').textContent = dev.version;
  $('update-time').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');

  // 在线状态
  const conn = $('conn-badge');
  conn.classList.toggle('offline', !dev.online);
  conn.innerHTML = dev.online ? '<i></i>在线' : '<i></i>离线';

  // 六项参数
  setVal('v-env', d.envTemp, '℃');
  setVal('v-ir', d.irTemp, '℃');
  setVal('v-smoke', d.smoke, 'ppm');
  setVal('v-co', d.co, 'ppm');
  setVal('v-cur', d.current, 'A');
  setVal('v-vol', d.voltage, 'V');

  // 风险指数仪表
  const R = d.riskIndex;
  $('risk-value').textContent = R;
  const arcLen = 157; // 半圆弧长
  const frac = Math.min(R, 100) / 100;
  const arc = $('risk-arc');
  arc.setAttribute('stroke-dasharray', (frac * arcLen) + ' 999');
  arc.setAttribute('stroke', R >= 85 ? '#dc2626' : R >= 60 ? '#ef4444' : R >= 30 ? '#f59e0b' : '#22c55e');

  // 报警横幅
  const banner = $('alarm-banner');
  banner.hidden = false;
  banner.className = 'alarm-banner level' + s.alarmLevel;
  const icons = { 0: '✓', 1: '⚠', 2: '⛔', 3: '🔥' };
  $('alarm-icon').textContent = icons[s.alarmLevel] || '';
  $('alarm-text').textContent =
    s.alarmLevel === 0 ? '系统运行正常，各参数在安全范围内'
    : LEVEL_TEXT[s.alarmLevel] + '：' + bannerText(s.alarmLevel);

  // 控件状态
  const relay = $('sw-relay');
  relay.checked = s.relayOn;
  relay.disabled = s.alarmLevel >= 2 && s.relayOn === false;
  $('sw-buzzer').checked = s.buzzerMuted;
  const tag = $('aerosol-tag');
  tag.textContent = s.aerosolFired ? '已触发' : '正常';
  tag.className = 'tag ' + (s.aerosolFired ? 'tag-fired' : 'tag-ok');
  $('aerosol-status').textContent = s.aerosolFired
    ? '气溶胶灭火装置已触发（单次设计，请联系专业人员更换）'
    : '未触发（单次设计，触发后需更换）';
}

function bannerText(level) {
  if (level === 1) return '监测到火灾风险上升，蜂鸣器间歇鸣响';
  if (level === 2) return '继电器已切断市电（断电优先）';
  if (level === 3) return '断电复核完成后，气溶胶灭火装置已触发';
  return '';
}

function setVal(id, v, unit) {
  const el = $(id);
  el.textContent = v;
  const num = parseFloat(v);
  let cls = '';
  if (id === 'v-env' || id === 'v-ir') cls = num > 60 ? 'danger' : num > 45 ? 'warn' : '';
  if (id === 'v-smoke') cls = num > 100 ? 'danger' : num > 50 ? 'warn' : '';
  if (id === 'v-co') cls = num > 50 ? 'danger' : num > 24 ? 'warn' : '';
  if (id === 'v-cur') cls = num > 8 ? 'danger' : num > 6 ? 'warn' : '';
  el.className = cls;
}

/* ---------------- 报警记录 ---------------- */
async function loadAlarms() {
  try {
    const r = await api('/api/alarms');
    const list = $('alarm-list');
    if (!r.alarms || !r.alarms.length) {
      list.innerHTML = '<div class="alarm-empty">暂无报警记录</div>';
      return;
    }
    list.innerHTML = r.alarms.map((a) => `
      <div class="alarm-item">
        <span class="t">${new Date(a.time).toLocaleString('zh-CN')}</span>
        <span class="alarm-badge ab${a.level}">${LEVEL_TEXT[a.level]}</span>
        <span class="msg">${a.text}</span>
      </div>`).join('');
  } catch (e) { /* 静默 */ }
}

/* ---------------- 远程管控 ---------------- */
$('sw-relay').addEventListener('change', async (e) => {
  const action = e.target.checked ? 'relay_on' : 'relay_off';
  const r = await api('/api/control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ action }) });
  if (!r.ok) { toast(r.message || '操作失败'); e.target.checked = !e.target.checked; }
  else toast(e.target.checked ? '已闭合继电器，负载上电' : '已断开继电器，负载断电');
});

$('sw-buzzer').addEventListener('change', async (e) => {
  const action = e.target.checked ? 'buzzer_mute' : 'buzzer_unmute';
  await api('/api/control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ action }) });
  toast(e.target.checked ? '蜂鸣器已消音' : '蜂鸣器已恢复');
});

$('reset-btn').addEventListener('click', async () => {
  await api('/api/control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ action: 'device_reset' }) });
  toast('远程复位指令已下发');
  setTimeout(() => { loadAlarms(); }, 300);
});

document.querySelectorAll('[data-demo]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await api('/api/control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ action: btn.dataset.demo }) });
    toast(btn.dataset.demo === 'demo_stop' ? '自检已结束' : '预警事件已注入，请观察风险指数与联动响应');
  });
});

/* ---------------- 历史数据（纯 Canvas 折线图，无第三方库） ---------------- */
let currentRange = 60;
document.querySelectorAll('.range').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = parseInt(btn.dataset.range, 10);
    loadHistory(currentRange);
  });
});

$('refresh-btn').addEventListener('click', () => {
  refreshState(); loadAlarms(); loadHistory(currentRange);
  toast('数据已刷新');
});

async function loadHistory(minutes) {
  try {
    const r = await api('/api/history?minutes=' + minutes);
    if (r.ok) { drawTempChart(r.points); drawElecChart(r.points); }
  } catch (e) { /* 静默 */ }
}

// 简易折线图绘制
function drawLine(canvas, series, colors, labels) {
  const ctx = canvas.getContext('2d');
  const W = canvas.clientWidth, H = canvas.height;
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 44, r: 12, t: 10, b: 22 };
  const all = series.flat();
  if (!all.length) return;
  let min = Math.min(...all), max = Math.max(...all);
  if (max - min < 1) { max += 1; min -= 1; }
  const span = max - min;
  min -= span * 0.08; max += span * 0.08;

  const n = series[0].length;
  const x = (i) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  // 网格
  ctx.strokeStyle = '#eef0f3';
  ctx.fillStyle = '#9ca3af';
  ctx.font = '10px sans-serif';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gy = pad.t + (g / 4) * (H - pad.t - pad.b);
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
    const v = max - (g / 4) * (max - min);
    ctx.fillText(v.toFixed(1), 4, gy + 3);
  }

  // 折线
  series.forEach((s, si) => {
    ctx.strokeStyle = colors[si];
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    s.forEach((v, i) => { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); });
    ctx.stroke();
  });

  // 时间轴
  ctx.fillStyle = '#9ca3af';
  const times = window._lastTimes || [];
  if (times.length === n) {
    [0, Math.floor(n / 2), n - 1].forEach((i) => {
      if (times[i]) ctx.fillText(times[i].slice(11, 16), x(i) - 12, H - 6);
    });
  }

  // 图例
  let lx = pad.l;
  ctx.font = '11px sans-serif';
  labels.forEach((lb, i) => {
    ctx.fillStyle = colors[i];
    ctx.fillRect(lx, 0, 10, 3);
    ctx.fillStyle = '#6b7280';
    ctx.fillText(lb, lx + 14, 6);
    lx += ctx.measureText(lb).width + 30;
  });
}

function drawTempChart(pts) {
  window._lastTimes = pts.map((p) => p.time);
  drawLine($('chart-temp'), [
    pts.map((p) => p.envTemp),
    pts.map((p) => p.irTemp),
    pts.map((p) => p.smoke / 10),
    pts.map((p) => p.co / 10),
    pts.map((p) => p.risk / 5),
  ], ['#1f6feb', '#8b5cf6', '#f59e0b', '#14b8a6', '#ef4444'],
     ['环境温度℃', '红外温度℃', '可燃气体/10', 'CO/10', '风险指数/5']);
}

function drawElecChart(pts) {
  drawLine($('chart-elec'), [
    pts.map((p) => p.current),
    pts.map((p) => p.voltage / 10),
  ], ['#1f6feb', '#22c55e'], ['电流A', '电压/10']);
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------- 启动 ---------------- */
if (sessionStorage.getItem(tokenKey)) {
  showApp();
} else {
  $('app-view').hidden = true;
  $('login-view').style.display = 'flex';
}
