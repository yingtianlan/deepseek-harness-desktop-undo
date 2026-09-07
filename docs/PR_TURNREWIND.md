## feat(turnrewind): turn 级工作区撤销插件（Git 目录快照模式）

### 概述

新增内置插件 `dsh-tauri-turnrewind`：为一次 Agent 对话回合建立可恢复的文件基线，用户通过 `/undo` 或消息卡按钮撤销该回合的工作区修改。采用 OpenCode 式 **Git 目录快照**——每个 Git worktree 一个私有 snapshot repo（`$DSH_HOME/snapshots/<hash>.git`），通过 alternates 借用源仓库对象，ignore 语义委托源仓库，**绝不触碰用户项目的 HEAD/branch/index/stash**。

### 核心能力

- **两阶段 /undo**：预览卡（红绿 diff + `+x -y` 徽标）→ 卡内 ✓/✗ 确认 → 原子恢复（bak-swap）
- **预览绑定漂移校验**：确认时的快照 ref 与重算 diff 必须与预览一致
- **安全恢复**：单事务提交（turn/operation/notice）、逐路径失败计入未恢复清单、`needs-recovery` 围栏 + 应用内恢复面板、`/undo --doctor` 诊断
- **并发安全**：跨进程 workspace lock（O_EXCL + pid 探测 + TTL 接管）、SQLite busy_timeout + BEGIN IMMEDIATE、计划构建有界并发
- **容量治理**：`TURNREWIND_RETAIN_TURNS`（默认 50）+ `TURNREWIND_MAX_SNAPSHOT_MB`（默认 1024，超限整仓重建自愈基线）
- **留档可查**：过期/取消/被替换的 plan 永久保留（卡片保留 diff 视图，仅锁执行）；unsupported 提示单会话只弹一次
- **特殊文件防护**：symlink/junction/gitlink/submodule 标记 unsupported，恢复拒绝；非空目录拒绝递归删除
- **模式恢复**：可执行位跨 undo 幸存（git mode 持久化 + chmod）；CRLF 归一化遵循 `.gitattributes`
- **诊断**：`/undo --doctor` 只读输出 git/工作区/账本/快照/备份健康；ledger 打开时 quick_check + 每日滚动备份

### 安全边界

- 路径：`assertSafePath` 拒绝 workspace 外路径与根路径，全组件链 lstat 防 symlink/junction，关键写入点前重验（TOCTOU 缓解）
- 注入：git 参数数组传递、commit/ref 统一校验、planId/sessionId 格式校验
- HTTP：POST/GET 方法限制、loopback-only mutate、body 大小上限、JSON Content-Type、nosniff/no-store、一次性响应 guard
- 恢复直接使用 Node fs API（未接 sandbox bridge）——TOCTOU 窗口已压缩但未归零，生产前需接入受控文件系统

### 测试

25 个测试文件 / 130 个测试全绿：git-state 零污染、原子 bak-swap 恢复与崩溃清扫、git-worktree 隔离、ignore 委托、oversize 单文件报告、symlink/junction 拒绝、mode 恢复、账本生命周期、needs-recovery 围栏、plan 绑定漂移、跨进程锁、barrier 时序、retention、路由加固、client 纯函数

### 已知限制

- 非 Git workspace 不支持（记 `TURNREWIND_GIT_REQUIRED`）
- 恢复依赖 Node fs API，TOCTOU 窗口未归零（待接 sandbox bridge）
- redo 已实现底层加固但入口冻结（重开只需移除一行闸门）
- 子树 undo 未实现（需 DSH turn tree 契约）
