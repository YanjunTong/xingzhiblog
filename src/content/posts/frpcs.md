---
title: 内网穿透实战：FRP 打通 Azure 公网与家里 T440 的通道
published: 2026-03-10
description: 详细记录如何用 FRP 搭建 Azure 公网服务器和家里 T440 之间的连通，涵盖 frps 部署、frpc 配置、隧道建立和故障排查。
tags: [FRP, 内网穿透, 异地组网, Azure, Linux]
category: 网络与系统
draft: false
---

## 前言

在公网上访问 NAT 后面的内网设备一直很麻烦。要么等着运营商分配公网 IP（遥遥无期），要么自己搭 VPN 倒腾一堆。FRP 就是为了解决这个问题的——它很轻量，配置也不复杂。

我的场景是这样的：在 Azure 上租了个服务器（有公网IP），家里有个运行 Ubuntu 的 T440。需要能从任何地方 SSH 进去，或者访问上面的 Web 服务。用 FRP 搭好以后，体验还不错，基本上跟在本地内网一样。

这篇文章就记录一下完整的部署过程，包括 frps 怎么配，frpc 怎么配，以及碰到过的一些坑。基于 FRP v0.55.0，如果版本不一样可能配置格式会有些差异。

## 基础概念

### FRP 怎么工作

FRP 就是个 C/S 的反向代理。

**frps（服务端）** 跑在有公网 IP 的 Azure 上，作为中转站。

**frpc（客户端）**：运行于内网 T440 Server 上，主动向 frps 建立持久连接，将本地的各式服务（SSH、HTTP、DNS 等）暴露给 frps。

**流量转发链路**：外部访问者 > Azure frps 监听端口 > frpc 隧道 > T440 Server 本地服务

### 1.2 软件清单与版本信息

| 组件 | 版本 | 运行环境 | 说明 |
|------|------|---------|------|
| frps | v0.55.0 | Azure Ubuntu 22.04 LTS | 服务端程序 |
| frpc | v0.55.0 | T440 Ubuntu 20.04 LTS | 客户端程序 |
| Go 运行时 | - | 可选 | 若从源代码编译则需要 |

### 1.3 网络拓扑示意

```
┌─────────────────────────────────────────┐
│       互联网 / 公网访问者               │
└──────────────────┬──────────────────────┘
                   │
        ┌──────────▼─────────┐
        │  Azure frps 服务  │
        │  公网 IP: 1.2.3.4 │
        │  监听端口: 7000  │
        └──────────┬─────────┘
                   │ (FRP 协议隧道)
        ┌──────────▼─────────┐
        │  T440 frpc 客户    │
        │  内网 IP: 192.168  │
        │  连接至 frps      │
        └──────────┬─────────┘
                   │
      ┌────────────┴────────────┐
      │   T440 本地服务        │
      ├─ SSH (22)             │
      ├─ HTTP (80/443)        │
      ├─ 自定义服务 (xxx)     │
      └────────────────────────┘
```

---

## 二、Azure 服务端部署（frps）

### 2.1 服务器环境准备

首先通过 SSH 连接到 Azure 服务器并检查基本信息：

```bash
ssh azureuser@<azure-public-ip>
```

验证系统环境：

```bash
uname -a
# 输出示例：Linux azure-server 5.15.0-1052-azure #60-Ubuntu SMP x86_64 GNU/Linux

cat /etc/os-release
# 确认是 Ubuntu 22.04 LTS 或更新版本
```

更新系统包并安装必要的依赖：

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget vim net-tools
```

### 2.2 下载 FRP 服务端程序

前往 [FRP 官方 GitHub Release 页面](https://github.com/fatedier/frp/releases) 下载最新的稳定版本。为了避免版本混乱导致客户端兼容性问题，**必须确保 frps 与 frpc 版本一致**。

在 Azure 服务器上执行：

```bash
cd /tmp
wget https://github.com/fatedier/frp/releases/download/v0.55.0/frp_0.55.0_linux_amd64.tar.gz

# 验证下载完整性（可选，但建议执行）
# wget https://github.com/fatedier/frp/releases/download/v0.55.0/frp_0.55.0_linux_amd64.tar.gz.sha256
# sha256sum -c frp_0.55.0_linux_amd64.tar.gz.sha256

tar -xzf frp_0.55.0_linux_amd64.tar.gz
```

解压后会得到以下目录结构：

```
frp_0.55.0_linux_amd64/
├── frps              # 服务端可执行文件
├── frpc              # 客户端可执行文件
├── frps.toml         # 服务端配置文件模板
├── frpc.toml         # 客户端配置文件模板
└── README.md
```

### 2.3 安装 frps 到系统目录

为了方便管理和系统集成，将 frps 安装到标准路径：

```bash
sudo mkdir -p /opt/frp
sudo cp /tmp/frp_0.55.0_linux_amd64/frps /opt/frp/
sudo cp /tmp/frp_0.55.0_linux_amd64/frps.toml /opt/frp/frps.toml
sudo chmod +x /opt/frp/frps
```

### 2.4 配置 frps.toml 服务端配置文件

编辑服务端配置文件（**这是最关键的一步**）：

```bash
sudo nano /opt/frp/frps.toml
```

根据你的实际需求，输入以下配置内容。注意：该配置为完整示例，包含详细的注释说明：

```toml
# ============================================
# FRP 服务端配置文件
# 版本: v0.55.0
# ============================================

# 【基础服务配置】
# 服务端监听地址（建议绑定到 0.0.0.0 以接受来自任何网卡的连接）
bindAddr = "0.0.0.0"

# 服务端与客户端通信的端口（frpc 会向此端口建立连接）
bindPort = 7000

# 【日志配置】
logFile = "/opt/frp/frps.log"
logLevel = "info"          # 可选: trace, debug, info, warn, error
logMaxDays = 7             # 日志保留天数

# 【身份认证与安全】
# 通俗来说，这是客户端连接服务端时需要提供的"密钥"
# 强烈建议修改为复杂的随机字符串（如生成的 uuid 或高熵密码）
auth.method = "token"
auth.token = "your_secure_token_here_change_this"

# 【性能与连接优化】
# 单个客户端允许的最大代理数量（防止单个客户端资源占用过多）
maxPoolCount = 5

# 代理保活检测间隔（秒）—— 检测客户端是否仍在线
keepaliveInterval = 30
keepaliveTimeout = 90

# UDP 包缓冲区大小（仅当使用 STCP/SUDP 协议时相关）
udpPacketSize = 1500

# 【仪表板配置（可选）】
# webServer.addr = "0.0.0.0"
# webServer.port = 7500
# webServer.user = "admin"
# webServer.password = "your_web_dashboard_password"
# webServer.tls.certFile = "/path/to/cert.pem"
# webServer.tls.keyFile = "/path/to/key.pem"

# ============================================
# 【启用的协议说明】
# ============================================
# 注意：下方各个代理均在默认情况下启用
# 如需禁用特定协议，注释相应的 [[proxies]] 段落即可

# ============================================
# 第一个代理：SSH 远程访问
# ================================================
[[proxies]]
name = "T440_SSH"
type = "tcp"
# 该代理在 frps 服务端监听的端口
# 外部通过 ssh -p 10022 <azure-ip> 即可连接到 T440 的 SSH
bindPort = 10022
# frpc 客户端连接到本地哪个地址和端口（T440 本地 SSH 服务运行于 22 端口）
transport.useEncryption = true
transport.useCompression = true

# ================================================
# 第二个代理：HTTP Web 服务
# ================================================
[[proxies]]
name = "T440_HTTP"
type = "http"
customDomains = ["server.yourdomain.com"]
# 后端真实服务地址（T440 本地 HTTP 服务）
# 注意：此字段在客户端配置中指定，而非服务端
# transport.useEncryption = true
# transport.useCompression = true

# ================================================
# 第三个代理：HTTPS Web 服务
# ================================================
[[proxies]]
name = "T440_HTTPS"
type = "https"
customDomains = ["server.yourdomain.com"]
# 后端 HTTPS 服务也可以转发，无需额外配置

# ================================================
# 第四个代理：TCP 通用转发（示例：数据库或自定义端口）
# ================================================
[[proxies]]
name = "T440_CUSTOM_TCP"
type = "tcp"
bindPort = 13306
# 用于转发 MySQL 等自定义 TCP 服务

# 【以下为可选的高级配置】

# 【多客户端支持】
# 如果计划连接多个内网客户端，可在下方添加更多代理
# [[proxies]]
# name = "Other_Client_Service"
# type = "tcp"
# bindPort = 20000
```

**关键配置项解释：**

| 配置项 | 说明 | 典型值 |
|--------|------|--------|
| `bindPort` | frps 监听端口 | 7000 |
| `auth.token` | 客户端认证令牌 | 需修改为强密码 |
| `maxPoolCount` | 单客户端最大代理数 | 5 |
| `[[proxies]]` | 代理服务段 | 按需配置 |

### 2.5 创建 Systemd 服务单元（自动启动与管理）

为了让 frps 在系统启动时自动运行，并支持使用 systemctl 进行管理，创建服务单元文件：

```bash
sudo tee /etc/systemd/system/frps.service > /dev/null <<EOF
[Unit]
Description=FRP Server
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/frp
ExecStart=/opt/frp/frps -c /opt/frp/frps.toml
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

重新加载 systemd 配置并启动 frps：

```bash
sudo systemctl daemon-reload
sudo systemctl enable frps          # 设置开机自启
sudo systemctl start frps           # 启动服务
sudo systemctl status frps          # 查看状态
```

验证 frps 是否正确监听端口：

```bash
sudo ss -tlnp | grep frps
# 应输出类似：
# LISTEN  0  128  0.0.0.0:7000  0.0.0.0:*  users:(("frps",pid=xxxx,fd=3))
```

### 2.6 配置云防火墙规则（Azure NSG）

需要在 Azure 的网络安全组（NSG）中添加入站规则，允许外部流量到达 frps 监听的端口。

登录 Azure 门户，依次进入虚拟机、网络设置、添加入站规则：

- **协议**：TCP
- **目标端口范围**：7000（以及所有代理的 bindPort，如 10022, 13306）
- **来源**：`*`（或限制为特定 IP）
- **优先级**：设置为较高优先级（如 100）

---

## 三、T440 客户端部署（frpc）

### 3.1 T440 Server 环境准备

在家中 T440 Server 上执行类似的初始设置：

```bash
ssh your_username@192.168.1.100  # T440 内网地址
```

更新系统并安装依赖：

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget vim net-tools
```

### 3.2 下载 FRP 客户端程序

**关键提示：客户端版本必须与服务端版本一致（都是 v0.55.0）**

```bash
cd /tmp
wget https://github.com/fatedier/frp/releases/download/v0.55.0/frp_0.55.0_linux_amd64.tar.gz
tar -xzf frp_0.55.0_linux_amd64.tar.gz
sudo mkdir -p /opt/frp
sudo cp /tmp/frp_0.55.0_linux_amd64/frpc /opt/frp/
sudo cp /tmp/frp_0.55.0_linux_amd64/frpc.toml /opt/frp/frpc.toml
sudo chmod +x /opt/frp/frpc
```

### 3.3 配置 frpc.toml 客户端配置文件

编辑客户端配置文件（这是最核心的配置）：

```bash
sudo nano /opt/frp/frpc.toml
```

输入以下完整配置：

```toml
# ============================================
# FRP 客户端配置文件
# 版本: v0.55.0
# 部署环境: ThinkPad T440 Server (Ubuntu 20.04)
# ============================================

# 【服务端连接信息】
# frps 所在的公网服务器地址
serverAddr = "1.2.3.4"    # 替换为你的 Azure 公网 IP
serverPort = 7000         # 必须与 frps 配置中的 bindPort 一致

# 【身份认证】
# 该令牌必须与 frps 配置中的 auth.token 一致
auth.method = "token"
auth.token = "your_secure_token_here_change_this"

# 【日志配置】
logFile = "/opt/frp/frpc.log"
logLevel = "info"          # 可选: trace, debug, info, warn, error
logMaxDays = 7

# 【连接优化】
# 该客户端与服务端之间的连接池大小
transport.poolCount = 1

# 启用数据加密（推荐）
transport.useEncryption = true

# 启用数据压缩（推荐，可加快传输速度）
transport.useCompression = true

# DNS 服务器地址（可选）
# dnsServer = "8.8.8.8"

# ============================================
# 【代理配置：定义本地哪些服务需要暴露】
# ============================================

# ================================================
# 代理 1: SSH 远程访问
# 本地 T440 的 SSH 服务（通常运行在 127.0.0.1:22）
# ================================================
[[proxies]]
name = "T440_SSH"
type = "tcp"
# 本地服务地址（T440 内网 SSH）
localIP = "127.0.0.1"
localPort = 22
# 在服务端 frps 监听的端口（客户端无需指定，由服务端配置决定）
# 当连接到 frps 的 10022 端口时，流量会被转发到这里

# ================================================
# 代理 2: HTTP 服务
# 用于暴露 T440 上运行的 Web 应用
# ================================================
[[proxies]]
name = "T440_HTTP"
type = "http"
localIP = "127.0.0.1"
localPort = 8080            # 替换为你的实际 HTTP 服务端口
customDomains = ["server.yourdomain.com"]  # 必须与 frps 配置中的域名一致

# ================================================
# 代理 3: HTTPS 服务（可选）
# ================================================
[[proxies]]
name = "T440_HTTPS"
type = "https"
localIP = "127.0.0.1"
localPort = 443
customDomains = ["server.yourdomain.com"]

# ================================================
# 代理 4: TCP 通用转发
# 示例：转发本地运行的自定义服务或数据库
# ================================================
[[proxies]]
name = "T440_CUSTOM_TCP"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3306            # 例如本地 MySQL 服务

# ================================================
# 代理 5: 文件共享服务（在需要时添加）
# ================================================
# [[proxies]]
# name = "T440_FILE_SYNC"
# type = "tcp"
# localIP = "127.0.0.1"
# localPort = 8888          # 文件服务端口

# 【高级选项（可选）】

# STCP（Secure TCP）—— 点对点加密传输
# [[proxies]]
# name = "T440_STCP"
# type = "stcp"
# secretKey = "your_secret_key"
# localIP = "127.0.0.1"
# localPort = 6000
# useEncryption = true
# useCompression = true

# SUDP（Secure UDP）—— UDP 加密传输，用于实时应用
# [[proxies]]
# name = "T440_SUDP"
# type = "sudp"
# secretKey = "your_secret_key"
# localIP = "127.0.0.1"
# localPort = 6001
# useEncryption = true
# useCompression = true
```

**配置项关键说明：**

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `serverAddr` | frps 公网地址 | 1.2.3.4 |
| `serverPort` | frps 监听端口 | 7000 |
| `auth.token` | 认证令牌 | 必须与服务端一致 |
| `localIP` | 本地服务监听地址 | 127.0.0.1 |
| `localPort` | 本地服务端口 | 22, 8080 等 |
| `customDomains` | HTTP/HTTPS 的域名 | server.yourdomain.com |

### 3.4 创建 Systemd 服务单元

类似地，为 frpc 创建自启动服务：

```bash
sudo tee /etc/systemd/system/frpc.service > /dev/null <<EOF
[Unit]
Description=FRP Client
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/frp
ExecStart=/opt/frp/frpc -c /opt/frp/frpc.toml
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

启动 frpc：

```bash
sudo systemctl daemon-reload
sudo systemctl enable frpc
sudo systemctl start frpc
sudo systemctl status frpc
```

---

## 四、隧道建立与功能验证

### 4.1 验证连接状态

在 frpc 运行的 T440 上，查看日志确认是否成功连接到 frps：

```bash
sudo tail -f /opt/frp/frpc.log
```

成功的日志输出应显示：

```
[2026-04-12 10:15:30] [I] [service.go:xxx] login to server success
[2026-04-12 10:15:30] [I] [proxy_manager.go:xxx] [T440_SSH] proxy online
[2026-04-12 10:15:30] [I] [proxy_manager.go:xxx] [T440_HTTP] proxy online
```

在 Azure frps 服务器上，验证是否接收到客户端连接：

```bash
sudo tail -f /opt/frp/frps.log
```

预期日志：

```
[2026-04-12 10:15:28] [I] [server.go:xxx] client login info: cid=[xxxxx]
[2026-04-12 10:15:28] [I] [server.go:xxx] new proxy [T440_SSH] success
```

### 4.2 测试 SSH 远程访问

从任何联网的计算机、手机或远程机器，通过 Azure 公网 IP 访问 T440 的 SSH：

```bash
ssh -p 10022 your_username@1.2.3.4
# 或使用 root 用户
ssh -p 10022 root@1.2.3.4
```

成功连接后应进入 T440 Server 的 shell 环境。

### 4.3 测试 HTTP 服务

若 T440 上运行着 Web 应用（如在 8080 端口），则可通过浏览器访问：

```
http://server.yourdomain.com
```

**前提条件**：需要将域名 `server.yourdomain.com` 的 DNS A 记录指向 Azure 服务器的公网 IP（1.2.3.4）。

### 4.4 测试自定义 TCP 转发

若要测试其他服务（如数据库），使用本地客户端工具：

```bash
# 连接到通过 frp 转发的 MySQL 服务
mysql -h 1.2.3.4 -P 13306 -u root -p
```

---

## 五、常见问题与故障排查

### 5.1 客户端无法连接到服务端

**症状**：frpc 日志显示 `dial tcp: i/o timeout` 或 `connection refused`

**排查步骤**：

1. 检查 frps 是否正常运行：
   ```bash
   sudo systemctl status frps
   sudo ss -tlnp | grep frps
   ```

2. 验证防火墙规则：
   ```bash
   # 在 Azure frps 所在服务器上
   sudo ufw status
   sudo ufw allow 7000/tcp  # 如果需要
   ```

3. 检查 Azure NSG 规则是否已配置

4. 验证 frp 版本一致性：
   ```bash
   /opt/frp/frps --version
   /opt/frp/frpc --version
   ```

### 5.2 认证失败（auth.token 不匹配）

**症状**：frpc 日志显示 `login failed`

**解决**：确保 frpc.toml 中的 `auth.token` 完全匹配 frps.toml 中的值。注意大小写和空格。

### 5.3 代理连接正常但无法访问服务

**症状**：成功连接 SSH，但无法访问 HTTP 服务

**排查**：

1. 确认本地服务确实在监听：
   ```bash
   sudo ss -tlnp | grep 8080  # 查看 HTTP 服务
   ```

2. 如果服务未运行，启动应用

3. 检查本地防火墙是否阻止连接：
   ```bash
   sudo ufw status
   ```

### 5.4 T440 内网地址无法直接访问怎么办

如果 frpc 中使用的 `localIP = "127.0.0.1"` 无法访问某些服务，尝试改为：

```toml
localIP = "0.0.0.0"  # 或 T440 的实际内网 IP（如 192.168.1.100）
```

### 5.5 性能优化建议

- 若出现卡顿，增加 `transport.poolCount`：
  ```toml
  transport.poolCount = 4
  ```

- 根据带宽调整压缩：
  ```toml
  transport.useCompression = false  # 带宽充足时禁用可提升速度
  ```

---

## 六、安全加固建议

### 6.1 修改默认端口

避免使用 7000 等常见端口，改为随机高位端口：

```toml
# frps.toml
bindPort = 27000  # 修改为 20000-30000 范围内的随机数

# frpc.toml
serverPort = 27000  # 必须一致
```

### 6.2 启用 TLS 加密（生产环境推荐）

如果配置了 HTTPS 证书，在 frps 中启用 TLS：

```toml
# frps.toml
tls.enable = true
tls.certFile = "/path/to/server.crt"
tls.keyFile = "/path/to/server.key"

# frpc.toml
transport.tls.enable = true
```

### 6.3 限制客户端连接来源

在 Azure NSG 中配置源 IP 限制，而非开放 `*`。

### 6.4 定期更新 FRP

关注 [FRP GitHub Release](https://github.com/fatedier/frp/releases)，定期更新至最新稳定版本以获取安全补丁。

---

## 七、总结与最佳实践

通过本文详尽的部署流程，我们成功打通了 Azure 公网环境与家中内网 T440 Server，实现了真正的异地组网。FRP 的优势在于其轻量级、高效率与开源特性，相比于 Frp、ZeroTier 等方案，具有更好的控制力与可定制性。

部署 FRP 的核心要点总结如下：

1. **版本一致性** —— frps 与 frpc 必须使用相同版本，否则协议解析会失败
2. **令牌安全** —— 使用强随机令牌而非文本密码，定期轮换
3. **日志监控** —— 及时检查日志发现异常，建立告警机制
4. **备份配置** —— 保存每个版本的配置文件，便于快速回滚
5. **定期维护** —— 更新 FRP，查看是否有新功能或安全补丁

未来，可考虑集成 Prometheus + Grafana 对 FRP 流量进行可视化监控，或使用 Kubernetes 进行容器化部署以增强可扩展性。希望本文能为你的内网穿透实践提供有力支持。

