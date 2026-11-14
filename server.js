#!/usr/bin/env node
/**
 * Nexus-Flux · 端口转发与加密隧道主控服务端 (Master Server)
 * Version: v1.1.0
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const net = require('net');
const os = require('os');

// ======================= 配置与全局变量 =======================
const VERSION = '1.1.0';
const PANEL_VERSION = 'v1.1.0';
const DATA_DIR = process.env.NEXUS_FLUX_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'flux-db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AGENT_SCRIPT_PATH = path.join(__dirname, 'agent', 'nexus-flux-agent.js');
const NODE_INSTALL_SCRIPT_PATH = path.join(__dirname, 'node-install.sh');
let cachedIndexHtml = null;
let cachedIndexGzip = null;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// 默认数据库结构
function createDefaultDb() {
  const now = Date.now();
  const defaultPwdHash = hashPassword('admin_user');
  return {
    meta: {
      version: PANEL_VERSION,
      createdAt: now,
      updatedAt: now,
      nextIds: {
        node: 1,
        tunnel: 1,
        forward: 1,
        speedLimit: 1,
        statisticsFlow: 1
      }
    },
    admin: {
      id: 1,
      user: process.env.FLUX_ADMIN_USER || 'admin_user',
      pwd: process.env.FLUX_ADMIN_PWD ? hashPassword(process.env.FLUX_ADMIN_PWD) : defaultPwdHash,
      roleId: 0,
      inFlow: 0,
      outFlow: 0,
      updatedTime: now
    },
    configs: {
      app_name: 'Nexus-Flux',
      ip: process.env.FLUX_PUBLIC_ADDR || '',
      panel_domain: process.env.FLUX_PANEL_DOMAIN || '',
      block_ip_access: process.env.FLUX_BLOCK_IP === '1' ? 'true' : 'false',
      agent_mode: 'light',
      github_repo: 'mor2026-28/Nexus-flux',
      theme: 'light'
    },
    nodes: [],
    tunnels: [],
    forwards: [],
    speedLimits: [],
    statisticsFlows: []
  };
}

function md5(str) {
  return crypto.createHash('md5').update(String(str), 'utf8').digest('hex');
}

function hashPassword(plainPwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(String(plainPwd), salt, 100000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${derived}`;
}

function verifyPassword(plainPwd, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  if (storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const expectedHex = parts[2];
    const actualBuf = crypto.pbkdf2Sync(String(plainPwd), salt, 100000, 32, 'sha256');
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (actualBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  }
  // 兼容旧版 32 位 MD5 并在登录成功后自动升级为 PBKDF2
  const actualMd5 = Buffer.from(md5(plainPwd), 'utf8');
  const expectedMd5 = Buffer.from(storedHash, 'utf8');
  if (actualMd5.length !== expectedMd5.length) return false;
  return crypto.timingSafeEqual(actualMd5, expectedMd5);
}

// 登录防爆破限流器 (同 IP 15分钟内最多允许 5 次失败尝试)
const loginAttemptMap = new Map();
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const rec = loginAttemptMap.get(ip);
  if (!rec) return { allowed: true };
  if (now - rec.firstAt > 15 * 60 * 1000) {
    loginAttemptMap.delete(ip);
    return { allowed: true };
  }
  if (rec.count >= 5) {
    return { allowed: false, retryAfterSec: Math.ceil((15 * 60 * 1000 - (now - rec.firstAt)) / 1000) };
  }
  return { allowed: true };
}
function recordLoginFailure(ip) {
  const now = Date.now();
  const rec = loginAttemptMap.get(ip);
  if (!rec || now - rec.firstAt > 15 * 60 * 1000) {
    loginAttemptMap.set(ip, { count: 1, firstAt: now });
  } else {
    rec.count += 1;
  }
}
function clearLoginFailures(ip) {
  loginAttemptMap.delete(ip);
}

function simpleUUID() {
  return crypto.randomBytes(16).toString('hex');
}

// ======================= 内存数据库与防抖批量落盘 =======================
let db = createDefaultDb();
let dbDirty = false;
let jwtSecret = crypto.randomBytes(32).toString('hex');

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      db = Object.assign(createDefaultDb(), parsed);
      db.meta = Object.assign(createDefaultDb().meta, parsed.meta || {});
      db.meta.nextIds = Object.assign(createDefaultDb().meta.nextIds, (parsed.meta && parsed.meta.nextIds) || {});
      db.configs = Object.assign(createDefaultDb().configs, parsed.configs || {});
      if (db.meta.jwtSecret) {
        jwtSecret = db.meta.jwtSecret;
      } else {
        db.meta.jwtSecret = jwtSecret;
      }
      // 启动时将所有节点初始状态重置为离线(0)，等待 WebSocket 重新握手上线
      if (Array.isArray(db.nodes)) {
        db.nodes.forEach(n => { n.status = 0; });
      }
      console.log(`[Nexus-Flux] 数据库加载成功: 节点=${db.nodes.length}, 隧道=${db.tunnels.length}, 转发=${db.forwards.length}`);
    } else {
      db.meta.jwtSecret = jwtSecret;
      saveDbSync();
      console.log(`[Nexus-Flux] 初始化全新数据库: ${DB_FILE}`);
    }
  } catch (err) {
    console.error(`[Nexus-Flux] 加载数据库失败，使用默认库:`, err.message);
    db.meta.jwtSecret = jwtSecret;
  }
}

function markDirty() {
  dbDirty = true;
}

function saveDbSync() {
  try {
    db.meta.updatedAt = Date.now();
    const tmpFile = DB_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmpFile, DB_FILE);
    dbDirty = false;
  } catch (err) {
    console.error(`[Nexus-Flux] 保存数据库失败:`, err.message);
  }
}

// 每 10 秒检查一次脏标记并合并写盘（大幅降低小内存机器磁盘 I/O 与 Swap 压力）
const flushTimer = setInterval(() => {
  if (dbDirty) {
    saveDbSync();
  }
}, 10000);
flushTimer.unref();

// 每整点记录一次流量趋势快照
const statsTimer = setInterval(() => {
  recordHourlyFlowSnapshot();
}, 3600 * 1000);
statsTimer.unref();

function recordHourlyFlowSnapshot(customTimeLabel) {
  const now = new Date();
  const timeStr = customTimeLabel || `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:00`;
  const totalFlow = (db.admin.inFlow || 0) + (db.admin.outFlow || 0);
  const lastRecord = db.statisticsFlows.length > 0 ? db.statisticsFlows[db.statisticsFlows.length - 1] : null;
  const deltaFlow = lastRecord ? Math.max(0, totalFlow - (lastRecord.totalFlow || 0)) : totalFlow;

  db.statisticsFlows.push({
    id: db.meta.nextIds.statisticsFlow++,
    userId: 1,
    flow: deltaFlow,
    totalFlow: totalFlow,
    time: timeStr,
    createdTime: Date.now()
  });

  // 仅保留最近 48 条记录，防止文件膨胀
  if (db.statisticsFlows.length > 48) {
    db.statisticsFlows = db.statisticsFlows.slice(-48);
  }
  markDirty();
}

// ======================= AES-256-GCM 加密器 (100% 兼容 Go / Java 端) =======================
const cryptoKeyCache = new Map();

function getAesKey(secret) {
  if (!secret) return null;
  let key = cryptoKeyCache.get(secret);
  if (!key) {
    key = crypto.createHash('sha256').update(String(secret), 'utf8').digest();
    if (cryptoKeyCache.size > 200) cryptoKeyCache.clear();
    cryptoKeyCache.set(secret, key);
  }
  return key;
}

function aesEncrypt(plainText, secret) {
  const key = getAesKey(secret);
  if (!key) return plainText;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

function aesDecrypt(base64Cipher, secret) {
  const key = getAesKey(secret);
  if (!key) throw new Error('Empty secret');
  const buf = Buffer.from(base64Cipher, 'base64');
  if (buf.length < 28) throw new Error('Ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

function wrapEncryptedMessage(plainObjOrStr, secret) {
  const plainStr = typeof plainObjOrStr === 'string' ? plainObjOrStr : JSON.stringify(plainObjOrStr);
  if (!secret) return plainStr;
  try {
    return JSON.stringify({
      encrypted: true,
      data: aesEncrypt(plainStr, secret),
      timestamp: Date.now()
    });
  } catch (e) {
    return plainStr;
  }
}

function unwrapEncryptedMessage(rawPayload, secret) {
  if (!rawPayload) return '';
  const str = typeof rawPayload === 'string' ? rawPayload : rawPayload.toString('utf8');
  try {
    const parsed = JSON.parse(str);
    if (parsed && parsed.encrypted === true && typeof parsed.data === 'string' && secret) {
      return aesDecrypt(parsed.data, secret);
    }
  } catch (e) {
    // 非加密格式或直接 JSON
  }
  return str;
}

// ======================= JWT 轻量签名与校验 =======================
function signJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(Object.assign({}, payload, {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400 * 7
  }))).toString('base64url');
  const sig = crypto.createHmac('sha256', jwtSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const clean = token.replace(/^Bearer\s+/i, '').trim();
  const parts = clean.split('.');
  if (parts.length !== 3) return null;
  const expectedSig = crypto.createHmac('sha256', jwtSecret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const sigBuf = Buffer.from(parts[2], 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ======================= 原生 RFC6455 WebSocket 引擎 =======================
class WsConnection {
  constructor(socket, meta = {}) {
    this.socket = socket;
    this.id = simpleUUID();
    this.meta = meta;
    this.isOpen = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (payloadLen > 2 * 1024 * 1024) { this.close(); return; }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + payloadLen) return;

      let payload = this.buffer.subarray(offset + maskLength, offset + maskLength + payloadLen);
      if (masked) {
        const maskKey = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      }

      this.buffer = this.buffer.subarray(offset + maskLength + payloadLen);

      if (opcode === 0x08) { // Close
        this.close();
        return;
      } else if (opcode === 0x09) { // Ping
        this._sendFrame(0x0a, payload);
      } else if (opcode === 0x0a) { // Pong
        // ignore
      } else if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
        if (opcode !== 0x00) this.fragmentOpcode = opcode;
        this.fragments.push(payload);
        if (fin) {
          const fullPayload = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.onMessage) {
            this.onMessage(fullPayload.toString('utf8'));
          }
        }
      }
    }
  }

  _sendFrame(opcode, payloadBuf) {
    if (!this.isOpen || this.socket.destroyed) return;
    const len = payloadBuf.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payloadBuf]));
    } catch (e) {
      this._onClose();
    }
  }

  sendText(text) {
    this._sendFrame(0x01, Buffer.from(String(text), 'utf8'));
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    try {
      this._sendFrame(0x08, Buffer.alloc(0));
      this.socket.end();
    } catch (e) {}
    if (this.onClose) this.onClose();
  }

  _onClose() {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.onClose) this.onClose();
  }
}

// ======================= WebSocket 会话与节点命令调度中心 =======================
const adminSessions = new Set();        // 网页管理员实时监控连接
const nodeSessions = new Map();         // nodeId (Number) -> WsConnection
const nodeTelemetryCache = new Map();   // nodeId (Number) -> 最新系统监控指标 + 实时网速计算
const pendingRequests = new Map();      // requestId -> { resolve, timer }

function broadcastToAdmins(obj) {
  const msg = typeof obj === 'string' ? obj : JSON.stringify(obj);
  for (const ws of adminSessions) {
    if (ws.isOpen) ws.sendText(msg);
  }
}

function sendNodeCommand(nodeId, cmdType, data, timeoutMs = 8000) {
  const numNodeId = Number(nodeId);
  const ws = nodeSessions.get(numNodeId);
  if (!ws || !ws.isOpen) {
    return Promise.resolve({ msg: '节点不在线', success: false, offline: true });
  }

  const requestId = simpleUUID();
  const payloadObj = {
    type: cmdType,
    data: data,
    requestId: requestId
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({ msg: '等待响应超时', success: false, timeout: true });
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve: (res) => {
        clearTimeout(timer);
        resolve(res);
      }
    });

    const outgoing = wrapEncryptedMessage(payloadObj, ws.meta.secret);
    ws.sendText(outgoing);
  });
}

// ======================= 节点转发与隧道配置构建器 =======================
const GostBuilder = {
  createLimiterData(name, speedMBps) {
    return {
      name: String(name),
      limits: [`$ ${speedMBps}MB ${speedMBps}MB`]
    };
  },

  convertBitsToMBps(speedInMbps) {
    const mbs = (Number(speedInMbps) || 100) / 8.0;
    return mbs.toFixed(1);
  },

  buildServiceName(forwardId, userId = 1, userTunnelId = 0) {
    return `${forwardId}_${userId || 1}_${userTunnelId || 0}`;
  },

  createServicePair(serviceName, inPort, limiterId, remoteAddr, fowType, tunnel, strategy, interfaceName) {
    const protocols = ['tcp', 'udp'];
    return protocols.map(protocol => {
      const tcpAddr = (tunnel && tunnel.tcpListenAddr) ? tunnel.tcpListenAddr : '[::]';
      const udpAddr = (tunnel && tunnel.udpListenAddr) ? tunnel.udpListenAddr : '[::]';
      const listenHost = protocol === 'tcp' ? tcpAddr : udpAddr;

      const svc = {
        name: `${serviceName}_${protocol}`,
        addr: `${listenHost}:${inPort}`
      };

      if (interfaceName && String(interfaceName).trim()) {
        svc.metadata = { interface: String(interfaceName).trim() };
      }

      if (limiterId != null && limiterId !== '' && Number(limiterId) > 0) {
        svc.limiter = String(limiterId);
      }

      const handler = { type: protocol };
      if (Number(fowType) !== 1) {
        handler.chain = `${serviceName}_chains`;
      }
      svc.handler = handler;

      const listener = { type: protocol };
      if (protocol === 'udp') {
        listener.metadata = { keepAlive: true };
      }
      svc.listener = listener;

      if (Number(fowType) === 1) {
        svc.forwarder = this.createForwarder(remoteAddr, strategy);
      }
      return svc;
    });
  },

  createForwarder(remoteAddr, strategy) {
    const addrs = String(remoteAddr || '')
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);
    const nodes = addrs.map((addr, idx) => ({
      name: `node_${idx + 1}`,
      addr: addr
    }));
    return {
      nodes,
      selector: {
        strategy: strategy || 'fifo',
        maxFails: 1,
        failTimeout: '600s'
      }
    };
  },

  createRemoteService(serviceName, outPort, remoteAddr, protocol, strategy, interfaceName) {
    const data = {
      name: `${serviceName}_tls`,
      addr: `:${outPort}`,
      handler: { type: 'relay' },
      listener: { type: protocol || 'tls' },
      forwarder: this.createForwarder(remoteAddr, strategy)
    };
    if (interfaceName && String(interfaceName).trim()) {
      data.metadata = { interface: String(interfaceName).trim() };
    }
    return [data];
  },

  createChainData(serviceName, remoteAddr, protocol, interfaceName) {
    const dialer = { type: protocol || 'tls' };
    if (protocol === 'quic') {
      dialer.metadata = { keepAlive: true, ttl: '10s' };
    }
    const node = {
      name: `node-${serviceName}`,
      addr: remoteAddr,
      connector: { type: 'relay' },
      dialer: dialer
    };
    if (interfaceName && String(interfaceName).trim()) {
      node.interface = String(interfaceName).trim();
    }
    return {
      name: `${serviceName}_chains`,
      hops: [
        {
          name: `hop-${serviceName}`,
          nodes: [node]
        }
      ]
    };
  }
};

// ======================= 节点配置自动纳管与全节点批量操作 =======================
function adoptNodeReportedConfig(node, gostConfig) {
  if (!node || !gostConfig) return;
  const services = Array.isArray(gostConfig.services) ? gostConfig.services : [];
  const chainsList = Array.isArray(gostConfig.chains) ? gostConfig.chains : [];
  let changed = false;

  const chainMap = new Map();
  for (const c of chainsList) {
    if (c && c.name) chainMap.set(String(c.name), c);
  }

  for (const svc of services) {
    if (!svc || !svc.name || svc.name === 'web_api') continue;
    const nameStr = String(svc.name);
    if (!nameStr.endsWith('_tcp')) continue;

    const addrStr = String(svc.addr || '');
    const lastColon = addrStr.lastIndexOf(':');
    const inPort = lastColon !== -1 ? Number(addrStr.slice(lastColon + 1)) : 0;
    if (!inPort) continue;

    // 检查该入口节点的 inPort 是否已在面板中存在
    const existingFwd = db.forwards.find(f => {
      const t = db.tunnels.find(tu => Number(tu.id) === Number(f.tunnelId));
      return t && Number(t.inNodeId) === Number(node.id) && Number(f.inPort) === inPort;
    });
    if (existingFwd) continue;

    const chainName = svc.handler && svc.handler.chain;
    if (chainName && chainMap.has(String(chainName))) {
      const cObj = chainMap.get(String(chainName));
      const hopNode = cObj && Array.isArray(cObj.hops) && cObj.hops[0] && Array.isArray(cObj.hops[0].nodes) && cObj.hops[0].nodes[0];
      if (!hopNode || !hopNode.addr) continue;
      const parsedHop = splitHostPort(hopNode.addr);
      if (!parsedHop) continue;
      const outNode = db.nodes.find(n => n.serverIp === parsedHop.host || n.ip === parsedHop.host);
      if (!outNode) continue;

      const proto = (hopNode.dialer && hopNode.dialer.type) || 'tls';
      let tunnel = db.tunnels.find(t => Number(t.type) === 2 && Number(t.inNodeId) === Number(node.id) && Number(t.outNodeId) === Number(outNode.id));
      if (!tunnel) {
        tunnel = {
          id: db.meta.nextIds.tunnel++,
          name: `${node.name}-${outNode.name}`,
          type: 2,
          inNodeId: node.id,
          inIp: node.ip || node.serverIp,
          outNodeId: outNode.id,
          outIp: outNode.serverIp,
          protocol: proto,
          tcpListenAddr: '[::]',
          udpListenAddr: '[::]',
          interfaceName: '',
          flow: 1,
          trafficRatio: 1.0,
          status: 1,
          createdTime: Date.now(),
          updatedTime: Date.now()
        };
        db.tunnels.push(tunnel);
        changed = true;
      }

      const fwdId = db.meta.nextIds.forward++;
      db.forwards.push({
        id: fwdId,
        userId: 1,
        userName: db.admin.user,
        name: `${node.name}-${outNode.name}-${inPort}`,
        tunnelId: tunnel.id,
        inPort: inPort,
        outPort: parsedHop.port,
        remoteAddr: `${ parsedHop.host }:${ parsedHop.port }`,
        strategy: 'fifo',
        interfaceName: '',
        speedId: null,
        inFlow: 0,
        outFlow: 0,
        createdTime: Date.now(),
        updatedTime: Date.now(),
        status: 1,
        inx: db.forwards.length
      });
      changed = true;
    } else if (svc.forwarder && Array.isArray(svc.forwarder.nodes) && svc.forwarder.nodes.length > 0) {
      const remoteAddr = svc.forwarder.nodes.map(n => n.addr).filter(Boolean).join(',');
      if (!remoteAddr) continue;
      let tunnel = db.tunnels.find(t => Number(t.type) === 1 && Number(t.inNodeId) === Number(node.id));
      if (!tunnel) {
        tunnel = {
          id: db.meta.nextIds.tunnel++,
          name: `${node.name}-直转`,
          type: 1,
          inNodeId: node.id,
          inIp: node.ip || node.serverIp,
          outNodeId: node.id,
          outIp: node.serverIp,
          protocol: null,
          tcpListenAddr: '[::]',
          udpListenAddr: '[::]',
          interfaceName: '',
          flow: 1,
          trafficRatio: 1.0,
          status: 1,
          createdTime: Date.now(),
          updatedTime: Date.now()
        };
        db.tunnels.push(tunnel);
        changed = true;
      }
      const fwdId = db.meta.nextIds.forward++;
      db.forwards.push({
        id: fwdId,
        userId: 1,
        userName: db.admin.user,
        name: `${node.name}-${inPort}`,
        tunnelId: tunnel.id,
        inPort: inPort,
        outPort: null,
        remoteAddr,
        strategy: (svc.forwarder.selector && svc.forwarder.selector.strategy) || 'fifo',
        interfaceName: (svc.metadata && svc.metadata.interface) || '',
        speedId: null,
        inFlow: 0,
        outFlow: 0,
        createdTime: Date.now(),
        updatedTime: Date.now(),
        status: 1,
        inx: db.forwards.length
      });
      changed = true;
    }
  }

  // Also check relay _tls services on exit nodes to update remoteAddr of adopted tunnel forwards
  for (const svc of services) {
    if (!svc || !svc.name || !String(svc.name).endsWith('_tls')) continue;
    const addrStr = String(svc.addr || '');
    const lastColon = addrStr.lastIndexOf(':');
    const outPort = lastColon !== -1 ? Number(addrStr.slice(lastColon + 1)) : 0;
    if (!outPort || !svc.forwarder || !Array.isArray(svc.forwarder.nodes) || svc.forwarder.nodes.length === 0) continue;
    const realRemoteAddr = svc.forwarder.nodes.map(n => n.addr).filter(Boolean).join(',');
    if (!realRemoteAddr) continue;

    for (const fwd of db.forwards) {
      const t = db.tunnels.find(tu => Number(tu.id) === Number(fwd.tunnelId));
      if (t && Number(t.type) === 2 && Number(t.outNodeId) === Number(node.id) && Number(fwd.outPort) === outPort) {
        if (fwd.remoteAddr !== realRemoteAddr) {
          fwd.remoteAddr = realRemoteAddr;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    saveDbSync();
  }
}

// ======================= 节点上线自动全量状态同步 =======================
async function syncNodeDesiredState(nodeId) {
  const numNodeId = Number(nodeId);
  const node = db.nodes.find(n => n.id === numNodeId);
  if (!node) return;

  // 1. 同步节点协议屏蔽开关 (HTTP / TLS / SOCKS)
  await sendNodeCommand(numNodeId, 'SetProtocol', {
    http: Number(node.http) || 0,
    tls: Number(node.tls) || 0,
    socks: Number(node.socks) || 0
  });

  // 2. 同步绑定在该入口节点上的限速器
  const inTunnels = db.tunnels.filter(t => Number(t.inNodeId) === numNodeId);
  const inTunnelIds = new Set(inTunnels.map(t => Number(t.id)));
  const nodeLimiters = db.speedLimits.filter(s => inTunnelIds.has(Number(s.tunnelId)) && Number(s.status) === 1);
  for (const lim of nodeLimiters) {
    const speedMB = GostBuilder.convertBitsToMBps(lim.speed);
    const limData = GostBuilder.createLimiterData(lim.id, speedMB);
    const res = await sendNodeCommand(numNodeId, 'UpdateLimiters', { limiter: String(lim.id), data: limData });
    if (!res.success && String(res.msg).includes('not found')) {
      await sendNodeCommand(numNodeId, 'AddLimiters', limData);
    }
  }

  // 3. 同步所有以该节点为出口节点的隧道转发远端服务 (_tls)
  const outTunnels = db.tunnels.filter(t => Number(t.type) === 2 && Number(t.outNodeId) === numNodeId && Number(t.status) === 1);
  for (const tunnel of outTunnels) {
    const forwards = db.forwards.filter(f => Number(f.tunnelId) === Number(tunnel.id) && Number(f.status) === 1);
    for (const fwd of forwards) {
      const serviceName = GostBuilder.buildServiceName(fwd.id, 1, 0);
      const remoteSvc = GostBuilder.createRemoteService(serviceName, fwd.outPort, fwd.remoteAddr, tunnel.protocol || 'tls', fwd.strategy, fwd.interfaceName);
      const res = await sendNodeCommand(numNodeId, 'UpdateService', remoteSvc);
      if (!res.success && String(res.msg).includes('not found')) {
        await sendNodeCommand(numNodeId, 'AddService', remoteSvc);
      }
    }
  }

  // 4. 同步所有以该节点为入口节点的转发链 (_chains) 与主服务 (_tcp, _udp)
  for (const tunnel of inTunnels) {
    if (Number(tunnel.status) !== 1) continue;
    const forwards = db.forwards.filter(f => Number(f.tunnelId) === Number(tunnel.id) && Number(f.status) === 1);
    for (const fwd of forwards) {
      const serviceName = GostBuilder.buildServiceName(fwd.id, 1, 0);
      if (Number(tunnel.type) === 2) {
        const outIp = tunnel.outIp || '';
        const remoteChainAddr = outIp.includes(':') && !outIp.startsWith('[') ? `[${outIp}]:${fwd.outPort}` : `${outIp}:${fwd.outPort}`;
        const chainData = GostBuilder.createChainData(serviceName, remoteChainAddr, tunnel.protocol || 'tls', tunnel.interfaceName);
        const cRes = await sendNodeCommand(numNodeId, 'UpdateChains', { chain: `${serviceName}_chains`, data: chainData });
        if (!cRes.success && String(cRes.msg).includes('not found')) {
          await sendNodeCommand(numNodeId, 'AddChains', chainData);
        }
      }

      const limiterId = fwd.speedId || getDefaultTunnelSpeedId(tunnel.id);
      const mainInterface = Number(tunnel.type) !== 2 ? fwd.interfaceName : '';
      const svcPair = GostBuilder.createServicePair(serviceName, fwd.inPort, limiterId, fwd.remoteAddr, tunnel.type, tunnel, fwd.strategy, mainInterface);
      const sRes = await sendNodeCommand(numNodeId, 'UpdateService', svcPair);
      if (!sRes.success && String(sRes.msg).includes('not found')) {
        await sendNodeCommand(numNodeId, 'AddService', svcPair);
      }
    }
  }
}

function getDefaultTunnelSpeedId(tunnelId) {
  const rule = db.speedLimits.find(s => Number(s.tunnelId) === Number(tunnelId) && Number(s.status) === 1);
  return rule ? rule.id : null;
}

// ======================= 下发单条转发至 GOST / Light Agent =======================
async function deployForwardToNodes(forward, tunnel) {
  const serviceName = GostBuilder.buildServiceName(forward.id, 1, 0);
  const limiterId = forward.speedId !== undefined && forward.speedId !== null
    ? forward.speedId
    : getDefaultTunnelSpeedId(tunnel.id);

  // 如果是隧道转发 (type === 2)，先在入口建 Chain，出口建 RemoteService
  if (Number(tunnel.type) === 2) {
    const outIp = tunnel.outIp || '';
    const remoteChainAddr = outIp.includes(':') && !outIp.startsWith('[') ? `[${outIp}]:${forward.outPort}` : `${outIp}:${forward.outPort}`;
    const chainData = GostBuilder.createChainData(serviceName, remoteChainAddr, tunnel.protocol || 'tls', tunnel.interfaceName);

    let chainRes = await sendNodeCommand(tunnel.inNodeId, 'UpdateChains', { chain: `${serviceName}_chains`, data: chainData });
    if (!chainRes.offline && !chainRes.success && String(chainRes.msg).includes('not found')) {
      chainRes = await sendNodeCommand(tunnel.inNodeId, 'AddChains', chainData);
    }

    const remoteSvc = GostBuilder.createRemoteService(serviceName, forward.outPort, forward.remoteAddr, tunnel.protocol || 'tls', forward.strategy, forward.interfaceName);
    let remoteRes = await sendNodeCommand(tunnel.outNodeId, 'UpdateService', remoteSvc);
    if (!remoteRes.offline && !remoteRes.success && String(remoteRes.msg).includes('not found')) {
      remoteRes = await sendNodeCommand(tunnel.outNodeId, 'AddService', remoteSvc);
    }
  }

  // 在入口节点创建或更新主服务 (_tcp, _udp)
  const mainInterface = Number(tunnel.type) !== 2 ? forward.interfaceName : '';
  const svcPair = GostBuilder.createServicePair(serviceName, forward.inPort, limiterId, forward.remoteAddr, tunnel.type, tunnel, forward.strategy, mainInterface);
  let mainRes = await sendNodeCommand(tunnel.inNodeId, 'UpdateService', svcPair);
  if (!mainRes.offline && !mainRes.success && String(mainRes.msg).includes('not found')) {
    mainRes = await sendNodeCommand(tunnel.inNodeId, 'AddService', svcPair);
  }
  return mainRes;
}

async function removeForwardFromNodes(forward, tunnel) {
  if (!tunnel) return;
  const serviceName = GostBuilder.buildServiceName(forward.id, 1, 0);
  await sendNodeCommand(tunnel.inNodeId, 'DeleteService', { services: [`${serviceName}_tcp`, `${serviceName}_udp`] });
  if (Number(tunnel.type) === 2) {
    await sendNodeCommand(tunnel.inNodeId, 'DeleteChains', { chain: `${serviceName}_chains` });
    if (tunnel.outNodeId) {
      await sendNodeCommand(tunnel.outNodeId, 'DeleteService', { services: [`${serviceName}_tls`] });
    }
  }
}

// ======================= 端口分配算法 =======================
function getUsedPortsOnNode(nodeId, excludeForwardId = null) {
  const numNodeId = Number(nodeId);
  const used = new Set();
  const inTunnelIds = new Set(db.tunnels.filter(t => Number(t.inNodeId) === numNodeId).map(t => Number(t.id)));
  const outTunnelIds = new Set(db.tunnels.filter(t => Number(t.outNodeId) === numNodeId).map(t => Number(t.id)));

  for (const fwd of db.forwards) {
    if (excludeForwardId != null && Number(fwd.id) === Number(excludeForwardId)) continue;
    if (inTunnelIds.has(Number(fwd.tunnelId)) && fwd.inPort) {
      used.add(Number(fwd.inPort));
    }
    if (outTunnelIds.has(Number(fwd.tunnelId)) && fwd.outPort) {
      used.add(Number(fwd.outPort));
    }
  }
  return used;
}

function allocatePortForNode(nodeId, specifiedPort = null, excludeForwardId = null) {
  const node = db.nodes.find(n => Number(n.id) === Number(nodeId));
  if (!node) return { error: '节点不存在' };
  const portSta = Number(node.portSta) || 1000;
  const portEnd = Number(node.portEnd) || 65535;
  const used = getUsedPortsOnNode(nodeId, excludeForwardId);

  if (specifiedPort != null && specifiedPort !== '') {
    const p = Number(specifiedPort);
    if (isNaN(p) || p < portSta || p > portEnd) {
      return { error: `指定的端口 ${p} 不在节点允许范围 (${portSta}-${portEnd}) 内` };
    }
    if (used.has(p)) {
      return { error: `指定的端口 ${p} 已被占用` };
    }
    return { port: p };
  }

  for (let p = portSta; p <= portEnd; p++) {
    if (!used.has(p)) return { port: p };
  }
  return { error: '节点可用端口范围已满' };
}

// ======================= HTTP 响应辅助工具 =======================
const R = {
  ok(data = null, msg = '操作成功') {
    const res = { code: 0, msg, ts: Date.now() };
    if (data !== null && typeof data === 'string' && arguments.length === 1) {
      res.msg = data;
    } else {
      res.data = data;
    }
    return res;
  },
  okData(data, msg = '操作成功') {
    return { code: 0, msg, data, ts: Date.now() };
  },
  err(msg = '操作失败', code = -1) {
    return { code, msg, ts: Date.now() };
  }
};

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function readRequestBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 检查是否开启了“禁止 IP+端口 直接访问面板”
function isBlockedByDomainLock(req, pathname) {
  // 节点上报接口与安装脚本始终放行，保证无论面板锁不锁 IP，节点心跳和转发永远不断连！
  if (
    pathname.startsWith('/flow/') ||
    pathname.startsWith('/system-info') ||
    pathname === '/node-install.sh' ||
    pathname === '/agent/nexus-flux-agent.js' ||
    pathname === '/healthz'
  ) {
    return false;
  }

  const blockIp = db.configs.block_ip_access === 'true';
  const panelDomain = (db.configs.panel_domain || '').trim().toLowerCase();
  if (!blockIp || !panelDomain) return false;

  const hostHeader = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  // 如果请求 Host 与绑定的域名一致，则放行（由 Caddy 反代或域名访问）
  if (hostHeader === panelDomain) return false;

  // 允许本地 CLI 脚本 (127.0.0.1 / ::1) 带 X-Nexus-Local 头访问，或已持有合法管理员 JWT 修改配置解锁
  const remoteIp = req.socket.remoteAddress || '';
  if ((remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') && req.headers['x-nexus-local'] === '1') {
    return false;
  }
  if (pathname.startsWith('/api/v1/config/') && req.headers.authorization && verifyJwt(req.headers.authorization)) {
    return false;
  }

  return true;
}

// ======================= SQL 备份导入解析器 =======================
function parseFluxSqlDump(sqlText) {
  const result = { nodes: [], tunnels: [], forwards: [], speedLimits: [] };
  // 提取 INSERT INTO `table` (...) VALUES (...);
  const insertRegex = /INSERT\s+INTO\s+`?(node|tunnel|forward|speed_limit)`?\s*\(([^)]+)\)\s*VALUES\s*([\s\S]+?);/gi;
  let match;
  while ((match = insertRegex.exec(sqlText)) !== null) {
    const table = match[1].toLowerCase();
    const cols = match[2].split(',').map(c => c.replace(/[`'"\s]/g, '').trim());
    const valuesPart = match[3];
    const rowRegex = /\(([^()]+)\)/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(valuesPart)) !== null) {
      const rawVals = [];
      let cur = '';
      let inQuote = false;
      const rowStr = rowMatch[1];
      for (let i = 0; i < rowStr.length; i++) {
        const ch = rowStr[i];
        if (ch === "'" && rowStr[i - 1] !== '\\') {
          inQuote = !inQuote;
        } else if (ch === ',' && !inQuote) {
          rawVals.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      }
      rawVals.push(cur.trim());

      const obj = {};
      cols.forEach((col, idx) => {
        let v = rawVals[idx];
        if (v === undefined || v === 'NULL' || v === 'null') {
          obj[col] = null;
        } else if (v.startsWith("'") && v.endsWith("'")) {
          obj[col] = v.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, '\n');
        } else if (!isNaN(Number(v))) {
          obj[col] = Number(v);
        } else {
          obj[col] = v;
        }
      });

      if (table === 'node') {
        result.nodes.push({
          id: Number(obj.id),
          name: obj.name || `Node-${obj.id}`,
          secret: obj.secret || simpleUUID(),
          ip: obj.ip || obj.server_ip || '',
          serverIp: obj.server_ip || obj.ip || '',
          portSta: Number(obj.port_sta) || 1000,
          portEnd: Number(obj.port_end) || 65535,
          version: obj.version || '1.1.0',
          http: Number(obj.http) || 0,
          tls: Number(obj.tls) || 0,
          socks: Number(obj.socks) || 0,
          createdTime: Number(obj.created_time) || Date.now(),
          updatedTime: Number(obj.updated_time) || Date.now(),
          status: 0
        });
      } else if (table === 'tunnel') {
        result.tunnels.push({
          id: Number(obj.id),
          name: obj.name || `Tunnel-${obj.id}`,
          trafficRatio: Number(obj.traffic_ratio) || 1.0,
          inNodeId: Number(obj.in_node_id),
          inIp: obj.in_ip || '',
          outNodeId: Number(obj.out_node_id) || Number(obj.in_node_id),
          outIp: obj.out_ip || obj.in_ip || '',
          type: Number(obj.type) || 1,
          protocol: obj.protocol || 'tls',
          flow: Number(obj.flow) || 1,
          tcpListenAddr: obj.tcp_listen_addr || '[::]',
          udpListenAddr: obj.udp_listen_addr || '[::]',
          interfaceName: obj.interface_name || '',
          createdTime: Number(obj.created_time) || Date.now(),
          updatedTime: Number(obj.updated_time) || Date.now(),
          status: Number(obj.status) ?? 1
        });
      } else if (table === 'forward') {
        result.forwards.push({
          id: Number(obj.id),
          userId: 1,
          userName: 'admin',
          name: obj.name || `Forward-${obj.id}`,
          tunnelId: Number(obj.tunnel_id),
          inPort: Number(obj.in_port),
          outPort: obj.out_port ? Number(obj.out_port) : null,
          remoteAddr: obj.remote_addr || '',
          strategy: obj.strategy || 'fifo',
          interfaceName: obj.interface_name || '',
          inFlow: Number(obj.in_flow) || 0,
          outFlow: Number(obj.out_flow) || 0,
          speedId: null,
          createdTime: Number(obj.created_time) || Date.now(),
          updatedTime: Number(obj.updated_time) || Date.now(),
          status: Number(obj.status) ?? 1,
          inx: Number(obj.inx) || 0
        });
      } else if (table === 'speed_limit') {
        result.speedLimits.push({
          id: Number(obj.id),
          name: obj.name || `Limit-${obj.id}`,
          speed: Number(obj.speed) || 100,
          tunnelId: Number(obj.tunnel_id),
          tunnelName: obj.tunnel_name || '',
          createdTime: Number(obj.created_time) || Date.now(),
          updatedTime: Number(obj.updated_time) || Date.now(),
          status: Number(obj.status) ?? 1
        });
      }
    }
  }
  return result;
}

// ======================= HTTP 路由处理器 =======================
async function handleHttpRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { code: 0 });
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || '/';
  const query = parsedUrl.query || {};

  // 安全检查：如果启用了“禁止 IP+端口 直接访问面板”
  if (isBlockedByDomainLock(req, pathname)) {
    sendText(
      res,
      403,
      `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>403 禁止直接通过 IP+端口 访问</title><style>body{background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#1e293b;padding:32px 40px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.4);max-width:480px;text-align:center;border:1px solid #334155}h2{margin-top:0;color:#38bdf8}p{color:#94a3b8;line-height:1.6}code{background:#0f172a;padding:3px 8px;border-radius:6px;color:#f43f5e}</style></head><body><div class="card"><h2>🔒 已启用域名安全访问锁</h2><p>当前 Nexus-Flux 主控面板已设置为<b>禁止 IP+端口 直接访问</b>。请通过您绑定的 HTTPS 域名访问面板，或在服务器 SSH 中输入 <code>fl</code> 选择选项 6 解除限制。</p></div></body></html>`,
      'text/html; charset=utf-8'
    );
    return;
  }

  // 健康检查
  if (pathname === '/healthz') {
    const mem = process.memoryUsage();
    sendJson(res, 200, {
      status: 'ok',
      version: PANEL_VERSION,
      rssMB: Number((mem.rss / 1048576).toFixed(2)),
      heapUsedMB: Number((mem.heapUsed / 1048576).toFixed(2)),
      onlineNodes: nodeSessions.size,
      totalNodes: db.nodes.length,
      totalTunnels: db.tunnels.length,
      totalForwards: db.forwards.length
    });
    return;
  }

  // 节点一键安装脚本下发端点
  if (pathname === '/node-install.sh') {
    if (fs.existsSync(NODE_INSTALL_SCRIPT_PATH)) {
      sendText(res, 200, fs.readFileSync(NODE_INSTALL_SCRIPT_PATH, 'utf8'), 'text/x-shellscript; charset=utf-8');
    } else {
      sendText(res, 404, '#!/bin/bash\necho "node-install.sh not found"\nexit 1\n');
    }
    return;
  }

  // 轻量原生被控脚本下发端点
  if (pathname === '/agent/nexus-flux-agent.js') {
    if (fs.existsSync(AGENT_SCRIPT_PATH)) {
      sendText(res, 200, fs.readFileSync(AGENT_SCRIPT_PATH, 'utf8'), 'application/javascript; charset=utf-8');
    } else {
      sendText(res, 404, '// agent script not found');
    }
    return;
  }

  // ================== 1. 被控端流量与配置上报接口 (/flow/*) ==================
  if (pathname === '/flow/test') {
    sendText(res, 200, 'test');
    return;
  }

  if (pathname === '/flow/upload') {
    const secret = query.secret || '';
    const node = db.nodes.find(n => n.secret === secret);
    if (!node) {
      sendText(res, 200, 'ok');
      return;
    }
    try {
      const rawBody = await readRequestBody(req);
      const decrypted = unwrapEncryptedMessage(rawBody, secret);
      const flowData = JSON.parse(decrypted);
      if (flowData && flowData.n && flowData.n !== 'web_api') {
        const parts = String(flowData.n).split('_');
        const forwardId = Number(parts[0]);
        const fwd = db.forwards.find(f => Number(f.id) === forwardId);
        if (fwd) {
          const tunnel = db.tunnels.find(t => Number(t.id) === Number(fwd.tunnelId));
          const ratio = tunnel ? (Number(tunnel.trafficRatio) || 1.0) : 1.0;
          const flowMode = tunnel ? (Number(tunnel.flow) || 1) : 1; // 1=单向计算, 2=双向计算
          const rawD = Math.max(0, Number(flowData.d) || 0);
          const rawU = Math.max(0, Number(flowData.u) || 0);

          // 乘以流量倍率统计
          const addIn = Math.round(rawD * ratio * (flowMode === 2 ? 1 : 1));
          const addOut = Math.round(rawU * ratio * (flowMode === 2 ? 1 : 1));

          fwd.inFlow = (Number(fwd.inFlow) || 0) + addIn;
          fwd.outFlow = (Number(fwd.outFlow) || 0) + addOut;
          fwd.updatedTime = Date.now();

          db.admin.inFlow = (Number(db.admin.inFlow) || 0) + addIn;
          db.admin.outFlow = (Number(db.admin.outFlow) || 0) + addOut;
          markDirty();
        }
      }
    } catch (e) {
      // 忽略异常报文，保证返回 ok
    }
    sendText(res, 200, 'ok');
    return;
  }

  if (pathname === '/flow/config') {
    const secret = query.secret || '';
    const node = db.nodes.find(n => n.secret === secret);
    if (!node) {
      sendText(res, 200, 'ok');
      return;
    }
    try {
      const rawBody = await readRequestBody(req);
      const decrypted = unwrapEncryptedMessage(rawBody, secret);
      const gostConfig = JSON.parse(decrypted);
      if (gostConfig && typeof gostConfig === 'object') {
        adoptNodeReportedConfig(node, gostConfig);
      }
    } catch (e) {}
    sendText(res, 200, 'ok');
    return;
  }

  // ================== 2. 管理面板 API 接口 (/api/v1/*) ==================
  if (pathname.startsWith('/api/v1/')) {
    const subPath = pathname.slice('/api/v1'.length);
    let bodyObj = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const raw = await readRequestBody(req);
        if (raw && raw.trim()) bodyObj = JSON.parse(raw);
      } catch (e) {
        sendJson(res, 400, R.err('请求 JSON 格式错误'));
        return;
      }
    }

    // 免登录公开接口
    if (subPath === '/captcha/check') {
      sendJson(res, 200, R.okData(0)); // 默认关闭繁琐滑块验证码，极速登录
      return;
    }

    if (subPath === '/config/list') {
      sendJson(res, 200, R.okData(db.configs));
      return;
    }

    if (subPath === '/config/get') {
      const key = bodyObj.name || '';
      sendJson(res, 200, R.okData(db.configs[key] ?? ''));
      return;
    }

    if (subPath === '/user/login') {
      const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
      const rateCheck = checkLoginRateLimit(clientIp);
      if (!rateCheck.allowed) {
        sendJson(res, 429, R.err(`登录失败次数过多，请 ${Math.ceil(rateCheck.retryAfterSec / 60)} 分钟后再试`, 429));
        return;
      }
      const username = String(bodyObj.username || '').trim();
      const password = String(bodyObj.password || '').trim();
      if (username === db.admin.user && verifyPassword(password, db.admin.pwd)) {
        clearLoginFailures(clientIp);
        if (!String(db.admin.pwd).startsWith('pbkdf2$')) {
          db.admin.pwd = hashPassword(password);
          markDirty();
        }
        const token = signJwt({ sub: db.admin.id, role_id: 0, user: db.admin.user });
        const requirePasswordChange = (db.admin.user === 'admin_user' && password === 'admin_user');
        sendJson(res, 200, R.okData({
          token,
          role_id: 0,
          name: db.admin.user,
          requirePasswordChange
        }));
      } else {
        recordLoginFailure(clientIp);
        sendJson(res, 200, R.err('用户名或密码错误'));
      }
      return;
    }

    // 鉴权检查（支持 JWT Authorization 或 本地 CLI 管理密钥 X-Nexus-Local）
    const remoteIp = req.socket.remoteAddress || '';
    const isLocalCli = (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') && req.headers['x-nexus-local'] === '1';
    const authPayload = isLocalCli ? { sub: 1, role_id: 0, user: db.admin.user } : verifyJwt(req.headers.authorization);

    if (!authPayload) {
      sendJson(res, 401, R.err('未登录或登录已过期，请重新登录', 401));
      return;
    }

    // ---- 仪表板与管理员资料 ----
    if (subPath === '/user/package') {
      const mem = process.memoryUsage();
      const forwardsWithTunnel = db.forwards.map(f => {
        const t = db.tunnels.find(tu => Number(tu.id) === Number(f.tunnelId));
        return Object.assign({}, f, {
          tunnelName: t ? t.name : '未知隧道',
          inIp: t ? t.inIp : '',
          outIp: t ? t.outIp : '',
          type: t ? t.type : 1,
          protocol: t ? t.protocol : 'tls'
        });
      });

      // 计算总实时速率
      let totalUpSpeed = 0;
      let totalDownSpeed = 0;
      for (const [, tele] of nodeTelemetryCache.entries()) {
        totalUpSpeed += tele.uploadSpeed || 0;
        totalDownSpeed += tele.downloadSpeed || 0;
      }

      sendJson(res, 200, R.okData({
        userInfo: {
          id: 1,
          user: db.admin.user,
          flow: 999999,
          inFlow: db.admin.inFlow || 0,
          outFlow: db.admin.outFlow || 0,
          num: 999999
        },
        nodeSummary: {
          total: db.nodes.length,
          online: nodeSessions.size,
          offline: Math.max(0, db.nodes.length - nodeSessions.size),
          totalUpSpeed,
          totalDownSpeed
        },
        tunnelSummary: {
          total: db.tunnels.length,
          portForwards: db.tunnels.filter(t => Number(t.type) === 1).length,
          tunnelForwards: db.tunnels.filter(t => Number(t.type) === 2).length
        },
        systemMemory: {
          rssMB: Number((mem.rss / 1048576).toFixed(1)),
          heapMB: Number((mem.heapUsed / 1048576).toFixed(1)),
          hostFreeMB: Math.round(os.freemem() / 1048576),
          hostTotalMB: Math.round(os.totalmem() / 1048576)
        },
        tunnelPermissions: [],
        forwards: forwardsWithTunnel,
        statisticsFlows: db.statisticsFlows.slice(-24)
      }));
      return;
    }

    if (subPath === '/user/updatePassword') {
      const { currentPassword, newUsername, newPassword } = bodyObj;
      if (!verifyPassword(currentPassword || '', db.admin.pwd)) {
        sendJson(res, 200, R.err('当前密码不正确'));
        return;
      }
      if (!newPassword || String(newPassword).length < 5) {
        sendJson(res, 200, R.err('新密码长度不能少于 5 位'));
        return;
      }
      if (newUsername && String(newUsername).trim()) {
        db.admin.user = String(newUsername).trim();
      }
      db.admin.pwd = hashPassword(newPassword);
      db.admin.updatedTime = Date.now();
      saveDbSync();
      sendJson(res, 200, R.ok('账号密码修改成功'));
      return;
    }

    if (subPath === '/user/reset') {
      db.admin.inFlow = 0;
      db.admin.outFlow = 0;
      db.forwards.forEach(f => {
        f.inFlow = 0;
        f.outFlow = 0;
      });
      markDirty();
      sendJson(res, 200, R.ok('流量统计已清零'));
      return;
    }

    // ---- 节点管理 (/node/*) ----
    if (subPath === '/node/list') {
      const list = db.nodes.map(n => {
        const tele = nodeTelemetryCache.get(Number(n.id)) || null;
        return Object.assign({}, n, {
          secret: undefined,
          status: nodeSessions.has(Number(n.id)) ? 1 : 0,
          systemInfo: tele
        });
      });
      sendJson(res, 200, R.okData(list));
      return;
    }

    if (subPath === '/node/create') {
      const name = String(bodyObj.name || '').trim();
      const serverIp = String(bodyObj.serverIp || '').trim();
      const ip = String(bodyObj.ip || serverIp).trim();
      const portSta = Number(bodyObj.portSta) || 1000;
      const portEnd = Number(bodyObj.portEnd) || 65535;
      if (!name || !serverIp) {
        sendJson(res, 200, R.err('节点名称和服务器IP不能为空'));
        return;
      }
      if (portSta < 1 || portEnd > 65535 || portEnd < portSta) {
        sendJson(res, 200, R.err('端口范围必须在 1-65535 之间且结束端口不小于起始端口'));
        return;
      }
      const newNode = {
        id: db.meta.nextIds.node++,
        name,
        secret: simpleUUID(),
        ip,
        serverIp,
        portSta,
        portEnd,
        version: '-',
        http: Number(bodyObj.http) || 0,
        tls: Number(bodyObj.tls) || 0,
        socks: Number(bodyObj.socks) || 0,
        createdTime: Date.now(),
        updatedTime: Date.now(),
        status: 0
      };
      db.nodes.push(newNode);
      saveDbSync();
      sendJson(res, 200, R.okData(newNode, '节点创建成功'));
      return;
    }

    if (subPath === '/node/update') {
      const id = Number(bodyObj.id);
      const node = db.nodes.find(n => Number(n.id) === id);
      if (!node) {
        sendJson(res, 200, R.err('节点不存在'));
        return;
      }
      const portSta = Number(bodyObj.portSta) || 1000;
      const portEnd = Number(bodyObj.portEnd) || 65535;
      if (portSta < 1 || portEnd > 65535 || portEnd < portSta) {
        sendJson(res, 200, R.err('端口范围无效'));
        return;
      }

      const newHttp = bodyObj.http !== undefined ? Number(bodyObj.http) : node.http;
      const newTls = bodyObj.tls !== undefined ? Number(bodyObj.tls) : node.tls;
      const newSocks = bodyObj.socks !== undefined ? Number(bodyObj.socks) : node.socks;
      const protoChanged = newHttp !== node.http || newTls !== node.tls || newSocks !== node.socks;

      if (protoChanged && nodeSessions.has(id)) {
        const protoRes = await sendNodeCommand(id, 'SetProtocol', {
          http: newHttp,
          tls: newTls,
          socks: newSocks
        });
        if (!protoRes.success && !protoRes.offline) {
          sendJson(res, 200, R.err('同步节点协议屏蔽失败: ' + protoRes.msg));
          return;
        }
      }

      node.name = String(bodyObj.name || node.name).trim();
      node.serverIp = String(bodyObj.serverIp || node.serverIp).trim();
      node.ip = String(bodyObj.ip || node.serverIp).trim();
      node.portSta = portSta;
      node.portEnd = portEnd;
      node.http = newHttp;
      node.tls = newTls;
      node.socks = newSocks;
      node.updatedTime = Date.now();

      // 联动更新关联隧道的入口 IP 和出口 IP
      db.tunnels.forEach(t => {
        if (Number(t.inNodeId) === id) t.inIp = node.ip;
        if (Number(t.outNodeId) === id) t.outIp = node.serverIp;
      });

      saveDbSync();
      sendJson(res, 200, R.ok('节点更新成功'));
      return;
    }

    if (subPath === '/node/delete') {
      const id = Number(bodyObj.id);
      const inUseIn = db.tunnels.filter(t => Number(t.inNodeId) === id).length;
      if (inUseIn > 0) {
        sendJson(res, 200, R.err(`该节点还有 ${inUseIn} 个隧道作为入口节点在使用，请先删除相关隧道`));
        return;
      }
      const inUseOut = db.tunnels.filter(t => Number(t.type) === 2 && Number(t.outNodeId) === id).length;
      if (inUseOut > 0) {
        sendJson(res, 200, R.err(`该节点还有 ${inUseOut} 个隧道作为出口节点在使用，请先删除相关隧道`));
        return;
      }
      const ws = nodeSessions.get(id);
      if (ws) ws.close();
      nodeSessions.delete(id);
      nodeTelemetryCache.delete(id);
      db.nodes = db.nodes.filter(n => Number(n.id) !== id);
      saveDbSync();
      sendJson(res, 200, R.ok('节点删除成功'));
      return;
    }

    if (subPath === '/node/install') {
      const id = Number(bodyObj.id);
      const node = db.nodes.find(n => Number(n.id) === id);
      if (!node) {
        sendJson(res, 200, R.err('节点不存在'));
        return;
      }
      const rawHost = (db.configs.ip || req.headers.host || '127.0.0.1:6366').trim();
      const cleanAddr = rawHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      const installCmd = `curl -fsSL http://${cleanAddr}/node-install.sh -o ./node-install.sh && chmod +x ./node-install.sh && ./node-install.sh -a ${cleanAddr} -s ${node.secret}`;
      sendJson(res, 200, R.okData({
        defaultCommand: installCmd,
        lightCommand: installCmd,
        secret: node.secret,
        serverAddr: cleanAddr
      }));
      return;
    }

    if (subPath === '/node/sync-all') {
      const onlineIds = Array.from(nodeSessions.keys());
      let syncedNodes = 0;
      for (const nId of onlineIds) {
        try {
          await syncNodeDesiredState(nId);
          syncedNodes++;
        } catch (e) {}
      }
      sendJson(res, 200, R.okData({
        onlineNodes: onlineIds.length,
        syncedNodes,
        totalTunnels: db.tunnels.length,
        totalForwards: db.forwards.length,
        version: PANEL_VERSION
      }, `已向 ${syncedNodes} 台在线节点全量重新下发并校准 ${db.forwards.length} 条转发规则`));
      return;
    }

    if (subPath === '/node/upgrade-all') {
      if (!fs.existsSync(AGENT_SCRIPT_PATH)) {
        sendJson(res, 200, R.err('主控未找到内置被控脚本文件'));
        return;
      }
      const agentCode = fs.readFileSync(AGENT_SCRIPT_PATH, 'utf8');
      const targetNodeId = bodyObj && bodyObj.nodeId ? Number(bodyObj.nodeId) : null;
      const noRestart = Boolean(bodyObj && bodyObj.noRestart);
      const onlineIds = targetNodeId ? (nodeSessions.has(targetNodeId) ? [targetNodeId] : []) : Array.from(nodeSessions.keys());

      let upgradedCount = 0;
      let syncedCount = 0;
      for (const nId of onlineIds) {
        try {
          const upRes = await sendNodeCommand(nId, 'UpgradeAgent', {
            code: agentCode,
            version: VERSION,
            noRestart
          }, 6000);
          if (upRes && upRes.success) {
            upgradedCount++;
            const nodeObj = db.nodes.find(n => Number(n.id) === Number(nId));
            if (nodeObj) nodeObj.version = VERSION;
          }
          await syncNodeDesiredState(nId);
          syncedCount++;
        } catch (e) {}
      }
      saveDbSync();
      sendJson(res, 200, R.okData({
        onlineNodes: onlineIds.length,
        upgradedCount,
        syncedCount,
        version: VERSION
      }, `已完成 ${upgradedCount}/${onlineIds.length} 台在线节点被控热升级 (v${VERSION}) 并全量重下发规则`));
      return;
    }

    // ---- 隧道管理 (/tunnel/*) ----
    if (subPath === '/tunnel/list' || subPath === '/speed-limit/tunnels') {
      sendJson(res, 200, R.okData(db.tunnels));
      return;
    }

    if (subPath === '/tunnel/user/tunnel') {
      const activeTunnels = db.tunnels.filter(t => Number(t.status) === 1).map(t => {
        const inNode = db.nodes.find(n => Number(n.id) === Number(t.inNodeId));
        return {
          id: t.id,
          name: t.name,
          ip: t.inIp,
          type: t.type,
          protocol: t.protocol,
          inNodePortSta: inNode ? inNode.portSta : 1000,
          inNodePortEnd: inNode ? inNode.portEnd : 65535
        };
      });
      sendJson(res, 200, R.okData(activeTunnels));
      return;
    }

    if (subPath === '/tunnel/create') {
      const name = String(bodyObj.name || '').trim();
      if (!name) {
        sendJson(res, 200, R.err('隧道名称不能为空'));
        return;
      }
      if (db.tunnels.some(t => t.name === name)) {
        sendJson(res, 200, R.err('隧道名称已存在'));
        return;
      }
      const type = Number(bodyObj.type) || 1;
      const inNode = db.nodes.find(n => Number(n.id) === Number(bodyObj.inNodeId));
      if (!inNode) {
        sendJson(res, 200, R.err('入口节点不存在'));
        return;
      }

      let outNode = inNode;
      if (type === 2) {
        if (!bodyObj.outNodeId) {
          sendJson(res, 200, R.err('隧道转发模式下必须选择出口节点'));
          return;
        }
        if (Number(bodyObj.inNodeId) === Number(bodyObj.outNodeId)) {
          sendJson(res, 200, R.err('隧道转发模式下，入口和出口不能是同一个节点'));
          return;
        }
        outNode = db.nodes.find(n => Number(n.id) === Number(bodyObj.outNodeId));
        if (!outNode) {
          sendJson(res, 200, R.err('出口节点不存在'));
          return;
        }
      }

      const newTunnel = {
        id: db.meta.nextIds.tunnel++,
        name,
        type,
        inNodeId: inNode.id,
        inIp: inNode.ip,
        outNodeId: outNode.id,
        outIp: outNode.serverIp,
        protocol: type === 2 ? (bodyObj.protocol || 'tls') : null,
        tcpListenAddr: String(bodyObj.tcpListenAddr || '[::]').trim(),
        udpListenAddr: String(bodyObj.udpListenAddr || '[::]').trim(),
        interfaceName: bodyObj.interfaceName ? String(bodyObj.interfaceName).trim() : '',
        flow: Number(bodyObj.flow) || 1,
        trafficRatio: Number(bodyObj.trafficRatio) || 1.0,
        status: 1,
        createdTime: Date.now(),
        updatedTime: Date.now()
      };

      db.tunnels.push(newTunnel);
      saveDbSync();
      sendJson(res, 200, R.okData(newTunnel, '隧道创建成功'));
      return;
    }

    if (subPath === '/tunnel/update') {
      const id = Number(bodyObj.id);
      const tunnel = db.tunnels.find(t => Number(t.id) === id);
      if (!tunnel) {
        sendJson(res, 200, R.err('隧道不存在'));
        return;
      }
      const name = String(bodyObj.name || tunnel.name).trim();
      if (db.tunnels.some(t => t.name === name && Number(t.id) !== id)) {
        sendJson(res, 200, R.err('隧道名称已存在'));
        return;
      }

      const needSyncForwards = (
        tunnel.tcpListenAddr !== bodyObj.tcpListenAddr ||
        tunnel.udpListenAddr !== bodyObj.udpListenAddr ||
        tunnel.protocol !== bodyObj.protocol ||
        tunnel.interfaceName !== bodyObj.interfaceName
      );

      tunnel.name = name;
      if (bodyObj.flow !== undefined) tunnel.flow = Number(bodyObj.flow);
      if (bodyObj.trafficRatio !== undefined) tunnel.trafficRatio = Number(bodyObj.trafficRatio);
      if (bodyObj.tcpListenAddr !== undefined) tunnel.tcpListenAddr = String(bodyObj.tcpListenAddr).trim();
      if (bodyObj.udpListenAddr !== undefined) tunnel.udpListenAddr = String(bodyObj.udpListenAddr).trim();
      if (bodyObj.protocol !== undefined) tunnel.protocol = bodyObj.protocol;
      if (bodyObj.interfaceName !== undefined) tunnel.interfaceName = String(bodyObj.interfaceName || '').trim();
      if (bodyObj.status !== undefined) tunnel.status = Number(bodyObj.status);
      tunnel.updatedTime = Date.now();
      saveDbSync();

      if (needSyncForwards) {
        const relatedForwards = db.forwards.filter(f => Number(f.tunnelId) === id && Number(f.status) === 1);
        for (const fwd of relatedForwards) {
          await deployForwardToNodes(fwd, tunnel);
        }
      }
      sendJson(res, 200, R.ok('隧道更新成功'));
      return;
    }

    if (subPath === '/tunnel/delete') {
      const id = Number(bodyObj.id);
      const usedCount = db.forwards.filter(f => Number(f.tunnelId) === id).length;
      if (usedCount > 0) {
        sendJson(res, 200, R.err(`该隧道还有 ${usedCount} 个转发规则在使用，请先删除相关转发`));
        return;
      }
      db.tunnels = db.tunnels.filter(t => Number(t.id) !== id);
      saveDbSync();
      sendJson(res, 200, R.ok('隧道删除成功'));
      return;
    }

    if (subPath === '/tunnel/diagnose') {
      const tunnelId = Number(bodyObj.tunnelId);
      const tunnel = db.tunnels.find(t => Number(t.id) === tunnelId);
      if (!tunnel) {
        sendJson(res, 200, R.err('隧道不存在'));
        return;
      }
      const inNode = db.nodes.find(n => Number(n.id) === Number(tunnel.inNodeId));
      if (!inNode) {
        sendJson(res, 200, R.err('入口节点不存在'));
        return;
      }
      const results = [];
      if (Number(tunnel.type) === 1) {
        const r1 = await performNodeTcpPing(inNode, 'www.cloudflare.com', 443, '入口->外网');
        results.push(r1);
      } else {
        const outNode = db.nodes.find(n => Number(n.id) === Number(tunnel.outNodeId));
        const activeFwd = db.forwards.find(f => Number(f.tunnelId) === tunnelId && Number(f.status) === 1);
        const testOutPort = activeFwd && activeFwd.outPort ? activeFwd.outPort : 22;
        if (outNode) {
          const r1 = await performNodeTcpPing(inNode, outNode.serverIp, testOutPort, '入口->出口');
          results.push(r1);
          const r2 = await performNodeTcpPing(outNode, 'www.cloudflare.com', 443, '出口->外网');
          results.push(r2);
        }
      }
      sendJson(res, 200, R.okData({
        tunnelId: tunnel.id,
        tunnelName: tunnel.name,
        tunnelType: Number(tunnel.type) === 1 ? '端口转发' : '隧道转发',
        results,
        timestamp: Date.now()
      }));
      return;
    }

    // ---- 转发管理 (/forward/*) ----
    if (subPath === '/forward/list') {
      const list = db.forwards
        .slice()
        .sort((a, b) => (Number(a.inx) || 0) - (Number(b.inx) || 0) || (b.createdTime - a.createdTime))
        .map(f => {
          const t = db.tunnels.find(tu => Number(tu.id) === Number(f.tunnelId));
          const lim = f.speedId ? db.speedLimits.find(s => Number(s.id) === Number(f.speedId)) : null;
          return Object.assign({}, f, {
            tunnelName: t ? t.name : '未知隧道',
            inIp: t ? t.inIp : '',
            outIp: t ? t.outIp : '',
            type: t ? t.type : 1,
            protocol: t ? t.protocol : 'tls',
            speedName: lim ? `${lim.name} (${lim.speed} Mbps)` : ''
          });
        });
      sendJson(res, 200, R.okData(list));
      return;
    }

    if (subPath === '/forward/create') {
      const name = String(bodyObj.name || '').trim();
      const tunnelId = Number(bodyObj.tunnelId);
      const remoteAddr = String(bodyObj.remoteAddr || '').trim();
      if (!name || !tunnelId || !remoteAddr) {
        sendJson(res, 200, R.err('转发名称、所属隧道和目标地址不能为空'));
        return;
      }
      const tunnel = db.tunnels.find(t => Number(t.id) === tunnelId);
      if (!tunnel) {
        sendJson(res, 200, R.err('所选隧道不存在'));
        return;
      }

      const inAlloc = allocatePortForNode(tunnel.inNodeId, bodyObj.inPort, null);
      if (inAlloc.error) {
        sendJson(res, 200, R.err(inAlloc.error));
        return;
      }

      let outPort = null;
      if (Number(tunnel.type) === 2) {
        const outAlloc = allocatePortForNode(tunnel.outNodeId, null, null);
        if (outAlloc.error) {
          sendJson(res, 200, R.err('出口节点端口分配失败: ' + outAlloc.error));
          return;
        }
        outPort = outAlloc.port;
      }

      const newForward = {
        id: db.meta.nextIds.forward++,
        userId: 1,
        userName: db.admin.user,
        name,
        tunnelId,
        inPort: inAlloc.port,
        outPort,
        remoteAddr: remoteAddr.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).join(','),
        strategy: bodyObj.strategy || 'fifo',
        interfaceName: bodyObj.interfaceName ? String(bodyObj.interfaceName).trim() : '',
        speedId: bodyObj.speedId ? Number(bodyObj.speedId) : null,
        inFlow: 0,
        outFlow: 0,
        createdTime: Date.now(),
        updatedTime: Date.now(),
        status: 1,
        inx: db.forwards.length
      };

      db.forwards.push(newForward);
      saveDbSync();

      const gostRes = await deployForwardToNodes(newForward, tunnel);
      if (!gostRes.offline && !gostRes.success) {
        sendJson(res, 200, R.okData(newForward, `转发规则已保存，但节点下发返回提示: ${gostRes.msg}`));
        return;
      }
      sendJson(res, 200, R.okData(newForward, '端口转发创建成功'));
      return;
    }

    if (subPath === '/forward/update') {
      const id = Number(bodyObj.id);
      const fwd = db.forwards.find(f => Number(f.id) === id);
      if (!fwd) {
        sendJson(res, 200, R.err('转发规则不存在'));
        return;
      }
      const newTunnelId = Number(bodyObj.tunnelId || fwd.tunnelId);
      const newTunnel = db.tunnels.find(t => Number(t.id) === newTunnelId);
      if (!newTunnel) {
        sendJson(res, 200, R.err('目标隧道不存在'));
        return;
      }
      const oldTunnel = db.tunnels.find(t => Number(t.id) === Number(fwd.tunnelId));
      const tunnelChanged = Number(fwd.tunnelId) !== newTunnelId;
      const inPortChanged = bodyObj.inPort != null && Number(bodyObj.inPort) !== Number(fwd.inPort);

      let nextInPort = fwd.inPort;
      let nextOutPort = fwd.outPort;

      if (tunnelChanged || inPortChanged) {
        const inAlloc = allocatePortForNode(newTunnel.inNodeId, bodyObj.inPort || (tunnelChanged ? null : fwd.inPort), fwd.id);
        if (inAlloc.error) {
          sendJson(res, 200, R.err(inAlloc.error));
          return;
        }
        nextInPort = inAlloc.port;
        if (Number(newTunnel.type) === 2) {
          if (tunnelChanged || !nextOutPort) {
            const outAlloc = allocatePortForNode(newTunnel.outNodeId, null, fwd.id);
            if (outAlloc.error) {
              sendJson(res, 200, R.err(outAlloc.error));
              return;
            }
            nextOutPort = outAlloc.port;
          }
        } else {
          nextOutPort = null;
        }
      }

      if (tunnelChanged && oldTunnel) {
        await removeForwardFromNodes(fwd, oldTunnel);
      }

      fwd.name = String(bodyObj.name || fwd.name).trim();
      fwd.tunnelId = newTunnelId;
      fwd.inPort = nextInPort;
      fwd.outPort = nextOutPort;
      if (bodyObj.remoteAddr) {
        fwd.remoteAddr = String(bodyObj.remoteAddr).split(/[\n,]+/).map(s => s.trim()).filter(Boolean).join(',');
      }
      if (bodyObj.strategy !== undefined) fwd.strategy = bodyObj.strategy || 'fifo';
      if (bodyObj.interfaceName !== undefined) fwd.interfaceName = String(bodyObj.interfaceName || '').trim();
      if (bodyObj.speedId !== undefined) fwd.speedId = bodyObj.speedId ? Number(bodyObj.speedId) : null;
      fwd.status = 1;
      fwd.updatedTime = Date.now();
      saveDbSync();

      await deployForwardToNodes(fwd, newTunnel);
      sendJson(res, 200, R.ok('端口转发更新成功'));
      return;
    }

    if (subPath === '/forward/delete' || subPath === '/forward/force-delete') {
      const id = Number(bodyObj.id);
      const fwd = db.forwards.find(f => Number(f.id) === id);
      if (!fwd) {
        sendJson(res, 200, R.err('端口转发不存在'));
        return;
      }
      const tunnel = db.tunnels.find(t => Number(t.id) === Number(fwd.tunnelId));
      if (subPath === '/forward/delete' && tunnel) {
        await removeForwardFromNodes(fwd, tunnel);
      } else if (tunnel) {
        removeForwardFromNodes(fwd, tunnel).catch(() => {});
      }
      db.forwards = db.forwards.filter(f => Number(f.id) !== id);
      saveDbSync();
      sendJson(res, 200, R.ok('端口转发删除成功'));
      return;
    }

    if (subPath === '/forward/pause' || subPath === '/forward/resume') {
      const id = Number(bodyObj.id);
      const fwd = db.forwards.find(f => Number(f.id) === id);
      if (!fwd) {
        sendJson(res, 200, R.err('转发不存在'));
        return;
      }
      const tunnel = db.tunnels.find(t => Number(t.id) === Number(fwd.tunnelId));
      if (!tunnel) {
        sendJson(res, 200, R.err('关联隧道不存在'));
        return;
      }
      const isPause = subPath === '/forward/pause';
      const cmd = isPause ? 'PauseService' : 'ResumeService';
      const serviceName = GostBuilder.buildServiceName(fwd.id, 1, 0);

      await sendNodeCommand(tunnel.inNodeId, cmd, { services: [`${serviceName}_tcp`, `${serviceName}_udp`] });
      if (Number(tunnel.type) === 2 && tunnel.outNodeId) {
        await sendNodeCommand(tunnel.outNodeId, cmd, { services: [`${serviceName}_tls`] });
      }
      fwd.status = isPause ? 0 : 1;
      fwd.updatedTime = Date.now();
      saveDbSync();
      sendJson(res, 200, R.ok(isPause ? '转发服务已暂停' : '转发服务已恢复'));
      return;
    }

    if (subPath === '/forward/reset-flow') {
      const id = Number(bodyObj.id);
      const fwd = db.forwards.find(f => Number(f.id) === id);
      if (!fwd) {
        sendJson(res, 200, R.err('转发不存在'));
        return;
      }
      fwd.inFlow = 0;
      fwd.outFlow = 0;
      fwd.updatedTime = Date.now();
      saveDbSync();
      sendJson(res, 200, R.ok('该条转发流量已清零'));
      return;
    }

    if (subPath === '/forward/update-order') {
      if (Array.isArray(bodyObj.forwards)) {
        for (const item of bodyObj.forwards) {
          const f = db.forwards.find(x => Number(x.id) === Number(item.id));
          if (f) f.inx = Number(item.inx) || 0;
        }
        saveDbSync();
      }
      sendJson(res, 200, R.ok('排序更新成功'));
      return;
    }

    if (subPath === '/forward/diagnose') {
      const forwardId = Number(bodyObj.forwardId);
      const fwd = db.forwards.find(f => Number(f.id) === forwardId);
      if (!fwd) {
        sendJson(res, 200, R.err('转发不存在'));
        return;
      }
      const tunnel = db.tunnels.find(t => Number(t.id) === Number(fwd.tunnelId));
      if (!tunnel) {
        sendJson(res, 200, R.err('隧道不存在'));
        return;
      }
      const inNode = db.nodes.find(n => Number(n.id) === Number(tunnel.inNodeId));
      if (!inNode) {
        sendJson(res, 200, R.err('入口节点不存在'));
        return;
      }

      const results = [];
      const targets = String(fwd.remoteAddr || '').split(',').map(s => s.trim()).filter(Boolean);

      if (Number(tunnel.type) === 1) {
        for (let idx = 0; idx < targets.length; idx++) {
          const parsed = splitHostPort(targets[idx]);
          if (parsed) {
            const r = await performNodeTcpPing(inNode, parsed.host, parsed.port, targets.length > 1 ? `转发->目标(${idx + 1})` : '转发->目标');
            results.push(r);
          }
        }
      } else {
        const outNode = db.nodes.find(n => Number(n.id) === Number(tunnel.outNodeId));
        if (outNode) {
          const rInOut = await performNodeTcpPing(inNode, outNode.serverIp, fwd.outPort || 22, '入口->出口');
          results.push(rInOut);
          for (let idx = 0; idx < targets.length; idx++) {
            const parsed = splitHostPort(targets[idx]);
            if (parsed) {
              const rOutTarget = await performNodeTcpPing(outNode, parsed.host, parsed.port, targets.length > 1 ? `出口->目标(${idx + 1})` : '出口->目标');
              results.push(rOutTarget);
            }
          }
        }
      }

      sendJson(res, 200, R.okData({
        forwardId: fwd.id,
        forwardName: fwd.name,
        tunnelName: tunnel.name,
        remoteAddr: fwd.remoteAddr,
        tunnelType: Number(tunnel.type) === 1 ? '端口转发' : '隧道转发',
        results,
        timestamp: Date.now()
      }));
      return;
    }

    // ---- 限速规则管理 (/speed-limit/*) ----
    if (subPath === '/speed-limit/list') {
      sendJson(res, 200, R.okData(db.speedLimits));
      return;
    }

    if (subPath === '/speed-limit/create') {
      const name = String(bodyObj.name || '').trim();
      const speed = Number(bodyObj.speed) || 100;
      const tunnelId = Number(bodyObj.tunnelId);
      const tunnel = db.tunnels.find(t => Number(t.id) === tunnelId);
      if (!name || !tunnel) {
        sendJson(res, 200, R.err('规则名称和绑定隧道不能为空'));
        return;
      }
      const newRule = {
        id: db.meta.nextIds.speedLimit++,
        name,
        speed,
        tunnelId: tunnel.id,
        tunnelName: tunnel.name,
        createdTime: Date.now(),
        updatedTime: Date.now(),
        status: 1
      };
      db.speedLimits.push(newRule);
      saveDbSync();

      const speedMB = GostBuilder.convertBitsToMBps(newRule.speed);
      await sendNodeCommand(tunnel.inNodeId, 'AddLimiters', GostBuilder.createLimiterData(newRule.id, speedMB));
      sendJson(res, 200, R.okData(newRule, '限速规则创建成功'));
      return;
    }

    if (subPath === '/speed-limit/update') {
      const id = Number(bodyObj.id);
      const rule = db.speedLimits.find(s => Number(s.id) === id);
      if (!rule) {
        sendJson(res, 200, R.err('限速规则不存在'));
        return;
      }
      const tunnel = db.tunnels.find(t => Number(t.id) === Number(bodyObj.tunnelId || rule.tunnelId));
      if (!tunnel) {
        sendJson(res, 200, R.err('绑定隧道不存在'));
        return;
      }
      rule.name = String(bodyObj.name || rule.name).trim();
      rule.speed = Number(bodyObj.speed) || rule.speed;
      rule.tunnelId = tunnel.id;
      rule.tunnelName = tunnel.name;
      rule.updatedTime = Date.now();
      saveDbSync();

      const speedMB = GostBuilder.convertBitsToMBps(rule.speed);
      const limData = GostBuilder.createLimiterData(rule.id, speedMB);
      const resLim = await sendNodeCommand(tunnel.inNodeId, 'UpdateLimiters', { limiter: String(rule.id), data: limData });
      if (!resLim.offline && !resLim.success && String(resLim.msg).includes('not found')) {
        await sendNodeCommand(tunnel.inNodeId, 'AddLimiters', limData);
      }
      sendJson(res, 200, R.ok('限速规则更新成功'));
      return;
    }

    if (subPath === '/speed-limit/delete') {
      const id = Number(bodyObj.id);
      const rule = db.speedLimits.find(s => Number(s.id) === id);
      if (!rule) {
        sendJson(res, 200, R.err('限速规则不存在'));
        return;
      }
      const tunnel = db.tunnels.find(t => Number(t.id) === Number(rule.tunnelId));
      if (tunnel) {
        await sendNodeCommand(tunnel.inNodeId, 'DeleteLimiters', { limiter: String(rule.id) });
      }
      db.forwards.forEach(f => {
        if (Number(f.speedId) === id) f.speedId = null;
      });
      db.speedLimits = db.speedLimits.filter(s => Number(s.id) !== id);
      saveDbSync();
      sendJson(res, 200, R.ok('限速规则删除成功'));
      return;
    }

    // ---- 网站配置管理 (/config/*) ----
    if (subPath === '/config/update') {
      if (bodyObj && typeof bodyObj === 'object') {
        Object.keys(bodyObj).forEach(k => {
          db.configs[k] = String(bodyObj[k] ?? '');
        });
        saveDbSync();
      }
      sendJson(res, 200, R.ok('配置更新成功'));
      return;
    }

    if (subPath === '/config/update-single') {
      if (bodyObj && bodyObj.name) {
        db.configs[String(bodyObj.name)] = String(bodyObj.value ?? '');
        saveDbSync();
      }
      sendJson(res, 200, R.ok('配置更新成功'));
      return;
    }

    // ---- 备份导出与导入恢复 (/backup/*) ----
    if (subPath === '/backup/export') {
      saveDbSync();
      const backupPayload = {
        backupType: 'Nexus-Flux-Full-Backup',
        exportedAt: new Date().toISOString(),
        version: PANEL_VERSION,
        db
      };
      sendJson(res, 200, R.okData(backupPayload, '备份导出成功'));
      return;
    }

    if (subPath === '/backup/import') {
      try {
        // 支持 JSON 备份与 SQL 备份文件
        if (typeof bodyObj.sqlContent === 'string' && bodyObj.sqlContent.trim()) {
          const migrated = parseFluxSqlDump(bodyObj.sqlContent);
          if (migrated.nodes.length === 0 && migrated.tunnels.length === 0 && migrated.forwards.length === 0) {
            sendJson(res, 200, R.err('未在 SQL 文件中识别到有效的 node/tunnel/forward 数据表记录'));
            return;
          }
          db.nodes = migrated.nodes;
          db.tunnels = migrated.tunnels;
          db.forwards = migrated.forwards;
          db.speedLimits = migrated.speedLimits;
          db.meta.nextIds.node = Math.max(0, ...db.nodes.map(x => Number(x.id) || 0)) + 1;
          db.meta.nextIds.tunnel = Math.max(0, ...db.tunnels.map(x => Number(x.id) || 0)) + 1;
          db.meta.nextIds.forward = Math.max(0, ...db.forwards.map(x => Number(x.id) || 0)) + 1;
          db.meta.nextIds.speedLimit = Math.max(0, ...db.speedLimits.map(x => Number(x.id) || 0)) + 1;
          saveDbSync();
          sendJson(res, 200, R.okData({
            nodes: db.nodes.length,
            tunnels: db.tunnels.length,
            forwards: db.forwards.length,
            speedLimits: db.speedLimits.length
          }, 'SQL 备份数据导入恢复成功'));
          return;
        }

        const incomingDb = bodyObj.db || bodyObj;
        if (!incomingDb || !Array.isArray(incomingDb.nodes) || !Array.isArray(incomingDb.tunnels)) {
          sendJson(res, 200, R.err('无效的备份文件结构'));
          return;
        }

        // 先自动保存一份当前快照防误操作
        const autoSnap = path.join(BACKUP_DIR, `auto-before-restore-${Date.now()}.json`);
        fs.writeFileSync(autoSnap, JSON.stringify(db, null, 2), 'utf8');

        db.nodes = incomingDb.nodes.map(n => Object.assign({}, n, { status: nodeSessions.has(Number(n.id)) ? 1 : 0 }));
        db.tunnels = incomingDb.tunnels || [];
        db.forwards = incomingDb.forwards || [];
        db.speedLimits = incomingDb.speedLimits || [];
        if (incomingDb.configs) {
          db.configs = Object.assign(db.configs, incomingDb.configs);
        }
        if (incomingDb.statisticsFlows) {
          db.statisticsFlows = incomingDb.statisticsFlows;
        }
        db.meta.nextIds.node = Math.max(0, ...db.nodes.map(x => Number(x.id) || 0)) + 1;
        db.meta.nextIds.tunnel = Math.max(0, ...db.tunnels.map(x => Number(x.id) || 0)) + 1;
        db.meta.nextIds.forward = Math.max(0, ...db.forwards.map(x => Number(x.id) || 0)) + 1;
        db.meta.nextIds.speedLimit = Math.max(0, ...db.speedLimits.map(x => Number(x.id) || 0)) + 1;
        saveDbSync();

        // 对所有当前在线节点立即同步恢复后的配置
        for (const [onlineNodeId] of nodeSessions.entries()) {
          syncNodeDesiredState(onlineNodeId).catch(() => {});
        }

        sendJson(res, 200, R.okData({
          nodes: db.nodes.length,
          tunnels: db.tunnels.length,
          forwards: db.forwards.length,
          speedLimits: db.speedLimits.length
        }, '全量备份恢复成功'));
      } catch (err) {
        sendJson(res, 200, R.err('恢复备份失败: ' + err.message));
      }
      return;
    }

    sendJson(res, 404, R.err(`未知接口: ${subPath}`, 404));
    return;
  }

  // ================== 3. 静态前端单页应用服务 (内存缓存 + Gzip 极速响应) ==================
  const indexHtmlPath = path.join(PUBLIC_DIR, 'index.html');
  if (!cachedIndexHtml && fs.existsSync(indexHtmlPath)) {
    cachedIndexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    cachedIndexGzip = zlib.gzipSync(Buffer.from(cachedIndexHtml, 'utf8'));
  }
  if (cachedIndexHtml) {
    const acceptEnc = String(req.headers['accept-encoding'] || '');
    if (acceptEnc.includes('gzip') && cachedIndexGzip) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'no-cache'
      });
      res.end(cachedIndexGzip);
    } else {
      sendText(res, 200, cachedIndexHtml, 'text/html; charset=utf-8');
    }
  } else {
    sendText(res, 200, 'Nexus-Flux Master Running', 'text/plain; charset=utf-8');
  }
}

function splitHostPort(addr) {
  if (!addr) return null;
  const s = String(addr).trim();
  if (s.startsWith('[')) {
    const idx = s.indexOf(']');
    if (idx > 1 && s[idx + 1] === ':') {
      return { host: s.slice(1, idx), port: Number(s.slice(idx + 2)) };
    }
  }
  const lastColon = s.lastIndexOf(':');
  if (lastColon > 0) {
    return { host: s.slice(0, lastColon), port: Number(s.slice(lastColon + 1)) };
  }
  return null;
}

async function performNodeTcpPing(node, targetIp, targetPort, description) {
  const baseResult = {
    nodeId: node.id,
    nodeName: node.name,
    targetIp,
    targetPort,
    description,
    timestamp: Date.now(),
    success: false,
    message: '节点未在线',
    averageTime: -1,
    packetLoss: 100
  };

  const res = await sendNodeCommand(node.id, 'TcpPing', {
    ip: targetIp,
    port: Number(targetPort),
    count: 4,
    timeout: 3000
  }, 10000);

  if (res && res.success) {
    const data = res.data || {};
    baseResult.success = data.success !== false;
    baseResult.averageTime = Number(data.averageTime ?? 0);
    baseResult.minTime = Number(data.minTime ?? data.averageTime ?? 0);
    baseResult.maxTime = Number(data.maxTime ?? data.averageTime ?? 0);
    baseResult.jitter = Number(data.jitter ?? 0);
    baseResult.packetLoss = Number(data.packetLoss ?? 0);
    baseResult.message = baseResult.success ? '连接成功' : (data.errorMessage || '连接失败');
  } else {
    baseResult.message = res ? res.msg : '节点无响应';
  }
  return baseResult;
}

// ======================= WebSocket 握手与消息处理 (/system-info) =======================
function handleWsUpgrade(req, socket, head) {
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname !== '/system-info') {
    socket.destroy();
    return;
  }

  const query = parsedUrl.query || {};
  const type = String(query.type || '0');
  const secret = String(query.secret || '');

  let wsMeta = { type };

  if (type === '1') {
    // 节点被控端连接
    const node = db.nodes.find(n => n.secret === secret);
    if (!node) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wsMeta.nodeId = Number(node.id);
    wsMeta.secret = secret;
    wsMeta.version = query.version ? String(query.version) : '1.1.0';
    wsMeta.http = query.http !== undefined ? Number(query.http) : node.http;
    wsMeta.tls = query.tls !== undefined ? Number(query.tls) : node.tls;
    wsMeta.socks = query.socks !== undefined ? Number(query.socks) : node.socks;
  } else {
    // 网页管理员实时监控连接
    const payload = verifyJwt(secret);
    if (!payload) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wsMeta.adminId = payload.sub;
  }

  const wsKey = req.headers['sec-websocket-key'];
  if (!wsKey) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-Websocket-Accept: ${acceptKey}\r\n\r\n`
  );

  const ws = new WsConnection(socket, wsMeta);

  if (type !== '1') {
    adminSessions.add(ws);
    ws.onClose = () => {
      adminSessions.delete(ws);
    };
    return;
  }

  // 处理被控节点上线
  const nodeId = wsMeta.nodeId;
  const existing = nodeSessions.get(nodeId);
  if (existing && existing !== ws) {
    existing.onClose = null;
    existing.close();
  }
  nodeSessions.set(nodeId, ws);

  const node = db.nodes.find(n => Number(n.id) === nodeId);
  if (node) {
    node.status = 1;
    if (wsMeta.version) node.version = wsMeta.version;
    if (!isNaN(wsMeta.http)) node.http = wsMeta.http;
    if (!isNaN(wsMeta.tls)) node.tls = wsMeta.tls;
    if (!isNaN(wsMeta.socks)) node.socks = wsMeta.socks;
    node.updatedTime = Date.now();
    markDirty();
  }

  broadcastToAdmins({ id: String(nodeId), type: 'status', data: 1 });

  // 节点连接稳定 600ms 后自动校准并下发全量期望转发与限速规则
  setTimeout(() => {
    if (nodeSessions.get(nodeId) === ws && ws.isOpen) {
      syncNodeDesiredState(nodeId).catch(() => {});
    }
  }, 600);

  ws.onMessage = (rawText) => {
    try {
      const decrypted = unwrapEncryptedMessage(rawText, secret);
      if (decrypted.includes('memory_usage')) {
        // 节点上报的系统监控指标
        ws.sendText(wrapEncryptedMessage('{"type":"call"}', secret));
        try {
          const sys = JSON.parse(decrypted);
          const now = Date.now();
          const prev = nodeTelemetryCache.get(nodeId);
          const rx = Number(sys.bytes_received) || 0;
          const tx = Number(sys.bytes_transmitted) || 0;
          let downSpeed = 0;
          let upSpeed = 0;
          if (prev && prev.ts && now > prev.ts) {
            const dt = (now - prev.ts) / 1000;
            if (dt > 0) {
              downSpeed = Math.max(0, Math.round((rx - prev.downloadTraffic) / dt));
              upSpeed = Math.max(0, Math.round((tx - prev.uploadTraffic) / dt));
            }
          }
          nodeTelemetryCache.set(nodeId, {
            uptime: Number(sys.uptime) || 0,
            cpuUsage: Number(Number(sys.cpu_usage || 0).toFixed(1)),
            memoryUsage: Number(Number(sys.memory_usage || 0).toFixed(1)),
            uploadTraffic: tx,
            downloadTraffic: rx,
            uploadSpeed: upSpeed,
            downloadSpeed: downSpeed,
            ts: now
          });
        } catch (e) {}

        broadcastToAdmins({
          id: String(nodeId),
          type: 'info',
          data: decrypted
        });
      } else if (decrypted.includes('requestId')) {
        const resp = JSON.parse(decrypted);
        const reqId = resp.requestId;
        if (reqId && pendingRequests.has(reqId)) {
          const pending = pendingRequests.get(reqId);
          pendingRequests.delete(reqId);
          pending.resolve({
            success: resp.success !== false && (resp.message === 'OK' || resp.success === true),
            msg: resp.message || 'OK',
            type: resp.type,
            data: resp.data
          });
        }
      }
    } catch (e) {}
  };

  ws.onClose = () => {
    if (nodeSessions.get(nodeId) === ws) {
      nodeSessions.delete(nodeId);
      const n = db.nodes.find(x => Number(x.id) === nodeId);
      if (n) {
        n.status = 0;
        markDirty();
      }
      broadcastToAdmins({ id: String(nodeId), type: 'status', data: 0 });
    }
  };
}

// ======================= 启动与优雅退出 =======================
loadDb();
if (db.statisticsFlows.length === 0) {
  recordHourlyFlowSnapshot();
}

const PORT = Number(process.env.FLUX_PORT || process.env.PORT || 6366);
const HOST = process.env.FLUX_BIND_HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch(err => {
    console.error('[Nexus-Flux] 请求异常:', err);
    if (!res.headersSent) {
      sendJson(res, 500, R.err('服务器内部错误'));
    }
  });
});

server.on('upgrade', handleWsUpgrade);

server.listen(PORT, HOST, () => {
  const mem = (process.memoryUsage().rss / 1048576).toFixed(1);
  console.log(`======================================================`);
  console.log(` ✨ Nexus-Flux 主控端已启动 (${PANEL_VERSION})`);
  console.log(` 🌐 监听地址: http://${HOST}:${PORT}`);
  console.log(` 🍃 物理内存占用: ${mem} MB (极致轻量单进程模式)`);
  console.log(`======================================================`);
});

function gracefulShutdown() {
  if (dbDirty) saveDbSync();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
