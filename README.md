# antigravity-hakimi (`哈基米.app`)

> 面向 **macOS Apple Silicon (ARM64)**，直接从官方更新源拉取并验签最新版 Antigravity（无需预先安装原版，也可离线基于本地只读 `/Applications/Antigravity.app`）构建独立增强版桌面客户端 **`/Applications/哈基米.app`**。与官方客户端共享 Google 登录态、历史对话与设置，同时严格保持官方 `/Applications/Antigravity.app`（及 `.orig`）只读不改。

---

## 核心特性

1. **账号地区 / Free-tier 自适应解锁与版本同步检测**
   - [`meter-region-unlock.js`](payload/dist/meter-region-unlock.js) 动态解析 `language_server` Mach-O Go `.gopclntab` 符号表与 `authclient.ValidateAndOnboardAccount` 指令特征，自动定位 `"free-tier"` 限制分支并写入无条件跳转，不依赖写死 SHA-256 或固定偏移。
   - **`agy` CLI 地区解锁（macOS ARM64 & Linux `x86-64` / `arm64`）**：[`meter-cli-unlock.js`](payload/dist/meter-cli-unlock.js) 与独立 Python 版 [`unlock/agy-cli/agy-patch.py`](unlock/agy-cli/agy-patch.py) 支持在 macOS 和 Linux（兼容 ELF64 PIE `.rela.dyn`）上对本机 `agy` CLI 二进制执行自适应地区解锁。
   - **语义化版本同步检测**：比对只读官方 `/Applications/Antigravity.app` 与 `/Applications/哈基米.app` 的 `CFBundleShortVersionString`，仅当官方版本**高于**哈基米版本时弹出同步提示；当哈基米通过内置升级超前于本地只读官方版时自动放行。

2. **双源静默自动升级与一键原子冷替换**
   - **官方反重力 + 哈基米本体双源追新**：直接读取 `app-update.yml` 拉取官方最新 `latest-arm64-mac.yml` 与 `Antigravity.zip`（校验 `SHA-512` 与 Google LLC Developer ID 代码签名），同时追踪 `cli117/antigravity-hakimi` 的 `main` 最新提交（基于包内 `hakimi-build-meta.json` 与 GitHub `compare` 仅在 `ahead` 时触发，避免误降级本地开发版）。后台通过 Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`）完成构建，不依赖本地仓库路径、`git` 或系统 `node`。
   - **仅验证成功才提示**：检测到上游更新后在独立沙盒静默执行全套构建与校验（`region-unlock` + `pack-hakimi-asar` + `ElectronAsarIntegrity` SHA-256 + 自定义图标沿用 + `codesign --verify --strict`）。**只有全部通过**，顶栏才会亮起「重启更新」提示；点击后由零外部依赖的脱离式冷替换进程 [`hakimi-upgrade-helper.js`](payload/dist/hakimi-upgrade-helper.js) 完成零存活退出屏障、`SingletonLock` 清理、同盘 APFS 原子替换（失败通过 `.prev` 自动回滚）与干净环境重启。
   - **失败静默隔离与原生更新器接管**：若官方新版本导致补丁不兼容，顶栏保持安静且不影响当前版本，仅在「设置」面板更新卡片记录具体失败阶段诊断，并跳过该不兼容版本直到哈基米 `main` 有新提交再重试（期间若 `main` 领先仍可回退执行仅哈基米升级）。同时在模块边界包装接管原生 `dist/updater.js`，禁用必然验签失败的 Squirrel.Mac，消除原版更新按钮闪现消失问题。
   - **严格磁盘防囤积**：官方干净 `Antigravity.zip` 仅维护单槽位缓存（对应当前已安装版本，并避免与 `~/Library/Caches/com.google.antigravity/` 重复留存），哈基米源码 tarball 与失败沙盒用完即删，`.prev` 替换成功后立刻清理，启动时自动执行 Orphan GC 清扫异常中断残留。仅限 macOS 本机窗口，Remote SSH 窗口自动隐藏。

3. **macOS 钥匙串多账号冷切换**
   - 入口位于左下角模型额度卡片标题栏人像图标（停留在未登录页且已有备份账号时，左下角自动浮现快捷切回胶囊；「配置」页同步提供管理卡片），支持保存/更新账号快照、行内编辑备注名、添加新账号（不吊销原号 Refresh Token）与两步删除 Vault 备份。
   - **外部接力全冷停换盘**：切换时由零外部依赖的脱离式子进程 [`meter-account-cold-helper.js`](payload/dist/meter-account-cold-helper.js) 等待 `哈基米.app`、`language_server` 与 sidecars 全部归零并清理残留 `SingletonLock`，再执行原子换盘与干净环境变量重启（`open -n`），避免运行中热切导致的内存旧状态残留。
   - **防串号与零明文落盘**：凭据严格存放于 macOS 系统钥匙串（活动槽位 `("gemini", "antigravity")` ↔ Vault `antigravity-hakimi-accounts`），写入走 `/usr/bin/security -i` stdin 管道，状态刷新仅用不带 `-w` 的元数据探测；切换时拦截运行中的 `agy` CLI，清理 `credential-user-scope`、降级 Token 文件与缓存 Mendel 开关，并按账号还原 `agy.onboarding.lastLoginUsername` / `lastLoginIsGcpTos` 以免重复弹出引导确认窗，同时保留 `installation_id` 与共享历史对话。
   - 仅限 macOS 本机窗口生效，Remote SSH 窗口自动隐藏并拦截。

4. **左下角模型额度卡片、Effort 速切与自定义快捷键**
   - 独立停靠于左侧栏底部「设置」上方（侧栏收起或手动最小化时自动缩为双/单同心圆环状态点），实时展示当前模型本周额度与可折叠的 5 小时额度，支持一键切换「已用 / 剩余」口径并在每轮对话结束后自动刷新（10 分钟冷却防抖）。
   - 卡片内置当前模型 **Effort 思考档位**速切步进按钮，并配备二级快捷键浮层，支持录制全局组合键以直达指定模型/档位、上下切换模型或调整 Effort。

5. **实时上下文监控、缓存命中率告警与纯 Token 历史看板**
   - 顶栏悬浮胶囊（Context Meter）实时展示当前会话上下文 Token 占用进度、输入/输出速率（`tok/s`）、上下文缓存命中率，以及 8 类失败原因自动分类诊断。
   - 顶栏内置纯图标 `/compact` 快捷压缩按钮；缓存命中率智能区分新会话首轮冷启动与多轮缓存失效（琥珀色/红色告警与悬停构成气泡），并在会话详情提供四维缓存速览卡片。
   - 历史看板统计桌面端与 CLI 的纯 Token 消耗（输入 / 输出 / 缓存读取），提供日/周/月/年/累计热力图、按模型与档位分组的输出速率中位数对比，以及订阅套餐与 Prompt / Flow 额度池详情。

6. **桌面端简体中文界面**
   - 通过 `app.asar` 预加载注入全量简体中文词库（`zh-CN.json`）与 DOM 翻译引擎（`i18n-runtime.js`），严格限定于本地 Electron DOM 界面渲染，不触碰聊天正文、代码块或外发请求，支持在面板中随时切回英文界面。

7. **Remote SSH 远端无缝适配（Linux `x86-64` & `arm64`）**
   - [`meter-ssh.js`](payload/dist/meter-ssh.js) 注入 `dist/remote/bootstrapScript.js` 与 `dist/remote/remoteManager.js`：通过 Remote SSH 连接 Linux 主机时，自动对远端 `~/.antigravity-hub-server/bin/<ver>-<arch>/language_server`（64 位 ELF `x86-64` / `arm64`，兼容 PIE `.rela.dyn`）执行自适应地区解锁并接管重启未修补服务（日志写远端 `hakimi-patch.log`，异常自动 fail-open，不污染引导 stdout）。
   - SSH 窗口内同样生效简体中文界面与顶部 Context Meter 监控条，复用窗口独立 Electron `session` 走内置 SSH SOCKS5 通道直连远端语言服务，与本机窗口严格隔离。

8. **应用内实时预览换图标与一键健康诊断**
   - **应用内直接更换/还原图标**（「配置」页「应用图标（哈基米）」卡片）：支持点击选图或从 Finder 直接拖入本地图片（`PNG` / `JPG` / `WebP` / `HEIC` / `ICNS` 等），实时渲染 **当前 → 新图标** 预览并支持在线切换「自动添加 macOS 圆角留白遮罩 / 原图直出」；点击应用后先在隔离沙盒（APFS CoW 克隆）完成图标替换、ASAR 摘要更新与 `codesign --verify --strict` 校验，全部通过后再经脱离式冷替换进程原子替换并重启；支持一键恢复官方默认图标（依次只读提取本地官方包 / 单槽底包缓存 / 自动留存的默认图标快照），后续覆盖构建与自动升级会自动沿用自定义图标。Remote SSH 窗口自动隐藏并拦截。
   - 命令行仍支持 `build-hakimi.sh --icon` / `--raw-icon` / `--default-icon` 与 `set-hakimi-icon.sh` 原位秒级换图。
   - `npm run doctor`（[`scripts/doctor.js`](scripts/doctor.js)）一键只读核查官方纯净隔离、语义化版本同步、`ElectronAsarIntegrity` 摘要、`codesign --verify --strict`、原生更新器接管状态、地区解锁状态、运行进程与 `agy` CLI 状态。

---

## 安全与隔离设计

- **只读官方守卫 (`assertNotOfficialAntigravityApp`)**：构建、签名、图标替换与冷切换重启全链路强制校验目标路径绝非 `/Applications/Antigravity.app`、`/Applications/Antigravity.app.orig` 或其符号链接。
- **Bundle 身份保留**：`/Applications/哈基米.app` 保留内部 `CFBundleIdentifier` (`com.google.antigravity`) 与可执行文件名 `Antigravity`，与官方客户端共享登录态与本地会话目录。
- **零提示词与零外发请求篡改**：不修改任何系统提示词、工具声明或会话消息正文，预加载脚本与渲染层不包含任何 `fetch` / `WebSocket` / `XMLHttpRequest` 外发请求拦截钩子。

---

## 快速使用

### 1. 构建并安装 `/Applications/哈基米.app`

```bash
# 一键安装或升级（默认拉取/复用官方最新签名版 + 覆盖安装 + 解锁本机 agy CLI + 自动打开/重启）
bash ./build-hakimi.sh

# 指定一张本地图片作为应用图标（支持 PNG/JPG/WebP/HEIC/ICNS）
bash ./build-hakimi.sh --icon ~/Pictures/hakimi.jpg

# 纯离线使用本机 /Applications/Antigravity.app 构建（不联网）
bash ./build-hakimi.sh --local

# 单独解锁本机 agy CLI 或运行只读健康诊断
npm run unlock:cli
npm run doctor
```

### 2. Windows 10 / 11 独立版构建、多账号冷切与自动更新

Windows 下默认只读读取本机官方 `%LOCALAPPDATA%\Programs\Antigravity`（严禁修改官方原版），在同级构建独立客户端 **`%LOCALAPPDATA%\Programs\Hakimi`** 并创建开始菜单/桌面 **`哈基米`** 快捷方式（要求 Node.js `>= 22.4.0`）：

```powershell
# 一键构建、安装并启动独立版（保留官方原版纯净隔离）
.\build-hakimi.ps1

# 仅在临时沙盒试构建与校验（不动已安装目录与运行中进程）
.\build-hakimi.ps1 --stage-only

# 指定自定义图标（PNG/JPG/BMP/ICO，自动生成多尺寸 .ico 绑定快捷方式与窗口图标，不破坏主程序签名）
.\build-hakimi.ps1 --icon C:\path\to\hakimi.png

# 构建但不自动启动 / 恢复官方默认图标
.\build-hakimi.ps1 --no-restart
.\build-hakimi.ps1 --restore-icon

# 只读健康诊断（官方纯净隔离、Electron Fuse、ASAR 模块、版本同步与运行进程）
npm run doctor

# 终端管理多账号（Windows 凭据管理器原生 Vault，零明文落盘，亦可在桌面左下角浮层操作）
npm run accounts -- status
npm run accounts -- save --label "主力号"
npm run accounts -- switch <email>
```

- **Windows 完整双源静默自动升级**：应用内自动监测官方 `latest-x64-win.yml` 与 GitHub 仓库提交；拉取官方 NSIS 安装包后强制校验 `SHA-512` 与 `CN=Google LLC` Authenticode 签名，优先使用 7-Zip、无 7-Zip 时自动按 7z 头部切片调用 Windows 原生 `tar.exe` 零依赖拆包，沙盒校验通过后经独立脱离式 Worker（避开目录占用锁 + NTFS 重试与 `.prev` 自动回滚）原子替换并重启。

### 3. 在 Linux 开发机解锁 `agy` CLI（支持 `x86-64` / `arm64`）

Linux 环境无需 macOS `codesign` 或桌面端应用，自动探测 `~/.local/bin/agy`、`~/.antigravity/antigravity/bin/agy`、`$PATH`（或通过 `--binary` / `AGY_CLI_BIN` 指定）：

```bash
# 方式一（推荐，一键自动识别 Linux 并解锁 agy CLI）：
bash ./build-hakimi.sh

# 方式二（Node.js CLI 命令）：
npm run unlock:cli
# 仅检测状态或显式指定二进制路径：
node scripts/cli-unlock.js --analyze
node scripts/cli-unlock.js --apply --binary ~/.local/bin/agy

# 方式三（无 Node.js 环境，纯 Python 3）：
python3 unlock/agy-cli/agy-patch.py --in-place
```

### 3. 为已构建的 `哈基米.app` 快速换图标

`set-hakimi-icon.sh` 原位替换 `.icns` 与 `app.asar/icon.png` 并刷新完整性与签名（约 1~2 秒，不重新复制 `language_server`）：

```bash
# 替换图标（应用正在运行时可加 --restart 自动重启）
bash ./set-hakimi-icon.sh ~/Pictures/new-icon.png --restart

# 自定义图标不加圆角遮罩
bash ./set-hakimi-icon.sh --icon ~/Pictures/logo.png --raw-icon

# 还原为官方默认图标（从官方 app 只读提取）
bash ./set-hakimi-icon.sh --restore --restart
```

### 4. 构建参数说明

直接运行 `./build-hakimi.sh` 即可一步完成：**拉取/复用官方最新签名版**（断网时自动回退本机官方源）→ **覆盖安装** → **联动解锁本机 `agy` CLI** → **自动重启或首次打开 `哈基米.app`**（Linux 上则自动仅解锁 `agy` CLI）。

```text
./build-hakimi.sh [选项]
  --stage-only                    仅在 /tmp 临时目录试构建并验签，不写入 /Applications、不改用户配置目录、不打开应用
  --local                         强制纯离线使用本机只读官方源 (优先 /Applications/Antigravity.app.orig，其次 /Applications/Antigravity.app)
  --from <path>                   显式指定只读官方 Antigravity.app 本地源路径
  --fetch-latest                  强制从官方更新源拉取/复用最新 Antigravity（默认已开启；显式指定时断网不回退本机旧版）
  --app <path>                    指定输出 .app 路径 (默认: /Applications/哈基米.app；严禁指向官方 Antigravity.app)
  -i, --icon <path>               指定本地图片作为应用图标 (不传时若旧副本已有自定义图标会自动保留)
  --raw-icon                      配合 --icon 使用，不自动添加 macOS 圆角矩形留白遮罩
  --default-icon                  覆盖旧副本时强制恢复为默认官方图标
  --no-restart, --no-open         构建完成后不自动退出/重启或自动打开目标应用
  --no-cli                        跳过本机 agy CLI 地区解锁联动
  --no-overwrite                  若输出 .app 路径已存在则报错退出而不覆盖
  --cli-only                      仅对本机 agy CLI 执行地区解锁，跳过 macOS 桌面应用构建（支持 Linux 与 macOS）
  --cli-bin <path>                指定 agy 二进制路径并严格校验解锁
  --client-lang <zh-CN|en>        初始化桌面端界面语言 (首次默认为 zh-CN)
  --force, -r, --restart, --patch-cli
                                  向下兼容参数（现均已默认开启；显式传 --patch-cli 时 CLI 解锁失败会返回非 0）
```

---

## 开发与测试

```bash
# 编译渲染层 src/renderer/* -> payload/dist/meter-renderer.js
npm run build:renderer

# 自动编译渲染层并运行全部自动化单测
npm test

# 只读健康诊断（支持 --json / --allow-missing）
npm run doctor

# 安全沙盒构建验证（仅在 /tmp 目录构建与验签，不动 /Applications 与用户目录；离线可加 --local）
bash ./build-hakimi.sh --stage-only
bash ./build-hakimi.sh --stage-only --local
```

## 目录结构

- `build-hakimi.sh`：一键拉取/复用官方最新签名版（断网自动回退本地源，也支持 `--local` / `--from`）、自定义图标处理、自适应地区解锁、ASAR 重打包、`hakimi-build-meta.json` 写入、`ElectronAsarIntegrity` 同步、`codesign` 签名、默认覆盖与自动打开/重启及 CLI 解锁脚本
- `set-hakimi-icon.sh`：针对已构建 `哈基米.app` 原位秒级替换/还原图标的轻量脚本
- `scripts/`：
  - `build-renderer.js`：将 `src/renderer/*` 编译拼装为 `payload/dist/meter-renderer.js`
  - `pack-hakimi-asar.js` / `replace-asar-icon.js`：调用自包含打包器重打包官方 `app.asar`、注入主进程/预加载/Remote SSH/`dist/updater.js` 钩子、替换内置 `icon.png` 并计算头摘要 SHA-256
  - `build-macos-icon.js`：本地图片转 `.icns` 与 `512x512` Dock PNG
  - `region-unlock.js` / `cli-unlock.js` / `doctor.js`：地区解锁 CLI、`agy` CLI 解锁 CLI、只读健康诊断工具
  - `lib/target-app-lifecycle.sh`：目标 `.app` 进程探测与零存活退出屏障公共库
- `payload/dist/`：
  - `asar-engine.js` / `hakimi-asar-packer.js` / `modular-installer.js` / `modules-config.js` / `binary-utils.js`：ASAR 读写与自包含打包、官方路径守卫、钩子注入、状态持久化（含语义化版本同步）与 Mach-O/ELF Go 符号解析公共工具
  - `hakimi-builder.js` / `hakimi-updater.js` / `hakimi-upgrade-helper.js` / `hakimi-icon-manager.js`：官方源拉取与 Google 验签、GitHub `main` 提交对比与沙盒试构建、双源静默升级状态机与 `dist/updater.js` 接管桥接、应用内图标实时预览与沙盒替换/还原、零依赖脱离式 APFS 原子冷替换与 Orphan GC
  - `meter-region-unlock.js` / `meter-cli-unlock.js` / `meter-ssh.js` / `meter-enhance.js`：桌面端与 `agy` CLI 地区解锁、Remote SSH 远端 ELF64 自动解锁与会话通道、后台语言服务检测与重启
  - `meter-account-cold-helper.js` / `meter-account-switcher.js`：macOS 钥匙串多账号冷切换独立工作进程与编排引擎
  - `meter-main.js` / `local-api.js` / `meter-collector.js` / `meter-core.js` / `meter-storage.js`：主进程 IPC、本地 API、Token 历史与额度采集及纯 Token 统计分析
  - `i18n/i18n-runtime.js` & `i18n/zh-CN.json`：桌面端简体中文 DOM 翻译运行时与词库
- `src/renderer/`：Context Meter 悬浮胶囊、顶栏升级提示与设置更新卡片、左下角模型额度与 Effort 速切卡片、自定义快捷键浮层、多账号冷切换浮层、速率对比与纯 Token 热力图源码
- `unlock/agy-cli/agy-patch.py`：独立 Python 版 `agy` CLI 自适应地区解锁工具
- `test/`：自动化单元测试套件（双源自动升级与原子冷替换、应用内图标替换与还原、冷切账号、ARM64/ELF64 地区解锁、ASAR 打包与符号守卫、模型额度与快捷键、Remote SSH）

---

## 致谢与上游项目

- **Context Meter / 看板与汉化基础**：本项目的前端监控面板、纯 Token 统计与桌面端简体中文化运行时基于 [`elviscjn-cjn/antigravity-context-viewer`](https://github.com/elviscjn-cjn/antigravity-context-viewer)（`v0.8.3`）演进，在此基础上构建了 macOS Apple Silicon 独立 `/Applications/哈基米.app` 打包体系、双源静默自动升级与原子冷替换、自适应账号地区与 `agy` CLI 解锁、Remote SSH 远端自动解锁、左下角模型额度/Effort/快捷键卡片、macOS 钥匙串多账号冷切换及自定义图标能力。
