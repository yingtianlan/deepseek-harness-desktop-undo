# 项目进展与交接备忘

> 更新于 2026-09-05。用途：换设备/换会话时快速接续 turn-rewind 插件开发。
> 详细设计见 `docs/TURN_REWIND.md`，用户文档见 `packages/dsh-tauri-turnrewind-ts/README.md`。
> 审查与待办的唯一真相源：`docs/TURN_REWIND_REVIEW_2026-09-03.md`（§1.1/§1.2）+ `docs/TURN_REWIND_OPTIMIZATION_SECURITY_AUDIT.md`（§7 统一待办）。

## 一句话状态

turn-rewind TS 重写（`packages/dsh-tauri-turnrewind-ts`，v0.2.0-beta.1，Git 目录模式）已完成 **09-03 审查报告的全部 P0/P1/P2 修复**与安全审计（`TURN_REWIND_OPTIMIZATION_SECURITY_AUDIT.md`）实施顺序第 1、2 条：20 个测试文件、115 个测试全绿；typecheck/eslint（0 problems）/build 全绿。旧 JS 版已删除。剩余待办见上述 §7 与下文「下一步」。

## 仓库拓扑

| 仓库 | 位置/远程 | 用途 | 当前位置 |
| --- | --- | --- | --- |
| 桌面开发仓库（TS 分支） | 本机 `Desktop/dsh-git-rewind-ts` ↔ `origin`（我的 fork） | 插件开发 + 真机验证 | `dsh/turnrewind-ts` @ `0e55e92`+ |
| 桌面仓库 fork | github.com/yingtianlan/deepseek-harness-desktop-undo | 备份/PR | `dsh/turnrewind-ts` 已推送远程 |
| 官方插件参考源码 | 本机 `Desktop/dsh/source/dsh-tauri-plugins` | 只读参考（packages 插件规范） | 本地 clone |
| 旧 JS 实验分支 | 同 fork `dsh/turnrewind-git-dir-undo` | 历史存档（JS 版 Git 模式原型） | 不再演进 |

## 当前形态（Git 目录模式 + TS）

- **TS 重写**：包位于 `packages/dsh-tauri-turnrewind-ts`，遵循 `packages/*` 插件规范（tsdown 构建、exports 指向 `dist/`、workspace catalog 依赖）；host half（`src/host/`）/ client half（`src/client/`）/ shared 常量三层目录。
- **Git-only**：会话 cwd 必须位于 Git worktree（子目录归并到根）；非 Git 目录 turn 记 `skipped`（`TURNREWIND_GIT_REQUIRED`），`/undo` 明确提示。系统目录（家目录/祖先/盘根）硬拒。
- **快照模型（OpenCode 式）**：每个 worktree 一个私有 snapshot repo（`$DSH_HOME/snapshots/<hash>.git`），经 alternates 借用源对象（gc/prune 自愈）；ignore 语义委托源仓库；自定义敏感文件名单已全部移除。
- **原子恢复**：bak-swap（target→bak→temp→target→删 bak），崩溃窗口由启动清扫复活；绝不触碰用户 HEAD/branch/index/stash（git-state.test 钉死）。
- **安全加固（2026-09-03 审查后落地）**：workspace 跨进程锁、plan 预览绑定漂移校验、symlink/junction 拒绝、mode/可执行位恢复、写点全链重验（TOCTOU 缓解）、needs-recovery 实时围栏、SQLite busy_timeout/BEGIN IMMEDIATE、计划构建有界并发、HTTP 路由一次性响应/超时/nosniff/格式校验。
- **容量治理（P2-4）**：`TURNREWIND_RETAIN_TURNS`（默认 50，超出标记过期）+ `TURNREWIND_MAX_SNAPSHOT_MB`（默认 1024，超限整仓重建自愈基线）。
- **留档可查**：过期/取消/被替换的 plan 转 `expired` 永久保留（卡片可回看 diff，仅锁执行）；unsupported 提示**单会话只报一次**（历史提示以会话内消息永久可见，重启/清浏览器存储不重弹）。
- **redo 已冻结**：入口拒绝，底层加固保留（一行重开）。

## 本轮已完成（09-03 审查 → 09-05）

- 审查报告（09-03）P0×5 + P1×5 + P2×3 全部修复或关闭，详见报告 §1.1/§1.2；
- 安全审计报告（09-05）实施顺序第 1、2 条完成：client compat 解析修复、purge CLI（`purge-workspace.mjs`）、弹窗种子纯函数化 + 测试、prepublishOnly 修复；
- UI 修复：css-render 裸数字 px 根因、dialog/-card 类名冲突、提示高对比与对齐；
- 20 个测试文件、115 个测试全绿。

## 换设备环境搭建

1. clone fork + 检出 `dsh/turnrewind-ts`；
2. `pnpm install`；
3. `pnpm --filter dsh-tauri-turnrewind build`（产出 `dist/`，Host 导入必需）；
4. 测试：`pnpm --filter dsh-tauri-turnrewind test`；
5. debug 桌面端启动时自动以 `link:` 安装全部内部插件（含本插件）；dev 数据目录 `~/.dsh.dev`，日志在 `%APPDATA%\io.github.hairyf.deepseek-harness-desktop\logs\dsh-web.dev.log`。

## 下一步待办（优先级序）

统一待办见 `TURN_REWIND_OPTIMIZATION_SECURITY_AUDIT.md` §7，当前优先级序：

1. 真实 DSH lifecycle 集成测试（agent-loop claim → baseline → tool write 时序）；
2. P2-1 子树 undo（先定 DSH turn tree 契约，接入 parentTurnId + planner）；
3. P2-4 后续：retention 并发安全（纳入 workspace lock + quarantine 两阶段重建）；
4. P2-8 剩余：协议常量收敛 + Host/client 路径契约测试、`expandKey` 稳定化、`as never` 移除、文案入 locales；
5. 消息旁 Undo 按钮、设置页回退模式；干净安装冒烟；
6. redo 重开（一行闸门，需产品拍板）。

## 踩坑备忘（血泪浓缩）

- **client 模块 id 必须归一化为包名**：模块系统剥 `/client` 后缀；启动清单只 import 包名。
- **keyed slot 必须带 `key`**：`conversation.chat.commandview` 注册时漏 `key` 会直接 fail apply（报 `requires options.key`）。
- **`dsh.client.inject` 必须列出 `dsh-tauri`**：client bundle 里 `require('dsh-tauri/client')` 依赖 ModuleLoader 注入该模块，漏了报 `missed the module table`；同时 `dsh.client.external` 也要声明 `dsh-tauri/client`。
- **client bundle 是浏览器脚本**：`dist/client.cjs` 第一行就引用 `window`；Node 单测要通过 vitest alias 指到 TS 源码（见 `vitest.config.ts`）。
- **包名 ≠ 目录名**：包名 `dsh-tauri-turnrewind`，目录 `packages/dsh-tauri-turnrewind-ts`；`pnpm --filter` 按包名。
- **Host 导入零容忍**：改导出/接口后必跑 `node --input-type=module -e "await import('.../dist/index.js')"` 冒烟；改后必 `pnpm --filter dsh-tauri-turnrewind build`。
- **pnpm store 版本冲突**：debug profile 的 `node_modules` 若由不同大版本 pnpm 安装，重装会报 `ERR_PNPM_UNEXPECTED_STORE`——删 profile 的 `node_modules` 重来即可。
- **`git rev-parse --verify <裸sha>` 不检查对象存在性**：快照链校验必须用 ref 名比较。
- **dsh Host 对插件 import 失败零容忍**：整个进程退出。
- **push 网络抽风**：`git -c http.proxy= -c https.proxy= push ...` 直连重试。
