/**
 * 基于气溶胶灭火原理的多功能智能插座 V1.0 —— 云端监控平台服务端
 *
 * 特性：
 *   - 零第三方依赖，Node.js 22+ 直接运行：node server.js（需支持全局 fetch）
 *   - 提供登录接口（会话令牌鉴权）、设备真实数据上报接口与模拟数据
 *   - 可选：定时拉取华为云 IoTDA 设备影子（环境变量开启）
 *   - 托管 public/ 目录下的前端静态页面
 *
 * 环境变量：
 *   PORT        监听端口，默认 3000
 *   ADMIN_USER  管理员账号，默认 admin
 *   ADMIN_PASS  管理员密码，默认 admin123（部署后务必修改！）
 *   DEVICE_KEY  设备上报密钥，默认 cfcg-m1-2026（部署后务必修改！）
 *   HW_IOTDA_REGION / HW_IOTDA_PROJECT_ID / HW_IOTDA_DEVICE_ID
 *   HW_IAM_DOMAIN_NAME / HW_IAM_USER_NAME / HW_IAM_PASSWORD
 *               以上华为云六项全部配置后，启用 IoTDA 影子拉取（10 秒一次）
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
// 设备上报密钥：STM32/ESP8266 上报时通过请求头 X-Device-Key 携带，需与之一致
const DEVICE_KEY = process.env.DEVICE_KEY || 'cfcg-m1-2026';
// 真实设备数据的有效期：超过该时间未收到上报则回落到模拟数据
const DEVICE_DATA_TTL = 60 * 1000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* 会话管理                                                            */
/* ------------------------------------------------------------------ */
const sessions = new Map(); // token -> { user, expires }
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 小时

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { user, expires: Date.now() + SESSION_TTL });
  return token;
}

function checkAuth(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !sessions.has(token)) return null;
  const s = sessions.get(token);
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* 设备数据模拟（对应说明书：五类参量 + 风险指数 + 三级预警）            */
/* ------------------------------------------------------------------ */
const state = {
  online: true,
  relayOn: true,        // 继电器闭合（负载供电）
  buzzerMuted: false,   // 蜂鸣器消音
  alarmLevel: 0,        // 0 正常 / 1 预警级 / 2 报警级 / 3 处置级
  aerosolFired: false,  // 气溶胶已触发（单次）
  envTemp: 27.6,        // DS18B20 环境温度 ℃
  irTemp: 29.2,         // MLX90614 红外温度 ℃
  smoke: 0,             // MQ-2 可燃气体 ppm
  co: 0,                // MQ-7 一氧化碳 ppm
  current: 0.02,        // 负载电流 A
  voltage: 218.5,       // 电压 V
  riskIndex: 5,         // 综合火灾风险指数 R (0~100)
};

// 权重系数（层次分析法，与说明书一致）
const W = { envTemp: 0.15, irTemp: 0.30, smoke: 0.25, co: 0.20, current: 0.10 };

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
const rnd = (a) => (Math.random() - 0.5) * a;

function step() {
  if (!state.online) return;

  // 负载电流随机波动（模拟家用电器）
  if (state.relayOn && Math.random() < 0.02) {
    state.current = clamp(state.current + rnd(1.2), 0, 10);
  }
  state.current = clamp(state.current + rnd(0.02), 0, 10);
  state.voltage = clamp(220 + rnd(3), 200, 240);
  state.envTemp = clamp(state.envTemp + rnd(0.15), 18, 32);
  state.irTemp = clamp(state.envTemp + state.current * 1.6 + rnd(0.5), 20, 45);
  state.smoke = clamp(state.smoke + rnd(2), 0, 30);
  state.co = clamp(state.co + rnd(1), 0, 15);

  // 偶发异常事件（演示三级预警流程），可通过 API 关闭演示
  if (demoFault.active) {
    const t = (Date.now() - demoFault.start) / 1000;
    if (demoFault.type === 'heat') {
      // 负载过热：环境与表面温度急升，伴随烟雾与CO（约30s走完三级闭环）
      state.envTemp = clamp(27 + t * 2, 27, 120);
      state.irTemp = clamp(30 + t * 4, 30, 210);
      state.smoke = clamp(t * 12, 0, 400);
      state.co = clamp(t * 5, 0, 200);
    } else if (demoFault.type === 'smoke') {
      // 烟雾积聚：可燃气体与CO为主，最高演化至报警级断电
      state.irTemp = clamp(30 + t * 3, 30, 210);
      state.smoke = clamp(t * 25, 0, 400);
      state.co = clamp(t * 8, 0, 200);
    }
  }

  // 多参量加权融合 → 风险指数 R 与三级预警判定（层次分析法权重）
  const { risk, level } = calcRisk(state);
  state.riskIndex = risk;

  if (level !== state.alarmLevel) {
    const prev = state.alarmLevel;
    state.alarmLevel = level;
    if (level > prev) {
      addAlarm(level, buildAlarmText(level));
      if (level >= 2) state.relayOn = false;   // 断电优先
      if (level >= 3) state.aerosolFired = true; // 断电延时后灭火
    }
  }
}

const demoFault = { active: false, type: null, start: 0 };

/**
 * 多参量加权融合计算综合火灾风险指数与预警等级
 * d: { envTemp, irTemp, smoke, co, current }
 * 返回 { risk: 0~100, level: 0正常 / 1预警级 / 2报警级 / 3处置级 }
 */
function calcRisk(d) {
  const n = {
    envTemp: clamp((d.envTemp - 30) / 50, 0, 1),
    irTemp: clamp((d.irTemp - 45) / 80, 0, 1),
    smoke: clamp(d.smoke / 200, 0, 1),
    co: clamp(d.co / 100, 0, 1),
    current: clamp((d.current - 8) / 2, 0, 1),
  };
  const risk = Math.round(
    (n.envTemp * W.envTemp + n.irTemp * W.irTemp + n.smoke * W.smoke +
     n.co * W.co + n.current * W.current) * 100
  );
  let level = 0;
  if (risk >= 30) level = 1;       // 预警级
  if (risk >= 60) level = 2;       // 报警级 → 断电
  if (risk >= 85) level = 3;       // 处置级 → 气溶胶灭火
  return { risk, level };
}

/* ------------------------------------------------------------------ */
/* 真实设备数据接入（STM32 + ESP8266 上报）                            */
/* ------------------------------------------------------------------ */
const deviceData = {
  receivedAt: 0,        // 最近一次收到真实上报的时间戳
  envTemp: null, irTemp: null, smoke: null, co: null, current: null, voltage: null,
  relayOn: null, aerosolFired: null, alarmLevel: null,
  deviceAlarmLevel: 0,  // 真实数据通道的预警等级（与模拟通道分开维护）
};

function deviceDataFresh() {
  return deviceData.receivedAt > 0 && (Date.now() - deviceData.receivedAt) < DEVICE_DATA_TTL;
}

/** 处理设备上报数据：计算风险指数，维护真实通道的预警等级与报警记录 */
function applyDeviceReport(body) {
  const num = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);
  deviceData.envTemp  = num(body.envTemp, deviceData.envTemp);
  deviceData.irTemp   = num(body.irTemp, deviceData.irTemp);
  deviceData.smoke    = num(body.smoke, deviceData.smoke);
  deviceData.co       = num(body.co, deviceData.co);
  deviceData.current  = num(body.current, deviceData.current);
  deviceData.voltage  = num(body.voltage, deviceData.voltage);
  deviceData.receivedAt = Date.now();

  // 与模拟通道一致的风险计算与三级预警判定（真实通道）
  const d = {
    envTemp: deviceData.envTemp ?? 27, irTemp: deviceData.irTemp ?? 30,
    smoke: deviceData.smoke ?? 0, co: deviceData.co ?? 0, current: deviceData.current ?? 0,
  };
  const { risk, level } = calcRisk(d);
  deviceData.riskIndex = risk;
  deviceData.alarmLevel = level;
  if (typeof body.relayOn === 'boolean') deviceData.relayOn = body.relayOn;
  if (typeof body.aerosolFired === 'boolean') deviceData.aerosolFired = body.aerosolFired;

  const prev = deviceData.deviceAlarmLevel;
  if (level !== prev) {
    deviceData.deviceAlarmLevel = level;
    if (level > prev) addAlarm(level, '[设备上报] ' + buildAlarmText(level));
    else addAlarm(0, '[设备上报] 风险回落：预警解除');
  }
  return { riskIndex: risk, alarmLevel: level };
}

/**
 * 当前生效数据：60 秒内有真实上报 → 用真实数据，否则回落模拟数据
 * 前端与历史曲线统一走这里，实现"模拟 ↔ 真实"无缝切换
 */
function currentData() {
  if (deviceDataFresh()) {
    return {
      source: 'device',
      envTemp: deviceData.envTemp, irTemp: deviceData.irTemp,
      smoke: deviceData.smoke, co: deviceData.co,
      current: deviceData.current, voltage: deviceData.voltage,
      riskIndex: deviceData.riskIndex,
      alarmLevel: deviceData.alarmLevel,
      relayOn: deviceData.relayOn !== null ? deviceData.relayOn : state.relayOn,
      aerosolFired: deviceData.aerosolFired !== null ? deviceData.aerosolFired : state.aerosolFired,
      online: true,
    };
  }
  return {
    source: 'simulated',
    envTemp: +state.envTemp.toFixed(1), irTemp: +state.irTemp.toFixed(1),
    smoke: Math.round(state.smoke), co: Math.round(state.co),
    current: +state.current.toFixed(2), voltage: +state.voltage.toFixed(1),
    riskIndex: state.riskIndex,
    alarmLevel: state.alarmLevel,
    relayOn: state.relayOn, aerosolFired: state.aerosolFired,
    online: state.online,
  };
}

function buildAlarmText(level) {
  if (level === 1) return '预警级：监测到火灾风险上升，蜂鸣器间歇鸣响，请关注设备状态';
  if (level === 2) return '报警级：继电器已切断市电，负载断电保护生效';
  return '处置级：断电完成并延时复核后，气溶胶灭火装置已触发';
}

const alarms = []; // { time, level, text }
function addAlarm(level, text) {
  alarms.unshift({ time: new Date().toISOString(), level, text });
  if (alarms.length > 200) alarms.pop();
}

setInterval(step, 1000);

// 初始填充 1 小时历史数据
const history = [];
(function seedHistory() {
  const now = Date.now();
  for (let i = 360; i >= 0; i--) {
    const t = now - i * 10000;
    const base = 26 + Math.sin(i / 40) * 2 + Math.random();
    history.push({
      time: new Date(t).toISOString(),
      envTemp: +base.toFixed(1),
      irTemp: +(base + 1.5 + Math.random()).toFixed(1),
      smoke: +(Math.random() * 2).toFixed(0),
      co: +(Math.random() * 1).toFixed(0),
      current: +(Math.random() * 2).toFixed(2),
      voltage: +(218 + Math.random() * 4).toFixed(1),
      risk: Math.round(Math.random() * 8),
    });
  }
})();

setInterval(() => {
  const cd = currentData();
  history.push({
    time: new Date().toISOString(),
    envTemp: +(+cd.envTemp).toFixed(1),
    irTemp: +(+cd.irTemp).toFixed(1),
    smoke: Math.round(cd.smoke),
    co: Math.round(cd.co),
    current: +(+cd.current).toFixed(2),
    voltage: +(+cd.voltage).toFixed(1),
    risk: cd.riskIndex,
  });
  if (history.length > 4000) history.shift();
}, 10000);

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let file = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* API 路由                                                            */
/* ------------------------------------------------------------------ */
async function handleAPI(req, res, urlPath) {
  // 登录
  if (urlPath === '/api/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      return sendJSON(res, 200, { ok: true, token: createSession(username), user: username });
    }
    return sendJSON(res, 401, { ok: false, message: '用户名或密码错误' });
  }

  // 设备数据上报（STM32/ESP8266 或 华为云影子拉取回填），用 X-Device-Key 鉴权，不走用户会话
  if (urlPath === '/api/device/report' && req.method === 'POST') {
    const key = req.headers['x-device-key'] || '';
    if (key !== DEVICE_KEY) {
      return sendJSON(res, 401, { ok: false, message: '设备密钥无效' });
    }
    const body = await readBody(req);
    const result = applyDeviceReport(body);
    return sendJSON(res, 200, { ok: true, ...result });
  }

  // 以下接口均需登录
  const session = checkAuth(req);
  if (!session) return sendJSON(res, 401, { ok: false, message: '未登录或会话已过期' });

  if (urlPath === '/api/state' && req.method === 'GET') {
    const cd = currentData();
    return sendJSON(res, 200, {
      ok: true,
      device: { name: '新的设备', model: 'CFCG-M1', version: 'V1.0', online: cd.online },
      source: cd.source,                       // device = 真实设备数据 / simulated = 模拟数据
      data: {
        envTemp: cd.envTemp,
        irTemp: cd.irTemp,
        smoke: Math.round(cd.smoke),
        co: Math.round(cd.co),
        current: +(+cd.current).toFixed(2),
        voltage: +(+cd.voltage).toFixed(1),
        riskIndex: cd.riskIndex,
      },
      status: {
        alarmLevel: cd.alarmLevel,
        relayOn: cd.relayOn,
        buzzerMuted: state.buzzerMuted,
        aerosolFired: cd.aerosolFired,
      },
    });
  }

  if (urlPath === '/api/history' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const minutes = clamp(parseInt(q.get('minutes') || '60', 10) || 60, 5, 1440);
    const since = Date.now() - minutes * 60000;
    return sendJSON(res, 200, {
      ok: true,
      points: history.filter((p) => new Date(p.time).getTime() >= since),
    });
  }

  if (urlPath === '/api/alarms' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, alarms });
  }

  if (urlPath === '/api/control' && req.method === 'POST') {
    const { action } = await readBody(req);
    switch (action) {
      case 'relay_on':
        if (state.alarmLevel >= 2) return sendJSON(res, 400, { ok: false, message: '火灾风险未解除，禁止远程合闸' });
        state.relayOn = true; break;
      case 'relay_off':
        state.relayOn = false; break;
      case 'buzzer_mute':
        state.buzzerMuted = true; break;
      case 'buzzer_unmute':
        state.buzzerMuted = false; break;
      case 'device_reset':
        state.alarmLevel = 0; state.aerosolFired = false;
        state.smoke = 0; state.co = 0; state.irTemp = 29.0; state.envTemp = 27.0;
        state.current = state.relayOn ? 0.5 : 0; state.riskIndex = 4;
        demoFault.active = false;
        addAlarm(0, '远程复位：系统状态已复位');
        break;
      case 'demo_heat':
        demoFault.active = true; demoFault.type = 'heat'; demoFault.start = Date.now();
        break;
      case 'demo_smoke':
        demoFault.active = true; demoFault.type = 'smoke'; demoFault.start = Date.now();
        break;
      case 'demo_stop':
        demoFault.active = false;
        break;
      default:
        return sendJSON(res, 400, { ok: false, message: '未知指令' });
    }
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { ok: false, message: '接口不存在' });
}

/* ------------------------------------------------------------------ */
/* 华为云 IoTDA 设备影子拉取模块（可选）                                */
/*                                                                     */
/* 说明书写明的最终方案：设备 → 华为云 IoTDA，本平台定时拉取设备影子。  */
/* 全部通过环境变量开启（缺省关闭，走本地上报/模拟数据）：              */
/*   HW_IOTDA_REGION        华为云区域，如 cn-north-4                  */
/*   HW_IOTDA_PROJECT_ID    IoTDA 项目 ID（华为云控制台"我的凭证"页）  */
/*   HW_IOTDA_DEVICE_ID     IoTDA 注册设备后的设备 ID                  */
/*   HW_IAM_DOMAIN_NAME     IAM 账号名（主账号名）                     */
/*   HW_IAM_USER_NAME       IAM 用户名（子用户，无子用户则与账号名相同）*/
/*   HW_IAM_PASSWORD        IAM 用户密码                               */
/* ------------------------------------------------------------------ */
const HW = {
  region: process.env.HW_IOTDA_REGION || '',
  projectId: process.env.HW_IOTDA_PROJECT_ID || '',
  deviceId: process.env.HW_IOTDA_DEVICE_ID || '',
  domainName: process.env.HW_IAM_DOMAIN_NAME || '',
  userName: process.env.HW_IAM_USER_NAME || '',
  password: process.env.HW_IAM_PASSWORD || '',
};
HW.enabled = !!(HW.region && HW.projectId && HW.deviceId && HW.domainName && HW.password);
let hwToken = { value: '', expiresAt: 0 };

/** 向华为云 IAM 申请 X-Auth-Token（密码认证，12 小时有效，提前 10 分钟续期） */
async function hwGetToken() {
  if (hwToken.value && Date.now() < hwToken.expiresAt) return hwToken.value;
  const body = {
    auth: {
      identity: {
        methods: ['password'],
        password: {
          user: {
            name: HW.userName || HW.domainName,
            domain: { name: HW.domainName },
            password: HW.password,
          },
        },
      },
      scope: { project: { id: HW.projectId } },
    },
  };
  const resp = await fetch('https://iam.myhuaweicloud.com/v3/auth/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('IAM 认证失败: HTTP ' + resp.status);
  const token = resp.headers.get('X-Subject-Token');
  if (!token) throw new Error('IAM 响应中缺少 X-Subject-Token');
  hwToken = { value: token, expiresAt: Date.now() + 11 * 60 * 60 * 1000 };
  return token;
}

/** 拉取设备影子并回填到平台数据通道 */
async function hwPullShadow() {
  const token = await hwGetToken();
  const url = `https://iotda.${HW.region}.myhuaweicloud.com/v5/iot/${HW.projectId}/devices/${HW.deviceId}/shadow`;
  const resp = await fetch(url, { headers: { 'X-Auth-Token': token } });
  if (!resp.ok) throw new Error('影子拉取失败: HTTP ' + resp.status);
  const json = await resp.json();
  const reported = (json.shadow && json.shadow[0] && json.shadow[0].reported) || {};
  const p = reported.properties || {};
  // 属性标识符（产品模型中定义的 identifier）与平台字段映射，缺的沿用旧值
  applyDeviceReport({
    envTemp: p.envTemp, irTemp: p.irTemp, smoke: p.smoke, co: p.co,
    current: p.current, voltage: p.voltage,
    relayOn: typeof p.relayOn === 'boolean' ? p.relayOn : undefined,
    aerosolFired: typeof p.aerosolFired === 'boolean' ? p.aerosolFired : undefined,
  });
}

if (HW.enabled) {
  console.log(' 华为云 IoTDA 影子拉取已启用: 区域=' + HW.region + ' 设备=' + HW.deviceId);
  const pull = () => hwPullShadow().catch((e) => console.error('[IoTDA] ' + e.message));
  pull();
  setInterval(pull, 10 * 1000);
}

/* ------------------------------------------------------------------ */
/* HTTP 服务器                                                         */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.startsWith('/api/')) {
    try { await handleAPI(req, res, urlPath); }
    catch (e) { sendJSON(res, 500, { ok: false, message: '服务器内部错误' }); }
    return;
  }
  serveStatic(req, res, urlPath);
});

server.listen(PORT, () => {
  console.log('==============================================');
  console.log(' 多功能智能插座云端监控平台 V1.0 已启动');
  console.log(' 访问地址:  http://localhost:' + PORT);
  console.log(' 默认账号:  ' + ADMIN_USER + ' / ' + ADMIN_PASS);
  console.log(' (生产环境请通过环境变量修改账号密码)');
  console.log('==============================================');
});
