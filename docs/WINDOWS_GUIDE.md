# Antigravity 哈基米（Windows 版）使用说明

本文档面向 **Windows 10 / 11（x64）** 用户，介绍如何构建、使用、升级、切换多账号与排查独立增强版客户端 **`哈基米`**（安装目录：`%LOCALAPPDATA%\Programs\Hakimi`）。

> **安全隔离承诺**：本工具严格只读官方原版 `%LOCALAPPDATA%\Programs\Antigravity`，绝不修改、重签名或删除官方原版客户端；同时复用 `%APPDATA%\Antigravity` 登录态与对话历史，做到**数据共享、程序隔离**。

---

## 一、环境要求

- **操作系统**：Windows 10 / Windows 11（x64）
- **官方原版客户端**：已安装官方 Antigravity（默认位于 `%LOCALAPPDATA%\Programs\Antigravity`）
- **Node.js**：`>= 22.4.0`（运行 `node -v` 确认）
- **PowerShell**：系统自带 Windows PowerShell 5.1 或 PowerShell 7+
- **可选**：若已安装 [7-Zip](https://www.7-zip.org/)，自动升级拆包速度更快；未安装时会自动回退到 Windows 内置 `tar.exe`，**无需额外安装第三方软件**。

---

## 二、首次安装与日常启动

### 1. 一键构建并安装

在 **外部独立 PowerShell 终端**（不要在正在运行的哈基米内嵌终端中覆盖自身）执行：

```powershell
cd C:\work\github\antigravity-hakimi
.\build-hakimi.ps1
```

脚本会自动完成：
1. 编译前端监控面板（`payload\dist\meter-renderer.js`）；
2. 只读检测本机官方 Antigravity 与 Electron Fuses 兼容性；
3. 在临时沙盒目录复制运行环境并注入中文汉化、Context Meter 监控、模型额度/快捷键卡片、多账号冷切与双源自更新模块；
4. 自动替换到 `%LOCALAPPDATA%\Programs\Hakimi`，并在**桌面**和**开始菜单**创建 **`哈基米`** 快捷方式；
5. 自动启动独立版 **`哈基米`**（如不想立即启动，可加 `--no-restart`）。

> [!TIP]
> **首次切换注意**：建议先完全退出原版 Antigravity，再双击桌面或开始菜单的 **`哈基米`** 快捷方式启动，避免两个客户端同时占用同一份 `%APPDATA%\Antigravity` 用户数据锁。

### 2. 常用构建参数速查

| 命令 | 说明 |
| :--- | :--- |
| `.\build-hakimi.ps1` | 默认一键构建、安装、创建快捷方式并启动 |
| `.\build-hakimi.ps1 --no-restart` | 仅安装更新，不自动启动 |
| `.\build-hakimi.ps1 --stage-only` | 仅在 `%TEMP%` 沙盒试构建与校验，不动已安装目录和运行中进程 |
| `.\build-hakimi.ps1 --icon C:\path\to\logo.png` | 指定自定义图标（支持 PNG / JPG / BMP / ICO） |
| `.\build-hakimi.ps1 --restore-icon` | 还原为官方默认图标 |
| `.\build-hakimi.ps1 --client-lang en` | 默认使用英文界面（仍可在面板内随时切换中/英） |
| `.\build-hakimi.ps1 --from D:\Custom\Antigravity` | 手动指定非默认路径的官方只读源目录 |
| `.\build-hakimi.ps1 --no-desktop-shortcut` | 仅保留开始菜单快捷方式，不在桌面创建图标 |

---

## 三、核心功能使用指南

启动 **`哈基米`** 后，原有 Google 登录态与全部历史会话会自动继承，界面中新增以下能力：

### 1. 简体中文界面与语言切换
- 启动即自动生效本地简体中文 DOM 翻译（不影响聊天正文、代码块与外发请求）。
- 点击顶栏 Context Meter 胶囊 → **配置（Settings）** → 可随时在 **简体中文 / English** 间切换。

### 2. 顶栏 Context Meter 实时监控
- 实时显示当前会话**上下文 Token 占用百分比**、输入/输出速率（`tok/s`）、缓存命中率与缓存失效告警。
- 顶栏右侧提供纯图标 **`/compact`** 快捷压缩按钮。
- 点击胶囊展开详情面板，可查看：
  - **历史看板**：按日 / 周 / 月 / 年 / 累计展示纯 Token 消耗热力图；
  - **速率对比**：按模型与思考档位统计输出速率中位数；
  - **错误诊断**：自动归类常见会话失败原因。

### 3. 左下角模型额度卡片、Effort 速切与全局快捷键
- 停靠在左侧导航栏「设置」正上方，支持展示当前模型**本周额度**与可折叠的 **5 小时额度**，支持一键切换「已用 / 剩余」口径；最小化后缩为紧凑同心圆环。
- 点击卡片上的 **Effort** 档位控件可快速升降思考深度。
- 点击快捷键图标可自定义全局组合键（如 `Ctrl+Alt+...` 或 `F1–F12`），快速切换常用模型或调节 Effort 档位。

---

## 四、多 Google / Gemini 账号一键冷切换

Windows 版基于系统原生 **Windows 凭据管理器**（`advapi32.dll`）实现，**零明文 Token 落盘**，切号前通过外部脱离进程完全冷停客户端，**防止串号且保留全部共享对话历史**。

### 1. 桌面端操作流程
入口位于**左下角模型额度卡片标题栏的人像按钮**（若处于未登录页且已有备份账号，左下角会自动浮现快捷切号胶囊；「配置」页内也提供管理卡片）：

1. **保存当前账号**：点击「保存当前账号」，可填写备注（例如 `主力 Pro`、`备用号`）。凭据会安全存入 Windows 凭据管理器的 `antigravity-hakimi-accounts` 保险库。
2. **添加第二个账号**：点击「添加新账号」→ 客户端会自动备份当前账号（**不会吊销原号 Refresh Token**）→ 冷停清理活动登录槽位并重启进入官方 Google 登录页 → 登录第二个账号后再次点击「保存当前账号」。
3. **一键冷切换**：在账号列表中点击目标账号 → 确认后客户端优雅退出（约 3~5 秒）→ 后台脱离进程自动换盘并清理账号绑定残余 → 重新拉起即已无感切至目标账号。

### 2. 命令行管理（CLI）

也可以直接在终端使用内置 CLI：

```powershell
# 查看当前活动账号与已保存快照列表
npm run accounts -- status

# 保存当前活动账号（可选附加备注）
npm run accounts -- save --label "主力号"

# 一键冷切换到指定账号（会自动备份当前账号并重启 Hakimi）
npm run accounts -- switch your_email@gmail.com

# 备份当前账号并重启进入官方登录页以添加新账号
npm run accounts -- add

# 修改备注 / 从保险库删除快照（删除不影响当前已登录状态）
npm run accounts -- rename your_email@gmail.com "工作备用"
npm run accounts -- remove your_email@gmail.com
```

> [!IMPORTANT]
> - 切号前如果检测到终端正在运行 `agy.exe` CLI，会自动拦截以防并发抢写系统凭据；请先退出 `agy` 后再重试。
> - Remote SSH 远端窗口会自动隐藏并禁用本机切号入口。

---

## 五、双源静默自动升级

`哈基米` 内置双源更新器，同时跟踪：
1. **官方 Antigravity**（`latest-x64-win.yml`，自动校验 `SHA-512` 与 `CN=Google LLC` Authenticode 数字签名）；
2. **哈基米 GitHub 仓库**（自动读取安装时记录的 `origin` 仓库与分支，例如 `zhangga/antigravity-hakimi` 的 `main`）。

### 工作流程
1. 启动后每隔 1 小时在后台静默检测（也可在 **配置 → 自动更新** 手动点击「检查更新」）；
2. 发现新版后在临时沙盒自动下载/复用缓存、验签、拆包（优先 7-Zip，无 7-Zip 自动用 Windows 内置 `tar.exe`）并重打包校验；
3. **仅全部校验通过才会提示**：顶栏亮起「更新就绪」按钮，点击后客户端退出 → 独立脱离式进程（避开 `Hakimi\` 目录锁，内置 NTFS 句柄释放重试与 `.prev` 自动回滚）原子替换目录并重启；
4. **失败静默隔离**：若未来官方大版本变动导致暂不兼容，顶栏不弹窗打扰，当前版本不受任何影响，仅在设置面板展示失败阶段诊断。

> [!NOTE]
> 你也可以随时在外部终端拉取最新代码并手动重建：
> ```powershell
> cd C:\work\github\antigravity-hakimi
> git pull
> .\build-hakimi.ps1
> ```

---

## 六、自定义图标（区分原版与哈基米）

为了在任务栏和桌面一眼区分「哈基米」与官方原版：

```powershell
# 支持 PNG / JPG / BMP / ICO，自动居中裁剪生成 256/48/32 多尺寸 .ico
.\build-hakimi.ps1 --icon C:\Users\你的用户名\Pictures\hakimi.png

# 还原官方默认图标
.\build-hakimi.ps1 --restore-icon
```

- 图标保存在 `%LOCALAPPDATA%\Programs\Hakimi\resources\hakimi.ico` 并绑定到 `哈基米.lnk` 与应用窗口 `icon.png`，后续覆盖安装或双源自动升级均会自动沿用。

---

## 七、健康体检与常见问题排查

### 运行一键只读体检

```powershell
npm run doctor
# 输出 JSON 格式便于排查
node scripts/doctor.js --json
```

正常状态应显示 `0 FAIL -> PASS`，涵盖：官方纯净隔离校验、版本同步状态、Electron Fuse 状态、ASAR 注入模块就绪度、原生更新器接管与后台进程状态。

### 常见问题（FAQ）

1. **安装或冷替换提示文件占用 / `EBUSY` / `EPERM`**
   - 检查是否仍有旧的 `Hakimi\Antigravity.exe` 或 `Hakimi\resources\bin\language_server.exe` 在后台常驻（托盘右键彻底退出，或等待 2 秒后重试）；切勿在哈基米内嵌终端中覆盖安装自己。
2. **打开哈基米后仍显示旧图标**
   - Windows 图标缓存可能延迟刷新，重新固定任务栏图标或在任务管理器重启「Windows 资源管理器」即可立即生效。
3. **自动升级提示 `EnableEmbeddedAsarIntegrityValidation=1`**
   - 表示官方未来新版本开启了嵌入式 ASAR 强制完整性校验；出于安全考虑构建器会主动拦截，等待仓库适配更新即可，原有已安装版本不受影响。
4. **如何查看冷切换 / 自动升级日志？**
   - 运行时状态与日志位于 `%LOCALAPPDATA%\AntigravityContextMeter\runtime\`：
     - 多账号冷切日志：`cold-switch.log` / `cold-switch-last-result.json`
     - 自动升级日志：`hakimi-upgrade-cold.log` / `hakimi-upgrade-last-result.json`
   - 所有日志与状态文件均**不含任何 OAuth Token 明文**。

---

## 八、卸载与清理

因为完全独立安装且不写系统注册表，卸载非常简单且不影响官方原版和对话数据：

1. 退出正在运行的 **`哈基米`**；
2. 删除安装目录：`%LOCALAPPDATA%\Programs\Hakimi`；
3. 删除桌面和开始菜单（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\`）下的 `哈基米.lnk`；
4. （可选）如需一并清理监控配置与更新缓存，删除 `%LOCALAPPDATA%\AntigravityContextMeter`（如需清理多账号备份，可在「Windows 凭据管理器 → Windows 凭据」中删除 `antigravity-hakimi-accounts:*` 条目，切勿误删 `gemini:antigravity`）。
