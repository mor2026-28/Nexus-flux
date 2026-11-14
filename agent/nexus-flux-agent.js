#!/usr/bin/env node
/**
 * Nexus-Flux · 节点转发与隧道服务程序 (Node Agent)
 * Version: 1.0.0
 */

'use strict';

const net = require('net');
const dgram = require('dgram');
const tls = require('tls');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

process.title = 'nexus-netd';
const AGENT_VERSION = '1.0.0';

const RELAY_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgiX6yxZvTOJclOPxf
xmayf8rXgY6q2VkYlBL1Bd78N+ShRANCAARPG9omE70lYHVwEf7QpjJIZQ7g4FX0
MAbCJbEEdO880WIM/p9JFwYXZ9wGQHhH3b2DAhAA2oLyh1kk27cC0zgc
-----END PRIVATE KEY-----`;
const RELAY_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIUW4VcRou0oaFAfhdWcaTfAJE6Ue0wCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNd3d3LmFwcGxlLmNvbTAeFw0yNjExMTQxMTExMTJaFw0zNjEx
MTExMTExMTJaMBgxFjAUBgNVBAMMDXd3dy5hcHBsZS5jb20wWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAARPG9omE70lYHVwEf7QpjJIZQ7g4FX0MAbCJbEEdO880WIM
/p9JFwYXZ9wGQHhH3b2DAhAA2oLyh1kk27cC0zgco1MwUTAdBgNVHQ4EFgQUkLwZ
d3gmjHf2bhwzGcsMjfodnicwHwYDVR0jBBgwFoAUkLwZd3gmjHf2bhwzGcsMjfod
nicwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA4tTq0lCJ51di
9oPlxs9CHcjcbCgNZ3eSlZlpMgOA82oCIBjbi7Y/0CAAYiuA5gPnvvdqbIz6Ynn6
81+WSXCQiYrp
-----END CERTIFICATE-----`;

function tuneTcpSocket(sock) {
  if (!sock || sock.destroyed) return;
  try {
    if (typeof sock.setNoDelay === 'function') sock.setNoDelay(true);
    if (typeof sock.setKeepAlive === 'function') sock.setKeepAlive(true, 15000);
  } catch (e) {}
}

const WORK_DIR = process.env.FLUX_AGENT_DIR || process.cwd();
const CONFIG_PATH = path.join(WORK_DIR, 'config.json');
const GOST_JSON_PATH = path.join(WORK_DIR, 'gost.json');

// ======================= 读取本地配置 =======================
let localConfig = {
  addr: process.env.FLUX_ADDR || '',
  secret: process.env.FLUX_SECRET || '',
  http: 0,
  tls: 0,
  socks: 0
};

function loadLocalConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      localConfig = Object.assign(localConfig, raw);
    } catch (e) {
      console.error('[Flux-Agent] 读取 config.json 失败:', e.message);
    }
  }
  // 支持命令行参数 -a <addr> -s <secret> -V
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-V' || args[i] === '--version') {
      console.log(`gost ${AGENT_VERSION} (Nexus-Flux Light Engine ${process.version} ${os.platform()}/${os.arch()})`);
      process.exit(0);
    }
    if (args[i] === '-a' && args[i + 1]) localConfig.addr = args[++i];
    if (args[i] === '-s' && args[i + 1]) localConfig.secret = args[++i];
  }
}

function saveLocalConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(localConfig, null, 2), 'utf8');
  } catch (e) {}
}

// ======================= AES-256-GCM 加密器 =======================
let aesKey = null;
function initAesKey(secret) {
  if (!secret) return;
  aesKey = crypto.createHash('sha256').update(String(secret), 'utf8').digest();
}

function aesEncrypt(plainStr) {
  if (!aesKey) return plainStr;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const enc = Buffer.concat([cipher.update(String(plainStr), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

function aesDecrypt(base64Str) {
  if (!aesKey) return base64Str;
  const buf = Buffer.from(base64Str, 'base64');
  if (buf.length < 28) throw new Error('Ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function wrapEncrypted(objOrStr) {
  const raw = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
  if (!aesKey) return raw;
  return JSON.stringify({
    encrypted: true,
    data: aesEncrypt(raw),
    timestamp: Math.floor(Date.now() / 1000)
  });
}

function unwrapEncrypted(rawStr) {
  try {
    const parsed = JSON.parse(rawStr);
    if (parsed && parsed.encrypted && parsed.data) {
      return aesDecrypt(parsed.data);
    }
  } catch (e) {}
  return rawStr;
}

// ======================= 协议嗅探与阻断 (HTTP / TLS / SOCKS) =======================
function isBlockedProtocolPacket(buf) {
  if (!buf || buf.length < 3) return null;
  // 1. 检测 SOCKS4 / SOCKS5
  if (Number(localConfig.socks) === 1) {
    if ((buf[0] === 0x05 && buf[1] >= 1 && buf[1] <= 10) || (buf[0] === 0x04 && (buf[1] === 0x01 || buf[1] === 0x02))) {
      return 'SOCKS';
    }
  }
  // 2. 检测 TLS Handshake ClientHello (0x16 0x03 0x01..0x04)
  if (Number(localConfig.tls) === 1) {
    if (buf[0] === 0x16 && buf[1] === 0x03 && buf[2] >= 0x00 && buf[2] <= 0x04) {
      return 'TLS';
    }
  }
  // 3. 检测 HTTP 明文请求与 HTTP/2 Preface
  if (Number(localConfig.http) === 1) {
    const head = buf.subarray(0, Math.min(buf.length, 8)).toString('ascii');
    if (
      head.startsWith('GET ') ||
      head.startsWith('POST ') ||
      head.startsWith('PUT ') ||
      head.startsWith('DELETE ') ||
      head.startsWith('HEAD ') ||
      head.startsWith('OPTIONS ') ||
      head.startsWith('CONNECT ') ||
      head.startsWith('PATCH ') ||
      head.startsWith('TRACE ') ||
      head.startsWith('PRI *')
    ) {
      return 'HTTP';
    }
  }
  return null;
}

// ======================= 令牌桶限速器管理 =======================
const limiters = new Map(); // name -> { bytesPerSec, config }

function parseLimiterBytesPerSec(limiterCfg) {
  if (!limiterCfg || !Array.isArray(limiterCfg.limits) || limiterCfg.limits.length === 0) {
    return 0;
  }
  // 格式: "$ 12.5MB 12.5MB"
  const line = String(limiterCfg.limits[0]);
  const m = line.match(/([\d.]+)\s*(MB|KB|GB|B)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'GB') return Math.round(val * 1024 * 1024 * 1024);
  if (unit === 'MB') return Math.round(val * 1024 * 1024);
  if (unit === 'KB') return Math.round(val * 1024);
  return Math.round(val);
}

// ======================= 转发链与服务注册表 =======================
const chains = new Map();           // chainName -> chainConfig
const activeServices = new Map();   // serviceName -> { config, server, udpSocket, paused, rrIndex }
const trafficDeltas = new Map();    // serviceBaseName ("forwardId_userId_userTunnelId") -> { u: 0, d: 0 }

function recordTraffic(serviceName, upBytes, downBytes) {
  if (!serviceName || serviceName === 'web_api') return;
  const baseName = String(serviceName).replace(/_(tcp|udp|tls)$/i, '');
  let item = trafficDeltas.get(baseName);
  if (!item) {
    item = { u: 0, d: 0 };
    trafficDeltas.set(baseName, item);
  }
  item.u += upBytes;
  item.d += downBytes;
}

function saveGostJsonState() {
  try {
    const state = {
      services: Array.from(activeServices.values()).map(s => s.config),
      chains: Array.from(chains.values()),
      limiters: Array.from(limiters.values()).map(l => l.config)
    };
    fs.writeFileSync(GOST_JSON_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {}
}

function parseBindAddr(addrStr) {
  const s = String(addrStr || ':0').trim();
  const lastColon = s.lastIndexOf(':');
  if (lastColon === -1) return { host: '::', port: Number(s) || 0 };
  let host = s.slice(0, lastColon).trim();
  const port = Number(s.slice(lastColon + 1));
  if (!host || host === '[::]' || host === '::') host = '::';
  else if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, port };
}

function splitHostPort(addr) {
  const s = String(addr || '').trim();
  if (s.startsWith('[')) {
    const closeIdx = s.indexOf(']');
    if (closeIdx > 1 && s[closeIdx + 1] === ':') {
      return { host: s.slice(1, closeIdx), port: Number(s.slice(closeIdx + 2)) };
    }
  }
  const lastColon = s.lastIndexOf(':');
  if (lastColon > 0) {
    return { host: s.slice(0, lastColon), port: Number(s.slice(lastColon + 1)) };
  }
  return { host: s, port: 80 };
}

function selectTargetNode(svcEntry, clientIp = '') {
  const cfg = svcEntry.config;
  const nodes = (cfg.forwarder && Array.isArray(cfg.forwarder.nodes)) ? cfg.forwarder.nodes : [];
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return splitHostPort(nodes[0].addr);

  const strategy = (cfg.forwarder && cfg.forwarder.selector && cfg.forwarder.selector.strategy) || 'fifo';
  if (strategy === 'round') {
    svcEntry.rrIndex = ((svcEntry.rrIndex || 0) + 1) % nodes.length;
    return splitHostPort(nodes[svcEntry.rrIndex].addr);
  }
  if (strategy === 'rand') {
    const idx = Math.floor(Math.random() * nodes.length);
    return splitHostPort(nodes[idx].addr);
  }
  if (strategy === 'hash' && clientIp) {
    let hash = 0;
    for (let i = 0; i < clientIp.length; i++) hash = ((hash << 5) - hash + clientIp.charCodeAt(i)) | 0;
    const idx = Math.abs(hash) % nodes.length;
    return splitHostPort(nodes[idx].addr);
  }
  // 默认 fifo：按顺序选取首个可用目标
  return splitHostPort(nodes[0].addr);
}

// 建立带失败自动切换 (Failover) 的 TCP 连接
function dialWithFailover(svcEntry, clientIp, callback) {
  const cfg = svcEntry.config;
  const nodes = (cfg.forwarder && Array.isArray(cfg.forwarder.nodes)) ? cfg.forwarder.nodes : [];
  if (nodes.length === 0) return callback(new Error('No target nodes'));

  const primary = selectTargetNode(svcEntry, clientIp);
  const candidates = [primary];
  for (const n of nodes) {
    const parsed = splitHostPort(n.addr);
    if (parsed.host !== primary.host || parsed.port !== primary.port) {
      candidates.push(parsed);
    }
  }

  let idx = 0;
  function tryNext() {
    if (idx >= candidates.length) {
      return callback(new Error('All target nodes unreachable'));
    }
    const target = candidates[idx++];
    const dialOpts = { host: target.host, port: target.port, timeout: 5000, allowHalfOpen: true };
    if (cfg.metadata && cfg.metadata.interface && net.isIP(cfg.metadata.interface)) {
      dialOpts.localAddress = cfg.metadata.interface;
    }
    const sock = net.connect(dialOpts);
    let connected = false;
    sock.once('connect', () => {
      connected = true;
      sock.setTimeout(0);
      tuneTcpSocket(sock);
      callback(null, sock);
    });
    sock.once('timeout', () => {
      if (!connected) {
        sock.destroy();
        tryNext();
      }
    });
    sock.once('error', () => {
      if (!connected) {
        sock.destroy();
        tryNext();
      }
    });
  }
  tryNext();
}

// 连接到隧道链出口节点 (支持 TLS 1.3 加密隧道封装与 TCP_NODELAY 低延迟流控)
function dialChainHop(chainName, callback) {
  const chainCfg = chains.get(chainName);
  if (!chainCfg || !Array.isArray(chainCfg.hops) || !chainCfg.hops[0] || !Array.isArray(chainCfg.hops[0].nodes) || !chainCfg.hops[0].nodes[0]) {
    return callback(new Error(`Chain ${chainName} not found`));
  }
  const hopNode = chainCfg.hops[0].nodes[0];
  const target = splitHostPort(hopNode.addr);
  const dialerType = String((hopNode.dialer && hopNode.dialer.type) || 'tls').toLowerCase();
  const useTls = (dialerType === 'tls' || dialerType === 'mtls' || dialerType === 'wss');

  const rawSock = net.connect({
    host: target.host,
    port: target.port,
    timeout: 6000,
    allowHalfOpen: true,
    localAddress: (hopNode.interface && net.isIP(hopNode.interface)) ? hopNode.interface : undefined
  });
  tuneTcpSocket(rawSock);

  let connected = false;
  rawSock.once('connect', () => {
    rawSock.setTimeout(0);
    tuneTcpSocket(rawSock);
    if (!useTls) {
      connected = true;
      return callback(null, rawSock);
    }
    const tlsSock = tls.connect({
      socket: rawSock,
      servername: 'www.apple.com',
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1']
    });
    tlsSock.once('secureConnect', () => {
      connected = true;
      tuneTcpSocket(tlsSock);
      callback(null, tlsSock);
    });
    tlsSock.once('error', (err) => {
      if (!connected) {
        tlsSock.destroy();
        callback(err);
      }
    });
  });
  rawSock.once('timeout', () => {
    if (!connected) {
      rawSock.destroy();
      callback(new Error('Chain dial timeout'));
    }
  });
  rawSock.once('error', (err) => {
    if (!connected) {
      rawSock.destroy();
      callback(err);
    }
  });
}

// 启动单个转发服务 (_tcp / _udp / _tls)
function startServiceInstance(serviceConfig) {
  const name = String(serviceConfig.name || '').trim();
  if (!name) throw new Error('service name is required');
  if (activeServices.has(name)) {
    stopServiceInstance(name);
  }

  const { host, port } = parseBindAddr(serviceConfig.addr);
  const handlerType = (serviceConfig.handler && serviceConfig.handler.type) || 'tcp';
  const chainName = serviceConfig.handler && serviceConfig.handler.chain;

  const entry = {
    config: serviceConfig,
    server: null,
    udpSocket: null,
    paused: false,
    rrIndex: 0
  };

  if (handlerType === 'udp') {
    // UDP 转发服务
    const udpType = host.includes(':') ? 'udp6' : 'udp4';
    const udpSocket = dgram.createSocket({ type: udpType, reuseAddr: true });
    const sessions = new Map();

    udpSocket.on('message', (msg, rinfo) => {
      if (entry.paused) return;
      const clientKey = `${rinfo.address}:${rinfo.port}`;
      let sess = sessions.get(clientKey);

      const target = chainName
        ? (() => {
            const c = chains.get(chainName);
            const addr = c && c.hops && c.hops[0] && c.hops[0].nodes && c.hops[0].nodes[0] && c.hops[0].nodes[0].addr;
            return addr ? splitHostPort(addr) : null;
          })()
        : selectTargetNode(entry, rinfo.address);

      if (!target) return;

      if (!sess) {
        const upstream = dgram.createSocket(net.isIPv6(target.host) ? 'udp6' : 'udp4');
        sess = { upstream, lastActive: Date.now() };
        sessions.set(clientKey, sess);

        upstream.on('message', (backMsg) => {
          sess.lastActive = Date.now();
          recordTraffic(name, 0, backMsg.length);
          udpSocket.send(backMsg, rinfo.port, rinfo.address, () => {});
        });
        upstream.on('error', () => {
          sessions.delete(clientKey);
          try { upstream.close(); } catch (e) {}
        });
      }

      sess.lastActive = Date.now();
      recordTraffic(name, msg.length, 0);
      sess.upstream.send(msg, target.port, target.host, () => {});
    });

    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of sessions.entries()) {
        if (now - v.lastActive > 60000) {
          sessions.delete(k);
          try { v.upstream.close(); } catch (e) {}
        }
      }
    }, 30000);
    cleanupInterval.unref();

    udpSocket.on('close', () => {
      clearInterval(cleanupInterval);
      for (const [, v] of sessions.entries()) {
        try { v.upstream.close(); } catch (e) {}
      }
      sessions.clear();
    });

    udpSocket.on('error', () => {});
    try {
      udpSocket.bind(port, host === '::' ? undefined : host);
    } catch (e) {}

    entry.udpSocket = udpSocket;
    activeServices.set(name, entry);
    return;
  }

  // TCP / Relay 服务 (支持 TLS 1.3 自动解封装、拨号期零丢包缓冲、TCP_NODELAY 零延迟与内核背压流控)
  const server = net.createServer({ allowHalfOpen: true }, (rawClientSock) => {
    if (entry.paused) {
      rawClientSock.destroy();
      return;
    }
    tuneTcpSocket(rawClientSock);

    let upstreamSock = null;

    const startBridge = (activeClientStream, preBufferedChunks) => {
      // 在上游连接建立完成前暂停并缓冲客户端流，防止跨境拨号耗时窗口内后续数据包丢失导致 Shadowsocks/AEAD 解密断流
      const pendingChunks = Array.isArray(preBufferedChunks) ? preBufferedChunks.slice() : [];
      activeClientStream.pause();
      const onPreConnectData = (chunk) => {
        pendingChunks.push(chunk);
        activeClientStream.pause();
      };
      let clientEndedEarly = false;
      const onPreConnectEnd = () => {
        clientEndedEarly = true;
      };
      activeClientStream.on('data', onPreConnectData);
      activeClientStream.once('end', onPreConnectEnd);

      const dialFn = (chainName && handlerType !== 'relay')
        ? (cb) => dialChainHop(chainName, cb)
        : (cb) => dialWithFailover(entry, rawClientSock.remoteAddress, cb);

      dialFn((err, targetSock) => {
        activeClientStream.removeListener('data', onPreConnectData);
        activeClientStream.removeListener('end', onPreConnectEnd);

        if (err || activeClientStream.destroyed || rawClientSock.destroyed) {
          if (targetSock) targetSock.destroy();
          activeClientStream.destroy();
          rawClientSock.destroy();
          return;
        }
        upstreamSock = targetSock;
        tuneTcpSocket(upstreamSock);

        rawClientSock.setTimeout(300000, () => { activeClientStream.destroy(); upstreamSock.destroy(); });
        upstreamSock.setTimeout(300000, () => { upstreamSock.destroy(); activeClientStream.destroy(); });

        const limiterObj = serviceConfig.limiter ? limiters.get(String(serviceConfig.limiter)) : null;
        const maxBytesPerSec = limiterObj ? limiterObj.bytesPerSec : 0;
        let windowStart = Date.now();
        let windowBytes = 0;

        // 先将拨号窗口期缓冲的首包及后续包完整写入上游
        let initialBackpressure = false;
        for (const chunk of pendingChunks) {
          recordTraffic(name, chunk.length, 0);
          if (!upstreamSock.write(chunk)) {
            initialBackpressure = true;
          }
        }
        pendingChunks.length = 0;

        // 客户端 -> 目标端 (含背压控制与限速控制)
        activeClientStream.on('data', (chunk) => {
          recordTraffic(name, chunk.length, 0);
          if (upstreamSock.destroyed) return;

          if (maxBytesPerSec > 0) {
            const now = Date.now();
            if (now - windowStart >= 1000) {
              windowStart = now;
              windowBytes = 0;
            }
            windowBytes += chunk.length;
            if (windowBytes > maxBytesPerSec) {
              activeClientStream.pause();
              setTimeout(() => {
                if (!activeClientStream.destroyed) activeClientStream.resume();
              }, 80);
            }
          }

          const flushed = upstreamSock.write(chunk);
          if (!flushed && maxBytesPerSec === 0) {
            activeClientStream.pause();
          }
        });

        upstreamSock.on('drain', () => {
          if (!activeClientStream.destroyed) activeClientStream.resume();
        });

        // 目标端 -> 客户端 (含完整背压流控，消除直播大流量缓冲卡顿)
        upstreamSock.on('data', (chunk) => {
          recordTraffic(name, 0, chunk.length);
          if (activeClientStream.destroyed) return;
          const flushed = activeClientStream.write(chunk);
          if (!flushed) {
            upstreamSock.pause();
          }
        });

        activeClientStream.on('drain', () => {
          if (!upstreamSock.destroyed) upstreamSock.resume();
        });

        // 优雅半关闭 (Half-Close) 处理，确保双向缓冲区数据 100% 排空
        activeClientStream.once('end', () => {
          try { upstreamSock.end(); } catch (e) {}
        });
        upstreamSock.once('end', () => {
          try { activeClientStream.end(); } catch (e) {}
        });

        activeClientStream.on('error', () => upstreamSock.destroy());
        upstreamSock.on('error', () => activeClientStream.destroy());

        if (clientEndedEarly) {
          try { upstreamSock.end(); } catch (e) {}
        } else if (!initialBackpressure) {
          activeClientStream.resume();
        }
      });
    };

    rawClientSock.once('data', (firstChunk) => {
      if (handlerType === 'relay') {
        // 出口 Relay 节点自动检测首字节是否为 TLS 1.3/1.2 握手 (0x16 0x03)
        if (firstChunk.length >= 3 && firstChunk[0] === 0x16 && firstChunk[1] === 0x03) {
          const tlsServerSock = new tls.TLSSocket(rawClientSock, {
            isServer: true,
            key: RELAY_TLS_KEY,
            cert: RELAY_TLS_CERT
          });
          tuneTcpSocket(tlsServerSock);
          tlsServerSock.on('error', () => {
            if (upstreamSock) upstreamSock.destroy();
            rawClientSock.destroy();
          });
          rawClientSock.unshift(firstChunk);
          startBridge(tlsServerSock, []);
          return;
        }
        rawClientSock.pause();
        startBridge(rawClientSock, [firstChunk]);
      } else {
        // 入口节点检测是否命中协议屏蔽 (HTTP / TLS / SOCKS)
        const blockedProto = isBlockedProtocolPacket(firstChunk);
        if (blockedProto) {
          rawClientSock.destroy();
          return;
        }
        rawClientSock.pause();
        startBridge(rawClientSock, [firstChunk]);
      }
    });

    rawClientSock.on('error', () => {
      if (upstreamSock) upstreamSock.destroy();
    });
  });

  server.on('error', (err) => {
    console.error(`[Flux-Agent] Service ${name} listen error on :${port}:`, err.message);
  });

  server.listen(port, host === '::' ? undefined : host);
  entry.server = server;
  activeServices.set(name, entry);
}

function stopServiceInstance(name) {
  const entry = activeServices.get(name);
  if (!entry) return false;
  if (entry.server) {
    try { entry.server.close(); } catch (e) {}
  }
  if (entry.udpSocket) {
    try { entry.udpSocket.close(); } catch (e) {}
  }
  activeServices.delete(name);
  return true;
}

// ======================= 系统指标采集 (Linux /proc + 跨平台回退) =======================
let prevCpuIdle = 0;
let prevCpuTotal = 0;

function sampleCpuUsage() {
  try {
    if (fs.existsSync('/proc/stat')) {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      const idle = parts[3] + (parts[4] || 0);
      const total = parts.reduce((a, b) => a + b, 0);
      const diffIdle = idle - prevCpuIdle;
      const diffTotal = total - prevCpuTotal;
      prevCpuIdle = idle;
      prevCpuTotal = total;
      if (diffTotal > 0) {
        return Math.max(0, Math.min(100, Number((((diffTotal - diffIdle) / diffTotal) * 100).toFixed(1))));
      }
    }
  } catch (e) {}
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return 0.5;
  const load = os.loadavg()[0] || 0;
  return Math.min(100, Number(((load / cpus.length) * 100).toFixed(1)));
}

function sampleMemoryUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  if (!total) return 0;
  return Number((((total - free) / total) * 100).toFixed(1));
}

function sampleNetworkBytes() {
  let rx = 0;
  let tx = 0;
  try {
    if (fs.existsSync('/proc/net/dev')) {
      const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('lo:')) continue;
        const parts = trimmed.replace(':', ' ').trim().split(/\s+/);
        rx += Number(parts[1]) || 0;
        tx += Number(parts[9]) || 0;
      }
    }
  } catch (e) {}
  return { bytes_received: rx, bytes_transmitted: tx };
}

function collectSystemInfo() {
  const netStats = sampleNetworkBytes();
  return {
    uptime: Math.floor(os.uptime()),
    bytes_received: netStats.bytes_received,
    bytes_transmitted: netStats.bytes_transmitted,
    cpu_usage: sampleCpuUsage(),
    memory_usage: sampleMemoryUsage()
  };
}

// ======================= TCP Ping 诊断实现 =======================
function executeTcpPing(reqData) {
  return new Promise((resolve) => {
    const ip = String(reqData.ip || '').trim();
    const port = Number(reqData.port) || 80;
    const count = Math.min(10, Math.max(1, Number(reqData.count) || 4));
    const timeoutMs = Math.min(10000, Math.max(500, Number(reqData.timeout) || 3000));

    let completed = 0;
    let successCount = 0;
    let totalTimeMs = 0;
    let minTimeMs = Infinity;
    let maxTimeMs = 0;
    let lastErr = '';

    function runOnce() {
      const start = process.hrtime.bigint();
      const sock = net.connect({ host: ip, port, timeout: timeoutMs });
      tuneTcpSocket(sock);
      let done = false;

      const finish = (ok, errMsg) => {
        if (done) return;
        done = true;
        sock.destroy();
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        if (ok) {
          successCount++;
          totalTimeMs += elapsedMs;
          if (elapsedMs < minTimeMs) minTimeMs = elapsedMs;
          if (elapsedMs > maxTimeMs) maxTimeMs = elapsedMs;
        } else {
          lastErr = errMsg || '连接超时';
        }
        completed++;
        if (completed >= count) {
          if (successCount === 0) {
            resolve({
              ip,
              port,
              success: false,
              averageTime: -1,
              minTime: -1,
              maxTime: -1,
              jitter: -1,
              packetLoss: 100,
              errorMessage: lastErr || 'TCP 连接失败',
              requestId: reqData.requestId
            });
          } else {
            const avg = totalTimeMs / successCount;
            const jitter = Math.max(0, maxTimeMs - minTimeMs);
            resolve({
              ip,
              port,
              success: true,
              averageTime: Number(avg.toFixed(2)),
              minTime: Number(minTimeMs.toFixed(2)),
              maxTime: Number(maxTimeMs.toFixed(2)),
              jitter: Number(jitter.toFixed(2)),
              packetLoss: Number((((count - successCount) / count) * 100).toFixed(1)),
              requestId: reqData.requestId
            });
          }
        } else {
          setTimeout(runOnce, 60);
        }
      };

      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false, '连接超时'));
      sock.once('error', (err) => finish(false, err.message));
    }

    runOnce();
  });
}

// ======================= 命令路由与执行 =======================
async function handleMasterCommand(cmd) {
  const response = {
    type: `${cmd.type}Response`,
    success: true,
    message: 'OK',
    requestId: cmd.requestId
  };

  try {
    const data = cmd.data;
    switch (cmd.type) {
      case 'AddService':
      case 'UpdateService': {
        const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : [data]);
        for (const svcCfg of list) {
          if (svcCfg && svcCfg.name) startServiceInstance(svcCfg);
        }
        saveGostJsonState();
        break;
      }
      case 'DeleteService': {
        const names = (data && Array.isArray(data.services)) ? data.services : [];
        for (const n of names) stopServiceInstance(String(n).trim());
        saveGostJsonState();
        break;
      }
      case 'PauseService': {
        const names = (data && Array.isArray(data.services)) ? data.services : [];
        for (const n of names) {
          const entry = activeServices.get(String(n).trim());
          if (entry) entry.paused = true;
        }
        break;
      }
      case 'ResumeService': {
        const names = (data && Array.isArray(data.services)) ? data.services : [];
        for (const n of names) {
          const entry = activeServices.get(String(n).trim());
          if (entry) entry.paused = false;
        }
        break;
      }
      case 'AddChains':
      case 'UpdateChains': {
        const chainCfg = (data && data.data && data.chain) ? data.data : data;
        if (chainCfg && chainCfg.name) {
          chains.set(String(chainCfg.name).trim(), chainCfg);
        }
        saveGostJsonState();
        break;
      }
      case 'DeleteChains': {
        const cName = typeof data === 'string' ? data : (data && data.chain);
        if (cName) chains.delete(String(cName).trim());
        saveGostJsonState();
        break;
      }
      case 'AddLimiters':
      case 'UpdateLimiters': {
        const limCfg = (data && data.data && data.limiter) ? data.data : data;
        if (limCfg && limCfg.name) {
          limiters.set(String(limCfg.name).trim(), {
            bytesPerSec: parseLimiterBytesPerSec(limCfg),
            config: limCfg
          });
        }
        saveGostJsonState();
        break;
      }
      case 'DeleteLimiters': {
        const lName = typeof data === 'string' ? data : (data && data.limiter);
        if (lName) limiters.delete(String(lName).trim());
        saveGostJsonState();
        break;
      }
      case 'SetProtocol': {
        if (data && typeof data === 'object') {
          if (data.http !== undefined) localConfig.http = Number(data.http) ? 1 : 0;
          if (data.tls !== undefined) localConfig.tls = Number(data.tls) ? 1 : 0;
          if (data.socks !== undefined) localConfig.socks = Number(data.socks) ? 1 : 0;
          saveLocalConfig();
        }
        break;
      }
      case 'TcpPing': {
        response.type = 'PingResponse';
        response.data = await executeTcpPing(data || {});
        break;
      }
      default:
        break;
    }
  } catch (err) {
    response.success = false;
    response.message = err.message || 'Execution error';
  }

  return response;
}

// ======================= 原生 WebSocket 客户端与 HTTP 流量上报 =======================
let wsSocket = null;
let wsConnected = false;
let reconnectTimer = null;

function buildWsFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const len = payload.length;
  const maskKey = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(6);
    header[0] = 0x81;
    header[1] = 0x80 | len;
    maskKey.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    maskKey.copy(header, 4);
  } else {
    header = Buffer.allocUnsafe(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    maskKey.copy(header, 10);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    masked[i] = payload[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, masked]);
}

function connectWebSocket() {
  if (wsConnected) return;
  const rawAddr = String(localConfig.addr || '').trim();
  if (!rawAddr || !localConfig.secret) {
    console.error('[Flux-Agent] 缺少服务器地址或密钥');
    return;
  }

  const isSecure = rawAddr.startsWith('wss://') || rawAddr.startsWith('https://');
  const cleanHostPort = rawAddr.replace(/^(wss?|https?):\/\//i, '').replace(/\/+$/, '');
  const { host, port } = splitHostPort(cleanHostPort.includes(':') ? cleanHostPort : `${cleanHostPort}:${isSecure ? 443 : 80}`);

  const wsPath = `/system-info?type=1&secret=${encodeURIComponent(localConfig.secret)}&version=${AGENT_VERSION}&http=${localConfig.http || 0}&tls=${localConfig.tls || 0}&socks=${localConfig.socks || 0}`;
  const wsKey = crypto.randomBytes(16).toString('base64');

  const reqMod = isSecure ? https : http;
  const req = reqMod.request({
    host,
    port,
    path: wsPath,
    method: 'GET',
    rejectUnauthorized: false,
    headers: {
      'Host': cleanHostPort,
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'Sec-WebSocket-Key': wsKey,
      'Sec-WebSocket-Version': '13'
    },
    timeout: 8000
  });

  req.on('upgrade', (res, socket) => {
    wsSocket = socket;
    wsConnected = true;
    console.log(`[Flux-Agent] ✅ 已连接主控: ${cleanHostPort} (version=${AGENT_VERSION})`);

    let rxBuf = Buffer.alloc(0);
    socket.on('data', async (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 2) {
        const b0 = rxBuf[0];
        const b1 = rxBuf[1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (rxBuf.length < 4) return;
          payloadLen = rxBuf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (rxBuf.length < 10) return;
          payloadLen = Number(rxBuf.readBigUInt64BE(2));
          offset = 10;
        }
        if (payloadLen > 2 * 1024 * 1024) { socket.destroy(); return; }
        const maskLen = masked ? 4 : 0;
        if (rxBuf.length < offset + maskLen + payloadLen) return;

        let payload = rxBuf.subarray(offset + maskLen, offset + maskLen + payloadLen);
        if (masked) {
          const mKey = rxBuf.subarray(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mKey[i & 3];
        }
        rxBuf = rxBuf.subarray(offset + maskLen + payloadLen);

        if (opcode === 0x08) {
          socket.destroy();
          return;
        } else if (opcode === 0x01) {
          const rawStr = payload.toString('utf8');
          const plainStr = unwrapEncrypted(rawStr);
          try {
            const cmd = JSON.parse(plainStr);
            if (cmd && cmd.type && cmd.type !== 'call') {
              const resp = await handleMasterCommand(cmd);
              if (wsConnected && wsSocket && !wsSocket.destroyed) {
                wsSocket.write(buildWsFrame(wrapEncrypted(resp)));
              }
            }
          } catch (e) {}
        }
      }
    });

    const onDisconnect = () => {
      if (!wsConnected) return;
      wsConnected = false;
      wsSocket = null;
      scheduleReconnect();
    };

    socket.on('close', onDisconnect);
    socket.on('error', onDisconnect);
  });

  req.on('error', () => {
    wsConnected = false;
    scheduleReconnect();
  });

  req.on('timeout', () => {
    req.destroy();
    wsConnected = false;
    scheduleReconnect();
  });

  req.end();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 3000);
}

// 每 2 秒通过 WebSocket 上报一次节点系统状态
setInterval(() => {
  if (!wsConnected || !wsSocket || wsSocket.destroyed) return;
  try {
    const sysInfo = collectSystemInfo();
    wsSocket.write(buildWsFrame(wrapEncrypted(sysInfo)));
  } catch (e) {}
}, 2000).unref();

// 每 3 秒通过 HTTP POST /flow/upload 上报增量流量
setInterval(() => {
  if (trafficDeltas.size === 0) return;
  const rawAddr = String(localConfig.addr || '').trim();
  const isSecure = rawAddr.startsWith('wss://') || rawAddr.startsWith('https://');
  const cleanHostPort = rawAddr.replace(/^(wss?|https?):\/\//i, '').replace(/\/+$/, '');
  const { host, port } = splitHostPort(cleanHostPort.includes(':') ? cleanHostPort : `${cleanHostPort}:${isSecure ? 443 : 80}`);
  const reqMod = isSecure ? https : http;

  for (const [baseName, delta] of trafficDeltas.entries()) {
    if (delta.u <= 0 && delta.d <= 0) continue;
    const uToSend = delta.u;
    const dToSend = delta.d;
    delta.u = 0;
    delta.d = 0;

    const body = wrapEncrypted({ n: baseName, u: uToSend, d: dToSend });
    const req = reqMod.request({
      host,
      port,
      path: `/flow/upload?secret=${encodeURIComponent(localConfig.secret)}`,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'GOST-Traffic-Reporter/1.0'
      },
      timeout: 4000
    }, (res) => {
      res.resume();
    });
    req.on('error', () => {
      // 上报失败则回滚累加，防止丢失流量数据
      const item = trafficDeltas.get(baseName);
      if (item) {
        item.u += uToSend;
        item.d += dToSend;
      }
    });
    req.write(body);
    req.end();
  }
}, 3000).unref();

// ======================= 启动恢复本地 gost.json 并连接主控 =======================
function restoreSavedState() {
  if (!fs.existsSync(GOST_JSON_PATH)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(GOST_JSON_PATH, 'utf8'));
    if (Array.isArray(saved.limiters)) {
      for (const l of saved.limiters) {
        if (l && l.name) {
          limiters.set(String(l.name), { bytesPerSec: parseLimiterBytesPerSec(l), config: l });
        }
      }
    }
    if (Array.isArray(saved.chains)) {
      for (const c of saved.chains) {
        if (c && c.name) chains.set(String(c.name), c);
      }
    }
    if (Array.isArray(saved.services)) {
      for (const s of saved.services) {
        if (s && s.name) {
          try { startServiceInstance(s); } catch (e) {}
        }
      }
    }
  } catch (e) {}
}

loadLocalConfig();
initAesKey(localConfig.secret);
restoreSavedState();
connectWebSocket();
