#!/bin/bash
# ==============================================================================
# ✨ Nexus-Flux 主控面板 一键安装、无损迁移与 SSH 管理脚本 (fl) - v1.0.0 ✨
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
CYAN="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

restore_tty() {
  stty sane </dev/tty >/dev/null 2>&1 || stty sane 2>/dev/null || true
  printf '\033[0m\033[?25h'
}
trap 'restore_tty; echo ""' EXIT
trap 'restore_tty; echo ""; exit 130' INT TERM

pause_return() {
  restore_tty
  if [[ -r /dev/tty ]]; then
    echo ""
    read -r -p "按回车键返回主菜单..." _ </dev/tty || true
  fi
}

get_proc_rss_mb() {
  local pattern="$1"
  local pid rss_kb
  pid="$(pgrep -f "$pattern" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$pid" && -r "/proc/$pid/status" ]]; then
    rss_kb="$(awk '/^VmRSS:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)"
    if [[ "${rss_kb:-0}" -gt 0 ]]; then
      awk "BEGIN {printf \"%.1f MB\", $rss_kb/1024}"
      return 0
    fi
  fi
  echo "-"
}

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
      export DEBIAN_FRONTEND=noninteractive
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
      export DEBIAN_FRONTEND=noninteractive
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

# 自动检测并导出旧面板 MySQL 数据 + 深度清理 Docker / MySQL / Java / Swap 垃圾
migrate_and_clean_legacy_docker_flux() {
  local migrated_sql="/tmp/flux_legacy_auto_migrate.sql"
  rm -f "$migrated_sql"

  local has_legacy=0
  if command -v docker &>/dev/null && docker ps -a --format "{{.Names}}" 2>/dev/null | grep -Eq "springboot-backend|gost-mysql|vite-frontend"; then
    has_legacy=1
  fi
  if [[ -f /root/docker-compose.yml || -f /root/gost.sql || -f /root/panel_install.sh.bak ]]; then
    has_legacy=1
  fi

  if [[ "$has_legacy" -eq 0 ]]; then
    return 0
  fi

  echo -e "${CYAN}======================================================${RESET}"
  echo -e "${YELLOW}🔍 检测到本机存在旧版容器面板环境 (Docker + MySQL + Java)${RESET}"
  echo -e "${CYAN}======================================================${RESET}"

  # 1. 如果 gost-mysql 正在运行，自动抢救导出里面的节点、隧道和转发数据
  if command -v docker &>/dev/null && docker ps --format "{{.Names}}" 2>/dev/null | grep -q "^gost-mysql$"; then
    echo -e "${BLUE}📦 正在从旧版数据库自动提取现有节点、隧道与转发数据...${RESET}"
    local db_name="" db_user="" db_pwd=""
    if [[ -f /root/.env ]]; then
      db_name=$(grep "^DB_NAME=" /root/.env 2>/dev/null | cut -d'=' -f2 | tr -d '[:space:]')
      db_user=$(grep "^DB_USER=" /root/.env 2>/dev/null | cut -d'=' -f2 | tr -d '[:space:]')
      db_pwd=$(grep "^DB_PASSWORD=" /root/.env 2>/dev/null | cut -d'=' -f2 | tr -d '[:space:]')
    fi
    if [[ -z "$db_name" ]]; then
      local env_out
      env_out=$(docker exec springboot-backend env 2>/dev/null || true)
      db_name=$(echo "$env_out" | grep "^DB_NAME=" | cut -d'=' -f2 | tr -d '[:space:]')
      db_user=$(echo "$env_out" | grep "^DB_USER=" | cut -d'=' -f2 | tr -d '[:space:]')
      db_pwd=$(echo "$env_out" | grep "^DB_PASSWORD=" | cut -d'=' -f2 | tr -d '[:space:]')
    fi

    if [[ -n "$db_name" && -n "$db_pwd" ]]; then
      if docker exec gost-mysql mysqldump -u "${db_user:-root}" -p"$db_pwd" --single-transaction "$db_name" > "$migrated_sql" 2>/dev/null ||
         docker exec gost-mysql mysqldump -u root -p"$db_pwd" --single-transaction "$db_name" > "$migrated_sql" 2>/dev/null; then
        if [[ -s "$migrated_sql" ]]; then
          mkdir -p "$BACKUP_DIR"
          cp -f "$migrated_sql" "$BACKUP_DIR/legacy_flux_auto_dump_$(date +%Y%m%d_%H%M%S).sql"
          echo -e "${GREEN}✅ 旧版数据库提取成功！将在新面板启动后自动无损导入。${RESET}"
        fi
      fi
    fi
  fi

  # 2. 彻底停止并删除旧版容器、镜像、数据卷与残留文件
  echo -e "${BLUE}🧹 正在停止并彻底清理旧版 Docker 容器、Java 进程、MySQL 数据卷与镜像垃圾...${RESET}"
  if command -v docker &>/dev/null; then
    if [[ -f /root/docker-compose.yml ]]; then
      (cd /root && (docker compose down --rmi all --volumes --remove-orphans >/dev/null 2>&1 || docker-compose down --rmi all --volumes --remove-orphans >/dev/null 2>&1 || true))
    fi
    for cname in vite-frontend frontend springboot-backend gost-mysql; do
      docker rm -f "$cname" >/dev/null 2>&1 || true
    done
    docker system prune -af --volumes >/dev/null 2>&1 || true

    # 如果机器上没有任何其他容器了，直接停用 dockerd 与 containerd 释放常驻内存与磁盘
    local remain_containers
    remain_containers=$(docker ps -a -q 2>/dev/null | wc -l || echo 0)
    if [[ "$remain_containers" -eq 0 ]]; then
      echo -e "${BLUE}🍃 检测到本机已无其他容器，正在停用 Docker 与 Containerd 后台守护进程以释放内存...${RESET}"
      systemctl stop docker.socket docker.service containerd.service 2>/dev/null || true
      systemctl disable docker.socket docker.service containerd.service 2>/dev/null || true
      rm -rf /var/lib/docker/* /var/lib/containerd/* 2>/dev/null || true
    fi
  fi

  # 清理 /root 下的旧面板残留文件
  rm -f /root/docker-compose.yml /root/docker-compose-v4.yml /root/docker-compose-v6.yml /root/docker-compose-v6* /root/gost.sql /root/panel_install.sh /root/panel_install.sh.bak /root/temp_migration.sql 2>/dev/null || true
  if [[ -f /root/.env ]] && grep -q "^JWT_SECRET=" /root/.env 2>/dev/null; then
    rm -f /root/.env
  fi

  # 3. 释放内核 PageCache 并将之前 Java 挤入 Swap 的 600MB+ 垃圾彻底清空回 0
  echo -e "${BLUE}⚡ 正在回收内核缓存并清空 Swap 交换分区残留数据...${RESET}"
  sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
  swapoff -a 2>/dev/null && swapon -a 2>/dev/null || true

  local mem_after swap_after disk_after
  mem_after="$(free -m 2>/dev/null | awk '/^Mem:/{printf "%dMB / %dMB", $3, $2}' || echo '-')"
  swap_after="$(free -m 2>/dev/null | awk '/^Swap:/{printf "%dMB / %dMB", $3, $2}' || echo '-')"
  disk_after="$(df -h / 2>/dev/null | awk 'NR==2{printf "已用 %s / 总计 %s (可用 %s)", $3, $2, $4}' || echo '-')"
  echo -e "${GREEN}✅ 旧面板内存与磁盘垃圾清理完毕！${RESET}"
  echo -e "   • 当前物理内存: ${GREEN}${mem_after}${RESET}"
  echo -e "   • 当前交换分区: ${GREEN}${swap_after}${RESET}"
  echo -e "   • 当前磁盘空间: ${GREEN}${disk_after}${RESET}"
}

deploy_source_files() {
  mkdir -p "$PANEL_DIR/public" "$PANEL_DIR/agent" "$DATA_DIR" "$BACKUP_DIR"

  # 优先检测是否存在本地上传的 /root/Nexus-flux*.zip
  local local_zip=""
  for cand in /root/Nexus-flux-v1.0.0.zip /root/Nexus-flux*.zip /tmp/Nexus-flux*.zip; do
    if [[ -f "$cand" ]]; then
      local_zip="$cand"
      break
    fi
  done

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [[ -f "$script_dir/server.js" && -f "$script_dir/public/index.html" ]]; then
    if [[ "$script_dir" != "$PANEL_DIR" ]]; then
      cp -rf "$script_dir/"* "$PANEL_DIR/"
    fi
  elif [[ -n "$local_zip" ]]; then
    echo -e "${CYAN}📦 检测到本地安装包: ${YELLOW}${local_zip}${CYAN}，正在直接解压部署...${RESET}"
    local tmp_unpack
    tmp_unpack="$(mktemp -d)"
    unzip -oq "$local_zip" -d "$tmp_unpack"
    if [[ -f "$tmp_unpack/server.js" ]]; then
      cp -rf "$tmp_unpack/"* "$PANEL_DIR/"
    elif [[ -f "$tmp_unpack/Nexus-flux/server.js" ]]; then
      cp -rf "$tmp_unpack/Nexus-flux/"* "$PANEL_DIR/"
    fi
    rm -rf "$tmp_unpack"
  else
    echo -e "${BLUE}⬇️ 正在从仓库下载最新面板组件...${RESET}"
    curl -fsSL "$REPO_RAW_URL/server.js" -o "$PANEL_DIR/server.js"
    curl -fsSL "$REPO_RAW_URL/public/index.html" -o "$PANEL_DIR/public/index.html"
    curl -fsSL "$REPO_RAW_URL/agent/nexus-flux-agent.js" -o "$PANEL_DIR/agent/nexus-flux-agent.js"
    curl -fsSL "$REPO_RAW_URL/node-install.sh" -o "$PANEL_DIR/node-install.sh"
    curl -fsSL "$REPO_RAW_URL/install.sh" -o "$PANEL_DIR/install.sh"
  fi

  chmod +x "$PANEL_DIR/server.js" "$PANEL_DIR/agent/nexus-flux-agent.js" "$PANEL_DIR/node-install.sh" "$PANEL_DIR/install.sh"
}

# 1. 安装面板
install_panel() {
  echo -e "${BLUE}🚀 开始安装 Nexus-Flux 主控面板 (v1.0.0)...${RESET}"
  ensure_dependencies

  # 自动检测并清理旧版 Docker Flux 释放 6366 端口、内存、Swap 与磁盘
  migrate_and_clean_legacy_docker_flux

  local default_port
  default_port=$(get_panel_port)
  read -p "请输入面板监听端口 [默认 ${default_port}]: " input_port
  local port="${input_port:-$default_port}"

  read -p "请输入初始管理员账号 [默认 admin_user]: " input_user
  local admin_user="${input_user:-admin_user}"

  read -p "请输入初始管理员密码 [默认 admin_user]: " input_pwd
  local admin_pwd="${input_pwd:-admin_user}"

  deploy_source_files

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

  # 如果刚才从旧版 MySQL 提取到了数据，询问或自动导入
  if [[ -f /tmp/flux_legacy_auto_migrate.sql && -s /tmp/flux_legacy_auto_migrate.sql ]]; then
    local auto_imp="y"
    if [[ -r /dev/tty ]]; then
      read -r -p "检测到已提取旧面板的节点与转发数据，是否立即无损导入到新面板？[Y/n]: " auto_imp </dev/tty || true
    fi
    if [[ "${auto_imp:-Y}" =~ ^[Yy]?$ ]]; then
      restore_backup "/tmp/flux_legacy_auto_migrate.sql" >/dev/null 2>&1 || true
      echo -e "${GREEN}✅ 已自动将原有节点、隧道与转发配置无损导入新面板！${RESET}"
    fi
    rm -f /tmp/flux_legacy_auto_migrate.sql
  fi

  echo -e "======================================================"
  echo -e " 🎉 ${GREEN}Nexus-Flux 面板部署完成 (v1.0.0)${RESET}"
  echo -e " 🌐 访问地址:   ${BLUE}http://${pub_ip}:${port}${RESET}"
  echo -e " 👤 管理员账号: ${YELLOW}${admin_user}${RESET}"
  echo -e " 🔑 管理员密码: ${YELLOW}${admin_pwd}${RESET}"
  echo -e " 💻 快捷命令:   输入 ${GREEN}fl${RESET} 即可打开管理菜单"
  echo -e "======================================================"
}

# 2. 更新面板
update_panel() {
  echo -e "${BLUE}🔄 正在更新 Nexus-Flux 面板 (支持本地 ZIP 包或在线拉取)...${RESET}"
  if [[ ! -d "$PANEL_DIR" ]]; then
    echo -e "${RED}❌ 面板尚未安装，请先执行安装。${RESET}"
    return 1
  fi

  ensure_dependencies
  export_backup "auto_pre_update" >/dev/null 2>&1 || true
  deploy_source_files
  install_fl_command
  restart_panel
  echo -e "${GREEN}✅ 面板更新完成，所有配置与历史数据完好无损！${RESET}"
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
  echo -e " 🌐 面板域名设置 (自动配置 HTTPS 反代 · 多面板零冲突)"
  echo -e " 当前绑定域名: ${YELLOW}${current_domain:-未绑定}${RESET}"
  echo -e "======================================================"
  read -p "请输入要绑定的域名 (如 zf.vponlive.com，输入 clear 解绑): " domain
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
      export DEBIAN_FRONTEND=noninteractive
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
    echo -e "${RED}❌ 域名 ${domain} 已被本机其他服务占用，请更换其他二级域名。${RESET}"
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

  curl -s -X POST "http://127.0.0.1:${port}/api/v1/config/update" \
    -H "Content-Type: application/json" \
    -H "X-Nexus-Local: 1" \
    -d "{\"panel_domain\":\"${domain}\",\"ip\":\"${domain}:${port}\"}" >/dev/null 2>&1 || true

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

  echo -e "${GREEN}🔒 已阻止 IP+${port} 直接访问面板，仅允许通过 https://${domain} 访问（不影响节点心跳上报）。${RESET}"
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
    cp -f "$zip_out" /root/nexus-flux-latest-backup.zip 2>/dev/null || true
  fi
  cp -f "$json_out" /root/nexus-flux-latest-backup.json 2>/dev/null || true

  echo -e "======================================================"
  echo -e " ✅ ${GREEN}面板数据备份成功${RESET}"
  echo -e " 📄 备份文件: ${YELLOW}${json_out}${RESET}"
  echo -e " 📥 快捷下载: ${CYAN}/root/nexus-flux-latest-backup.json${RESET}"
  echo -e "======================================================"
}

# 8. 恢复备份
restore_backup() {
  local file_path="$1"
  local port
  port=$(get_panel_port)

  if [[ -z "$file_path" ]]; then
    local candidates=()
    while IFS= read -r f; do
      [[ -n "$f" ]] && candidates+=("$f")
    done < <(ls -1t /root/nexus-flux*.json /root/nexus-flux*.zip /root/*.sql "$BACKUP_DIR"/*.json "$BACKUP_DIR"/*.zip "$BACKUP_DIR"/*.sql 2>/dev/null | awk '!seen[$0]++' | head -n 15)

    if [[ "${#candidates[@]}" -gt 0 ]]; then
      echo -e "📂 检测到本机可用备份文件列表："
      local i=1
      for c in "${candidates[@]}"; do
        local sz
        sz="$(ls -lh "$c" 2>/dev/null | awk '{print $5}')"
        echo -e "  ${GREEN}[${i}]${RESET} ${c} ${YELLOW}(${sz})${RESET}"
        i=$((i + 1))
      done
      echo ""
    fi
    read -p "请输入备份序号 [1-${#candidates[@]}] 或备份文件完整路径: " user_pick
    user_pick=$(echo "$user_pick" | tr -d '[:space:]')
    [[ -z "$user_pick" ]] && return 0
    if [[ "$user_pick" =~ ^[0-9]+$ ]] && [[ "$user_pick" -ge 1 && "$user_pick" -le "${#candidates[@]}" ]]; then
      file_path="${candidates[$((user_pick - 1))]}"
    else
      file_path="$user_pick"
    fi
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

# 11. 深度清理旧容器/数据库/Swap与系统垃圾并巡检多面板状态
clean_and_optimize_system() {
  migrate_and_clean_legacy_docker_flux

  # 限制 systemd-journald 日志体积，防止占满小硬盘与内存
  mkdir -p /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/99-lowmem-panels.conf <<'EOF'
[Journal]
SystemMaxUse=32M
SystemMaxFileSize=8M
RuntimeMaxUse=16M
MaxRetentionSec=5day
EOF
  systemctl restart systemd-journald 2>/dev/null || true
  journalctl --vacuum-size=16M >/dev/null 2>&1 || true
  apt-get clean >/dev/null 2>&1 || true
  sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
  swapoff -a 2>/dev/null && swapon -a 2>/dev/null || true

  echo ""
  echo -e "${CYAN}──────────────── 本机服务内存与磁盘状态巡检 ────────────────${RESET}"
  echo -e " 🖥 物理内存: ${YELLOW}$(free -m 2>/dev/null | awk '/^Mem:/{printf "已用 %d MB / 总计 %d MB (可用 %d MB)", $3, $2, $7}')${RESET}"
  echo -e " 💾 交换分区: ${YELLOW}$(free -m 2>/dev/null | awk '/^Swap:/{printf "已用 %d MB / 总计 %d MB", $3, $2}')${RESET}"
  echo -e " 💿 磁盘空间: ${YELLOW}$(df -h / 2>/dev/null | awk 'NR==2{printf "已用 %s / 总计 %s (可用 %s)", $3, $2, $4}')${RESET}"
  echo -e "   • 探针主控 (8080) : $(systemctl is-active --quiet probe-server 2>/dev/null && echo -e "${GREEN}运行中 ($(get_proc_rss_mb 'probe-server'))${RESET}" || echo -e "${YELLOW}未运行${RESET}")"
  echo -e "   • Nexus-Flux (fl) : $(systemctl is-active --quiet nexus-flux 2>/dev/null && echo -e "${GREEN}运行中 ($(get_proc_rss_mb 'nexus-flux/server.js'))${RESET}" || echo -e "${YELLOW}未运行${RESET}")"
  echo -e "   • Caddy (80/443)  : $(systemctl is-active --quiet caddy 2>/dev/null && echo -e "${GREEN}运行中 ($(get_proc_rss_mb 'caddy'))${RESET}" || echo -e "${YELLOW}未运行${RESET}")"
  pause_return
}

show_menu() {
  local port
  port=$(get_panel_port)
  local domain
  domain=$(get_panel_domain)
  local ip_lock
  ip_lock=$(get_block_ip_status)
  local fl_status="${RED}未运行${RESET}"
  if systemctl is-active --quiet nexus-flux 2>/dev/null || pgrep -f "[n]exus-flux/server.js" >/dev/null 2>&1; then
    fl_status="${GREEN}运行中 ($(get_proc_rss_mb 'nexus-flux/server.js'))${RESET}"
  fi

  echo ""
  echo -e "          ✨ ${BLUE}Nexus-Flux 主控管理面板 (fl) - v1.0.0${RESET} ✨          "
  echo "======================================================"
  echo -e " 主控状态: ${fl_status} | 端口: ${GREEN}${port}${RESET} | 域名: ${YELLOW}${domain:-未设置}${RESET}"
  echo -e " 访问策略: ${BLUE}${ip_lock}${RESET}"
  echo "------------------------------------------------------"
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
    clean|optimize) clean_and_optimize_system ;;
    uninstall) uninstall_panel ;;
    *) echo "用法: fl [install|update|restart|status|domain|block-ip|allow-ip|backup|restore|clean|uninstall]" ;;
  esac
  exit 0
fi

while true; do
  show_menu
  read -p "请输入选项 [0-11]: " choice
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
    11) clean_and_optimize_system ;;
    0|88|q|exit) echo "👋 已退出管理菜单"; exit 0 ;;
    *) echo -e "${RED}❌ 无效选项，请输入 0-11${RESET}" ;;
  esac
done
