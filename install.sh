#!/bin/bash
# ==============================================================================
# ✨ Nexus-Flux 主控面板 一键安装与 SSH 管理脚本 (fl) - v1.1.0 ✨
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
    node -e "try{const d=JSON.parse(require('fs').readFileSync('$DATA_DIR/flux-db.json','utf8'));console.log((d.configs&&d.configs.block_ip_access)==='true'?'已阻止IP+端口直接访问':'允许IP+端口直接访问')}catch(e){console.log('允许IP+端口直接访问')}" 2>/dev/null
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
      apt-get install -y curl unzip zip ca-certificates gnupg >/dev/null 2>&1 || true
    elif [ -f /etc/redhat-release ]; then
      yum install -y curl unzip zip ca-certificates >/dev/null 2>&1 || true
    fi
  fi

  local need_node=0
  if ! command -v node &>/dev/null; then
    need_node=1
  else
    local major_ver
    major_ver=$(node -v 2>/dev/null | sed 's/^v//' | cut -d'.' -f1)
    if [[ -z "$major_ver" || "$major_ver" -lt 18 ]]; then
      need_node=1
    fi
  fi

  if [[ "$need_node" -eq 1 ]]; then
    echo -e "${BLUE}📦 正在安装最新稳定版 Node.js 22 LTS 运行环境...${RESET}"
    if [ -f /etc/debian_version ]; then
      apt-get update -y >/dev/null 2>&1 || true
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || true
      apt-get install -y nodejs >/dev/null 2>&1 || true
    elif [ -f /etc/redhat-release ]; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || true
      yum install -y nodejs >/dev/null 2>&1 || dnf install -y nodejs >/dev/null 2>&1 || true
    elif [ -f /etc/alpine-release ]; then
      apk add --no-cache nodejs >/dev/null 2>&1 || true
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
  echo -e "${BLUE}🚀 开始安装 Nexus-Flux 主控面板 (v1.1.0)...${RESET}"
  ensure_dependencies

  local default_port
  default_port=$(get_panel_port)
  read -p "请输入面板监听端口 [默认 ${default_port}]: " input_port
  local port="${input_port:-$default_port}"

  read -p "请输入初始管理员账号 [默认 admin_user]: " input_user
  local admin_user="${input_user:-admin_user}"

  read -p "请输入初始管理员密码 [默认 admin_user]: " input_pwd
  local admin_pwd="${input_pwd:-admin_user}"

  mkdir -p "$PANEL_DIR/public" "$PANEL_DIR/agent" "$DATA_DIR" "$BACKUP_DIR"

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$script_dir/server.js" && -f "$script_dir/public/index.html" ]]; then
    if [[ "$script_dir" != "$PANEL_DIR" ]]; then
      cp -rf "$script_dir/"* "$PANEL_DIR/"
    fi
  else
    echo -e "${BLUE}⬇️ 正在下载面板组件...${RESET}"
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
Description=Nexus-Flux Master Panel Service
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
  echo -e " 🎉 ${GREEN}Nexus-Flux 面板部署完成 (v1.1.0)${RESET}"
  echo -e " 🌐 访问地址:   ${BLUE}http://${pub_ip}:${port}${RESET}"
  echo -e " 👤 管理员账号: ${YELLOW}${admin_user}${RESET}"
  echo -e " 🔑 管理员密码: ${YELLOW}${admin_pwd}${RESET}"
  echo -e " 💻 快捷命令:   输入 ${GREEN}fl${RESET} 即可打开管理菜单"
  echo -e "======================================================"
}

# 2. 更新面板
update_panel() {
  echo -e "${BLUE}🔄 正在更新 Nexus-Flux 面板 (支持本地 ZIP 包或在线无损热更新)...${RESET}"
  if [[ ! -d "$PANEL_DIR" ]]; then
    echo -e "${RED}❌ 面板尚未安装，请先执行安装。${RESET}"
    return 1
  fi

  ensure_dependencies
  export_backup "auto_pre_update" >/dev/null 2>&1 || true

  local local_zip=""
  local_zip=$(ls -t /root/Nexus-flux*.zip /root/*nexus-flux*.zip 2>/dev/null | head -n 1 || true)
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [[ -n "$local_zip" && -f "$local_zip" ]]; then
    echo -e "${GREEN}📦 检测到 /root 本地更新包: ${local_zip}，正在解压热更新...${RESET}"
    local tmp_up="/tmp/nexus_flux_up_$$"
    mkdir -p "$tmp_up"
    unzip -oq "$local_zip" -d "$tmp_up"
    local src_root="$tmp_up"
    if [[ ! -f "$src_root/server.js" ]]; then
      src_root=$(find "$tmp_up" -name "server.js" -printf "%h
" 2>/dev/null | head -n 1 || echo "$tmp_up")
    fi
    if [[ -f "$src_root/server.js" ]]; then
      cp -f "$src_root/server.js" "$PANEL_DIR/server.js"
      [[ -f "$src_root/public/index.html" ]] && cp -f "$src_root/public/index.html" "$PANEL_DIR/public/index.html"
      [[ -f "$src_root/agent/nexus-flux-agent.js" ]] && cp -f "$src_root/agent/nexus-flux-agent.js" "$PANEL_DIR/agent/nexus-flux-agent.js"
      [[ -f "$src_root/node-install.sh" ]] && cp -f "$src_root/node-install.sh" "$PANEL_DIR/node-install.sh"
      [[ -f "$src_root/install.sh" ]] && cp -f "$src_root/install.sh" "$PANEL_DIR/install.sh"
    fi
    rm -rf "$tmp_up"
  elif [[ -f "$script_dir/server.js" && "$script_dir" != "$PANEL_DIR" ]]; then
    cp -f "$script_dir/server.js" "$PANEL_DIR/server.js"
    cp -f "$script_dir/public/index.html" "$PANEL_DIR/public/index.html"
    cp -f "$script_dir/agent/nexus-flux-agent.js" "$PANEL_DIR/agent/nexus-flux-agent.js"
    cp -f "$script_dir/node-install.sh" "$PANEL_DIR/node-install.sh"
    cp -f "$script_dir/install.sh" "$PANEL_DIR/install.sh"
  else
    echo -e "${BLUE}⬇️ 正在从仓库下载最新面板组件...${RESET}"
    curl -fsSL "$REPO_RAW_URL/server.js" -o "$PANEL_DIR/server.js.new" && mv "$PANEL_DIR/server.js.new" "$PANEL_DIR/server.js"
    curl -fsSL "$REPO_RAW_URL/public/index.html" -o "$PANEL_DIR/public/index.html.new" && mv "$PANEL_DIR/public/index.html.new" "$PANEL_DIR/public/index.html"
    curl -fsSL "$REPO_RAW_URL/agent/nexus-flux-agent.js" -o "$PANEL_DIR/agent/nexus-flux-agent.js.new" && mv "$PANEL_DIR/agent/nexus-flux-agent.js.new" "$PANEL_DIR/agent/nexus-flux-agent.js"
    curl -fsSL "$REPO_RAW_URL/node-install.sh" -o "$PANEL_DIR/node-install.sh.new" && mv "$PANEL_DIR/node-install.sh.new" "$PANEL_DIR/node-install.sh"
    curl -fsSL "$REPO_RAW_URL/install.sh" -o "$PANEL_DIR/install.sh.new" && mv "$PANEL_DIR/install.sh.new" "$PANEL_DIR/install.sh"
  fi

  chmod +x "$PANEL_DIR/install.sh" "$PANEL_DIR/node-install.sh" "$PANEL_DIR/agent/nexus-flux-agent.js" 2>/dev/null || true
  install_fl_command
  restart_panel
  sleep 2
  upgrade_and_sync_all_nodes
  echo -e "${GREEN}✅ 面板更新完成 (v1.1.0)，所有配置、历史数据及在线节点规则已自动同步！${RESET}"
}

# 3. 重启面板服务
restart_panel() {
  echo -e "${BLUE}🔄 正在重启面板服务...${RESET}"
  if command -v systemctl &>/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl restart nexus-flux
  else
    pkill -f "[n]exus-flux/server.js" 2>/dev/null || true
    local node_bin
    node_bin=$(command -v node || echo "/usr/bin/node")
    nohup env $(cat "$ENV_FILE" | xargs) "$node_bin" --max-semi-space-size=2 --max-old-space-size=64 "$PANEL_DIR/server.js" > "$PANEL_DIR/panel.log" 2>&1 &
  fi
  sleep 1
  echo -e "${GREEN}✅ 服务已重启${RESET}"
}

# 查看状态
status_panel() {
  local port
  port=$(get_panel_port)
  echo -e "======================================================"
  echo -e " 📊 Nexus-Flux 主控运行状态"
  echo -e "======================================================"
  curl -s -H "X-Nexus-Local: 1" "http://127.0.0.1:${port}/healthz" || echo "服务未响应"
  echo ""
  if command -v systemctl &>/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl status nexus-flux --no-pager -n 10 || true
  fi
}

# 4. 面板域名设置
configure_domain() {
  local port
  port=$(get_panel_port)
  local current_domain
  current_domain=$(get_panel_domain)
  echo -e "======================================================"
  echo -e " 🌐 面板域名设置 (自动配置 HTTPS 反代)"
  echo -e " 当前绑定域名: ${YELLOW}${current_domain:-未绑定}${RESET}"
  echo -e "======================================================"
  read -p "请输入要绑定的域名 (输入 clear 解绑): " domain
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
    echo -e "${GREEN}✅ 已解绑域名并恢复默认访问${RESET}"
    return 0
  fi

  if ! command -v caddy &>/dev/null; then
    echo -e "${BLUE}📦 正在安装 Caddy 服务...${RESET}"
    if [ -f /etc/debian_version ]; then
      apt-get update -y >/dev/null 2>&1 || true
      apt-get install -y caddy >/dev/null 2>&1 || true
    elif [ -f /etc/redhat-release ]; then
      yum install -y caddy >/dev/null 2>&1 || dnf install -y caddy >/dev/null 2>&1 || true
    fi
  fi

  mkdir -p /etc/caddy
  touch "$CADDY_FILE"

  local temp_other
  temp_other=$(sed '/# BEGIN NEXUS-FLUX/,/# END NEXUS-FLUX/d' "$CADDY_FILE")
  if echo "$temp_other" | grep -Fq "$domain"; then
    echo -e "${RED}❌ 域名 ${domain} 已被占用，请更换其他域名。${RESET}"
    return 1
  fi

  sed -i '/# BEGIN NEXUS-FLUX/,/# END NEXUS-FLUX/d' "$CADDY_FILE"

  cat >> "$CADDY_FILE" <<EOF

# BEGIN NEXUS-FLUX
${domain} {
    encode gzip
    reverse_proxy 127.0.0.1:${port}
}
# END NEXUS-FLUX
EOF

  curl -s -X POST "http://127.0.0.1:${port}/api/v1/config/update-single" \
    -H "Content-Type: application/json" \
    -H "X-Nexus-Local: 1" \
    -d "{\"name\":\"panel_domain\",\"value\":\"${domain}\"}" >/dev/null 2>&1 || true

  if command -v caddy &>/dev/null && command -v systemctl &>/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl enable caddy >/dev/null 2>&1 || true
    systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
  fi

  echo -e "${GREEN}✅ 域名设置完成，现可通过 https://${domain} 访问面板。${RESET}"
}

# 5. 阻止 IP+端口 直接访问
block_ip_port_access() {
  local port
  port=$(get_panel_port)
  local domain
  domain=$(get_panel_domain)
  if [[ -z "$domain" ]]; then
    echo -e "${YELLOW}⚠️ 请先通过选项 4 绑定面板域名后再开启此项。${RESET}"
    return 1
  fi

  curl -s -X POST "http://127.0.0.1:${port}/api/v1/config/update-single" \
    -H "Content-Type: application/json" \
    -H "X-Nexus-Local: 1" \
    -d '{"name":"block_ip_access","value":"true"}' >/dev/null 2>&1

  echo -e "${GREEN}🔒 已阻止 IP+${port} 直接访问面板，仅允许通过 https://${domain} 访问。${RESET}"
}

# 6. 允许 IP+端口 直接访问
allow_ip_port_access() {
  local port
  port=$(get_panel_port)
  curl -s -X POST "http://127.0.0.1:${port}/api/v1/config/update-single" \
    -H "Content-Type: application/json" \
    -H "X-Nexus-Local: 1" \
    -d '{"name":"block_ip_access","value":"false"}' >/dev/null 2>&1

  local pub_ip
  pub_ip=$(get_public_ip)
  echo -e "${GREEN}🔓 已允许通过 http://${pub_ip}:${port} 直接访问面板。${RESET}"
}

# 7. 导出备份
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
    echo -e "${RED}❌ 未找到数据库文件${RESET}"
    return 1
  fi

  if command -v zip &>/dev/null; then
    zip -q -j "$zip_out" "$json_out" "$ENV_FILE" 2>/dev/null || true
  fi

  echo -e "======================================================"
  echo -e " ✅ ${GREEN}面板数据备份成功${RESET}"
  echo -e " 📄 备份文件: ${YELLOW}${json_out}${RESET}"
  [[ -f "$zip_out" ]] && echo -e " 📦 压缩归档: ${YELLOW}${zip_out}${RESET}"
  echo -e "======================================================"
}

# 8. 恢复备份
restore_backup() {
  local file_path="$1"
  local port
  port=$(get_panel_port)

  if [[ -z "$file_path" ]]; then
    echo -e "📂 当前可用本地备份列表 ($BACKUP_DIR):"
    ls -lh "$BACKUP_DIR" 2>/dev/null || echo "  (暂无备份文件)"
    echo ""
    read -p "请输入要恢复的备份文件完整路径: " file_path
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
  echo -e "${GREEN}✅ 备份数据恢复完成！${RESET}"
}

# 9. 卸载面板
uninstall_panel() {
  read -p "⚠️ 确认卸载 Nexus-Flux 主控面板吗？(y/N): " confirm
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
  echo -e "${GREEN}✅ Nexus-Flux 主控面板已彻底卸载。${RESET}"
}

# 10. 卸载本机被控端
uninstall_local_agent() {
  if [[ -f "$PANEL_DIR/node-install.sh" ]]; then
    bash "$PANEL_DIR/node-install.sh" <<< "4"
  else
    systemctl stop nexus-agent 2>/dev/null || true
    systemctl disable nexus-agent 2>/dev/null || true
    rm -f /etc/systemd/system/nexus-agent.service
    rm -rf /opt/nexus-agent
    systemctl daemon-reload 2>/dev/null || true
    echo -e "${GREEN}✅ 本机被控端已卸载${RESET}"
  fi
}

# 11. 深度清理旧面板 Docker/MySQL/Java/Swap 内存与磁盘垃圾
purge_legacy_bloat() {
  echo -e "${BLUE}🧹 正在清理旧面板残留容器、MySQL/Java 进程与 Swap 缓存...${RESET}"
  if command -v docker &>/dev/null; then
    for cid in $(docker ps -a --format '{{.ID}} {{.Image}} {{.Names}}' 2>/dev/null | grep -iE 'flux|gost|mysql|springboot|panel' | awk '{print $1}'); do
      docker rm -f "$cid" >/dev/null 2>&1 || true
    done
    docker system prune -af --volumes >/dev/null 2>&1 || true
    systemctl stop docker docker.socket containerd 2>/dev/null || true
    systemctl disable docker docker.socket containerd 2>/dev/null || true
  fi
  systemctl stop mysql mysqld mariadb 2>/dev/null || true
  systemctl disable mysql mysqld mariadb 2>/dev/null || true
  pkill -9 -f "springboot-backend|flux-panel" 2>/dev/null || true
  rm -rf /root/gost.sql /root/docker-compose*.yml /root/panel_install.sh* /var/lib/docker /var/lib/mysql 2>/dev/null || true
  sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
  swapoff -a 2>/dev/null && swapon -a 2>/dev/null || true
  echo -e "${GREEN}✅ 旧环境冗余容器、MySQL/Java 进程、磁盘垃圾与 Swap 已彻底清理释放！${RESET}"
}

# 12. 一键远程升级全部在线节点被控并重新下发规则
upgrade_and_sync_all_nodes() {
  local port
  port=$(get_panel_port)
  echo -e "${BLUE}🚀 正在向全部在线节点推送 v1.1.0 被控内核并全量重新下发转发/隧道规则...${RESET}"
  local res
  res=$(curl -s -X POST "http://127.0.0.1:${port}/api/v1/node/upgrade-all"     -H "Content-Type: application/json"     -H "X-Nexus-Local: 1"     -d '{}' 2>/dev/null || echo "")
  if [[ -n "$res" ]]; then
    echo -e "${GREEN}✅ 远程升级与规则同步完成: ${res}${RESET}"
  else
    echo -e "${YELLOW}⚠️ 暂未收到主控响应，请确认主控已启动且节点已连接。${RESET}"
  fi
}

show_menu() {
  local port
  port=$(get_panel_port)
  local domain
  domain=$(get_panel_domain)
  local ip_lock
  ip_lock=$(get_block_ip_status)
  local health_json
  health_json=$(curl -s -m 1 "http://127.0.0.1:${port}/healthz" 2>/dev/null || echo "")
  local run_state="${RED}未运行${RESET}"
  if [[ -n "$health_json" ]]; then
    local rss
    rss=$(echo "$health_json" | sed -n 's/.*"rssMB":\([0-9.]*\).*//p')
    run_state="${GREEN}运行中 (${rss:-30} MB)${RESET}"
  fi

  echo ""
  echo -e "          ✨ ${BLUE}Nexus-Flux 主控管理面板 (fl) - v1.1.0${RESET} ✨          "
  echo "======================================================"
  echo -e " 主控状态: ${run_state} | 端口: ${GREEN}${port}${RESET} | 域名: ${YELLOW}${domain:-未设置}${RESET}"
  echo -e " 访问策略: ${BLUE}${ip_lock}${RESET}"
  echo "======================================================"
  echo "  1. 安装面板 (自动清理旧容器环境并部署 Nexus-Flux)"
  echo "  2. 更新面板 (支持 /root 本地 ZIP 包或在线无损热更新)"
  echo "  3. 重启面板服务 / 查看面板状态"
  echo "  4. 面板域名设置 (自动配置 HTTPS 反代 · 多面板零冲突)"
  echo "  5. 阻止 IP+${port} 端口直接访问面板"
  echo "  6. 允许 IP+${port} 端口直接访问面板"
  echo "  7. 导出备份 (备份配置与历史数据 · 同步至 /root)"
  echo "  8. 恢复备份 (支持序号选择 JSON / ZIP / SQL 备份)"
  echo "  9. 卸载面板"
  echo " 10. 卸载本机被控端"
  echo " 11. 一键清理旧面板 Docker/MySQL/Java/Swap 内存与磁盘垃圾"
  echo " 12. 一键远程升级全部在线节点被控并重新下发规则"
  echo "  0. 退出"
  echo "======================================================"
}

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
    purge) purge_legacy_bloat ;;
    sync|upgrade-nodes) upgrade_and_sync_all_nodes ;;
    uninstall) uninstall_panel ;;
    *) echo "用法: fl [install|update|restart|status|domain|block-ip|allow-ip|backup|restore|purge|sync|uninstall]" ;;
  esac
  exit 0
fi

while true; do
  show_menu
  read -p "请输入选项 [0-12]: " choice
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
    11) purge_legacy_bloat ;;
    12) upgrade_and_sync_all_nodes ;;
    0|88|q|exit) echo "👋 已退出管理菜单"; exit 0 ;;
    *) echo -e "${RED}❌ 无效选项，请输入 0-12${RESET}" ;;
  esac
done
