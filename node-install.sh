#!/bin/bash
# ==============================================================================
# Nexus-Flux · 节点被控端一键安装与无损继承脚本 (v1.0.0)
# 支持自动继承节点原有转发规则 (/etc/gost/gost.json)，实现零断流无缝切换
# ==============================================================================

set -e
export LANG=en_US.UTF-8
export LC_ALL=C

AGENT_DIR="/opt/nexus-agent"
LEGACY_DIR="/etc/gost"
SERVER_ADDR=""
SECRET=""

while getopts "a:s:m:" opt; do
  case $opt in
    a) SERVER_ADDR="$OPTARG" ;;
    s) SECRET="$OPTARG" ;;
    *) ;;
  esac
done

ensure_latest_node_runtime() {
  local need_install=0
  if ! command -v node &>/dev/null; then
    need_install=1
  else
    local major_ver
    major_ver=$(node -v 2>/dev/null | sed 's/^v//' | cut -d'.' -f1)
    if [[ -z "$major_ver" || "$major_ver" -lt 18 ]]; then
      need_install=1
    fi
  fi

  if [[ "$need_install" -eq 0 ]]; then
    return 0
  fi

  echo "📦 正在安装最新稳定版 Node.js 22 LTS 运行时..."
  if [ -f /etc/debian_version ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y curl ca-certificates gnupg >/dev/null 2>&1 || true
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || true
    apt-get install -y nodejs >/dev/null 2>&1 || true
  elif [ -f /etc/redhat-release ]; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || true
    yum install -y nodejs curl ca-certificates >/dev/null 2>&1 || dnf install -y nodejs curl ca-certificates >/dev/null 2>&1 || true
  elif [ -f /etc/alpine-release ]; then
    apk add --no-cache nodejs curl ca-certificates >/dev/null 2>&1 || true
  fi
}

migrate_existing_rules_and_stop_old() {
  mkdir -p "$AGENT_DIR"

  # 1. 自动继承节点上已有的转发规则与隧道链 (/etc/gost/gost.json -> /opt/nexus-agent/gost.json)
  if [[ -f "$LEGACY_DIR/gost.json" && -s "$LEGACY_DIR/gost.json" ]]; then
    local fsize
    fsize=$(wc -c < "$LEGACY_DIR/gost.json" 2>/dev/null || echo 0)
    if [[ "$fsize" -gt 5 ]]; then
      echo "🔄 检测到本机已有正在运行的转发配置 ($LEGACY_DIR/gost.json)，正在无损继承..."
      cp -f "$LEGACY_DIR/gost.json" "$AGENT_DIR/gost.json"
    fi
  fi

  # 2. 读取旧配置的 http/tls/socks 协议开关状态
  OLD_HTTP=0
  OLD_TLS=0
  OLD_SOCKS=0
  if [[ -f "$LEGACY_DIR/config.json" ]] && command -v node &>/dev/null; then
    eval "$(node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync('$LEGACY_DIR/config.json', 'utf8'));
        console.log('OLD_HTTP=' + (Number(c.http) || 0));
        console.log('OLD_TLS=' + (Number(c.tls) || 0));
        console.log('OLD_SOCKS=' + (Number(c.socks) || 0));
      } catch (e) {}
    " 2>/dev/null || true)"
  elif [[ -f "$AGENT_DIR/config.json" ]] && command -v node &>/dev/null; then
    eval "$(node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync('$AGENT_DIR/config.json', 'utf8'));
        console.log('OLD_HTTP=' + (Number(c.http) || 0));
        console.log('OLD_TLS=' + (Number(c.tls) || 0));
        console.log('OLD_SOCKS=' + (Number(c.socks) || 0));
      } catch (e) {}
    " 2>/dev/null || true)"
  fi

  # 3. 停止并清理旧服务，释放端口并清理旧二进制垃圾
  if systemctl list-units --full -all 2>/dev/null | grep -Fq "nexus-agent.service"; then
    systemctl stop nexus-agent 2>/dev/null || true
  fi
  if systemctl list-units --full -all 2>/dev/null | grep -Fq "gost.service"; then
    systemctl stop gost 2>/dev/null || true
    systemctl disable gost 2>/dev/null || true
    rm -f /etc/systemd/system/gost.service
  fi
  pkill -f "/etc/gost/gost" 2>/dev/null || true
  if [[ -d "$LEGACY_DIR" ]]; then
    rm -rf "$LEGACY_DIR"
  fi
}

install_agent() {
  if [[ -z "$SERVER_ADDR" ]]; then
    read -p "请输入服务器通信地址 (如 example.com:6366): " SERVER_ADDR
  fi
  if [[ -z "$SECRET" ]]; then
    read -p "请输入节点通信密钥: " SECRET
  fi
  if [[ -z "$SERVER_ADDR" || -z "$SECRET" ]]; then
    echo "❌ 参数不完整，操作已取消。"
    exit 1
  fi

  ensure_latest_node_runtime
  migrate_existing_rules_and_stop_old

  cat > "$AGENT_DIR/config.json" <<EOF
{
  "addr": "$SERVER_ADDR",
  "secret": "$SECRET",
  "http": ${OLD_HTTP:-0},
  "tls": ${OLD_TLS:-0},
  "socks": ${OLD_SOCKS:-0}
}
EOF
  [[ ! -f "$AGENT_DIR/gost.json" ]] && echo "{}" > "$AGENT_DIR/gost.json"
  chmod 600 "$AGENT_DIR"/*.json

  CLEAN_ADDR=$(echo "$SERVER_ADDR" | sed -E 's#^https?://##; s#/$##')
  echo "⬇️ 正在下载节点服务程序..."
  if ! curl -fsSL "http://${CLEAN_ADDR}/agent/nexus-flux-agent.js" -o "$AGENT_DIR/nexus-agent.js" 2>/dev/null; then
    if ! curl -fsSL "https://${CLEAN_ADDR}/agent/nexus-flux-agent.js" -o "$AGENT_DIR/nexus-agent.js" 2>/dev/null; then
      curl -fsSL "https://raw.githubusercontent.com/mor2026-28/Nexus-flux/main/agent/nexus-flux-agent.js" -o "$AGENT_DIR/nexus-agent.js"
    fi
  fi
  chmod +x "$AGENT_DIR/nexus-agent.js"
  NODE_BIN=$(command -v node || echo "/usr/bin/node")

  cat > /etc/systemd/system/nexus-agent.service <<EOF
[Unit]
Description=Nexus-Flux Node Agent Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$AGENT_DIR
ExecStart=$NODE_BIN --max-semi-space-size=2 --max-old-space-size=48 $AGENT_DIR/nexus-agent.js
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable nexus-agent >/dev/null 2>&1 || true
  systemctl restart nexus-agent

  echo "======================================================="
  echo " ✅ 节点安装完成，已无损接管本机转发规则并连接主控"
  echo " 📁 配置目录: $AGENT_DIR"
  echo " 🔧 服务状态: $(systemctl is-active nexus-agent 2>/dev/null || echo 'running')"
  echo "======================================================="
}

update_agent() {
  if [[ ! -d "$AGENT_DIR" || ! -f "$AGENT_DIR/config.json" ]]; then
    echo "❌ 节点尚未安装，请先执行安装。"
    return 1
  fi
  ensure_latest_node_runtime
  SERVER_ADDR=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$AGENT_DIR/config.json','utf8')).addr||'')}catch(e){}" 2>/dev/null || echo "")
  CLEAN_ADDR=$(echo "$SERVER_ADDR" | sed -E 's#^https?://##; s#/$##')
  echo "🔄 正在更新节点程序..."
  if ! curl -fsSL "http://${CLEAN_ADDR}/agent/nexus-flux-agent.js" -o "$AGENT_DIR/nexus-agent.js.new" 2>/dev/null; then
    curl -fsSL "https://raw.githubusercontent.com/mor2026-28/Nexus-flux/main/agent/nexus-flux-agent.js" -o "$AGENT_DIR/nexus-agent.js.new"
  fi
  mv -f "$AGENT_DIR/nexus-agent.js.new" "$AGENT_DIR/nexus-agent.js"
  chmod +x "$AGENT_DIR/nexus-agent.js"
  systemctl restart nexus-agent
  echo "✅ 节点更新完成"
}

uninstall_agent() {
  systemctl stop nexus-agent 2>/dev/null || true
  systemctl disable nexus-agent 2>/dev/null || true
  systemctl stop gost 2>/dev/null || true
  systemctl disable gost 2>/dev/null || true
  rm -f /etc/systemd/system/nexus-agent.service /etc/systemd/system/gost.service
  rm -rf "$AGENT_DIR" "$LEGACY_DIR"
  systemctl daemon-reload 2>/dev/null || true
  echo "✅ 节点服务已彻底卸载"
}

if [[ -n "$SERVER_ADDR" && -n "$SECRET" ]]; then
  install_agent
  exit 0
fi

echo "==============================================="
echo "           Nexus-Flux 节点管理脚本"
echo "==============================================="
echo " 1. 安装节点"
echo " 2. 更新节点"
echo " 3. 重启节点"
echo " 4. 卸载节点"
echo " 0. 退出"
echo "==============================================="
read -p "请选择操作 [0-4]: " choice
case "$choice" in
  1) install_agent ;;
  2) update_agent ;;
  3) systemctl restart nexus-agent && echo "✅ 已重启节点服务" ;;
  4) uninstall_agent ;;
  *) exit 0 ;;
esac
