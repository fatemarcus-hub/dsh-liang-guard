# dsh-liang-guard · 梁神卫士 🛡️

[English](#english) | 中文

DeepSeek Harness (DSH) Web UI 的系统卫士插件：在左侧栏 **新建会话按钮下方** 注入
"梁神卫士"按钮，点击弹出与设置弹窗同规格的模态框。所有功能**真实执行**——直接调用
Windows Defender、CIM 性能计数器、netsh 等系统组件，不是摆设界面。

> 灵感来自传统"卫士"类软件，但原则相反：只报告真实检测到的东西，绝不制造焦虑。
> 插件接入模式参照 [dsh-balance](https://github.com/fatemarcus-hub/dsh-balance)
> 的 host/client 双层设计，零侵入、不改 harness 核心代码。

## 功能总览

| 模块 | 功能 | 实现方式 |
|---|---|---|
| 🩺 一键体检 | Defender 实时保护/病毒库 · 防火墙 · 磁盘水位 · 内存压力 · 临时文件 · 启动项 · 网络延迟 → 综合评分（含历史对比） | `Get-MpComputerStatus` / `Get-NetFirewallProfile` / CIM |
| 🦠 病毒查杀 | 快速/全面查杀（真实驱动 Defender 引擎）· 运行计时 · 可取消 · 威胁列表与一键清除 · 查杀历史 | `MpCmdRun.exe -Scan` / `Get-MpThreat` / `Remove-MpThreat` |
| 🌐 网络服务 | 三节点延迟 + 真实下载带宽测试 · DNS 缓存刷新（免提权）· 深度修复（winsock/TCP-IP 重置，需管理员） | `Test-Connection` / Cloudflare 测速端点 / `netsh` |
| 📊 系统情况 | CPU/内存实时曲线 · 磁盘水位 · TOP 内存进程 · 一键释放内存 · 磁盘空间分析（TOP 目录/大文件，异步任务） | CIM 计数 / `EmptyWorkingSet` / 单遍递归扫描 |

**后台感知**：扫描进行中，侧栏按钮挂蓝色呼吸点；结束后右下角 Toast + 浏览器桌面
原生通知，点击直达结果。关掉弹窗、甚至刷新页面都不丢任务状态。

**原生设置卡片**（需 DSH 0.1.0-rc.7+）：DSH 设置弹窗里出现"梁神卫士"卡片，可配置
桌面通知开关、监控轮询间隔、历史保留条数、测速下载量，白名单校验落盘
`~/.dsh/liang-guard/config.json`。

## 系统要求

- **Windows**（Defender / PowerShell / CIM 依赖；功能全部 Windows 专属）
- **DSH 0.1.0-rc.7+**（`webServer` 路由注册 + `settings.section` 设置卡片）；
  rc.6 可运行弹窗主体，但无设置卡片
- Node 22+（随 DSH）

## 安装

### 方式一：一键脚本（推荐）

```powershell
git clone https://github.com/YOUR_GITHUB_USERNAME/dsh-liang-guard.git "$env:USERPROFILE\.dsh\plugins\dsh-liang-guard"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\plugins\dsh-liang-guard\install.ps1"
```

重启 DSH，强刷浏览器（Ctrl+F5），左侧栏即见按钮。

### 方式二：手动三步

1. 把本仓库放到 `~/.dsh/plugins/dsh-liang-guard`
2. 链接进 profile（Windows junction，或类 Unix 符号链接）：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-liang-guard" -Target "$env:USERPROFILE\.dsh\plugins\dsh-liang-guard"
   ```

3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: dsh-liang-guard
         name: 'dsh-liang-guard'
   ```

卸载：`uninstall.ps1`（或删除 junction / plugins 目录 / patch 条目）。

## 架构与安全模型

```
侧栏按钮 + 卫士弹窗 + 设置卡片        lib/client.js（浏览器端）
        │ fetch 同源相对路径
        ▼
/plugins/dsh-liang-guard/api/*       lib/index.js（DSH 进程内）
  信任围栏：Host 回环或可信域 + Origin 同源 + 拒绝 cross-site
        │ 固定字符串 PowerShell（客户端仅可传白名单枚举参数）
        ▼
Windows Defender / CIM / netsh / psapi —— 真实系统操作
```

- **零端口**：API 挂载在 DSH 自己的 web 端口上（`ctx.webServer.register`），
  不监听任何额外端口，无 CORS，局域网设备访问 DSH 时自动可用。
- **零注入面**：所有 PowerShell 都是服务端固定字符串；客户端可传的参数只有
  `scan.mode ∈ {quick, full}`、`repair.level ∈ {dns, full}`、盘符单字母、
  数值钳制后的配置项。没有文件路径、没有自由命令。
- **零侵入**：不改 DSH 任何文件；junction + cordis.patch.yml 注册，随装随卸，
  DSH 升级无感。
- 数据落盘仅两处：`~/.dsh/liang-guard/history.json`（体检/查杀历史）与
  `config.json`（设置）。

## 权限说明

普通权限即可：体检、查杀、测速、DNS 刷新、收缩自己进程的内存。
需要管理员：深度网络修复、收缩他人进程工作集（未提权时如实报告跳过数量，
弹窗头部徽章实时显示当前权限）。

## 已知边界（如实告知）

- 全面查杀由 Windows 安全中心调度，可能持续数小时；"取消"结束的是等待进程，
  服务端扫描可能继续。
- "释放内存"的收益有限——Windows 自身的内存管理通常更聪明；卫士只如实报告
  收缩/跳过数与释放量。
- 大磁盘（数 TB）的空间分析可能需要几分钟，属正常物理开销，可随时取消。

## 开发

```powershell
# 独立起一个假 webserver 测试宿主端点（不启动 DSH）
node test-drive.mjs   # 假 DSH webserver 监听 3992，API 在 /plugins/dsh-liang-guard/api/*
```

无构建步骤：`lib/` 就是发布产物，改完同步到 `~/.dsh/plugins/dsh-liang-guard/lib/`
并重启 DSH 即可。

## License

[MIT](LICENSE)

---

<a id="english"></a>

# dsh-liang-guard · Liang Guard 🛡️

A system-guard plugin for DeepSeek Harness (DSH) web UI. Injects a guarded
button right below the sidebar's **New Session** button; clicking opens a
settings-style modal with four tabs. Everything runs for real — actual
Windows Defender scans, CIM performance counters, netsh repairs.

**Highlights**

- One-click health check with scoring and history diff
- Real Defender quick/full scans via `MpCmdRun.exe` (async, cancellable,
  background breathing-dot indicator + toast + desktop notification)
- Latency + bandwidth speed test, DNS flush and deep network repair
- Live CPU/memory sparklines, disk usage, top processes, one-click memory
  release (working-set trim), per-drive space analysis (async)
- Native DSH settings card (requires DSH 0.1.0-rc.7+)
- Same-origin API mounted on the DSH webserver — zero extra ports, zero CORS,
  zero injection surface (fixed PowerShell strings + whitelisted enum params)

**Requirements**: Windows, DSH 0.1.0-rc.7+, Node 22+.

**Install**: clone into `~/.dsh/plugins/dsh-liang-guard`, run `install.ps1`,
restart DSH, hard-refresh the browser. See the Chinese section above for a
manual three-step alternative and the security model.

[MIT](LICENSE)
