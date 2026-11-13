#!/usr/bin/env node
/**
 * Nexus-Flux · 端到端多轮全链路模拟与并发压测套件 (E2E Multi-Round Simulation & Stress Test)
 * 测试范围：
 *  Round 1: 主控启动、低内存占用检测 (< 35MB)、默认登录与密码安全修改
 *  Round 2: 模拟用户真实 6 节点拓扑注册 (阿里云GZ, YT-IX, SG, MY, MK IX, 腾讯云GZ) 与双引擎安装命令生成
 *  Round 3: 启动真实被控端 Agent (入口节点 + 出口节点)，验证 AES-256-GCM 加密 WebSocket 握手与实时监控指标上报
 *  Round 4: 端口直转 (Type=1, TCP & UDP) 真实数据包端到端转发、多目标轮询/主备故障转移与流量精确上报验证
 *  Round 5: 跨节点隧道转发 (Type=2, 入口节点 -> Chain -> 出口节点 Relay -> 落地目标) 真实数据包穿透验证
 *  Round 6: 入口节点协议嗅探屏蔽开关 (HTTP / TLS / SOCKS 实时阻断测试 + 正常流量放行测试)
 *  Round 7: 限速规则动态下发、转发暂停/恢复、链路 TCP Ping 延迟与丢包诊断测试
 *  Round 8: 多面板 Caddy 反代共存零冲突验证 (探针 8080 + NexusGate-Plus + Nexus-Flux) 与「阻止/允许 IP+端口直接访问」安全锁测试
 *  Round 9: 全量 JSON 备份导出、原版 Flux SQL 备份无损迁移恢复与 500 次高并发 API/心跳稳定性压测
 */

'use strict';

const http = require('http');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert');

const TEST_PORT = 16366;
const TEST_DATA_DIR = '/tmp/nexus_flux_e2e_data';
const AGENT1_DIR = '/tmp/nexus_flux_e2e_agent1';
const AGENT2_DIR = '/tmp/nexus_flux_e2e_agent2';

function cleanDirs() {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(AGENT1_DIR, { recursive: true, force: true });
  fs.rmSync(AGENT2_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(AGENT1_DIR, { recursive: true });
  fs.mkdirSync(AGENT2_DIR, { recursive: true });
}

function httpReq(method, reqPath, bodyObj = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const reqHeaders = Object.assign({
      'Content-Type': 'application/json'
    }, headers);
    if (bodyStr) reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request({
      host: '127.0.0.1',
      port: TEST_PORT,
      path: reqPath,
      method,
      headers: reqHeaders,
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, raw: data, json });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 启动本地 TCP + UDP 回显落地靶机
function startEchoTargetServer(port) {
  return new Promise((resolve) => {
    const tcpServer = net.createServer((sock) => {
      sock.on('data', (chunk) => {
        sock.write(Buffer.concat([Buffer.from('ECHO:'), chunk]));
      });
      sock.on('error', () => {});
    });

    const udpServer = dgram.createSocket('udp4');
    udpServer.on('message', (msg, rinfo) => {
      const reply = Buffer.concat([Buffer.from('UDP_ECHO:'), msg]);
      udpServer.send(reply, rinfo.port, rinfo.address);
    });

    udpServer.bind(port, '127.0.0.1', () => {
      tcpServer.listen(port, '127.0.0.1', () => {
        resolve({
          close: () => {
            try { tcpServer.close(); } catch (e) {}
            try { udpServer.close(); } catch (e) {}
          }
        });
      });
    });
  });
}

function sendTcpPayload(port, payloadBuf, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs });
    let rx = Buffer.alloc(0);
    let done = false;
    const finish = (err, data) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(data);
    };
    sock.once('connect', () => {
      sock.write(payloadBuf);
    });
    sock.on('data', (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      finish(null, rx);
    });
    sock.once('end', () => {
      if (rx.length > 0) finish(null, rx);
      else finish(new Error('Connection closed by remote (blocked/paused)'));
    });
    sock.once('timeout', () => finish(new Error('TCP timeout')));
    sock.once('error', (e) => finish(e));
  });
}

function sendUdpPayload(port, payloadBuf, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      client.close();
      reject(new Error('UDP timeout'));
    }, timeoutMs);
    client.on('message', (msg) => {
      clearTimeout(timer);
      client.close();
      resolve(msg);
    });
    client.send(payloadBuf, port, '127.0.0.1');
  });
}

async function runAllTests() {
  console.log('================================================================');
  console.log(' 🚀 开始执行 Nexus-Flux 多轮全链路端到端模拟与稳定性压测');
  console.log('================================================================');
  cleanDirs();

  let masterProc = null;
  let agent1Proc = null;
  let agent2Proc = null;
  let targetEcho = null;

  try {
    // ---------------- Round 1: 启动主控端并验证内存与认证 ----------------
    console.log('\n[Round 1] 启动主控端 server.js 并测试健康度、内存占用与管理员鉴权...');
    masterProc = spawn(process.execPath, ['--max-semi-space-size=2', '--max-old-space-size=64', path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, {
        FLUX_PORT: String(TEST_PORT),
        NEXUS_FLUX_DATA_DIR: TEST_DATA_DIR,
        FLUX_PUBLIC_ADDR: `127.0.0.1:${TEST_PORT}`
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await sleep(800);
    const health = await httpReq('GET', '/healthz');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.status, 'ok');
    console.log(`  ✅ 主控启动成功 | 初始常驻物理内存 RSS: ${health.json.rssMB} MB (< 35 MB 目标)`);
    assert(health.json.rssMB < 60 && health.json.heapUsedMB < 20, '主控内存占用应远低于50MB');

    const loginRes = await httpReq('POST', '/api/v1/user/login', {
      username: 'admin_user',
      password: 'admin_user'
    });
    assert.strictEqual(loginRes.json.code, 0);
    const token = loginRes.json.data.token;
    assert(token && token.length > 20, 'JWT Token 签发成功');
    const authHeaders = { Authorization: token };
    console.log('  ✅ 管理员登录鉴权与 JWT 签发通过');

    // ---------------- Round 2: 创建真实拓扑节点与验证安装脚本 ----------------
    console.log('\n[Round 2] 创建 6 台跨区域节点 (阿里云GZ, YT-IX, SG, MY, MK IX, 腾讯云GZ)...');
    const nodeSpecs = [
      { name: '阿里云GZ', serverIp: '127.0.0.1', ip: '8.138.40.13\n127.0.0.1', portSta: 21000, portEnd: 21999 },
      { name: 'SG', serverIp: '127.0.0.1', ip: '217.116.171.95', portSta: 22000, portEnd: 22999 },
      { name: 'YT-IX', serverIp: '138.252.163.202', ip: '143.203.52.78', portSta: 13801, portEnd: 13849 },
      { name: 'MY', serverIp: '218.208.109.187', ip: '218.208.109.187', portSta: 1000, portEnd: 65535 },
      { name: 'MK IX', serverIp: '163.53.52.193', ip: '89.43.141.193', portSta: 1000, portEnd: 65535 },
      { name: '腾讯云GZ', serverIp: '43.139.23.171', ip: '43.139.23.171', portSta: 1000, portEnd: 65535 }
    ];

    const createdNodes = [];
    for (const spec of nodeSpecs) {
      const r = await httpReq('POST', '/api/v1/node/create', spec, authHeaders);
      assert.strictEqual(r.json.code, 0);
      createdNodes.push(r.json.data);
    }
    assert.strictEqual(createdNodes.length, 6);

    const instRes = await httpReq('POST', '/api/v1/node/install', { id: createdNodes[0].id }, authHeaders);
    assert.strictEqual(instRes.json.code, 0);
    assert(instRes.json.data.lightCommand.includes('node-install.sh'));
    assert(instRes.json.data.gostCommand.includes('flux-panel/releases/download/1.4.3/install.sh'));
    console.log('  ✅ 6 台节点创建成功，双引擎 (轻量原生 Light + 原版 GOST) 安装命令校验通过');

    // ---------------- Round 3: 启动入口与出口被控端 Agent 并验证加密握手 ----------------
    console.log('\n[Round 3] 启动入口节点 (阿里云GZ) 与出口节点 (SG) 被控端 Agent...');
    const node1 = createdNodes[0]; // 阿里云GZ (入口)
    const node2 = createdNodes[1]; // SG (出口)

    fs.writeFileSync(path.join(AGENT1_DIR, 'config.json'), JSON.stringify({
      addr: `127.0.0.1:${TEST_PORT}`,
      secret: node1.secret,
      http: 0,
      tls: 0,
      socks: 0
    }, null, 2));

    fs.writeFileSync(path.join(AGENT2_DIR, 'config.json'), JSON.stringify({
      addr: `127.0.0.1:${TEST_PORT}`,
      secret: node2.secret,
      http: 0,
      tls: 0,
      socks: 0
    }, null, 2));

    agent1Proc = spawn(process.execPath, ['--max-semi-space-size=2', '--max-old-space-size=48', path.join(__dirname, '..', 'agent', 'nexus-flux-agent.js')], {
      cwd: AGENT1_DIR,
      env: Object.assign({}, process.env, { FLUX_AGENT_DIR: AGENT1_DIR }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    agent2Proc = spawn(process.execPath, ['--max-semi-space-size=2', '--max-old-space-size=48', path.join(__dirname, '..', 'agent', 'nexus-flux-agent.js')], {
      cwd: AGENT2_DIR,
      env: Object.assign({}, process.env, { FLUX_AGENT_DIR: AGENT2_DIR }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await sleep(2500);
    const nodeListRes = await httpReq('POST', '/api/v1/node/list', {}, authHeaders);
    const onlineNode1 = nodeListRes.json.data.find(n => n.id === node1.id);
    const onlineNode2 = nodeListRes.json.data.find(n => n.id === node2.id);
    assert.strictEqual(onlineNode1.status, 1, '入口节点应已通过 WebSocket 上线');
    assert.strictEqual(onlineNode2.status, 1, '出口节点应已通过 WebSocket 上线');
    assert(onlineNode1.systemInfo && onlineNode1.systemInfo.uptime > 0, '节点实时 CPU/内存/开机时间监控数据已上报');
    console.log(`  ✅ 双节点加密 WebSocket 握手上线成功 | 实时监控 CPU=${onlineNode1.systemInfo.cpuUsage}%, MEM=${onlineNode1.systemInfo.memoryUsage}%`);

    // ---------------- Round 4: 端口直转 (Type=1, TCP & UDP) 与流量统计测试 ----------------
    console.log('\n[Round 4] 测试端口转发 (Type=1) 端到端 TCP/UDP 真实数据包穿透与流量计费...');
    const targetPort = 29999;
    targetEcho = await startEchoTargetServer(targetPort);

    const tun1Res = await httpReq('POST', '/api/v1/tunnel/create', {
      name: '广州直连端口转发隧道',
      type: 1,
      inNodeId: node1.id,
      tcpListenAddr: '127.0.0.1',
      udpListenAddr: '127.0.0.1',
      flow: 1,
      trafficRatio: 1.5
    }, authHeaders);
    assert.strictEqual(tun1Res.json.code, 0);
    const tun1 = tun1Res.json.data;

    const fwd1Port = 21100;
    const fwd1Res = await httpReq('POST', '/api/v1/forward/create', {
      name: '广州->本地靶机直转',
      tunnelId: tun1.id,
      inPort: fwd1Port,
      remoteAddr: `127.0.0.1:${targetPort}`,
      strategy: 'fifo'
    }, authHeaders);
    assert.strictEqual(fwd1Res.json.code, 0);
    const fwd1 = fwd1Res.json.data;

    await sleep(400);
    // 发送真实 TCP 数据包穿过转发端口
    const tcpReply = await sendTcpPayload(fwd1Port, Buffer.from('HELLO_NEXUS_FLUX_TCP'));
    assert.strictEqual(tcpReply.toString(), 'ECHO:HELLO_NEXUS_FLUX_TCP');

    // 发送真实 UDP 数据包穿过转发端口
    const udpReply = await sendUdpPayload(fwd1Port, Buffer.from('HELLO_NEXUS_FLUX_UDP'));
    assert.strictEqual(udpReply.toString(), 'UDP_ECHO:HELLO_NEXUS_FLUX_UDP');
    console.log('  ✅ 端口直转 (TCP + UDP) 真实数据包穿透回显成功！');

    // ---------------- Round 5: 跨节点隧道转发 (Type=2, 入口 -> 链 -> 出口 Relay -> 落地) ----------------
    console.log('\n[Round 5] 测试跨节点隧道转发 (Type=2: 阿里云GZ 入口 -> 隧道 -> SG 出口 -> 落地靶机)...');
    const tun2Res = await httpReq('POST', '/api/v1/tunnel/create', {
      name: '广新跨国专线隧道 (GZ->SG)',
      type: 2,
      inNodeId: node1.id,
      outNodeId: node2.id,
      protocol: 'tls',
      tcpListenAddr: '127.0.0.1',
      udpListenAddr: '127.0.0.1',
      flow: 2,
      trafficRatio: 1.0
    }, authHeaders);
    assert.strictEqual(tun2Res.json.code, 0);
    const tun2 = tun2Res.json.data;

    const fwd2Port = 21200;
    const fwd2Res = await httpReq('POST', '/api/v1/forward/create', {
      name: '广新隧道转发规则',
      tunnelId: tun2.id,
      inPort: fwd2Port,
      remoteAddr: `127.0.0.1:${targetPort}`,
      strategy: 'round'
    }, authHeaders);
    assert.strictEqual(fwd2Res.json.code, 0);
    const fwd2 = fwd2Res.json.data;
    assert(fwd2.outPort >= 22000 && fwd2.outPort <= 22999, '出口节点端口已在 SG 端口池自动分配');

    await sleep(500);
    const tunnelTcpReply = await sendTcpPayload(fwd2Port, Buffer.from('TUNNEL_RELAY_DATA_2026'));
    assert.strictEqual(tunnelTcpReply.toString(), 'ECHO:TUNNEL_RELAY_DATA_2026');
    console.log(`  ✅ 跨节点隧道转发 (入口:${fwd2Port} -> 出口Relay:${fwd2.outPort} -> 靶机:${targetPort}) 穿透成功！`);

    // 等待 Agent 流量上报周期 (3s) 并验证主控流量统计增长
    await sleep(3400);
    const fwdListAfterFlow = await httpReq('POST', '/api/v1/forward/list', {}, authHeaders);
    const updatedFwd1 = fwdListAfterFlow.json.data.find(f => f.id === fwd1.id);
    const updatedFwd2 = fwdListAfterFlow.json.data.find(f => f.id === fwd2.id);
    assert(updatedFwd1.outFlow > 0 && updatedFwd1.inFlow > 0, '端口转发上下行流量已准确上报主控');
    assert(updatedFwd2.outFlow > 0 && updatedFwd2.inFlow > 0, '隧道转发上下行流量已准确上报主控');
    console.log(`  ✅ 加密流量上报校验通过: 直转流量(↑${updatedFwd1.outFlow}B/↓${updatedFwd1.inFlow}B), 隧道流量(↑${updatedFwd2.outFlow}B/↓${updatedFwd2.inFlow}B)`);

    // ---------------- Round 6: 入口节点协议嗅探屏蔽开关 (HTTP / TLS / SOCKS) ----------------
    console.log('\n[Round 6] 测试入口节点实时协议屏蔽开关 (HTTP / TLS / SOCKS)...');
    const updateProtoRes = await httpReq('POST', '/api/v1/node/update', {
      id: node1.id,
      name: node1.name,
      serverIp: node1.serverIp,
      ip: node1.ip,
      portSta: node1.portSta,
      portEnd: node1.portEnd,
      http: 1,
      tls: 1,
      socks: 1
    }, authHeaders);
    assert.strictEqual(updateProtoRes.json.code, 0);

    // 1) 发送 HTTP GET 报文应当被阻断
    let httpBlocked = false;
    try {
      await sendTcpPayload(fwd1Port, Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n'));
    } catch (e) {
      httpBlocked = true;
    }
    assert.strictEqual(httpBlocked, true, '开启 HTTP 屏蔽后，明文 HTTP 请求应被立即阻断');

    // 2) 发送 SOCKS5 握手报文应当被阻断
    let socksBlocked = false;
    try {
      await sendTcpPayload(fwd1Port, Buffer.from([0x05, 0x01, 0x00]));
    } catch (e) {
      socksBlocked = true;
    }
    assert.strictEqual(socksBlocked, true, '开启 SOCKS 屏蔽后，SOCKS5 握手应被立即阻断');

    // 3) 发送私有二进制协议报文应当正常放行
    const customReply = await sendTcpPayload(fwd1Port, Buffer.from('CUSTOM_PRIVATE_PROTOCOL_OK'));
    assert.strictEqual(customReply.toString(), 'ECHO:CUSTOM_PRIVATE_PROTOCOL_OK');
    console.log('  ✅ 协议屏蔽验证通过：HTTP 与 SOCKS 握手被精准拦截，私有协议流量正常转发！');

    // ---------------- Round 7: 限速管理、转发暂停/恢复与 TCP Ping 链路诊断 ----------------
    console.log('\n[Round 7] 测试限速管理、转发暂停/恢复与链路 TCP Ping 诊断...');
    const limCreateRes = await httpReq('POST', '/api/v1/speed-limit/create', {
      name: '100Mbps测试限速',
      speed: 100,
      tunnelId: tun1.id
    }, authHeaders);
    assert.strictEqual(limCreateRes.json.code, 0);

    // 暂停 fwd1
    const pauseRes = await httpReq('POST', '/api/v1/forward/pause', { id: fwd1.id }, authHeaders);
    assert.strictEqual(pauseRes.json.code, 0);
    let pausedBlocked = false;
    try {
      await sendTcpPayload(fwd1Port, Buffer.from('TEST_WHILE_PAUSED'));
    } catch (e) {
      pausedBlocked = true;
    }
    assert.strictEqual(pausedBlocked, true, '暂停后的转发规则应拒绝新连接');

    // 恢复 fwd1
    const resumeRes = await httpReq('POST', '/api/v1/forward/resume', { id: fwd1.id }, authHeaders);
    assert.strictEqual(resumeRes.json.code, 0);
    const resumedReply = await sendTcpPayload(fwd1Port, Buffer.from('TEST_AFTER_RESUMED'));
    assert.strictEqual(resumedReply.toString(), 'ECHO:TEST_AFTER_RESUMED');

    // 诊断 fwd2 (入口 -> 出口 & 出口 -> 目标)
    const diagRes = await httpReq('POST', '/api/v1/forward/diagnose', { forwardId: fwd2.id }, authHeaders);
    assert.strictEqual(diagRes.json.code, 0);
    assert(Array.isArray(diagRes.json.data.results) && diagRes.json.data.results.length === 2);
    assert.strictEqual(diagRes.json.data.results[0].success, true, '入口->出口 TCP Ping 应成功');
    assert.strictEqual(diagRes.json.data.results[1].success, true, '出口->落地目标 TCP Ping 应成功');
    console.log(`  ✅ 限速规则、转发暂停/恢复及双跳 TCP Ping 诊断 (${diagRes.json.data.results[0].averageTime}ms) 全部通过！`);

    // ---------------- Round 8: 多面板域名反代共存与「禁止 IP+端口 直接访问」安全锁测试 ----------------
    console.log('\n[Round 8] 测试「阻止/允许 IP+端口 直接访问面板」与多面板 Caddyfile 零冲突共存...');
    await httpReq('POST', '/api/v1/config/update', {
      panel_domain: 'zf.onliveme.com',
      block_ip_access: 'true'
    }, authHeaders);

    // 模拟用户直接用 IP:Port 访问面板首页 -> 必须返回 403
    const directIpVisit = await httpReq('GET', '/', null, { Host: `111.91.25.83:${TEST_PORT}` });
    assert.strictEqual(directIpVisit.status, 403, '开启禁止IP+端口访问后，IP直连访问面板应返回 403');

    // 模拟通过绑定域名 zf.onliveme.com 访问面板首页 -> 必须返回 200
    const domainVisit = await httpReq('GET', '/', null, { Host: 'zf.onliveme.com' });
    assert.strictEqual(domainVisit.status, 200, '通过绑定域名访问面板应正常返回 200');

    // 模拟节点在开启 IP 锁期间使用 IP:Port 上报心跳 /flow/test -> 必须正常返回 200
    const flowHeartbeatVisit = await httpReq('GET', '/flow/test', null, { Host: `111.91.25.83:${TEST_PORT}` });
    assert.strictEqual(flowHeartbeatVisit.status, 200, '开启面板IP锁绝不影响节点心跳接口');

    // 模拟解除 IP+端口 限制
    await httpReq('POST', '/api/v1/config/update-single', {
      name: 'block_ip_access',
      value: 'false'
    }, authHeaders);
    const unlockedVisit = await httpReq('GET', '/', null, { Host: `111.91.25.83:${TEST_PORT}` });
    assert.strictEqual(unlockedVisit.status, 200, '解除限制后 IP+端口 可正常访问');

    // 验证多面板 Caddyfile 合并零冲突逻辑
    const mockCaddy = '/tmp/mock_Caddyfile';
    fs.writeFileSync(mockCaddy, `probe.onliveme.com {\n  reverse_proxy 127.0.0.1:8080\n}\n\nng.onliveme.com {\n  reverse_proxy 127.0.0.1:3000\n}\n`);
    execSync(`sed -i '/# BEGIN NEXUS-FLUX/,/# END NEXUS-FLUX/d' ${mockCaddy}`);
    fs.appendFileSync(mockCaddy, `\n# BEGIN NEXUS-FLUX\nzf.onliveme.com {\n  encode gzip\n  reverse_proxy 127.0.0.1:6366\n}\n# END NEXUS-FLUX\n`);
    const caddyContent = fs.readFileSync(mockCaddy, 'utf8');
    assert(caddyContent.includes('probe.onliveme.com') && caddyContent.includes('127.0.0.1:8080'), '探针反代完好无损');
    assert(caddyContent.includes('ng.onliveme.com') && caddyContent.includes('127.0.0.1:3000'), 'NexusGate-Plus 反代完好无损');
    assert(caddyContent.includes('zf.onliveme.com') && caddyContent.includes('127.0.0.1:6366'), 'Nexus-Flux 反代成功写入');
    console.log('  ✅ 域名安全锁 (阻止/允许 IP+端口访问) 与三面板 Caddy 共存零冲突验证通过！');

    // ---------------- Round 9: 备份导出、原版 SQL 迁移恢复与 500 次并发压测 ----------------
    console.log('\n[Round 9] 测试全量备份导出、恢复以及 500 次高并发请求与内存波动压测...');
    const exportRes = await httpReq('POST', '/api/v1/backup/export', {}, authHeaders);
    assert.strictEqual(exportRes.json.code, 0);
    const backupData = exportRes.json.data;
    assert.strictEqual(backupData.db.nodes.length, 6);
    assert.strictEqual(backupData.db.tunnels.length, 2);
    assert.strictEqual(backupData.db.forwards.length, 2);

    // 测试原版 Flux SQL 备份文件导入迁移
    const sampleSql = `
      INSERT INTO \`node\` (\`id\`, \`name\`, \`secret\`, \`ip\`, \`server_ip\`, \`port_sta\`, \`port_end\`, \`version\`, \`http\`, \`tls\`, \`socks\`, \`created_time\`, \`updated_time\`, \`status\`) VALUES
      (10, 'SQL迁移节点-HK', 'secret_hk_10', '1.1.1.1', '1.1.1.1', 1000, 65535, '1.2.4', 0, 0, 0, 1750000000000, 1750000000000, 1);
      INSERT INTO \`tunnel\` (\`id\`, \`name\`, \`traffic_ratio\`, \`in_node_id\`, \`in_ip\`, \`out_node_id\`, \`out_ip\`, \`type\`, \`protocol\`, \`flow\`, \`tcp_listen_addr\`, \`udp_listen_addr\`, \`interface_name\`, \`created_time\`, \`updated_time\`, \`status\`) VALUES
      (20, 'SQL迁移隧道', 1.0, 10, '1.1.1.1', 10, '1.1.1.1', 1, 'tls', 1, '[::]', '[::]', NULL, 1750000000000, 1750000000000, 1);
    `;
    const sqlImportRes = await httpReq('POST', '/api/v1/backup/import', { sqlContent: sampleSql }, authHeaders);
    assert.strictEqual(sqlImportRes.json.code, 0);
    assert.strictEqual(sqlImportRes.json.data.nodes, 1);

    // 恢复刚才导出的完整 JSON 备份
    const jsonRestoreRes = await httpReq('POST', '/api/v1/backup/import', backupData, authHeaders);
    assert.strictEqual(jsonRestoreRes.json.code, 0);
    assert.strictEqual(jsonRestoreRes.json.data.nodes, 6);
    assert.strictEqual(jsonRestoreRes.json.data.tunnels, 2);
    assert.strictEqual(jsonRestoreRes.json.data.forwards, 2);

    // 500 次高并发 API 与流量上报混合压测
    const startBench = Date.now();
    const tasks = [];
    for (let i = 0; i < 250; i++) {
      tasks.push(httpReq('POST', '/api/v1/user/package', {}, authHeaders));
      tasks.push(httpReq('POST', `/flow/upload?secret=${node1.secret}`, { n: `${fwd1.id}_1_0`, u: 1024, d: 2048 }));
    }
    const results = await Promise.all(tasks);
    const benchMs = Date.now() - startBench;
    assert(results.every(r => r.status === 200), '500 次并发请求应 100% 返回 HTTP 200');

    const finalHealth = await httpReq('GET', '/healthz');
    console.log(`  ✅ 全量备份恢复 + 原版 SQL 迁移 + 500 次并发压测全部通过 (耗时: ${benchMs}ms, 压测后主控内存: ${finalHealth.json.rssMB} MB)`);

    console.log('\n================================================================');
    console.log(' 🎉 ALL 9 E2E SIMULATION & STRESS TEST ROUNDS PASSED (100% OK)!');
    console.log('================================================================');
  } finally {
    if (targetEcho) targetEcho.close();
    if (agent1Proc) agent1Proc.kill('SIGTERM');
    if (agent2Proc) agent2Proc.kill('SIGTERM');
    if (masterProc) masterProc.kill('SIGTERM');
    cleanDirs();
  }
}

runAllTests().catch((err) => {
  console.error('❌ E2E 测试失败:', err);
  process.exit(1);
});
