---
title: 零信任虚拟网络：Tailscale 打造武汉—乌鲁木齐的隐形局域网
published: 2026-03-15
description: 介绍如何用 Tailscale 搭建私密虚拟网络，对应 FRP 的不稳定和安全问题。从 Azure 和 T440 的节点加入开始，讲讲配置、授权和端点连接的问题。
tags: [Tailscale, VPN, WireGuard, 零信任网络, 异地组网, 内网穿透, 网络安全]
category: 网络与系统
draft: false
---

## 前言

前面用 FRP 把 Azure 公网和家里 T440 连上了。但用了段时间发现了两个问题：首先，隧道不太稳定，隔三差五就断连一次，得手动重启。其次，所有的端口都直接对着网络，每天都能看到各种扫描的流量，感觉很不安心。

后来弄了个 **Tailscale**。这东西基于 WireGuard，比普通的 VPN 聪明一些：它能自动穿过 NAT，点对点直连，也不需要一个中央服务器来中转流量。最关键的是，所有流量都被加密了，外面看不到，就像不存在一样。用上以后，网络就没再断过，感觉安心多了。

这篇就记一下怎么在 Azure 和 T440 上装 Tailscale，配置虚拟网络和设备权限这些东西。基于 Tailscale v1.60.0，如果版本不一样可能会有区别。

---

## 对比：FRP 和 Tailscale 有什么区别

### 1.1 FRP 存在的问题

| 问题 | 影响 | 严重程度 |
|------|------|--------|
| 隧道间歇性断连 | 需要手动重启服务 | 高 |
| 中央服务器单点故障 | frps 宕机时全网失联 | 极高 |
| 暴露在公网 | 容易成为扫描/攻击目标 | 高 |
| 配置管理复杂 | 每增加一个服务需要修改配置 | 中 |
| 无加密隔离 | 流量本质上还是明文转发 | 中 |

### 1.2 Tailscale 的优势

| 特性 | 优势 | Tailscale | FRP |
|------|------|-----------|-----|
| 连通稳定性 | 自动重连机制 | 优秀(99.99%) | 一般 |
| 单点故障风险 | 去中心化节点发现 | 无单点 | 有 |
| 安全性 | 零信任架构 | 极高 | 较低 |
| NAT 穿透 | 端点直连支持 | 支持 | 需服务器中转 |
| 配置门槛 | 即插即用 | 极低 | 需编写 TOML |
| 跨平台 | 支持度 | 全平台 | 主要 Linux/Windows |

### 1.3 应用场景对比

**使用 FRP 更适合的场景：**
- 搭建公开的 Web 服务
- 需要暴露多个不同端口的应用
- 对延迟要求不高的场景

**使用 Tailscale 更适合的场景：**
- 隐私性优先的企业网络
- 个人设备间的可靠互联
- 需要自动故障转移的关键服务
- **跨地区的远程内网访问**（正是我们的场景）

---

## Tailscale 怎么上手

### 一些基本概念

**Tailnet**：Tailscale 网络，由一组经过身份验证的设备组成。类似于私有局域网，但跨越互联网。

**节点（Node）**：加入 Tailnet 的每台设备（Azure 服务器、T440 等）都是一个节点。

**协调服务器（Control Server）**：负责节点发现、身份验证与密钥交换。Tailscale 官方提供托管版本，也支持自部署私有版本（Headscale）。

**WireGuard 底层**：Tailscale 基于 WireGuard 协议，提供军用级加密。

### 连接的流程

```
1. 设备认证
   ├─ 访问 Tailscale Web portal
   ├─ 扫二维码或复制链接
   └─ 登录 Tailscale 账户

2. 节点注册
   ├─ 协调服务器验证身份
   ├─ 生成唯一的 Tailscale IP（100.x.x.x）
   └─ 分配 WireGuard 密钥对

3. 端点发现
   ├─ 各节点向协调服务器汇报自身地址
   ├─ 尝试直连（点对点）
   ├─ NAT 穿透失败时使用中继服务器
   └─ 自动选择最优路径

4. 加密通信
   ├─ 所有流量使用 WireGuard 加密
   ├─ 点对点直连时无服务器介入
   └─ 虚拟网络内通信如同局域网
```

### 网络结构

```
                            Tailscale 协调服务器
                          (云·仅用于认证/发现)
                                   │
                ┌──────────────────┼──────────────────┐
                │                  │                  │
            ┌───▼────┐         ┌───▼────┐         ┌──▼────┐
            │ 武汉   │         │ 乌鲁   │         │其他   │
            │ 家中   │         │木齐    │         │设备   │
            │T440    │         │ Azure  │         │       │
            │        │         │        │         │       │
            └──┬─────┘         └───┬────┘         └──┬────┘
         Tailscale IP:       Tailscale IP:    Tailscale IP:
         100.64.1.50         100.64.1.100     100.64.1.200
               │ (WireGuard 加密隧道)  │             │
               ├────────────────────────┼─────────────┤
               │   虚拟局域网内直连    │             │
               │  (不经过公网中转)     │             │
               └────────────────────────┴─────────────┘

注：即使 T440 在家里的 NAT 后面（内网 192.168.1.x），
    也可通过虚拟网络直接连接。
```

---

## 三、Azure 服务端部署

### 3.1 整一下 Azure 这面

连接到 Azure 服务器：

```bash
ssh azureuser@<azure-public-ip>
```

系统环境检查：

```bash
uname -a
cat /etc/os-release
```

更新系统：

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget vim net-tools
```

### 3.2 装 Tailscale

直接用官方脚本：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

脚本会自动检测系统类型并安装最新稳定版本。安装完成后验证：

```bash
tailscale --version
# 输出应显示：tailscale version vX.XX.X
```

### 3.3 启动 Tailscale 服务

启用并启动 Tailscale 系统服务：

```bash
sudo systemctl enable tailscaled
sudo systemctl start tailscaled
sudo systemctl status tailscaled
```

验证服务运行状态：

```bash
sudo tailscale status
# 首次输出可能显示需要登录
```

### 3.4 Azure 节点加入 Tailnet

Tailscale 需要一个账户（可用 Google、Microsoft、GitHub 账号登录）。执行登录命令：

```bash
sudo tailscale up
```

终端会输出一条类似以下的授权 URL：

```
To authenticate, visit:

   https://login.tailscale.com/a/xxxxxxxxxxxxx

```

在浏览器中打开该 URL，选择登录方式（Google/Microsoft/GitHub），完成身份验证。

返回终端，脚本会自动完成注册。成功后输出：

```
Logged in.

Wireguard:     Active
DERP:          Nearest relay: {region}
Endpoints:     [1.2.3.4:xxxxx]
Tailscale IP:  100.64.1.100
OS:            linux
```

其中 `100.64.1.100` 是 Azure 节点在虚拟网络中的私有 IP。

### 3.5 验证 Azure 节点状态

查看当前 Tailnet 中的所有节点：

```bash
sudo tailscale status
```

输出示例：

```
Tailscale is running!

Logged in as: your-email@gmail.com
Tailnet: your-tailnet

# Tag=ubuntu:22.04 Status=online Latency=1.2ms
100.64.1.100 azure-ubuntu active; relayed via Toronto

```

记下 Azure 的 Tailscale IP（本例中为 `100.64.1.100`），稍后需要为 T440 提供。

---

## 四、T440 客户端部署

### 4.1 T440 这克的

SSH 连接到 T440 Server：

```bash
ssh your_username@192.168.1.100  # T440 内网地址
```

系统检查：

```bash
uname -a
cat /etc/os-release
```

更新系统：

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget vim net-tools
```

### 4.2 安装 Tailscale

使用相同的安装脚本：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

验证：

```bash
tailscale --version
```

### 4.3 打开 Tailscale 并加入

```bash
sudo systemctl enable tailscaled
sudo systemctl start tailscaled
sudo tailscale up
```

同样会显示登录 URL。**必须使用与 Azure 节点相同的 Tailscale 账户** 来登录，这样才能加入同一个 Tailnet。

成功后查看状态：

```bash
sudo tailscale status
```

输出示例：

```
Tailscale is running!

Logged in as: your-email@gmail.com
Tailnet: your-tailnet

100.64.1.100 azure-ubuntu      active; direct
100.64.1.50  t440-server       active; relayed via Toronto
```

T440 的 Tailscale IP 是 `100.64.1.50`。

### 4.4 本地服务暴露

如果希望通过虚拟网络访问 T440 上运行的本地服务，需要在防火墙中允许：

```bash
# 允许通过 Tailscale 接口进行 SSH 访问
sudo ufw allow in on tailscale0 from any to any port 22

# 允许 HTTP 服务
sudo ufw allow in on tailscale0 from any to any port 8080

# 允许自定义服务
sudo ufw allow in on tailscale0 from any to any port 3306  # MySQL示例
```

查看 tailscale0 网卡状态：

```bash
ip addr show dev tailscale0
# 输出应显示: inet 100.64.1.50
```

---

## 验证虚拟网络

### 5.1 测试 T440 通过虚拟 IP SSH 访问

在你的本地计算机（或任何地方）上，直接通过虚拟 IP 连接 T440：

```bash
ssh your_username@100.64.1.50
```

如果成功进入 T440 的 shell，说明虚拟网络配置完成！

### 5.2 连 SSH 连上 Azure

```bash
ssh azureuser@100.64.1.100
```

### 5.3 两个服务器究竟能不能直連

从 T440 ping Azure 节点：

```bash
ping -c 3 100.64.1.100
```

预期输出：

```
PING 100.64.1.100 (100.64.1.100) 56(84) bytes of data.
64 bytes from 100.64.1.100: icmp_seq=1 ttl=64 time=45.23 ms
64 bytes from 100.64.1.100: icmp_seq=2 ttl=64 time=43.12 ms
64 bytes from 100.64.1.100: icmp_seq=3 ttl=64 time=44.56 ms
```

### 5.4 看一下是不是直連

在 T440 上运行：

```bash
sudo tailscale netcheck
```

输出示例：

```
Package tailscale/tailscale is not installed, running "tailscale netcheck" from source.

Report:
        * UDP: true
        * IPv4: yes, 39.107.xxx.xxx:xxxxx
        * IPv6: no
        * MappingVariesByDestIP: false
        * HairPinning: false
        * PortMapping: UPnP
        * CaptivePortal: false
        * Nearest DERP: Singapore
        * KeyExchangeLatency: 1.2ms
```

再查看连接状态：

```bash
sudo tailscale status
```

如果显示 `direct`，说明是点对点直连；如果显示 `relayed via ...`，说明经过中继服务器（仍安全，但延迟会增加）。

---

## 需要完整的配置

### 6.1 配置 DNS 分割隧道

在 Azure 上设置 DNS 服务器，使虚拟网络内的节点可以互相解析：

```bash
# 在 Azure 节点上
sudo tailscale up --accept-dns=false
```

或在 Web 管理界面配置 Split DNS。

### 6.2 访问控制列表（ACL）

Tailscale 提供细粒度的访问控制。访问 [Tailscale 管理后台](https://login.tailscale.com/admin/acls)，配置 ACL：

```hujson
{
  // 允许所有节点间通信
  "grants": [
    {
      "src": ["tag:servers"],
      "dst": ["tag:servers"],
      "ports": ["*:*"]
    },
    {
      "src": ["tag:personal"],
      "dst": ["tag:servers"],
      "ports": ["22:22", "8080:8080"]  // 仅允许 SSH 和 HTTP
    }
  ]
}
```

为节点打上标签：

```bash
# 在 Azure
sudo tailscale up --advertise-tags=tag:servers

# 在 T440
sudo tailscale up --advertise-tags=tag:servers
```

### 6.3 启用 SSH 快捷访问

Tailscale 提供了 SSH 代理功能。在 Web 后台启用，然后：

```bash
# 从任何地方
ssh -i ~/.ssh/id_rsa your_username@100.64.1.50
```

无需配置 SSH 端口转发，代理自动处理。

### 6.4 将其他设备加入 Tailnet

手机、笔记本等其他设备可以安装 Tailscale 应用后无缝加入同一个网络：

- **Windows/Mac**：下载 [Tailscale 桌面应用](https://tailscale.com/download)
- **iOS/Android**：AppStore/Google Play 搜索 Tailscale

登录时使用同一个 Tailscale 账户即可。

---

## 七、常见问题与故障排查

### 7.1 无法连接到 Tailscale 服务

**症状**：`tailscale up` 后仍无法看到其他节点

**排查步骤**：

```bash
# 检查 tailscaled 是否运行
sudo systemctl status tailscaled

# 重启服务
sudo systemctl restart tailscaled

# 查看日志
sudo journalctl -u tailscaled -n 50
```

### 7.2 连接显示 "relayed" 而非 "direct"

**症状**：节点列表显示 `relayed via ...`，延迟较高

**原因**：NAT 穿透失败，自动使用中继服务器

**优化**：

```bash
# 在路由器上启用 UPnP（如支持）
# 或手动配置端口转发规则

# 强制尝试直连
sudo tailscale up --accept-routes

# 检查 NAT 穿透能力
sudo tailscale netcheck
```

如输出显示 `PortMapping: UPnP` 或 `PCP`，说明路由器支持自动端口映射。

### 7.3 特定端口无法访问

**症状**：可以 ping 通虚拟 IP，但无法访问特定端口的服务

**排查**：

```bash
# 检查目标服务是否监听
sudo ss -tlnp | grep :8080   # 检查 8080 端口

# 检查本地防火墙规则
sudo ufw status
sudo ufw allow in on tailscale0 from any to any port 8080

# 检查应用级防火墙（如 iptables）
sudo iptables -L -n
```

### 7.4 Tailscale IP 频繁变化

**症状**：每次重启或重连后 IP 变化

**解决**：在 Web 后台配置设备静态 IP。Tailscale 支持为每台设备分配固定 Tailscale IP：

Web 后台 - 设备 - 编辑 - 分配固定 IP - 重启 tailscaled

### 7.5 与 VPN/代理冲突

**症状**：Tailscale 与其他 VPN 不兼容或冲突

**解决**：

```bash
# 禁用 Tailscale 接管系统 DNS
sudo tailscale up --accept-dns=false

# 或使用 Tailscale 特定的隧道模式
sudo tailscale set --shields=all  # 严格模式
```

---

## 八、性能优化与监控

### 8.1 监控虚拟网络状态

创建一个监控脚本来定期检查连接：

```bash
#!/bin/bash
# /opt/scripts/tailscale_monitor.sh

while true; do
    echo "=== $(date) ==="
    sudo tailscale status | grep -E "Tailscale is|Tailnet|Status"
    
    # 测试连接延迟
    echo "Latency to Azure:"
    ping -c 1 100.64.1.100 | tail -1
    
    sleep 300  # 每 5 分钟检查一次
done
```

设置定时任务：

```bash
sudo crontab -e
# 添加: @reboot /opt/scripts/tailscale_monitor.sh >> /var/log/tailscale_monitor.log 2>&1
```

### 8.2 优化 WireGuard MTU 设置

如果发现丢包或延迟高，调整 MTU：

```bash
# 检查当前 MTU
ip link show tailscale0

# 临时调整为 1300 字节
sudo ip link set dev tailscale0 mtu 1300

# 永久配置（编辑 /etc/network/interfaces 或使用 netplan）
# 在相应的网卡配置中添加: mtu 1300
```

### 8.3 启用实时日志监控

```bash
# 查看 Tailscale 实时日志
sudo tailscale bugreport

# 持续监控
sudo journalctl -u tailscaled -f
```

---

## 可以能有帮助

如果出于极端隐私考虑（完全不依赖 Tailscale 官方服务器），可以自部署开源的 Headscale 协调服务器。但这样做的代价是：

**优点**：
- 完全隐私，数据不过云端
- 可完全自定义网络策略

**缺点**：
- 维护成本高
- NAT 穿透依赖 STUN 服务（仍需某种中继）
- 不支持 Tailscale 官方的某些高级功能

本文不赘述 Headscale 部署，有兴趣可参考 [Headscale 官方文档](https://headscale.net/)。

---

## 从 FRP 换成 Tailscale

如果你已经运行了 FRP，这是迁移的推荐流程：

### 步骤 1：并行部署 Tailscale
在 Azure 和 T440 上同时部署 Tailscale，不影响现有 FRP 运行。

### 步骤 2：切换工作流
逐步将关键应用接入点迁移到 Tailscale IP（如 100.64.1.50），保留 FRP 作为备用。

### 步骤 3：监测稳定性
观察 Tailscale 至少一周，确保连接稳定无误。

### 步骤 4：完全切换
确认无误后，停止 FRP 服务：
```bash
sudo systemctl stop frpc
sudo systemctl stop frps
```

### 步骤 5：清理 FRP
```bash
sudo rm -rf /opt/frp
sudo rm /etc/systemd/system/frp*.service
sudo systemctl daemon-reload
```

---

## 一些体会

Tailscale 作为新一代零信任网络解决方案，相比 FRP 最大的优势在于：**自动化、安全性与稳定性**。不再需要手动维护端口转发规则，不再担心暴露在公网的风险，不再因为隧道断连而苦恼。

为了充分发挥 Tailscale 的潜力，总结以下最佳实践：

1. **统一账户管理** —— 使用同一个 Tailscale 账户管理所有节点，便于权限控制
2. **启用 ACL** —— 配置访问控制列表，精细化权限管理，防止意外暴露
3. **监控连接质量** —— 定期检查 DERP 中继使用频率，识别网络瓶颈
4. **定期更新** —— Tailscale 与系统包保持最新，获取安全补丁与性能改进
5. **备份配置** —— 导出 Tailnet 配置与 ACL 规则，防止意外丢失
6. **多地部署** —— 在武汉、乌鲁木齐、其他地区的服务器都部署 Tailscale，形成全局认知网络

从 FRP 的"开放式端口转发"到 Tailscale 的"隐形虚拟网络"，这不仅是技术栈的升级，也是网络安全理念的进阶——从被动防守到主动隐身。希望本文的部署经验能为你的异地组网之旅提供有力支撑。在隐形的虚拟局域网中，武汉与乌鲁木齐的距离不再是 3000 公里，而是一个 ping 的延迟。

