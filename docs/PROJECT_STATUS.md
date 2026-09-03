# 项目进展与交接备忘

> 更新于 2026-09-03。用途：换设备/换会话时快速接续 turn-rewind 插件开发。
> 详细设计见 `docs/TURN_REWIND.md`，用户文档见 `packages/dsh-tauri-turnrewind-ts/README.md`。

## 一句话状态

turn-rewind 已完成 **TypeScript 重写**（`packages/dsh-tauri-turnrewind-ts`，v0.2.0-beta.1），并切换为 **Git 目录模式**：工作区必须是 Git worktree，非 Git 目录禁用（`TURNREWIND_GIT_REQUIRED`）；17 个测试文件、82 个测试全绿；完整 undo 闭环（预览红绿 diff → 卡内 ✓/✗ 确认 → 执行 → 结果永久可查）已在真机验证通过。旧 JS 版（`plugins/dsh-tauri-turnrewind`）已删除。

## 仓库拓扑

| 仓库 | 位置/远程 | 用途 | 当前位置 |
| --- | --- | --- | --- |
| 桌面开发仓库（TS 分支） | 本机 `Desktop/dsh-git-rewind-ts` ↔ `origin`（我的 fork） | 插件开发 + 真机验证 | `dsh/turnrewind-ts` @ `dace50b`+ |
| 桌面仓库 fork | github.com/yingtianlan/deepseek-harness-desktop-undo | 备份/PR | `dsh/turnrewind-ts` 已推送远程 |
| 官方插件参考源码 | 本机 `Desktop/dsh/source/dsh-tauri-plugins` | 只读参考（packages 插件规范） | 本地 clone |
| 旧 JS 实验分支 | 同 fork `dsh/turnrewind-git-dir-undo` | 历史存档（JS 版 Git 模式原型） | 不再演进 |

## 当前形态（Git 目录模式 + TS）

- **TS 重写**：包位于 `packages/dsh-tauri-turnrewind-ts`，遵循 `packages/*` 插件规范（tsdown 构建、exports 指向 `dist/`、workspace catalog 依赖）；host half（`src/host/`）/ client half（`src/client/`）/ shared 常量三层目录。
- **Git-only**：会话 cwd 必须位于 Git worktree（子目录归并到根）；非 Git 目录 turn 记 `skipped`（`TURNREWIND_GIT_REQUIRED`），`/undo` 明确提示。系统目录（家目录/祖先/盘根）硬拒。
- **快照模型（OpenCode 式）**：每个 worktree 一个私有 snapshot repo（`$DSH_HOME/snapshots/<hash>.git`），经 alternates 借用源对象（gc/prune 自愈）；ignore 语义委托源仓库（`.gitignore`/`.git/info/exclude`/global excludes/`.gitattributes`）；自定义敏感文件名单已全部移除。
- **原子恢复**：bak-swap（target→bak→temp→target→删 bak），崩溃窗口由启动清扫复活；绝不触碰用户 HEAD/branch/index/stash（git-state.test 钉死）。
- **客户端**：React 组件（command-view）渲染两阶段 undo 卡片 + 不可用弹窗；plan 提交按钮点击即禁用+「执行中…」，结果永久保留在账本（settled 行不清理，可追溯）。

## 本轮已完成

- TS 重写全量落地：host（apply/ledger/git-snapshot/git-workspace/guard/planner/undo/routes/dialog-projection/maintenance）+ client（command-view/dialog/register/utils/locales）
- 17 个测试文件、82 个测试全绿：git-state 零污染、atomic-restore、git-gc 自愈、git-worktree 隔离、git-ignore 委托、oversize 单文件报告、barrier 时序、ledger 生命周期、client 纯函数
- JS 版目录删除，文档同步为 Git-only + TS 描述
- plan 结果行永久保留（可追溯）；提交按钮 spinner + 防重复点击
- keyed slot 修复（`conversation.chat.commandview` 需要 `key`）；`dsh.client.inject` 补 `dsh-tauri` 依赖

## 换设备环境搭建

1. clone fork + 检出 `dsh/turnrewind-ts`；
2. `pnpm install`；
3. `pnpm --filter dsh-tauri-turnrewind build`（产出 `dist/`，Host 导入必需）；
4. 测试：`pnpm --filter dsh-tauri-turnrewind test`；
5. debug 桌面端启动时自动以 `link:` 安装全部内部插件（含本插件）；dev 数据目录 `~/.dsh.dev`，日志在 `%APPDATA%\io.github.hairyf.deepseek-harness-desktop\logs\dsh-web.dev.log`。

## 下一步待办（优先级序）

1. 真实 DSH lifecycle 集成测试（agent-loop claim → baseline → tool write 时序）；
2. redo 执行段接入 operation 记录与失败回滚（当前冻结，见 README「已知缺陷：redo」）；
3. 快照容量治理（turn 数/容量/保留期 GC）；
4. 消息旁 Undo 按钮、子树 undo；
5. 干净安装冒烟（非 link 安装下 client manifest 发现）。

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
