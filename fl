#!/bin/bash
# ==============================================================================
# ✨ Nexus-Flux · 极简轻量转发主控面板 一键安装与 SSH 管理脚本 (fl) ✨
# 适用系统: Debian 12 / 13, Ubuntu 20 / 22 / 24, CentOS / Alma / Alpine
# 架构特点: 零 Docker / 零 MySQL / 零 Java，常驻物理内存仅 ~18-25 MB
# 多面板共存: 与「极简私有探针 (8080)」及「NexusGate-Plus (ng)」共享 Caddy 零冲突
# ==============================================================================

set -e
export LANG=en_US.UTF-8
export LC_ALL=C

PANEL_DIR="/opt/nexus-flux"
DATA_DIR="/opt/nexus-flux/data"
BACKUP_DIR="/opt/nexus-flux/data/backups"
ENV_FILE="/opt/nexus-flux/.env"
SERVICE_FILE="/etc/systemd/system/nexus-flux.service"
CADDY_FILE="/etc/caddy/Caddyfile"
FL_BIN="/usr/local/bin/fl"
REPO_RAW_URL="https://raw.githubusercontent.com/mor2026-28/Nexus-flux/main"

# 颜色定义
GREEN="\033[32m"
BLUE="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

get_panel_port() {
  if [[ -f "$ENV_FILE" ]]; then
    local p
    p=$(grep "^FLUX_PORT=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2)
    echo "${p:-6366}"
  else
    echo "6366"
  fi
}

get_panel_domain() {
  if [[ -f "$DATA_DIR/flux-db.json" ]] && command -v node &>/dev/null; then
    node -e "try{const d=JSON.parse(require('fs').readFileSync('$DATA_DIR/flux-db.json','utf8'));console.log((d.configs&&d.configs.panel_domain)||'')}catch(e){}" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

get_block_ip_status() {
  if [[ -f "$DATA_DIR/flux-db.json" ]] && command -v node &>/dev/null; then
    node -e "try{const d=JSON.parse(require('fs').readFileSync('$DATA_DIR/flux-db.json','utf8'));console.log((d.configs&&d.configs.block_ip_access)==='true'?'已阻止IP+端口直连 (仅允许域名)':'允许IP+端口直接访问')}catch(e){console.log('允许IP+端口直接访问')}" 2>/dev/null
  else
    echo "未安装"
  fi
}

get_public_ip() {
  curl -s --max-time 4 https://api.ipify.org || curl -s --max-time 4 https://ifconfig.me || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1"
}

ensure_dependencies() {
  if ! command -v curl &>/dev/null || ! command -v unzip &>/dev/null || ! command -v zip &>/dev/null; then
    if [ -f /etc/debian_version ]; then
      apt-get update -y >/dev/null 2>&1 || true
      apt-get install -y curl unzip zip ca-certificates >/dev/null 2>&1 || true
    elif [ -f /etc/redhat-release ]; then
      yum install -y curl unzip zip ca-certificates >/dev/null 2>&1 || true
    fi
  fi

  if ! command -v node &>/dev/null; then
    echo -e "${BLUE}📦 正在安装轻量级 Node.js 运行环境...${RESET}"
    if [ -f /etc/debian_version ]; then
      apt-get update -y >/dev/null 2>&1 || true
      apt-get install -y nodejs >/dev/null 2>&1 || true
    elif [ -f /etc/redhat-release ]; then
      yum install -y nodejs >/dev/null 2>&1 || dnf install -y nodejs >/dev/null 2>&1 || true
    fi
  fi
}

install_fl_command() {
  if [[ -f "$PANEL_DIR/install.sh" ]]; then
    cp -f "$PANEL_DIR/install.sh" "$FL_BIN"
    chmod +x "$FL_BIN"
    ln -sf "$FL_BIN" /usr/bin/fl 2>/dev/null || true
  fi
}

# 1. 安装面板
install_panel() {
  echo -e "${BLUE}🚀 开始安装 Nexus-Flux 极简轻量转发主控面板...${RESET}"
  ensure_dependencies

  local default_port
  default_port=$(get_panel_port)
  read -p "请输入主控监听端口 [默认 ${default_port}]: " input_port
  local port="${input_port:-$default_port}"

  read -p "请输入初始管理员用户名 [默认 admin_user]: " input_user
  local admin_user="${input_user:-admin_user}"

  read -p "请输入初始管理员密码 [默认 admin_user]: " input_pwd
  local admin_pwd="${input_pwd:-admin_user}"

  mkdir -p "$PANEL_DIR/public" "$PANEL_DIR/agent" "$DATA_DIR" "$BACKUP_DIR"

  # 如果当前脚本所在目录已有项目文件，直接复制；否则从 GitHub 仓库拉取
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$script_dir/server.js" && -f "$script_dir/public/index.html" ]]; then
    if [[ "$script_dir" != "$PANEL_DIR" ]]; then
      cp -rf "$script_dir/"* "$PANEL_DIR/"
    fi
  else
    echo -e "${BLUE}⬇️ 正在从 GitHub 仓库下载最新组件...${RESET}"
    curl -fsSL "$REPO_RAW_URL/server.js" -o "$PANEL_DIR/server.js"
    curl -fsSL "$REPO_RAW_URL/public/index.html" -o "$PANEL_DIR/public/index.html"
    curl -fsSL "$REPO_RAW_URL/agent/nexus-flux-agent.js" -o "$PANEL_DIR/agent/nexus-flux-agent.js"
    curl -fsSL "$REPO_RAW_URL/node-install.sh" -o "$PANEL_DIR/node-install.sh"
    curl -fsSL "$REPO_RAW_URL/install.sh" -o "$PANEL_DIR/install.sh"
  fi

  chmod +x "$PANEL_DIR/server.js" "$PANEL_DIR/agent/nexus-flux-agent.js" "$PANEL_DIR/node-install.sh" "$PANEL_DIR/install.sh"

  local pub_ip
  pub_ip=$(get_public_ip)

  cat > "$ENV_FILE" <<EOF
FLUX_PORT=$port
FLUX_BIND_HOST=0.0.0.0
FLUX_ADMIN_USER=$admin_user
FLUX_ADMIN_PWD=$admin_pwd
FLUX_PUBLIC_ADDR=${pub_ip}:${port}
NEXUS_FLUX_DATA_DIR=$DATA_DIR
EOF
  chmod 600 "$ENV_FILE"

  local node_bin
  node_bin=$(command -v node || echo "/usr/bin/node")

  if command -v systemctl &>/dev/null && [[ -d /run/systemd/system ]]; then
    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Nexus-Flux Lightweight Forwarding Master Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=$PANEL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$node_bin --max-semi-space-size=2 --max-old-space-size=64 $PANEL_DIR/server.js
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable nexus-flux >/dev/null 2>&1 || true
    systemctl restart nexus-flux
  else
    pkill -f "[n]exus-flux/server.js" 2>/dev/null || true
    nohup env $(cat "$ENV_FILE" | xargs) "$node_bin" --max-semi-space-size=2 --max-old-space-size=64 "$PANEL_DIR/server.js" > "$PANEL_DIR/panel.log" 2>&1 &
  fi

  install_fl_command
  sleep 1

  echo -e "======================================================"
  echo -e " 🎉 ${GREEN}Nexus-Flux 面板安装并启动成功！${RESET}"
  echo -e " 🌐 面板访问地址: ${BLUE}http://${pub_ip}:${port}${RESET}"
  echo -e " 👤 管理员账号:   ${YELLOW}${admin_user}${RESET}"
  echo -e " 🔑 管理员密码:   ${YELLOW}${admin_pwd}${RESET}"
  echo -e " 💻 快捷管理命令: 在 SSH 任意位置输入 ${GREEN}fl${RESET} 即可唤起管理菜单"
  echo -e "======================================================"
}

# 2. 更新面板 (保留全部数据无损更新)
update_panel() {
  echo -e "${BLUE}🔄 正在更新 Nexus-Flux 主控面板 (保留全部节点与转发数据)...${RESET}"
  if [[ ! -d "$PANEL_DIR" ]]; then
    echo -e "${RED}❌ 面板尚未安装，请先执行选项 1 安装面板。${RESET}"
    return 1
  fi

  # 自动备份当前数据
  export_backup "auto_pre_update" >/dev/null 2>&1 || true

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$script_dir/server.js" && "$script_dir" != "$PANEL_DIR" ]]; then
    cp -f "$script_dir/server.js" "$PANEL_DIR/server.js"
    cp -f "$script_dir/public/index.html" "$PANEL_DIR/public/index.html"
    cp -f "$script_dir/agent/nexus-flux-agent.js" "$PANEL_DIR/agent/nexus-flux-agent.js"
    cp -f "$script_dir/node-install.sh" "$PANEL_DIR/node-install.sh"
    cp -f "$script_dir/install.sh" "$PANEL_DIR/install.sh"
  else
    curl -fsSL "$REPO_RAW_URL/server.js" -o "$PANEL_DIR/server.js.new" && mv "$PANEL_DIR/server.js.new" "$PANEL_DIR/server.js"
    curl -fsSL "$REPO_RAW_URL/public/index.html" -o "$PANEL_DIR/public/index.html.new" && mv "$PANEL_DIR/public/index.html.new" "$PANEL_DIR/public/index.html"
    curl -fsSL "$REPO_RAW_URL/agent/nexus-flux-agent.js" -o "$PANEL_DIR/agent/nexus-flux-agent.js.new" && mv "$PANEL_DIR/agent/nexus-flux-agent.js.new" "$PANEL_DIR/agent/nexus-flux-agent.js"
    curl -fsSL "$REPO_RAW_URL/node-install.sh" -o "$PANEL_DIR/node-install.sh.new" && mv "$PANEL_DIR/node-install.sh.new" "$PANEL_DIR/node-install.sh"
  fi

  install_fl_command
  restart_panel
  echo -e "${GREEN}✅ Nexus-Flux 更新完成，所有节点与转发数据完好无损！${RESET}"
}

# 3. 重启面板服务
restart_panel() {
  echo -e "${BLUE}🔄 正在重启 Nexus-Flux 主控服务...${RESET}"
  if command -v systemctl &>/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl restart nexus-flux
  else
    pkill -f "[n]exus-flux/server.js" 2>/dev/null || true
    local node_bin
    node_bin=$(command -v node || echo "/usr/bin/node")
    nohup env $(cat "$ENV_FILE" | xargs) "$node_bin" --max-semi-space-size=2 --max-old-space-size=64 "$PANEL_DIR/server.js" > "$PANEL_DIR/panel.log" 2>&1 &
  fi
  sleep 1
  echo -e "${GREEN}✅ 服务已重启完成${RESET}"
}

# 4. 查看面板状态
status_panel() {
  local port
  port=$(get_panel_port)
  echo -e "======================================================"
  echo -e " 📊 Nexus-Flux 主控运行状态检查"
  echo -e "======================================================"
  curl -s -H "X-Nexus-Local: 1" "http://127.0.0.1:${port}/healthz" || echo "服务未响应"
  echo ""
  if command -v systemctl &>/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl status nexus-flux --no-pager -n 12 || true
  fi
}

# 5. 面板域名设置 (自动配置 Caddy HTTPS 反代，与探针 8080 和 NexusGate-Plus 零冲突)
configure_domain() {
  local port
  port=$(get_panel_port)
  local current_domain
  current_domain=$(get_panel_domain)
  echo -e "======================================================"
  echo -e " 🌐 面板域名设置 (自动配置 Caddy HTTPS 反代 · 多面板零冲突)"
  echo -e " 当前绑定域名: ${YELLOW}${current_domain:-未绑定}${RESET}"
  echo -e "======================================================"
  read -p "请输入要绑定的新域名 (如 zf.onliveme.com，输入 clear 解绑): " domain
  domain=$(echo "$domain" | tr -d '[:space:]' | sed -E 's#^https?://##; s#/.*$##')
  if [[ -z "$domain" ]]; then
    echo -e "${YELLOW}⚠️ 域名为空，操作已取消。${RESET}"
    return 0
  fi

  if [[ "$domain" == "clear" ]]; then
    if [[ -f "$CADDY_FILE" ]]; then
      sed -i '/# BEGIN NEXUS-FLUX/,/# END NEXUS-FLUX/d' "$CADDY_FILE"
      systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
    fi
    curl -s -X POST "http://127.0.0.1:${port}/api/v1/config/update" \
      -H "Content-Type: application/json" \
      -H "X-Nexus-Local: 1" \
      -d '{"panel_domain":"","block_ip_access":"false"}' >/dev/null 2>&1 || true
    echo -e "${GREEN}✅ 已解绑面板域名并恢复 IP+端口 访问${RESET}"
    return 0
  fi

  # 安装 Caddy（如果尚未安装）
  if ! command -v caddy &>/dev/null; then
    echo -e "${BLUE}📦 正在安装 Caddy 反代服务...${RESET}"
    if [ -f /etc/debian_version ]; then
      apt-get update -y >/dev/null 2>&1 || true
      apt-get install -y caddy >/dev/null 2>&1 || true
    elif [ -f /etc/redhat-release ]; then
      yum install -y caddy >/dev/null 2>&1 || dnf install -y caddy >/dev/null 2>&1 || true
    fi
  fi

  mkdir -p /etc/caddy
  touch "$CADDY_FILE"

  # 检查该域名是否已被探针或 NexusGate-Plus 使用（排除 NEXUS-FLUX 自身区块）
  local temp_other
  temp_other=$(sed '/# BEGIN NEXUS-FLUX/,/# END NEXUS-FLUX/d' "$CADDY_FILE")
  if echo "$temp_other" | grep -Fq "$domain"; then
    echo -e "${RED}❌ 检测到域名 ${domain} 已被本机其他面板 (如探针或 NexusGate-Plus) 占用！请使用不同的二级域名。${RESET}"
    return 1
  fi

  # 仅移除旧的 # BEGIN NEXUS-FLUX 区块，绝不触碰探针 (8080) 和 NexusGate-Plus 的配置！
  sed -i '/# BEGIN NEXUS-FLUX/,/# END NEXUS-FLUX/d' "$CADDY_FILE"

  cat >> "$CADDY_FILE" <<EOF

# BEGIN NEXUS-FLUX
${domain} {
    encode gzip
    reverse_proxy 127.0.0.1:${port}
}
# END NEXUS-FLUX
EOF

  # 同步更新面板数据库中的 panel_domain
  curl -s -X POST "http://127.0.0.1:${port}/api/v1/config/update-single" \
    -H "Content-Type: application/json" \
    -H "X-Nexus-Local: 1" \
    -d "{\"name\":\"panel_domain\",\"value\":\"${domain}\"}" >/dev/null 2>&1 || true

  if command -v caddy &>/dev/null && command -v systemctl &>/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl enable caddy >/dev/null 2>&1 || true
    systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
  fi

  echo -e "${GREEN}✅ 域名设置完成！您的面板现可通过 https://${domain} 访问（与本机其他面板共享 Caddy 零冲突）。${RESET}"
  echo -e "💡 如需禁止通过 IP+${port} 直接访问面板，请继续在菜单中选择「5. 阻止 IP+${port} 端口直接访问」。"
}

# 6. 阻止 IP+端口 直接访问面板
block_ip_port_access() {
  local port
  port=$(get_panel_port)
  local domain
  domain=$(get_panel_domain)
  if [[ -z "$domain" ]]; then
    echo -e "${YELLOW}⚠️ 您尚未绑定面板域名！请先执行「4. 面板域名设置」绑定域名后再开启此项，以免把自己锁在面板外面。${RESET}"
    return 1
  fi

  curl -s -X POST "http://127.0.0.1:${port}/api/v1/config/update-single" \
    -H "Content-Type: application/json" \
    -H "X-Nexus-Local: 1" \
    -d '{"name":"block_ip_access","value":"true"}' >/dev/null 2>&1

  echo -e "${GREEN}🔒 已成功阻止 IP+${port} 直接访问 Web 面板！${RESET}"
  echo -e "   • 现在只能通过 ${BLUE}https://${domain}${RESET} 访问面板后台。"
  echo -e "   • 被控节点心跳与流量上报接口仍安全放行，不会影响节点在线状态！"
}

# 7. 允许 IP+端口 直接访问面板
allow_ip_port_access() {
  local port
  port=$(get_panel_port)
  curl -s -X POST "http://127.0.0.1:${port}/api/v1/config/update-single" \
    -H "Content-Type: application/json" \
    -H "X-Nexus-Local: 1" \
    -d '{"name":"block_ip_access","value":"false"}' >/dev/null 2>&1

  local pub_ip
  pub_ip=$(get_public_ip)
  echo -e "${GREEN}🔓 已解除限制，允许通过 http://${pub_ip}:${port} 直接访问面板！${RESET}"
}

# 8. 导出备份 (支持全量 JSON + ZIP 归档)
export_backup() {
  local prefix="${1:-nexus_flux_backup}"
  local port
  port=$(get_panel_port)
  mkdir -p "$BACKUP_DIR"
  local ts
  ts=$(date +%Y%m%d_%H%M%S)
  local json_out="$BACKUP_DIR/${prefix}_${ts}.json"
  local zip_out="$BACKUP_DIR/${prefix}_${ts}.zip"

  if curl -fsSL -X POST "http://127.0.0.1:${port}/api/v1/backup/export" \
      -H "Content-Type: application/json" \
      -H "X-Nexus-Local: 1" -o "$json_out" 2>/dev/null; then
    :
  elif [[ -f "$DATA_DIR/flux-db.json" ]]; then
    cp -f "$DATA_DIR/flux-db.json" "$json_out"
  else
    echo -e "${RED}❌ 未找到可备份的数据库文件${RESET}"
    return 1
  fi

  if command -v zip &>/dev/null; then
    zip -q -j "$zip_out" "$json_out" "$ENV_FILE" 2>/dev/null || true
  fi

  echo -e "======================================================"
  echo -e " ✅ ${GREEN}主控配置与历史数据备份成功！${RESET}"
  echo -e " 📄 JSON 备份文件: ${YELLOW}${json_out}${RESET}"
  [[ -f "$zip_out" ]] && echo -e " 📦 ZIP  完整归档: ${YELLOW}${zip_out}${RESET}"
  echo -e "======================================================"
}

# 9. 恢复备份 (支持 .json / .zip / 原版 Flux .sql)
restore_backup() {
  local file_path="$1"
  local port
  port=$(get_panel_port)

  if [[ -z "$file_path" ]]; then
    echo -e "📂 当前可用本地备份列表 ($BACKUP_DIR):"
    ls -lh "$BACKUP_DIR" 2>/dev/null || echo "  (暂无备份文件)"
    echo ""
    read -p "请输入要恢复的备份文件完整路径 (支持 .json / .zip / 原版 .sql): " file_path
  fi

  if [[ ! -f "$file_path" ]]; then
    echo -e "${RED}❌ 找不到指定的备份文件: $file_path${RESET}"
    return 1
  fi

  local tmp_restore="/tmp/flux_restore_$$"
  mkdir -p "$tmp_restore"
  local target_file="$file_path"

  if [[ "$file_path" == *.zip ]]; then
    unzip -q "$file_path" -d "$tmp_restore"
    target_file=$(find "$tmp_restore" -name "*.json" -o -name "*.sql" | head -n 1)
  fi

  if [[ "$target_file" == *.sql ]]; then
    # 原版 Flux SQL 备份自动转换导入
    node -e "
      const fs = require('fs');
      const http = require('http');
      const sql = fs.readFileSync('$target_file', 'utf8');
      const body = JSON.stringify({ sqlContent: sql });
      const req = http.request({
        host: '127.0.0.1',
        port: $port,
        path: '/api/v1/backup/import',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Nexus-Local': '1', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => console.log(d));
      });
      req.write(body);
      req.end();
    "
  else
    # JSON 备份导入
    node -e "
      const fs = require('fs');
      const http = require('http');
      const raw = JSON.parse(fs.readFileSync('$target_file', 'utf8'));
      const payload = raw.data ? raw.data : raw;
      const body = JSON.stringify(payload);
      const req = http.request({
        host: '127.0.0.1',
        port: $port,
        path: '/api/v1/backup/import',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Nexus-Local': '1', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => console.log(d));
      });
      req.write(body);
      req.end();
    "
  fi

  rm -rf "$tmp_restore"
  echo -e "${GREEN}✅ 备份数据恢复完成！所有在线节点已自动同步最新配置。${RESET}"
}

# 10. 卸载面板
uninstall_panel() {
  read -p "⚠️ 确认彻底卸载 Nexus-Flux 主控面板吗？(y/N): " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "已取消卸载。"
    return 0
  fi

  if command -v systemctl &>/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl stop nexus-flux 2>/dev/null || true
    systemctl disable nexus-flux 2>/dev/null || true
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload 2>/dev/null || true
  else
    pkill -f "[n]exus-flux/server.js" 2>/dev/null || true
  fi

  if [[ -f "$CADDY_FILE" ]]; then
    sed -i '/# BEGIN NEXUS-FLUX/,/# END NEXUS-FLUX/d' "$CADDY_FILE"
    systemctl reload caddy 2>/dev/null || true
  fi

  rm -rf "$PANEL_DIR"
  rm -f "$FL_BIN" /usr/bin/fl 2>/dev/null || true
  echo -e "${GREEN}✅ Nexus-Flux 主控面板已彻底卸载（不影响本机探针与其他面板）。${RESET}"
}

# 11. 卸载本机被控端
uninstall_local_agent() {
  if [[ -f "$PANEL_DIR/node-install.sh" ]]; then
    bash "$PANEL_DIR/node-install.sh" <<< "4"
  else
    systemctl stop gost 2>/dev/null || true
    systemctl disable gost 2>/dev/null || true
    rm -f /etc/systemd/system/gost.service
    rm -rf /etc/gost
    systemctl daemon-reload 2>/dev/null || true
    echo -e "${GREEN}✅ 本机被控端已卸载${RESET}"
  fi
}

# 显示主菜单
show_menu() {
  local port
  port=$(get_panel_port)
  local domain
  domain=$(get_panel_domain)
  local ip_lock
  ip_lock=$(get_block_ip_status)

  echo ""
  echo -e "          ✨ ${BLUE}极简轻量转发 · Nexus-Flux 主控管理面板 (fl)${RESET} ✨          "
  echo "======================================================"
  echo -e " 监听端口: ${GREEN}${port}${RESET} | 绑定域名: ${YELLOW}${domain:-未设置}${RESET}"
  echo -e " 访问策略: ${BLUE}${ip_lock}${RESET}"
  echo "======================================================"
  echo "  1. 安装面板 (初始化部署 Nexus-Flux 主控端)"
  echo "  2. 更新面板 (保留数据无损更新至最新版)"
  echo "  3. 重启面板服务 / 查看面板实时状态"
  echo "  4. 面板域名设置 (自动配置 HTTPS 反代 · 多面板零冲突)"
  echo "  5. 阻止 IP+${port} 端口直接访问面板"
  echo "  6. 允许 IP+${port} 端口直接访问面板"
  echo "  7. 导出备份 (备份主控配置与历史流量数据)"
  echo "  8. 恢复备份 (从 JSON / ZIP / 原版 Flux SQL 恢复)"
  echo "  9. 卸载面板 (卸载 Nexus-Flux 主控端)"
  echo " 10. 卸载本机被控端 (清理本机 GOST / Light 被控服务)"
  echo "  0. 退出"
  echo "======================================================"
}

# 支持 CLI 快捷参数调用 (如: fl status / fl backup / fl block-ip / fl allow-ip)
if [[ $# -gt 0 ]]; then
  case "$1" in
    install) install_panel ;;
    update) update_panel ;;
    restart) restart_panel ;;
    status) status_panel ;;
    domain) configure_domain ;;
    block-ip) block_ip_port_access ;;
    allow-ip) allow_ip_port_access ;;
    backup|export) export_backup "$2" ;;
    restore|import) restore_backup "$2" ;;
    uninstall) uninstall_panel ;;
    *) echo "用法: fl [install|update|restart|status|domain|block-ip|allow-ip|backup|restore|uninstall]" ;;
  esac
  exit 0
fi

while true; do
  show_menu
  read -p "请输入选项 [0-10]: " choice
  case "$choice" in
    1) install_panel ;;
    2) update_panel ;;
    3) restart_panel; status_panel ;;
    4) configure_domain ;;
    5) block_ip_port_access ;;
    6) allow_ip_port_access ;;
    7) export_backup ;;
    8) restore_backup ;;
    9) uninstall_panel; exit 0 ;;
    10) uninstall_local_agent ;;
    0|88|q|exit) echo "👋 已退出 Nexus-Flux 管理面板"; exit 0 ;;
    *) echo -e "${RED}❌ 无效选项，请输入 0-10${RESET}" ;;
  esac
done
