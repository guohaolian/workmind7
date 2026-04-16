# WorkMind7 在阿里云 Ubuntu（ECS）部署指南

> 部署目标：
> - 后端（Node/Express）+ Chroma 向量库使用 Docker Compose 常驻运行
> - 前端（Vue/Vite）编译成静态文件，由 Nginx 托管
> - Nginx 同时反向代理 `/api/*` 到后端 `127.0.0.1:3000`，并对 SSE 关闭缓冲，保证流式输出不卡顿

## 1. 前置准备

### 1.1 ECS 与网络

- 推荐系统：Ubuntu 22.04 LTS（20.04 也可）
- 安全组放行：
  - 22（SSH）
  - 8022（HTTP，本指南使用 8022，因 80/8080 已被占用）
  - 443（HTTPS，建议开）
- 域名（可选）：如果你有域名，在阿里云 DNS 或你使用的 DNS 服务商上，把域名 A 记录解析到 ECS 公网 IP

如果你**没有域名**：

- 直接使用 ECS **公网 IP** 访问：`http://<你的公网IP>:8022/`
- 本文提供的 Nginx 配置默认 `server_name _;`，无需域名也能工作

> 建议不要在安全组放行 3000/8006。
> - 本项目后端对外统一走 Nginx（8022/443）
> - Chroma 仅应内网/本机访问

### 1.2 服务器初始化

```bash
sudo apt update
sudo apt -y upgrade
sudo apt -y install ca-certificates curl gnupg git
```

（可选）创建非 root 用户并赋予 sudo：

```bash
sudo adduser workmind
sudo usermod -aG sudo workmind
```

## 2. 安装 Docker 与 Compose

### 2.1 安装 Docker Engine

参考官方方式安装更稳（下面是常用步骤）：

```bash
# 添加 Docker 官方源
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

验证：

```bash
docker --version
docker compose version
```

（可选）让当前用户免 sudo 使用 docker：

```bash
sudo usermod -aG docker $USER
# 重新登录 SSH 生效
```

## 3. 获取代码（你本地上传）

你现在的方式是“本地准备好文件，再上传到服务器”，建议在服务器统一放到 `/opt/workmind`：

```bash
sudo mkdir -p /opt/workmind
```

你需要上传这些内容到服务器（保持相对路径不变）：

- `docker-compose.yml`
- `server/`（后端源码 + Dockerfile）
- `deploy/nginx/workmind7.conf`（Nginx 站点配置）

上传完成后，服务器目录大致如下：

```
/opt/workmind/
  docker-compose.yml
  server/
    .env           # 你的环境变量文件（已在 server 目录下）
  deploy/nginx/workmind7.conf
  www/frontend/    # 你前端 dist 上传到这里
```

## 4. 配置生产环境变量（使用 server/.env）

你已经把 `.env` 放在 `server/` 目录下，这样是可以的（本项目已将 `docker-compose.yml` 配置为直接加载 `./server/.env`）。

如果服务器上还没有该文件，按下面方式创建：

```bash
cd /opt/workmind/server
cp .env.example .env

# 编辑 /opt/workmind/server/.env，至少填：DEEPSEEK_API_KEY
# 无域名用公网 IP 访问时，建议：ALLOWED_ORIGINS=http://<你的公网IP>
```

> 说明：
> - 后端会校验 `DEEPSEEK_API_KEY`，缺失会直接退出。
> - 使用 Nginx 同域反代（浏览器访问 `http://<公网IP>:8022/`，API 走 `/api`）时通常不会触发跨域；但填上 `ALLOWED_ORIGINS` 更稳。

## 5. 启动后端与 Chroma

### 5.1（推荐）限制容器端口仅监听本机

生产环境建议把端口只绑定到 `127.0.0.1`，避免被公网直接访问。

编辑 `docker-compose.yml`（仅改 ports 映射这一行即可）：
- `"8026:8026"` → `"127.0.0.1:8026:8026"`
- `"8006:8000"` → `"127.0.0.1:8006:8000"`

不改也能用，但你需要额外用安全组/防火墙策略确保外网不能访问 3000/8006。

### 5.2 启动

```bash
cd /opt/workmind
docker compose up -d --build
```

查看状态：

```bash
cd /opt/workmind
docker compose ps
```

查看日志：

```bash
cd /opt/workmind
docker compose logs -f server
```

健康检查：

```bash
curl -fsSL http://127.0.0.1:8026/health
```

## 6. 前端静态文件（你本地打包后上传）

你现在的方式是：前端在本地执行 `npm run build`，然后把打包产物上传到服务器目录 `/opt/workmind/www/frontend`，这是最省事的生产做法。

### 6.1 服务器上创建目录

```bash
sudo mkdir -p /opt/workmind/www/frontend
sudo chown -R www-data:www-data /opt/workmind/www
sudo chmod -R 755 /opt/workmind/www
```

### 6.2 本地打包

在你本地机器：

```bash
cd frontend
npm ci
npm run build
```

产物通常在 `frontend/dist/`。

### 6.3 上传到服务器

任选其一：

- **rsync（推荐，可增量/可删除旧文件）**

```bash
rsync -avz --delete frontend/dist/ root@<你的公网IP>:/opt/workmind/www/frontend/
```

- **scp（简单但不增量）**

```bash
scp -r frontend/dist/* root@<你的公网IP>:/opt/workmind/www/frontend/
```

## 7. 安装与配置 Nginx

### 7.1 安装 Nginx

```bash
sudo apt -y install nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 7.2 放置站点配置

仓库已提供一份示例配置：`deploy/nginx/workmind7.conf`（已默认适配无域名 + 前端目录 `/opt/workmind/www/frontend`）。

把它复制到 Nginx：

```bash
sudo cp /opt/workmind/deploy/nginx/workmind7.conf /etc/nginx/sites-available/workmind7.conf
```

按你的情况修改：

- 如果你**有域名**：把配置里的 `server_name _;` 改成 `server_name yourdomain.com;`
- 如果你**没有域名**：保持 `server_name _;` 不变即可
- `root /opt/workmind/www/frontend;`（如果你目录不同）

启用站点并检查语法：

```bash
sudo ln -sf /etc/nginx/sites-available/workmind7.conf /etc/nginx/sites-enabled/workmind7.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 8. 配置 HTTPS（可选但强烈建议）

### 8.1 有域名：使用 Let’s Encrypt（推荐）

```bash
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

完成后 certbot 会自动写入 443 配置并设置自动续期。

### 8.2 没有域名：先使用 HTTP

Let’s Encrypt 需要验证域名，**不能直接签发给公网 IP**。没有域名时建议：

- 先用 `http://<公网IP>:8022/` 跑通功能
- 后续绑定域名后再按 8.1 开启 HTTPS

## 9. 开机自启（可选）

Docker 自身会拉起 `restart: unless-stopped` 的容器。

如果你希望系统启动后自动执行 Docker Compose，建议直接使用仓库内提供的 systemd 文件：`deploy/systemd/workmind.service`。

```bash
# 复制 service 文件到 systemd
sudo cp /opt/workmind/deploy/systemd/workmind.service /etc/systemd/system/workmind.service

# 使其生效并设置开机自启
sudo systemctl daemon-reload
sudo systemctl enable workmind
sudo systemctl start workmind

# 查看状态/日志
sudo systemctl status workmind --no-pager
journalctl -u workmind -n 200 --no-pager
```

> 注意：如果你的项目目录不是 `/opt/workmind`，请编辑 `/etc/systemd/system/workmind.service` 里的 `WorkingDirectory=...` 后执行：
> `sudo systemctl daemon-reload && sudo systemctl restart workmind`

## 10. 验证清单

- 页面能打开：
  - 有域名：`http(s)://yourdomain.com/`
  - 无域名：`http://<你的公网IP>:8022/`
- API 健康检查：`curl -fsSL http://127.0.0.1:8026/health`
- Nginx 反代是否正常：

```bash
# 验证 Nginx 是否工作（注意端口 8022）
curl -i http://127.0.0.1:8022/api/monitor/stats
```

- SSE 流式是否不卡：
  - 进入“对话/知识库/工作流”等页面测试流式输出
  - 如果出现“等很久才一下子输出一大段”，优先检查 Nginx 是否对 SSE 关闭了 `proxy_buffering`

## 11. 更新与回滚

### 11.1 更新代码

```bash
# 你当前是“本地更新后再上传”，服务器侧不执行 git pull
docker compose build server  
docker save -o workmind7-images.tar workmind-server:latest
docker load -i /tmp/workmind7-images.tar
docker compose up -d --no-build --pull never
在服务器上 docker load 进来的镜像和普通镜像一样删。

先看镜像名/ID
docker image ls
如果镜像正在被容器使用，先停掉并删容器（以 compose 为例）
cd /opt/workmind
docker compose down
按镜像名或 ID 删除
docker image rm workmind-server:latest
# 或
docker image rm <IMAGE_ID>
如果提示 “image is being used by running/stopped container”，找出占用它的容器并删掉
docker ps -a --filter ancestor=workmind-server:latest
docker rm -f <CONTAINER_ID>
docker image rm workmind-server:latest
只清理“悬空”镜像（较安全）
docker image prune

# 后端更新：上传新的 server/ 与 docker-compose.yml 后，在服务器执行：
cd /opt/workmind
docker compose up -d --build

# 前端更新：本地重新打包 dist 后，rsync/scp 覆盖到：
# /opt/workmind/www/frontend/

sudo systemctl reload nginx
```

### 11.2 回滚

- Docker 镜像回滚：用旧 tag（如果你做了镜像版本管理）或 `git checkout <commit>` 后重新 `docker compose up -d --build`
- 前端回滚：保留上一版 `/opt/workmind/www/frontend` 的备份目录，直接替换回去

## 12. 常见问题排查

- **502 Bad Gateway**：后端未启动或 Nginx 反代地址不对。`docker compose ps`、`docker compose logs -f server`。
- **SSE 不流式/卡住**：确认 Nginx 对 SSE location 设置了 `proxy_buffering off`，并提高 `proxy_read_timeout`。
- **上传文件 413**：Nginx `client_max_body_size` 太小；示例配置已给到 20m（可按需调整）。
- **CORS 报错**：检查 `ALLOWED_ORIGINS` 是否包含你的域名或 `http://<公网IP>`（含 http/https）。
