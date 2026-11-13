#!/bin/bash
# ==============================================================================
# Nexus-Flux · 节点被控端一键安装与管理脚本 (支持极简原生 Light 引擎 & 原版 GOST 引擎)
# ==============================================================================

set -e
export LANG=en_US.UTF-8
export LC_ALL=C

INSTALL_DIR="/etc/gost"
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

install_agent() {
  if [[ -z "$SERVER_ADDR" ]]; then
    read -p "请输入主控服务器地址 (如 zf.onliveme.com:6366): " SERVER_ADDR
  fi
  if [[ -z "$SECRET" ]]; then
    read -p "请输入节点通信密钥 (Secret): " SECRET
  fi
  if [[ -z "$SERVER_ADDR" || -z "$SECRET" ]]; then
    echo "❌ 参数不完整，已取消安装。"
    exit 1
  fi

  mkdir -p "$INSTALL_DIR"

  if systemctl list-units --full -all 2>/dev/null | grep -Fq "gost.service"; then
    systemctl stop gost 2>/dev/null || true
  fi

  # 写入 config.json (与原版 GOST 100% 兼容)
  cat > "$INSTALL_DIR/config.json" <<EOF
{
  "addr": "$SERVER_ADDR",
  "secret": "$SECRET",
  "http": 0,
  "tls": 0,
  "socks": 0
}
EOF

  if [[ ! -f "$INSTALL_DIR/gost.json" ]]; then
    echo "{}" > "$INSTALL_DIR/gost.json"
  fi
  chmod 600 "$INSTALL_DIR"/*.json

  if [[ "$ENGINE_MODE" == "gost" ]]; then
    ARCH=$(get_architecture)
    DOWNLOAD_URL="https://github.com/bqlpfy/flux-panel/releases/download/1.4.3/gost-${ARCH}"
    COUNTRY=$(curl -s --max-time 3 https://ipinfo.io/country || echo "")
    if [[ "$COUNTRY" == "CN" ]]; then
      DOWNLOAD_URL="https://ghfast.top/${DOWNLOAD_URL}"
    fi
    echo "⬇️ 正在下载原版 GOST 二进制 ($ARCH)..."
    curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_DIR/gost"
    chmod +x "$INSTALL_DIR/gost"
    EXEC_CMD="$INSTALL_DIR/gost"
  else
    ensure_node_runtime
    CLEAN_ADDR=$(echo "$SERVER_ADDR" | sed -E 's#^https?://##; s#/$##')
    echo "⬇️ 正在从主控拉取极简原生转发引擎 nexus-flux-agent.js..."
    if ! curl -fsSL "http://${CLEAN_ADDR}/agent/nexus-flux-agent.js" -o "$INSTALL_DIR/nexus-flux-agent.js" 2>/dev/null; then
      curl -fsSL "https://raw.githubusercontent.com/mor2026-28/Nexus-flux/main/agent/nexus-flux-agent.js" -o "$INSTALL_DIR/nexus-flux-agent.js"
    fi
    chmod +x "$INSTALL_DIR/nexus-flux-agent.js"
    NODE_BIN=$(command -v node || echo "/usr/bin/node")
    EXEC_CMD="$NODE_BIN --max-semi-space-size=2 --max-old-space-size=48 $INSTALL_DIR/nexus-flux-agent.js"
  fi

  cat > /etc/systemd/system/gost.service <<EOF
[Unit]
Description=Nexus-Flux Forwarding Node Agent ($ENGINE_MODE)
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$EXEC_CMD
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable gost >/dev/null 2>&1 || true
  systemctl restart gost

  echo "======================================================="
  echo " ✅ Nexus-Flux 节点被控安装完成 ($ENGINE_MODE 模式)"
  echo " 📁 配置目录: $INSTALL_DIR"
  echo " 🔧 运行状态: $(systemctl is-active gost 2>/dev/null || echo 'running')"
  echo "======================================================="
}

uninstall_agent() {
  systemctl stop gost 2>/dev/null || true
  systemctl disable gost 2>/dev/null || true
  rm -f /etc/systemd/system/gost.service
  rm -rf "$INSTALL_DIR"
  systemctl daemon-reload 2>/dev/null || true
  echo "✅ 节点被控端已彻底卸载"
}

if [[ -n "$SERVER_ADDR" && -n "$SECRET" ]]; then
  install_agent
  exit 0
fi

echo "==============================================="
echo "       ✨ Nexus-Flux 节点被控管理脚本 ✨"
echo "==============================================="
echo " 1. 安装轻量原生被控 (推荐 · 仅占 ~12MB 内存)"
echo " 2. 安装原版 GOST 被控"
echo " 3. 重启被控服务"
echo " 4. 卸载被控服务"
echo " 0. 退出"
echo "==============================================="
read -p "请选择操作 [0-4]: " choice
case "$choice" in
  1) ENGINE_MODE="light"; install_agent ;;
  2) ENGINE_MODE="gost"; install_agent ;;
  3) systemctl restart gost && echo "✅ 已重启被控服务" ;;
  4) uninstall_agent ;;
  *) exit 0 ;;
esac
