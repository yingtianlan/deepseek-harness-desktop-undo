# 项目进展与交接备忘

> 更新于 2026-08-30。用途：换设备/换会话时快速接续 turn-rewind 插件开发。
> 详细设计见 `docs/TURN_REWIND.md`，用户文档见 `plugins/dsh-tauri-turnrewind/README.md`。

## 一句话状态

turn-rewind 插件 **v0.1.0 已发布**（独立仓库，CI 绿）；完整 undo 闭环（预览红绿 diff → 卡内 ✓/✗ 确认 → 执行 → 结果卡内展示）已在真机验证通过。

## 仓库拓扑

| 仓库 | 位置/远程 | 用途 | 当前位置 |
| --- | --- | --- | --- |
| 桌面开发仓库 | 本机 `Desktop/dsh` ↔ `origin`(dsh-tauri-desk 官方) + `undo`(我的 fork) | 插件开发 + 真机验证 | `feature/turn-rewind` @ `4974221` |
| 桌面仓库 fork | github.com/yingtianlan/deepseek-harness-desktop-undo | fork（备份/PR） | feature/turn-rewind @ `befd18c`（**本地 `4974221` README 修正未推**） |
| 插件发布仓库 | 本机 `Desktop/dsh-tauri-turnrewind` ↔ github.com/yingtianlan/dsh-tauri-turnrewind | 独立发布（v0.1.0 tag，CI 绿） | main @ `6bc62ae` |
| 官方插件参考源码 | 本机 `Desktop/dsh/source/dsh-tauri-plugins` | 只读参考（webServer 路由/client 模式都抄的它） | 本地 clone |

## 本轮已完成（全部真机验证）

- **两阶段 `/undo`**：预览卡（红绿 diff + `+x -y` 徽标 + 文件清单）→ 卡内 ✓/✗ 按钮 →
  ✓ 走同源 HTTP 路由 `/api/turnrewind/confirm` 执行（**不要用 sessions.prompt RPC，实测不通**）→
  结果写回 plan 行，卡片轮询 `/api/turnrewind/status` 就地显示绿字结果
- pending plan 持久化：5 分钟过期、新预览替换旧计划、状态（pending/applied/cancelled）+
  结果文本落账本；**卡片状态一律以账本为准**（刷新/时序都不丢）
- 取消/过期 → 卡片塌缩为无边框细行 `▸ undo · 已取消`（按钮不复活，路由二次校验兜底）
- 工作区守卫三层：家目录/祖先/盘根硬拒 + 预算探测（限额与守卫同源，`TURNREWIND_MAX_FILES`/
  `TURNREWIND_MAX_BYTES`）+ claim 时记录；`skipped` turn + 一次性提示（会话内消息 + 主题化弹窗）
- git 全异步（不冻结 Host）、git 探测、快照链自愈、死引用跳过、排除规则收窄（去掉 `*token*` 误伤）
- 独立发布仓库剥离：`scripts/sync.mjs` 同步流、CI（Node 22/24 矩阵）、lockfile 钉版本

## ⚠️ 未推送提醒

桌面仓库 `feature/turn-rewind` 本地 `4974221`（README 修正）**领先 fork 远程 1 个提交**
（当时网络断没推成）。换设备前在旧设备 `git push undo feature/turn-rewind`；
若已在颠覆性网络环境，新设备需从旧设备取包。

## 换设备环境搭建

1. clone 桌面仓库 + 检出 `feature/turn-rewind`；
2. `pnpm install`；
3. 插件 link 安装（命令见插件 README「从源码开发」节）；
4. 测试：`pnpm exec vitest run plugins/dsh-tauri-turnrewind/test --testTimeout=30000`（当前 43 个全绿）；
5. dev 数据目录 `~/.dsh.dev`（自动），Host 崩溃时看 `~/.dsh.dev` 旁 `dsh-web.dev.log`。

## 下一步待办（优先级序）

1. **干净安装冒烟**：`dsh plugin add github:yingtianlan/dsh-tauri-turnrewind`——非 link 安装下
   client manifest 是否被正确发现，是唯一未实测的发布路径；
2. 新发布仓库补 `pnpm-lock.yaml`（当时网络断没生成）：`pnpm install` 后提交，并把 CI 的
   `--no-frozen-lockfile` 改回 `--frozen-lockfile`、恢复 `cache: pnpm`（ci.yml 有 TODO 注释）；
3. P1 风险清单（详见会话讨论，未落文档的部分）：快照容量 GC、`core.longpaths` 未设
  （Windows 深路径恢复会炸）、崩溃中断 undo 无启动对账、`$DSH_HOME` 在 OneDrive 下的
  SQLite/git 锁风险；
4. 二期遗留：消息旁 `+x -y` 徽标（`conversation.chat.node` 是按键替换渲染，有维护风险，缓行）、
  设置页回退模式切换、子树 undo；
5. 向上游 `dsh-tauri-desk` 提两个 PR：`dsh-src-` 预发布 tag 识别修复（已在本分支）+
   turnrewind 插件本体（可等独立仓库稳定后）。

## 踩坑备忘（血泪浓缩）

- **client 模块 id 必须归一化为包名**：模块系统剥 `/client` 后缀；启动清单只 import 包名。
  注册第二个顶层模块 = apply 永远不执行（无报错、无日志，极难排查）。
- **`git rev-parse --verify <裸sha>` 不检查对象存在性**：快照链校验必须用 ref 名比较。
- **新仓库被上级 pnpm workspace 吞掉**（装到 `C:\Users\<user>` 去了）：加自己的
  `pnpm-workspace.yaml`（键序照抄桌面仓库，有 yaml 排序 lint）。
- **CI `setup-node` 的 `cache: pnpm` 在无 lockfile 仓库会直接 fail**；无 lockfile 期用
  `--no-frozen-lockfile`。
- **dsh Host 对插件 import 失败零容忍**：整个进程退出。改导出/接口后必跑
  `node --input-type=module -e "await import('./lib/index.js')"` 冒烟。
- **eslint 大整理后先 `--fix` 再手工**；jsonc/yaml 的键序规则会用 `--fix` 对齐。
- **push 网络抽风**：`git -c http.proxy= -c https.proxy= push ...` 直连重试；本机 7890 代理
  时好时坏；连不上就等，别硬推。
- 桌面仓库的 vitest 跑不在 root 下的测试文件会被项目 include 过滤掉——验证独立仓库用
  `--root` 或桌面工具链二进制直接指路径。
