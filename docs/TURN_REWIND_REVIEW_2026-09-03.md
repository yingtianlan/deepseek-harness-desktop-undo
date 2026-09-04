# dsh-tauri-turnrewind 审查报告

> 审查日期：2026-09-03  
> 审查对象：`packages/dsh-tauri-turnrewind-ts`（当前 TypeScript rewrite），审查时以 `plugins/dsh-tauri-turnrewind`（legacy JavaScript 实现，**现已删除**）作为对照  
> 相关设计：`docs/TURN_REWIND.md`  
> 相关用户文档：`packages/dsh-tauri-turnrewind-ts/README.md`

## 1. 执行摘要

当前 TypeScript 版本已经实现了一个可运行的单回合 turn rewind MVP：Git worktree 资格检查、私有 snapshot repo、baseline barrier、预览/确认/取消、冲突检测、单回合 Undo、基础 Redo、notice 注入、快照自愈以及大文件提示均已有代码和测试。

但它仍不应作为生产级文件恢复功能启用。主要原因是恢复操作仍有数据安全和账本一致性风险：

1. `--force` 在特定路径类型变化下可能递归删除整个目录；
2. `interrupted` turn Undo 后可能没有正确变为 `undone`；
3. 文件恢复、operation、turn 状态和 notice 不是一个完整的数据库事务；
4. Redo 尚未具备与 Undo 对等的失败回滚和 `needs-recovery` 机制；
5. 恢复仍直接使用 Node/Git，尚未接入受控 sandbox/Tauri bridge；
6. 只有进程内互斥，没有跨进程持久化 workspace lock。

因此当前适合继续在可丢弃的测试工作区验证，不建议在真实用户工作区中启用。

## 1.1 修复状态更新（2026-09-04）

本报告发布后，P0 修复已在 `dsh/turnrewind-ts-test` 分支完成并合入主分支，随后进行了复核与补充修复。当前状态：

| 项 | 状态 | 处理方式 |
| --- | --- | --- |
| P0-1 目录递归删除 | ✅ 已修复 | `assertSafePath` 拒绝 workspace 根；restore 只删空目录，非空目录与非普通文件一律拒绝（含 `--force`） |
| P0-2 interrupted turn 账本错误 | ✅ 已修复 | `completeUndoTransaction` 接受 settled/interrupted，`changes !== 1` 即回滚 |
| P0-3 恢复与账本非原子 | ✅ 已修复 | turn/operation/notice 单事务提交，失败落 `needs-recovery` |
| P0-4 redo 无失败恢复 | ✅ 以禁用方式关闭 | **产品决策：redo 功能冻结**。底层加固（applying operation / 失败明细 / needs-recovery 事务）已实现并保留测试，入口在 `applyUndo` 顶部直接拒绝；重新开放只需替换闸门行 |
| P0-5 单路径失败无持久记录 | ✅ 已修复 | `notRestored` 明细写入 `operation.error` 与 notice paths |
| P1-1 ~ P1-5 | ⬜ 未处理 | workspace 持久锁、plan 版本绑定、symlink、mode、TOCTOU（root 拒绝已随 P0-1 落地） |
| P2-5 同步 rev-parse | ✅ 已修复 | 60s TTL 进程级缓存 |
| P2-6 status route 方法限制 | ✅ 已修复 | `jsonRoute` 支持 `methods`，status 限 GET |
| P2-7 客户端样式规范 | ✅ 已修复 | 样式迁移至 css-render 对象树，effect 管理挂载/卸载 |
| P2-1/P2-2/P2-4 | ⬜ 未处理 | 子树 undo、文档冲突、容量治理（README 的 redo 章节已同步本次变更） |

验证：17 个测试文件 / 85 个测试全部通过；typecheck、eslint（0 errors）、build（publint 通过）均绿。附带清理：删除根目录误提交的 `test/ledger.test.js`、去除 `client/index.ts` 中重复的样式挂载 effect。

## 2. 审查范围

### 2.1 源码

- `packages/dsh-tauri-turnrewind-ts/src/host/apply.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/ledger.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/undo.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/git-snapshot.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/git-workspace.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/planner.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/guard.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/maintenance.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/routes/index.ts`
- `packages/dsh-tauri-turnrewind-ts/src/client/**`
- `packages/dsh-tauri-turnrewind-ts/package.json`
- `packages/dsh-tauri-turnrewind-ts/cordis.patch.yml`

### 2.2 文档

- `docs/TURN_REWIND.md`
- `packages/dsh-tauri-turnrewind-ts/README.md`
- `plugins/dsh-tauri-turnrewind/README.md`
- `docs/PROJECT_STATUS.md`
- `docs/AGENTS.plugins.md`

### 2.3 对照实现

- `plugins/dsh-tauri-turnrewind/lib/index.js`
- `plugins/dsh-tauri-turnrewind/lib/core/ledger.js`
- `plugins/dsh-tauri-turnrewind/lib/core/git-snapshot.js`
- `plugins/dsh-tauri-turnrewind/lib/client.js`

## 3. 完成度矩阵

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Git worktree 资格检查 | 已实现 | 非 Git workspace、系统目录会被拒绝；子目录归并到 worktree 根 |
| 私有 Git snapshot repo | 已实现 | 位于 `$DSH_HOME/snapshots/<hash>.git` |
| 不修改用户 Git 状态 | 已实现 | 已有测试覆盖 HEAD、branch、index、stash、refs 和 status |
| Git ignore / alternates | 已实现 | 有 ignore、`.git/info/exclude`、global excludes 和 GC 自愈测试 |
| baseline barrier | 已实现 | `agent/pre-step` 等待 before snapshot 完成 |
| 单回合 Undo | 基本实现 | 修改/创建/删除文件的基础路径可恢复 |
| 预览 / 确认 / 取消 | 基本实现 | pending plan 存 SQLite，默认 5 分钟过期 |
| 冲突检测 | 已实现 | 当前磁盘状态与 turn after snapshot 比较 |
| `--skip-conflicts` | 已实现 | 跳过冲突文件并报告 |
| `--force` | 已实现但有风险 | 非普通文件路径类型变化可能触发破坏性递归删除 |
| 基础 Redo | 已实现但不安全 | 失败时没有完整回滚和恢复围栏 |
| interrupted turn Undo | 部分实现 | 入口接受 interrupted，但账本完成条件只接受 settled |
| rewind notice | 已实现 | 下一次模型 step 消费一次，可多条 notice 排序注入 |
| 不可用 workspace 弹窗 | 已实现但集成不足 | 有投影和纯函数测试，缺真实 Web UI 测试 |
| 快照损坏/alternates 自愈 | 已实现 | 能重建 self-contained snapshot store |
| 父子 turn 关系 | 未接入 | planner 有纯函数，但实际 insert 没有 parentTurnId |
| `--subtree` | 未实现 | 当前明确返回 MVP 不支持 |
| 消息旁 Undo 按钮 | 未实现 | 当前只有 command view 卡片 |
| 设置页模式切换 | 未实现 | 三种会话回退模式尚未接入 |
| 非 Git workspace | 当前不支持 | Git directory 实验模式明确要求 Git worktree；与主设计文档旧描述冲突 |
| 受控 sandbox/Tauri bridge | 未实现 | 当前直接使用 Node filesystem/Git |
| workspace 持久化锁 | 未实现 | 只有 Host 进程内 Map/Promise 互斥 |
| snapshot 容量治理 | 未实现 | 没有按容量、turn 数、保留期进行 GC |
| mode / symlink / special file | 未完整实现 | symlink 可能被当作普通文件；权限位未恢复 |
| 真实 DSH lifecycle integration test | 未实现 | 当前主要为 fake context 和文件系统测试 |

## 4. Findings

### P0-1：`--force` 可能递归删除整个目录

**位置：** `packages/dsh-tauri-turnrewind-ts/src/host/service/git-snapshot.ts:638-647`

当 before snapshot 中路径不存在，而当前磁盘中的同名路径变成目录时，`restorePath()` 会执行：

```ts
rmSync(target, { recursive: info.isDirectory(), force: true })
```

这个行为已经在临时目录中用构建后的 dist 产物实证：turn 新建 `foo`，之后用户将 `foo` 替换为包含其他文件的目录，调用 `restorePath(before, 'foo')` 会返回 removed，并递归删除整个 `foo/` 子树。生产调用链中的路径目前来自 `git diff --name-only`，因此路径为 `.`/空路径、直接删除 workspace 根目录的情形当前不可由正常 diff 触达；但目录子树删除在显式 `--force` 下真实可发生。默认 Undo/confirm 会把目录类型变化标为 conflict 并拦截，`--skip-conflicts` 会跳过，只有 `--force` 绕过该保护。

另外，`assertSafePath()` 当前允许 `target === root`。虽然正常生产路径不会产生此类 path，但直接调用 `restorePath(..., '.')` 已实证会递归删除整个 workspace，因此这是需要补上的防御纵深。

**影响：** 破坏“只恢复 turn 触及路径”的边界，可能造成无关文件数据损失；被源仓库 ignore 的文件不在插件快照中，删除后无法从 turnrewind 快照找回。

**建议：**

- `assertSafePath()` 拒绝 `target === root`；
- 目标不是普通文件时默认拒绝；
- 即使 `--force` 也不要递归删除非空目录；
- 可将冲突目录移入 quarantine，或只允许删除空目录；
- 预览和 `--force` 确认文案明确提示“目标已变为目录，操作不会递归删除无关文件”；
- 增加“文件被替换成非空目录后执行 `--force`”以及根路径防御测试。

### P0-2：`interrupted` turn Undo 后账本状态可能错误

**位置：**

- `packages/dsh-tauri-turnrewind-ts/src/host/service/undo.ts:572`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/undo.ts:402-410`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/ledger.ts:513-530`

Undo 入口允许目标状态为 `settled` 或 `interrupted`，但 `completeUndoWithNotice()` 使用：

```sql
UPDATE turns SET status = 'undone'
WHERE turn_id = ? AND status = 'settled'
```

因此 interrupted turn 的文件可能已被恢复，但 turn 仍为 `interrupted`，继续出现在可撤销列表中。该情况已用真实 `executeUndoRestore` 复核：调用返回成功，但 turn 仍是 `interrupted + reversible=1`，后续可再次被 `/undo` 选中。随后 Redo 的：

```sql
UPDATE turns SET status = 'settled'
WHERE turn_id = ? AND status = 'undone'
```

也会更新 0 行，但仍可能写入 Redo operation 和 notice。

**影响：** 文件状态、turn 状态和 operation 状态不一致，可能重复 Undo 或产生错误 Redo 记录。

**建议：**

- Undo 状态更新支持 `settled` 和 `interrupted`；
- 检查 SQL `changes === 1`，否则事务失败；
- Redo 同样校验 operation 和 turn 的状态变更行数；
- 补充 interrupted → undo → redo 的集成测试。

### P0-3：文件恢复与账本提交不是一个完整的可恢复事务

**位置：**

- `packages/dsh-tauri-turnrewind-ts/src/host/service/undo.ts:372-381`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/undo.ts:402-410`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/ledger.ts:513-535`

当前 Undo 大致按以下顺序执行：

1. 捕获 operation before snapshot；
2. 创建 operation；
3. 恢复文件；
4. `completeUndoWithNotice()` 提交 turn 和 notice；
5. 单独调用 `settleOperation()`。

第 4、5 步不在同一个 SQLite 事务中。该崩溃窗口已用临时目录和构建产物复核：如果 `completeUndoWithNotice()` 已提交而进程在 `settleOperation()` 前退出，重启账本会把 operation 从 `applying` 改成 `needs-recovery`，但 turn 已经是 `undone`、notice 已经 pending。此时 workspace 会被恢复围栏拦截，错误提示“上一次 Undo/Redo 被中断”，而 Redo 也因只查 `outcome = 'applied'` 的 operation 而不可用。

**影响：** 磁盘、turn、operation、notice 互相矛盾；重启后的诊断和 Redo 选择可能错误。

**建议：**

新增一个完整的 ledger transaction API，在同一事务中完成：

- 校验目标 turn 当前状态；
- operation → `applied`；
- turn → `undone`；
- 插入 notice；
- 保存恢复结果和未恢复路径。

SQLite 与文件系统无法构成真正跨系统事务，但当账本提交失败时，至少应将 operation 标记为 `needs-recovery` 并阻止继续操作。

### P0-4：Redo 没有与 Undo 对等的失败恢复机制

**位置：** `packages/dsh-tauri-turnrewind-ts/src/host/service/undo.ts:58-112`

README 已明确记录 Redo 的已知缺陷：Redo 不创建 applying operation、不保存可用于失败回滚的 operation 记录，也没有 `needs-recovery` 围栏。

如果 Redo 恢复多个文件时中途失败，可能出现部分文件已重做、turn 仍为 undone、旧 operation 仍可重做的状态。重启后也不会自动阻止该 workspace。

**建议：**

在修复前：

- 默认禁用 `/undo --redo`，或限制为已证明安全的普通文件集合；
- 不要把 Redo 作为 README 中的正常可用能力宣传。

正式实现时复用 Undo 框架：创建 applying operation、保存 before snapshot、失败回滚、失败时写入 needs-recovery、最后以一个事务提交状态和 notice。

### P0-5：单路径恢复失败没有持久化为 partial outcome

**位置：** `packages/dsh-tauri-turnrewind-ts/src/host/service/undo.ts:383-417`

`executeUndoRestore()` 会有意吞掉单个路径的恢复异常，把失败放入内存中的 `failedPaths`，继续恢复其他文件，最后仍然无条件执行 `completeUndoWithNotice()` 和 `settleOperation(..., 'applied')`。当前测试也把这种行为作为预期：大文件失败时整体返回 success，turn 标记为 `undone`。

这本身可以是“尽力恢复”的产品选择，但失败事实没有完整进入账本：

- `operations.error` 保持为空；
- notice 只记录 `restoredPaths`，不包含失败路径；
- 直接命令执行的失败明细只有返回文本；
- 账本没有 `partial` / `partial_failure` outcome 或失败路径明细。

**影响：** 重启、审计或后续 Redo 无法可靠知道哪些文件实际没有恢复。用户看到的是部分结果，但持久状态可能看起来像完整 applied。

**建议：**

- 增加 `partial` 或 `partial_failure` operation outcome；
- 单独持久化 operation paths、每路径 resolution/result/error；
- notice 同时包含未恢复路径和原因；
- 明确部分 Undo 是否允许 Redo，以及 Redo 的目标路径集合；
- 在 operation 状态确定后再允许 turn 进入对应的 `undone`/`partial` 状态。

## 5. P1 风险

### P1-1：只有进程内互斥，没有 workspace 持久锁

**位置：** `packages/dsh-tauri-turnrewind-ts/src/host/apply.ts:191-204`、`packages/dsh-tauri-turnrewind-ts/src/host/service/undo.ts:460-474`

当前通过 `runtime.undoing`、`active Map` 和 per-session Promise chain 防止单进程内并发。它无法覆盖多个 Host 进程、多个 profile、Host 重启交界或外部维护脚本同时操作的情况。

**建议：** 使用 SQLite lease 或带 PID/时间戳的 lock 文件，覆盖 capture、settle、Undo、Redo、GC 和 snapshot rebuild，并设计崩溃接管规则。

### P1-2：pending plan 没有完整绑定预览时的 snapshot/digest

**位置：**

- `packages/dsh-tauri-turnrewind-ts/src/host/service/ledger.ts:288-314`
- `packages/dsh-tauri-turnrewind-ts/src/host/apply.ts:440-463`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/undo.ts:521-534`

文档中的 `planVersion` 应绑定 workspace、target turn、快照版本和当前摘要。当前 pending plan 主要保存 plan ID、session、workspace、turn 和 paths；确认时会重新计算路径和冲突，但 `row.paths` 没有作为严格版本校验使用。

**建议：** 保存并校验 before/after ref、paths digest、workspace digest 和 turn 状态，确认时拒绝任何计划版本漂移。

### P1-3：symlink 被静默当成普通文件

**位置：** `packages/dsh-tauri-turnrewind-ts/src/host/service/git-snapshot.ts:579-600`、`:638-655`

Git snapshot 中的 symlink 目前可能通过 `git show` 读出 link target 文本，随后 `stateAt()` 返回 `kind: file`，恢复时写成普通文件，而不是恢复 symlink。

**影响：** 恢复后的文件类型错误，且不是明确的 unsupported/failure。

**建议：** 首版应明确拒绝并标记 symlink 为 unsupported，或完整保存 `linkTarget` 并实现安全恢复。增加 symlink capture、diff、undo round-trip 测试。

### P1-4：文件 mode/权限位未恢复

**位置：** `packages/dsh-tauri-turnrewind-ts/src/host/types/index.ts:31-35`、`packages/dsh-tauri-turnrewind-ts/src/host/service/git-snapshot.ts:655-658`

`PathState` 没有 mode，恢复通过临时文件和 rename 写回，可能丢失 executable、read-only 等权限信息。只改权限不改内容的 turn 也不会进入 snapshot diff。

**建议：** 读取并持久化 Git mode，mode 变化参与 diff，恢复后调用 chmod；Windows 下明确处理只读属性和不支持的特殊文件。

### P1-5：路径校验存在 TOCTOU 窗口

**位置：** `packages/dsh-tauri-turnrewind-ts/src/host/service/git-snapshot.ts:301-324`、`:638-698`

`assertSafePath()` 校验完成后，到 `mkdirSync`、`renameSync`、删除备份之间仍可能被外部进程替换父目录为 symlink/junction。

**建议：** 优先接入受控 sandbox/Tauri bridge；否则每个关键操作前重新验证 realpath，并增加 Windows reparse point 检测，避免对验证后发生变化的路径继续写入。

## 6. P2 问题与工程改进

### P2-1：子树 Undo 的 planner 没有接入实际 turn 数据

`planner.ts` 已有 `collectDescendantTurns()` 和 `aggregatePathPlan()`，但实际插入 turn 时没有提供 `parentTurnId`。因此 parent/child 关系为空，`--subtree` 仍然只能返回不支持。

建议在确认 DSH 真实 turn tree 契约后，保存 parentTurnId，并实现同一 workspace 内后序遍历、路径聚合和重叠路径目标选择。

### P2-2：主设计文档、实验模式文档和状态文档存在冲突

当前 README 使用 Git directory experiment 语义：非 Git workspace 不支持；而 `docs/TURN_REWIND.md` 的非 Git 章节和验收矩阵仍要求普通目录可恢复。`docs/PROJECT_STATUS.md` 还保留预算预扫描、JS 版本和旧测试数量描述。

建议把以下内容拆开并标注唯一真相源：

- 主线架构目标；
- Git directory 实验模式；
- 当前 TypeScript rewrite 实际行为。

### P2-3：legacy JS 包和 TypeScript 包同名

以下两个 package 的 `name` 都是 `dsh-tauri-turnrewind`：

- `plugins/dsh-tauri-turnrewind/package.json`
- `packages/dsh-tauri-turnrewind-ts/package.json`

版本、入口和依赖不同，可能导致本地安装、发布 manifest 和 `pnpm` filter 选择错误实现。

建议确定一个 canonical package，删除或明确标记另一个 legacy 包，并同步 README、CI、manifest 和发布流程。

### P2-4：快照容量治理未实现

当前有 notice 清理和手工 workspace purge，但没有按总容量、turn 数、保留天数和 operation/redo 引用进行 snapshot/ref/object GC。大仓库长期运行会持续增加 `$DSH_HOME` 占用。

建议实现可配置配额、保留策略、引用检查、低磁盘提前失败和可观测清理结果。

### P2-5：Git worktree 解析仍使用同步子进程

`git-workspace.ts:35-48` 和 `:55-68` 使用 `spawnSync` 执行多次 `rev-parse`。在网络盘、OneDrive、杀毒软件锁定或 Git 异常时仍可能阻塞 Host。

建议缓存稳定的 workspace 元数据，并将探测迁移为带超时的异步执行；至少不要在每次 turn 领取时重复多次同步探测。

### P2-6：status route 没有严格限制 GET

`jsonRoute()` 只对 `mutate: true` 路由检查 POST，而 status route 注册时没有显式方法约束：

```ts
jsonRoute('/api/turnrewind/status', statusRoute)
```

建议给 route helper 增加显式 `method`/`methods` 选项，status 只接受 GET，confirm/cancel 只接受 POST。

### P2-7：客户端样式不符合插件规范

`packages/dsh-tauri-turnrewind-ts/src/client/components/command-view.ts` 和 `src/client/register/dialog.ts` 大量使用 React inline style 和 DOM `element.style`。`docs/AGENTS.plugins.md` 要求自定义样式统一使用 css-render，并由 `apply()` effect 管理挂载/卸载。

建议将 command card 和 dialog 的样式迁移到 css-render 对象树，集中管理 style ID、class name 和 disposer。

## 7. 测试与验证结果

本次验证执行于当前 checkout：

```powershell
pnpm --filter dsh-tauri-turnrewind typecheck
```

结果：通过。

```powershell
pnpm --filter dsh-tauri-turnrewind test -- --run
```

结果：通过：

- 17 个测试文件；
- 82 个测试；
- 全部通过。

覆盖范围包括 Git snapshot、增删改恢复、中文路径、CRLF、路径逃逸、symlink 路径拒绝、ignore 规则、alternates GC 自愈、账本生命周期、baseline barrier、pending plan、Undo/Redo 基础流程和 unsupported notice。

```powershell
pnpm exec eslint packages/dsh-tauri-turnrewind-ts
```

结果：0 errors、1 warning：

```text
packages/dsh-tauri-turnrewind-ts/src/client/components/command-view.ts:175
react/set-state-in-effect
```

```powershell
pnpm --filter dsh-tauri-turnrewind build
```

结果：通过，`publint` 通过。

此外，构建后的 Host import smoke test 通过：

```powershell
node --input-type=module -e "await import('./packages/dsh-tauri-turnrewind-ts/dist/index.js'); console.log('host import ok')"
```

### 测试不足

当前测试仍不足以证明生产安全性，特别缺少：

- 非空目录替换文件后的 `--force` 测试；
- interrupted turn Undo/Redo 的账本状态测试；
- Undo/Redo 中途失败后的文件和 ledger 一致性测试；
- 跨进程 workspace lock 测试；
- symlink 快照恢复类型测试；
- mode/权限位变化测试；
- Windows junction/reparse point 测试；
- 真实 DSH Host lifecycle 集成测试；
- 真实 Web ModuleLoader 和 commandview slot 集成测试；
- clean install / 发布包发现测试。

## 8. 建议修复顺序

### 第一阶段：先处理数据安全

1. 修复 `restorePath()` 对目录的递归删除；
2. 修复 interrupted turn 的 Undo/Redo 状态更新；
3. 统一 operation、turn、notice 的账本事务；
4. 在 Redo 完成恢复机制前暂时关闭或限制 Redo；
5. 增加失败恢复和 `needs-recovery` 测试。

### 第二阶段：补齐恢复边界

6. 实现 workspace 持久锁；
7. 为 pending plan 增加 snapshot/digest 绑定；
8. 明确 symlink、mode、目录和 special file 策略；
9. 处理 TOCTOU、junction 和 reparse point；
10. 接入受控 sandbox/Tauri bridge。

### 第三阶段：补产品和发布能力

11. 接入 parentTurnId 和 subtree Undo；
12. 实现消息旁 Undo；
13. 实现设置页回退模式；
14. 实现 snapshot 容量治理和 GC；
15. 增加真实 DSH/Web/clean-install 集成测试；
16. 消除 legacy JS 与 TypeScript 包同名歧义；
17. 同步架构文档、README、项目状态和发布 manifest。

## 9. 最终结论

当前版本的核心单回合 Undo 链路已经具备继续迭代的基础，测试也证明了正常路径较完整。但在修复 P0 问题前，它不满足文档定义的安全、可恢复和生产级文件回滚标准。

**发布阻断条件：**

- 修复目录递归删除风险；
- 修复 interrupted turn 的账本状态错误；
- 为 Undo/Redo 建立可恢复的 operation 状态机；
- 接入受控 filesystem/sandbox bridge，或明确限制插件运行边界；
- 补齐真实 DSH lifecycle 和 Web UI 集成测试。

本报告只记录审查结果，本次没有修改插件实现代码。
