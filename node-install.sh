#!/bin/bash
# ==============================================================================
# Nexus-Flux · 节点被控端一键安装与管理脚本
# 默认采用极简原生异步流转发引擎 (无 gost 进程特征，防国内云安全扫描警告，内存仅 ~12MB)
# ==============================================================================

set -e
export LANG=en_US.UTF-8
export LC_ALL=C

LIGHT_DIR="/opt/nexus-agent"
GOST_DIR="/etc/gost"
ENGINE_MODE="light"
SERVER_ADDR=""
SECRET=""

while getopts "a:s:m:" opt; do
  case $opt in
    a) SERVER_ADDR="$OPTARG" ;;
    s) SECRET="$OPTARG" ;;
    m) ENGINE_MODE="$OPTARG" ;;
    *) ;;
  esac
done

get_architecture() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "amd64" ;;
  esac
}

ensure_node_runtime() {
  if command -v node &>/dev/null; then
    return 0
  fi
  echo "📦 正在安装轻量 Node.js 运行时..."
  if [ -f /etc/debian_version ]; then
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y nodejs curl ca-certificates >/dev/null 2>&1 || true
  elif [ -f /etc/redhat-release ]; then
    yum install -y nodejs curl ca-certificates >/dev/null 2>&1 || dnf install -y nodejs curl ca-certificates >/dev/null 2>&1 || true
  elif [ -f /etc/alpine-release ]; then
    apk add --no-cache nodejs curl ca-certificates >/dev/null 2>&1 || true
  fi
}

stop_existing_agents() {
  # 平滑停止可能存在的旧版 gost 或 nexus-agent 服务，释放转发端口
  if systemctl list-units --full -all 2>/dev/null | grep -Fq "gost.service"; then
    systemctl stop gost 2>/dev/null || true
    systemctl disable gost 2>/dev/null || true
  fi
  if systemctl list-units --full -all 2>/dev/null | grep -Fq "nexus-agent.service"; then
    systemctl stop nexus-agent 2>/dev/null || true
  fi
}

install_agent() {
  if [[ -z "$SERVER_ADDR" ]]; then
    read -p "请输入主控服务器地址 (如 zf.vponlive.com:6366): " SERVER_ADDR
  fi
  if [[ -z "$SECRET" ]]; then
    read -p "请输入节点通信密钥 (Secret): " SECRET
  fi
  if [[ -z "$SERVER_ADDR" || -z "$SECRET" ]]; then
    echo "❌ 参数不完整，已取消安装。"
    exit 1
  fi

  stop_existing_agents

  if [[ "$ENGINE_MODE" == "gost" ]]; then
    mkdir -p "$GOST_DIR"
    cat > "$GOST_DIR/config.json" <<EOF
{
  "addr": "$SERVER_ADDR",
  "secret": "$SECRET",
  "http": 0,
  "tls": 0,
  "socks": 0
}
EOF
    [[ ! -f "$GOST_DIR/gost.json" ]] && echo "{}" > "$GOST_DIR/gost.json"
    chmod 600 "$GOST_DIR"/*.json

    ARCH=$(get_architecture)
    DOWNLOAD_URL="https://github.com/bqlpfy/flux-panel/releases/download/1.4.3/gost-${ARCH}"
    COUNTRY=$(curl -s --max-time 3 https://ipinfo.io/country || echo "")
    if [[ "$COUNTRY" == "CN" ]]; then
      DOWNLOAD_URL="https://ghfast.top/${DOWNLOAD_URL}"
    fi
    echo "⬇️ 正在下载 GOST 二进制 ($ARCH)..."
    curl -fsSL "$DOWNLOAD_URL" -o "$GOST_DIR/gost"
    chmod +x "$GOST_DIR/gost"

    cat > /etc/systemd/system/gost.service <<EOF
[Unit]
Description=Gost Proxy Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$GOST_DIR
ExecStart=$GOST_DIR/gost
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable gost >/dev/null 2>&1 || true
    systemctl restart gost
    echo "✅ GOST 模式被控安装完成 (运行状态: $(systemctl is-active gost))"
  else
    ensure_node_runtime
    mkdir -p "$LIGHT_DIR"
    cat > "$LIGHT_DIR/config.json" <<EOF
{
  "addr": "$SERVER_ADDR",
  "secret": "$SECRET",
  "http": 0,
  "tls": 0,
  "socks": 0
}
EOF
    [[ ! -f "$LIGHT_DIR/gost.json" ]] && echo "{}" > "$LIGHT_DIR/gost.json"
    chmod 600 "$LIGHT_DIR"/*.json

    CLEAN_ADDR=$(echo "$SERVER_ADDR" | sed -E 's#^https?://##; s#/$##')
    echo "⬇️ 正在拉取轻量转发引擎..."
    if ! curl -fsSL "http://${CLEAN_ADDR}/agent/nexus-flux-agent.js" -o "$LIGHT_DIR/nexus-agent.js" 2>/dev/null; then
      if ! curl -fsSL "https://${CLEAN_ADDR}/agent/nexus-flux-agent.js" -o "$LIGHT_DIR/nexus-agent.js" 2>/dev/null; then
        curl -fsSL "https://raw.githubusercontent.com/mor2026-28/Nexus-flux/main/agent/nexus-flux-agent.js" -o "$LIGHT_DIR/nexus-agent.js"
      fi
    fi
    chmod +x "$LIGHT_DIR/nexus-agent.js"
    NODE_BIN=$(command -v node || echo "/usr/bin/node")

    cat > /etc/systemd/system/nexus-agent.service <<EOF
[Unit]
Description=System Network Relay Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=$LIGHT_DIR
ExecStart=$NODE_BIN --max-semi-space-size=2 --max-old-space-size=48 $LIGHT_DIR/nexus-agent.js
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
    echo " ✅ 节点被控端安装完成 (轻量原生内核 · 防扫描中性服务)"
    echo " 📁 配置目录: $LIGHT_DIR"
    echo " 🔧 服务状态: $(systemctl is-active nexus-agent 2>/dev/null || echo 'running')"
    echo "======================================================="
  fi
}

uninstall_agent() {
  stop_existing_agents
  rm -f /etc/systemd/system/nexus-agent.service /etc/systemd/system/gost.service
  rm -rf "$LIGHT_DIR" "$GOST_DIR"
  systemctl daemon-reload 2>/dev/null || true
  echo "✅ 节点被控端已彻底卸载"
}

if [[ -n "$SERVER_ADDR" && -n "$SECRET" ]]; then
  install_agent
  exit 0
fi

echo "==============================================="
echo "       ✨ 节点被控端管理脚本 ✨"
echo "==============================================="
echo " 1. 安装轻量原生被控 (推荐 · 防云盾扫描 / 低内存)"
echo " 2. 安装原版 GOST 被控"
echo " 3. 重启被控服务"
echo " 4. 卸载被控服务"
echo " 0. 退出"
echo "==============================================="
read -p "请选择操作 [0-4]: " choice
case "$choice" in
  1) ENGINE_MODE="light"; install_agent ;;
  2) ENGINE_MODE="gost"; install_agent ;;
  3) systemctl restart nexus-agent 2>/dev/null || systemctl restart gost 2>/dev/null || true; echo "✅ 已重启被控服务" ;;
  4) uninstall_agent ;;
  *) exit 0 ;;
esac
