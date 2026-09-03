# dsh-tauri-turnrewind 生产环境审查报告

> 审查对象：`dsh-tauri-turnrewind` 主功能分支 `feature/turn-rewind` 的 **JS 版历史代码**（`plugins/dsh-tauri-turnrewind`，已删除）
>
> 审查基线：远端个人 fork 最新提交 `82e84bbe99802c5e3df9b9292ca9e8cbca18f500`
>
> 审查性质：生产安全与稳定性审查及修复后复审；报告区分已修复、部分缓解和仍未解决的问题。
>
> **范围说明（2026-09-03 更新）**：本报告是针对 **JS 版**的历史审查存档。当前活跃实现是 `packages/dsh-tauri-turnrewind-ts`（**TypeScript 重写**），快照模型为 **Git 目录模式**（工作区必须是 Git worktree，非 Git 目录禁用；ignore 语义委托源仓库；无预算预扫描与自定义敏感文件名单）——本报告中涉及 `guard.js` 预算扫描与排除规则的部分**不适用于当前实现**。其余安全边界（路径检查、冲突二次校验、原子 bak-swap 恢复、barrier/FIFO、needs-recovery、pending plan 原子 claim）在 TS 版同样保留并有测试钉住。TS 版的专项状态见 `TURN_REWIND_GIT_DIR_PROGRESS.md`，审查对照记录见 `TURN_REWIND_REVIEW_2026-09-03.md`。

## 1. 执行摘要

当前版本适合作为**实验性内部测试插件**，不建议直接作为生产级 Undo 功能发布。

本轮修复后的状态：已关闭部分高风险问题并通过 62 项自动化测试，但仍存在生产阻断项，详见“本轮修复后的最终状态”。

已存在的主要风险集中在：

- baseline barrier 已加入，并已有单元测试；真实 DSH 事件时序仍需集成验证；
- 同一 workspace 的其他 session 现在会被明确标记为 `skipped`，不再共享 snapshot 链；
- 未完成的 Undo/Redo operation 会在重启时标记为 `needs-recovery` 并阻断该 workspace，但尚未实现自动 journal 重放；
- 文件恢复与账本更新仍不是一个完整可崩溃恢复的事务；
- 文件替换与路径安全检查仍存在原子性和 TOCTOU 问题，悬空 symlink 检查已加固；
- 确认路由已增加 POST、body 限制和 pending→applying 原子 claim，但 loopback 应用层认证仍较弱；
- 客户端过期计划、取消失败、会话归属和主要 teardown 清理已修复，浏览器端集成测试仍缺失；
- 目前测试主要是 Host/core 单测，缺少浏览器、HTTP、并发、崩溃和干净安装集成测试。

### 发布结论

当前建议保持：

```text
0.1.0-dev / internal test
```

并限制在：

```text
可丢弃的测试 workspace
```

在解决 P0/P1 风险、补齐集成测试前，不建议发布稳定 npm 版本或推荐普通用户在真实项目启用。

## 2. 审查范围

重点审查文件：

- `plugins/dsh-tauri-turnrewind/lib/index.js`
- `plugins/dsh-tauri-turnrewind/lib/client.js`
- `plugins/dsh-tauri-turnrewind/lib/core/git-snapshot.js`
- `plugins/dsh-tauri-turnrewind/lib/core/ledger.js`
- `plugins/dsh-tauri-turnrewind/lib/core/guard.js`
- `plugins/dsh-tauri-turnrewind/lib/core/maintenance.js`
- `plugins/dsh-tauri-turnrewind/lib/purge-workspace.js`
- `plugins/dsh-tauri-turnrewind/package.json`
- `plugins/dsh-tauri-turnrewind/cordis.patch.yml`
- `plugins/dsh-tauri-turnrewind/test/*.test.js`
- `docs/TURN_REWIND.md`

审查方式：

- 阅读当前实现和相关测试；
- 对照 DSH agent loop、Client Slot 和 Web Server 约定；
- 检查 Git 快照、SQLite ledger、HTTP route 和 Client 生命周期；
- 执行插件测试、语法检查、包内容预检；
- 对嵌套敏感文件的 Git pathspec 做额外验证。

## 3. 风险等级定义

| 等级 | 含义 |
|---|---|
| P0 / Critical | 可能直接造成不可逆数据丢失、错误恢复或严重安全边界失效，应阻止发布 |
| P1 / High | 生产中较容易触发的完整性、安全或稳定性问题，应在生产候选版前修复 |
| P2 / Medium | 边界条件、可用性或防御性不足，应在稳定版前修复 |
| P3 / Low | 长期维护、隐私强化或性能改进项 |

## 4. P0 / Critical 风险

> 本章保留原始风险及修复后的状态；当前是否仍阻断发布，以文末“本轮修复后的最终状态”为准。

### P0-1：异步 baseline capture 可能晚于模型写文件（已部分修复，待集成验证）

**位置：**

- `plugins/dsh-tauri-turnrewind/lib/index.js:757-884`
- 重点：`active.set()` 与后续 `enqueueTurnTask(... captureSnapshot ...)`

**问题：**

历史版本曾在 `agent/inbox/claimed` 中仅登记 active turn，真正的 `captureSnapshot()` 在后续异步队列执行，因而存在晚于模型工具写入的风险。`82e84bb` 后，`agent/pre-step` 会等待 baseline deferred 完成；本问题当前已部分缓解，但仍需要真实 DSH 事件时序集成测试确认。

潜在时序：

```text
claim 事件
  ↓
active.set()
  ↓
claim handler 返回
  ↓
模型调用 write/bash/PowerShell
  ↓
baseline capture 才开始
```

如果工具写入先发生，写入可能已经进入 before snapshot，之后 before/after diff 看不到它，Undo 会漏掉文件。

**影响：**

- 用户看到 Agent 创建了文件，但 `/undo` 后文件仍然存在；
- Undo 的核心承诺不成立；
- 间歇性时序问题难以复现和诊断。

**建议：**

- 在允许 Agent step/tool 执行前建立明确的 baseline barrier；
- 若 `agent/inbox/claimed` 不支持等待，需要上游提供 pre-step/turn-start barrier；
- 或先执行可靠的轻量 baseline，再异步做后续工作；
- 增加事件级测试：claim 返回后立即写文件，验证写入不进入 before snapshot。

### P0-2：Undo/Redo 崩溃后磁盘和 ledger 可能分离（部分缓解：重启阻断，未自动恢复）

**位置：**

- `plugins/dsh-tauri-turnrewind/lib/index.js:311-327`
- `plugins/dsh-tauri-turnrewind/lib/index.js:379-429`
- `plugins/dsh-tauri-turnrewind/lib/core/ledger.js:109`
- `plugins/dsh-tauri-turnrewind/lib/core/ledger.js:338-347`
- `plugins/dsh-tauri-turnrewind/lib/core/ledger.js:405-455`

**问题：**

Undo/Redo 先逐文件修改磁盘，之后才提交 ledger 状态和 notice。进程可能在两者之间退出：

```text
磁盘：部分或全部已恢复
ledger：operation 仍为 applying，或 turn 状态未更新
```

历史版本启动恢复只将 `turns.status = 'active'` 标为 abandoned，没有处理 `operations.outcome = 'applying'`。当前已将 applying operation 标记为 `needs-recovery` 并阻断对应 workspace，但尚未实现自动 journal 重放。

**影响：**

- 重启后插件对实际磁盘状态判断错误；
- 后续 Undo/Redo 可能重复覆盖文件；
- notice 丢失或重复；
- 部分恢复无法自动诊断。

**建议：**

实现可恢复 operation journal：

```text
applying → restoring(path-1) → restoring(path-2) → applied
```

启动时扫描 applying operation，选择：

- 使用 before snapshot 完整回滚；或
- 标记为 `needs-recovery`，阻止后续操作并要求人工处理。

增加 kill/crash 注入测试。

## 5. P1 / High 风险

### P1-1：不同 session 共享 workspace 时缺少 workspace 级锁（已改为显式拒绝）

**位置：**

- `lib/index.js:693-733`
- `lib/index.js:853-857`
- `lib/index.js:235-268`

**问题：**

任务队列按 `sessionId`，但 `workspaceStores`、`parentRef` 和私有 snapshot repo 按 workspace 共享。两个 session 使用同一 cwd 时，baseline、after snapshot 和 parentRef 可能交叉。

**影响：**

- A turn 可能吸收 B turn 的文件；
- A 的 Undo 可能删除 B 创建的文件；
- 快照链和真实写入顺序不一致。

**建议：**

- MVP 直接拒绝同一 workspace 的多 session turnrewind；或
- 为 capture、settle、undo、redo、purge 统一增加 workspace-level FIFO/mutex；
- 增加双 session 同 workspace 并发集成测试。

> `docs/TURN_REWIND.md` 当前说明不同 session 可以并行，这与当前实现的 workspace 共享状态不一致，应同步修正文档或先实现锁。

### P1-2：恢复已有文件不是原子替换

**位置：** `lib/core/git-snapshot.js:462-491`

**问题：**

当前流程为：

```text
写 temp
删除 target
rename temp → target
```

进程在删除和 rename 之间退出时，原文件会永久缺失。

**建议：**

- 使用同目录临时文件、flush/fsync 和经过验证的原子替换 API；
- Windows、Linux、macOS 分别验证 replace 语义；
- 恢复前后拒绝 symlink/reparse point；
- 启动时清理或处理孤儿临时文件；
- 为 rename 失败、kill 和断电场景增加测试。

### P1-3：路径检查存在 TOCTOU 和 junction/reparse point 竞态

**位置：**

- `lib/core/git-snapshot.js:143-158`
- `lib/core/git-snapshot.js:384-392`
- `lib/core/git-snapshot.js:452-485`
- `lib/core/guard.js:66-107`

**问题：**

`assertSafePath()` 先检查路径，后续才执行 mkdir/lstat/remove/rename。检查和使用之间，其他程序可以替换父目录、目标文件或 Windows junction。

**影响：**

理论上可能写入或删除 workspace 外路径；`--force` 下影响更严重。

**建议：**

- Windows 显式拒绝 reparse point/junction；
- 使用 no-follow 文件系统 API 或目录句柄/fd 相对操作；
- 实际打开、替换、删除时再次验证；
- workspace lock 只能降低竞态，不能替代 no-follow 语义。

### P1-4：确认和取消计划存在 TOCTOU/并发竞态（主要重复执行问题已缓解，HTTP/完整状态机仍需验证）

**位置：**

- `lib/index.js:615-670`
- `lib/core/ledger.js:198-203`

**问题：**

confirm route 先读取 pending row，随后异步恢复文件；两个 confirm 请求可以同时读到 pending。confirm 与 cancel 也可能交叉。`planRuntime.undoing` 是内存标记，不能替代 ledger 原子状态迁移。

**影响：**

- 重复 restore；
- 重复 operation 或 notice；
- cancel 已返回成功但 confirm 仍执行；
- 多进程/重入时状态不确定。

**建议：**

增加 `applying` 状态并原子 claim：

```sql
UPDATE pending_plans
SET status = 'applying'
WHERE plan_id = ? AND status = 'pending'
```

只有 affected rows 为 1 的请求可以继续。

### P1-5：本地 HTTP 路由授权边界不足（方法/body/claim 已加固，应用层认证仍不足）

**位置：**

- `lib/index.js:339-369`
- `lib/index.js:611-691`
- `lib/core/ledger.js:130-141`
- `lib/client.js:575-586`

**问题：**

mutation route 只检查 loopback，plan ID 只取 UUID 的前 8 位；status route 不绑定 session；路由没有强制 POST，也没有 body 上限。任意本地进程/恶意网页在获得或枚举 planId/sessionId 后，理论上可以触发恢复或取消。

**建议：**

优先使用 DSH package-private Host RPC。若暂时保留 HTTP：

- 使用完整高熵一次性 token；
- 服务端绑定 session、workspace 和 plan；
- confirm/cancel/status 做授权校验；
- 强制 POST；
- 校验 Origin 作为补充；
- 限制请求体大小并拒绝异常 Content-Type。

### P1-6：嵌套敏感文件没有被实际 Git pathspec 排除（已修复）

**位置：** `lib/core/git-snapshot.js:16-39`

**复现：**

当前 pathspec 对根目录文件有效，但以下文件会被 Git 捕获：

```text
config/credentials.json
nested/secrets.yaml
```

原因是 `credentials.*`、`secrets.*` 缺少 `**/` 前缀；而预算 probe 的 basename 判断却会把它们视为排除，导致预检和实际快照不一致。

**建议：**

使用：

```text
:(exclude,glob)**/credentials.*
:(exclude,glob)**/secrets.*
```

让 probe 与 Git pathspec 共用规则来源，并为嵌套路径添加测试。已经进入 Git 对象的历史内容需要通过 purge/rebuild 清理。

### P1-7：客户端插件 teardown 不完整（主要问题已修复，待浏览器集成验证）

**位置：**

- `lib/client.js:436-537`
- `lib/client.js:556-563`
- `lib/client.js:611-623`

**问题：**

- unsupported modal 使用 module-global `dialog`，直接挂到 `document.body`，stop/update 时没有删除 DOM 和 listener；
- commandview 的 `ctx.slots.inject()` disposer 没有从 effect 返回；
- HMR/reapply 可能留下旧组件、旧 listener 或重复注册。

**建议：**

- effect cleanup 时 remove modal DOM、listener，并重置 global 引用；
- 返回并保留 `ctx.slots.inject()` disposer；
- 增加 apply → dispose → reapply 测试，确认只有一个 commandview 且没有旧 timer/DOM。

## 6. P2 / Medium 风险

### P2-1：特殊文件名使用换行分隔解析（已修复）

**位置：** `git-snapshot.js:311-314`、`419-421`

`git diff --name-only` 和 `ls-tree` 结果使用换行拆分、并对路径 trim。含换行、首尾空格的合法文件名会被拆错或丢失。

**建议：** 使用 Git `-z`/NUL 分隔和 `split('\0')`，不对路径无条件 trim。

### P2-2：turn ref 清洗存在碰撞（已修复）

**位置：** `index.js:16-18`

`/[^^\w.-]/gu`（实际实现为 `/[^\w.-]/gu`）把多个不同 turn ID 映射到相同 ref，后一个 snapshot 可能覆盖前一个。

**建议：** ref 使用完整随机 UUID 或 `sha256(turnId)`，原始 turn ID 只存 ledger。

### P2-3：ledger 状态迁移缺少前置状态和 affected-row 校验

**位置：** `ledger.js:232-245`、`293-303`、`405-455`

迟到/重复事件可能重新修改已完成 turn，或者插入幽灵 notice。

**建议：** 明确状态机并在 SQL 中限制预期前置状态，同时要求 `changes === 1`。

建议状态迁移：

```text
active → settled
active → interrupted
active → failed
settled → undone
undone → settled
```

### P2-4：Unix workspace identity 大小写策略不一致（已修复）

**位置：**

- `index.js:38-40`
- `git-snapshot.js:165-175`
- `maintenance.js:20-22`

`workspaceKeyFor()` 总是小写，而 snapshot hash 在 Unix 保留大小写。大小写敏感文件系统上可能出现 ledger key 和 snapshot repo 不对应。

**建议：** 统一 canonical identity：Windows 使用 realpath + lowercase，Unix 使用 realpath + 保留大小写。

### P2-5：过期 plan 无限轮询（已修复）

**位置：** `client.js:237-270`、`ledger.js:205-213`

后端过期返回 404，客户端在 `res.ok === false` 时直接 return，不设置 `gone`，也不清理 interval。

**影响：**

- UI 继续显示可操作按钮；
- 每 1.5 秒请求一次已不存在的计划；
- 页面长期运行产生无意义请求。

**建议：** 404 时设置 `planStatus = 'gone'`、清理 interval、隐藏按钮并提示重新执行 `/undo`。

### P2-6：客户端确认使用当前选中 session，而非卡片所属 session（已修复）

**位置：** `client.js:575-586`

用户切换 session 后点击旧卡，客户端使用新的 `sessions.list.current` 发送 sessionId。当前通常会 403，但归属逻辑不应依赖全局当前选中项。

**建议：** 使用 command card owner 的 session ID，或让 Host 根据 plan ID 自己解析归属。

### P2-7：取消请求失败时 UI 仍标记为 cancelled（已修复）

**位置：** `client.js:283-305`

cancel 请求失败时仍执行 `setPlanStatus('cancelled')`，卡片折叠且无法重试，但服务端可能仍是 pending。

**建议：** 只有服务端明确返回成功后才设置 cancelled；失败时保持 actionable 并显示错误。

### P2-8：HTTP body 没有限制（已修复）

**位置：** `index.js:339-369`

`req.on('data')` 无限累积 chunks，恶意本地请求可造成内存消耗。

**建议：** 设置几 KB 的 body 上限，超限立即返回 413 并销毁请求。

### P2-9：scan/probe 对权限错误静默跳过（仍未修复）

**位置：** `git-snapshot.js:231-235`、`guard.js:70-77`

目录无法读取时直接 continue，可能生成不完整 baseline，而用户没有得到明确错误。

**建议：** 区分“不存在”和“无权限”；权限错误应拒绝 workspace 或将 turn 标为 capture failed。

### P2-10：`runGitStdin()` 缺少统一输出上限和子进程清理

**位置：** `git-snapshot.js:325-347`

当前辅助函数没有像 `runGit()` 一样限制输出和统一处理 error/close/kill。

**建议：** 复用统一的受限 Git 子进程包装器。

### P2-11：维护清理不是可恢复事务（仍未修复）

**位置：** `lib/core/maintenance.js:20-49`

ledger 删除先提交，snapshot repo 后删除；中途退出会留下半清理状态。也没有检查 runtime 是否正在使用 repo。

**建议：** 使用 purge journal、workspace lock 和可重试状态。

## 7. P3 / Low 风险

### P3-1：快照目录权限未显式收紧

**位置：** `ledger.js:67-70`、`git-snapshot.js:113-130`

依赖系统默认 ACL/权限。快照中仍可能有源代码和配置，在多用户机器上应显式保护。

**建议：**

- Unix：目录 0700、文件 0600；
- Windows：仅当前用户和 SYSTEM；
- 启动时检查既有目录权限。

### P3-2：快照长期增长，没有 retention/GC

**位置：** `git-snapshot.js:277-308`、`ledger.js:326-331`

每个 workspace 的 Git 对象和 refs 持续累积，单次 probe 限制不能阻止长期磁盘增长。

**建议：** 增加按时间、数量和磁盘配额的 retention/GC，并保留失败可诊断信息。

### P3-3：workspace 级扫描和 Git 子进程性能偏慢

当前完整测试在提高超时后通过，但 Windows 上大量 Git 子进程成本很高。

主要重复操作包括：

```text
每个路径重复 ls-tree
每个路径重复 show
每个路径重复 hash-object
每个路径串行 restore
```

建议缓存 tree/path 元数据，使用 NUL 批量查询，并限制并发恢复数量。

## 8. 测试验证结果

### 已通过

使用较长测试超时、单 worker 运行：

```text
Test Files: 8 passed
Tests:      43 passed
Duration:   95.55s
```

覆盖：

- 常规创建、修改、删除和恢复；
- 中断 turn；
- Undo/Redo 基本流程；
- 冲突、`--force`、`--skip-conflicts`；
- Unicode 基础文件名；
- CRLF/LF 比较；
- workspace 预算；
- snapshot repo 自愈；
- ledger 基础生命周期；
- projection 基础逻辑。

语法和空白检查：

```text
node --check：通过
 git diff --check：通过
```

npm 包预检：

```text
npm pack --dry-run：通过
```

当前 tarball 预期包含：

```text
README.md
cordis.patch.yml
lib/**
package.json
```

### 测试超时说明

默认配置下，lifecycle/git-snapshot 测试可能因为 Windows Git 子进程耗时超过单测试 30 秒而超时；这不是当前已观察到的断言失败。提高到 120 秒后完整 43 项通过，但约 95 秒的总耗时本身暴露了生产性能问题。

## 9. 缺失的生产级测试

1. baseline barrier：claim 返回后立即写文件；
2. 两个 session 同 workspace 并发 capture/settle/undo；
3. Undo/Redo 恢复中途 kill/crash；
4. 原子替换失败和孤儿临时文件；
5. Windows junction/reparse point；
6. 父目录/目标文件并发替换；
7. 含换行、首尾空格的文件名；
8. turn ref collision；
9. 重复/乱序 turn/end、idle 事件；
10. applying operation 启动恢复；
11. confirm + cancel 并发 HTTP 请求；
12. GET/PUT/错误 Origin 路由拒绝；
13. plan 过期 UI 和 polling 停止；
14. Client stop/update/HMR DOM、Slot、timer 清理；
15. session 切换后点击旧 Undo 卡；
16. clean tarball 安装后的 Host + Client smoke test；
17. 嵌套敏感文件和更多凭据文件排除；
18. Unix 大小写路径和跨平台 workspace identity。

## 10. 推荐修复顺序

### 发布阻断项

```text
1. baseline capture barrier
2. workspace-level lock 或明确拒绝共享 workspace
3. 崩溃可恢复 operation journal
4. 原子文件替换和 no-follow/reparse-point 防护
5. confirm/cancel 原子 claim
6. 敏感文件排除规则统一
```

### 稳定版前

```text
7. 修复 HTTP token、方法和 body 限制
8. 修复过期 plan polling
9. 修复 Client teardown/disposer/modal 清理
10. 修复特殊文件名解析
11. 修复 ref collision
12. 收紧 ledger 状态迁移
13. 统一 workspace identity
```

### 长期质量

```text
14. Git 查询和恢复性能优化
15. snapshot retention/GC
16. 快照目录权限强化
17. 浏览器和 clean-install 集成测试
18. 真实 Windows/macOS/Linux 回归
```

## 11. 当前使用警告

在上述问题修复前，README 和发布说明应持续保留以下警告：

```text
This is an experimental prototype.
Use only with disposable workspaces.
Do not rely on it as the only backup.
Do not run it on a shared workspace used concurrently by multiple sessions.
A process crash during restore may require manual recovery.
```

本报告只记录审查结果，不会自动修改实现，也不替代正式安全评估或备份策略。

## 本轮修复后的最终状态

### 已修复并验证

- baseline barrier 已接入 `agent/pre-step`，新增 barrier 回归测试通过；
- 同一 workspace 的其他 session 不再进入同一 snapshot 链，而是记录为 `skipped`；
- nested `credentials/secrets` 结构化配置文件按任意深度排除，同时保留 `credentials.module.ts` 等合法源码；
- workspace identity 在 index、snapshot hash 和 purge 之间统一，Unix 大小写路径不再被错误折叠；
- turn snapshot ref 改用 turn ID 的 SHA-256 前缀，避免清洗碰撞；
- Git 路径列表改用 NUL 分隔，避免换行文件名被错误拆分；
- pending plan 使用 SQLite 条件 claim，confirm/cancel 竞争时最多一个请求获得执行权；
- mutation route 强制 POST，并限制请求体大小为 16 KiB；
- Client 的 404/gone plan 会停止 polling，取消失败不会错误折叠，命令卡使用 session-scoped owner；
- Client commandview、dialog、polling 和 submit channel 增加生命周期清理；
- 重启时 applying operation 会标记为 `needs-recovery`，对应 workspace 会阻止新的 Undo/Redo；
- 悬空符号链接和 turnrewind 临时文件增加了防护与测试。

### 当前验证

```text
Vitest: 10 test files, 62 passed, 0 failed
ESLint: 0 errors, 1 warning
node --check: passed
 git diff --check: passed
```

剩余的 1 个 ESLint warning 位于 `lib/client.js:268`，是展开状态在 React effect 中同步 setState 的性能提示，不是 lint error。

### 仍未解决的生产阻断项

- `restorePath()` 仍采用删除目标后再 rename，进程在两步之间退出可能造成文件缺失；
- 路径检查与实际文件操作仍存在 TOCTOU，Windows junction/reparse point 还没有句柄级 no-follow 保护；
- applying operation 当前是“重启后阻断并要求人工检查/清理”，不是自动 journal 重放；现有恢复方式是停止 Host 后使用 `purge-workspace.js` 清理该 workspace 的 turnrewind 数据，再重新建立基线；
- operation 终态仍与文件系统 I/O 分离，完整崩溃一致性仍未实现；
- loopback HTTP 仍没有强应用层认证，plan status 仍可按 planId 查询；
- purge 与运行中的 snapshot/restore 没有可恢复事务和 workspace lock；
- 尚无真实 DSH agent-loop、HTTP server、浏览器 Client、kill/crash、junction 和干净 tarball 安装集成测试；
- Git 子进程数量较多，Windows 大 workspace 的 Undo 性能仍需要优化和预算。

因此当前仍应保持：

```text
0.1.0-dev / internal test
```

不得把它当作正式项目的唯一备份或生产级文件恢复保障。

本轮修复没有创建 commit，也没有推送远端。桌面副本已在本次复审后同步。

## 12. `82e84bb` baseline barrier 更新复审

> 本节记录 barrier 提交本身；本报告上方的“本轮修复后的最终状态”记录当前未提交修复结果。

远端提交：

```text
82e84bb fix(turnrewind): add baseline execution barrier
```

本次提交将 baseline 等待接入 `agent/pre-step`：`agent/inbox/claimed` 同步创建 deferred reservation，`agent/pre-step` 在调用下游 `next()` 前等待该 deferred。按 DSH agent loop 的顺序，`next()` 之后才会进入模型请求和工具执行，因此该修改**方向正确，并部分缓解了 P0-1 的 baseline 晚于写入问题**。

相关实现：

- `plugins/dsh-tauri-turnrewind/lib/index.js:50-91`
- `plugins/dsh-tauri-turnrewind/lib/index.js:796-1004`
- `plugins/dsh-tauri-turnrewind/test/barrier.test.js`

本次同时增加：

- baseline 失败时将 turn 显式记为 skipped；
- pre-step abort 不取消后续 bookkeeping；
- 迟到 claim 和重复 claim 的基本防护；
- 插件停止时释放 baseline waiter，并等待 session queue 后关闭 SQLite；
- `DSH_HOME` 改为 apply 时读取，便于隔离测试。

### 12.1 当前验证结果

更新后完整测试结果：

```text
Test Files: 8 passed, 1 failed
Tests:      48 passed, 1 failed
```

失败项：

```text
test/barrier.test.js
"does not recreate a completed turn after a duplicate claim"
```

失败位置：

```text
plugins/dsh-tauri-turnrewind/test/barrier.test.js:136
assert.ok(after)
```

该测试在触发 `turn/end` 后仅固定等待 300ms，就断言 after snapshot ref 已存在。在当前 Windows Git 子进程耗时下，after snapshot 尚未完成，单独重跑也稳定复现。因此当前不能将 `82e84bb` 标记为完整测试通过。

建议测试不要依赖固定 sleep，应等待明确的可观察完成条件，例如：

- 账本中目标 turn 状态已变为 `settled` 或 `interrupted`；
- after ref 已通过带超时的 polling 出现；
- 测试 harness 暴露并等待对应 session queue drained 信号。

### 12.2 仍未完全关闭的 baseline 风险

新增测试验证了 `agent/pre-step` 会等待 baseline，但尚未模拟最关键的真实回归场景：

```text
inbox claim handler 返回
→ 立即尝试写文件
→ 验证写入不可能发生在 before snapshot 之前
```

应补充 agent-loop 级或真实 DSH 集成测试，确保模型工具执行确实受该 waterfall barrier 限制。若 DSH 调整事件顺序或某种工具路径绕过 `agent/pre-step`，当前单元测试不会发现。

### 12.3 复审结论

`82e84bb` 可以视为 P0-1 的有效修复候选，但在以下条件满足前应保持“部分缓解”状态：

```text
1. 修复新增 barrier 测试的确定性等待；
2. 完整测试重新达到全绿；
3. 新增真实 claim → 写入时序集成测试；
4. 继续处理本报告其余 P0/P1 项，尤其是 workspace 并发、崩溃恢复、原子恢复和路由竞态。
```
