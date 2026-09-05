# `dsh-tauri-turnrewind` 优化建议与安全审查报告

> 审查对象：`packages/dsh-tauri-turnrewind-ts`（当前 TypeScript 实现）  
> 审查范围：Host、Client、SQLite 账本、Git snapshot、HTTP 路由、生命周期、测试与发布配置  
> 审查基线：当前工作区代码与 `docs/AGENTS.plugins.md` 规范；本报告不替代产品设计文档。

## 1. 摘要

插件采用“独立 snapshot Git 仓库 + SQLite ledger + 两阶段预览/确认”的总体方案，已经具备较好的安全纵深：快照 refs 使用 `refs/turnrewind/` 命名空间；Git 参数通过参数数组传递；恢复前后多次检查路径链；符号链接、超大文件和非空目录不会被静默覆盖；Undo 的 turn、operation、notice 已通过单事务提交；workspace lock、pending plan claim 和 `needs-recovery` 围栏已经存在。

**当前建议：** 可继续在 Git worktree 与可恢复备份环境中使用 MVP，但不应把它描述为任意文件系统的通用灾备工具。生产推广前应优先完成受控文件系统桥接、真实 Host/Web 集成测试、容量治理的并发安全加固，以及文档/发布链路统一。

## 2. 已确认的安全控制

| 控制项 | 结论 |
| --- | --- |
| Git 命令注入 | 未发现把用户输入拼接为 shell 命令的证据；命令以参数数组执行，ref/path 仍需继续保持权威校验。 |
| 路径逃逸 | `assertSafePath()` 拒绝 workspace 外路径与 workspace 根路径，并检查路径组件中的符号链接。 |
| 恢复破坏范围 | 恢复普通文件使用临时文件与 `.turnrewind-restore.bak` swap；非空目录拒绝递归删除。 |
| 符号链接 / 特殊文件 | snapshot 中的 symlink 标记为 unsupported；磁盘侧非普通文件不会按普通文件写回。 |
| 并发 | SQLite pending plan 条件 claim、进程内 session FIFO，以及 workspace lock 覆盖主要 capture/settle/undo/purge。 |
| 崩溃恢复 | applying operation 在启动时转为 `needs-recovery`；bak swap 可在启动时自愈。 |
| HTTP 边界 | 变更路由限制 POST、loopback 与 body 大小；status 路由限制 GET。 |
| 客户端文本注入 | Diff、路径和错误原因使用 React 文本节点或 `textContent`，未见 `innerHTML`/HTML 解释执行路径。 |

## 3. 风险与改进项

### P0：发布前必须满足

#### P0-1 仍缺少受控文件系统边界

**位置：** `src/host/service/git-snapshot.ts`、`src/host/service/undo.ts`

恢复直接使用 Node 文件系统 API。虽然多次 `lstat` 检查显著缩小了 TOCTOU 窗口，但无法在检查与 `rename`/`mkdir` 之间提供原子保证；外部进程仍可能替换父目录、junction 或 reparse point。

**建议：** 将恢复能力下沉到受控 Tauri/sandbox bridge；优先使用基于目录句柄或等价安全语义的 API。桥接层应统一拒绝 symlink/junction、限制根目录、记录操作审计，并把“检查目标类型—写临时文件—原子替换”作为一个受控操作。

#### P0-2 事务不能覆盖文件系统，需完善恢复状态机

SQLite 事务只能保证账本一致性，不能与磁盘写入构成跨系统事务。当前已通过 operation `applying`、失败回滚与 `needs-recovery` 缓解，但应把恢复过程明确建模为状态机：`applying → applied | rolled_back | partial | needs-recovery`，并保存每个路径的实际结果。

**建议：** 增加启动恢复向导/诊断命令，展示 operation、目标路径、bak/tmp 残留和建议动作；禁止在 `needs-recovery` workspace 上执行任何自动写操作，直到用户确认或完成安全修复。

### P1：高优先级

#### P1-1 容量治理的整仓删除需要并发与失败保护

**位置：** `src/host/service/retention.ts:87-119`

容量超限时会递归删除 snapshot repo，并依赖下一次 capture 自愈。该函数注释假设调用点没有活动操作，但未来调用点或多 Host 进程若绕过同一把 lock，可能与 capture/undo 同时读写；删除中途失败也可能留下半仓。

**建议：** `enforceRetention()` 必须只能在 workspace lock 内运行；重建采用“rename 到 quarantine → 新仓库验证成功 → 删除旧仓库”的两阶段方式；失败时保留旧仓并写入可诊断状态。增加并发、删除失败、低磁盘和重建后首次 capture 测试。

#### P1-2 pending plan 绑定信息需要强制兼容策略

**位置：** `src/host/service/ledger.ts:126-130`、`src/host/service/undo.ts` 中 confirm 流程

新 plan 已保存 before/after ref 与 paths digest，但旧数据库迁移允许这些列为 NULL，confirm 对旧格式存在降级行为。若旧 plan 的路径集合或 snapshot 版本不可验证，继续执行会削弱“用户确认的是刚刚预览内容”的保证。

**建议：** 对缺少绑定字段的旧 plan 一律返回 409/410，要求重新生成预览；为 plan 增加 schema/version、workspace path digest 和创建时的 turn status；确认时再次校验 owner、workspace、refs、路径摘要和目标 turn 状态。

#### P1-3 HTTP 错误响应与请求生命周期需更健壮

**位置：** `src/host/routes/index.ts:64-97`

body 超限后仍需等待请求流结束；`error` 与 `end` 在异常客户端行为下可能触发重复响应。JSON 解析、Content-Type、请求超时和响应头安全策略也未集中约束。

**建议：** 超限后立即销毁/暂停请求并保证 response 一次性结束；增加 `responded` guard、请求超时、`Content-Type: application/json` 校验、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`；对 `planId/sessionId` 使用明确格式校验，避免把任意字符串带入日志。

#### P1-4 用户可控路径和错误文本应限制日志/消息规模

**位置：** `src/host/service/undo.ts`、`src/client/components/command-view.ts`

路径来自 Git diff，diff 文本和失败原因会进入 notice、命令输出和 UI。虽未发现 XSS，但超长路径、异常数量或 Git 生成的大 diff 仍可造成账本膨胀、UI 卡顿和模型上下文膨胀。

**建议：** 为路径数、单路径长度、notice 总字节数、错误原因长度和 diff 总行数设置硬上限；超限时保留计数与摘要，不把完整内容注入 notice；在 UI 中虚拟化或分段显示大量 diff。

#### P1-5 跨进程锁的发布竞态与 PID 判定

**位置：** `src/host/service/workspace-lock.ts:84-99,126-140`

锁文件使用 `openSync('wx')` 创建后再写入内容。其他进程可能在内容写入前读到空文件，将其判为 stale 并接管，形成短暂的双持锁；另外 `process.kill(pid, 0)` 返回 `EPERM` 时不应把进程判定为已死亡。

**建议：** 使用临时文件写入并 fsync 后再以原子 rename 发布，或获锁后回读 token/内容自检；对 `EPERM` 按“进程存活但不可探测”处理，并通过 TTL 和 token 保护接管流程。

#### P1-6 needs-recovery 围栏必须实时生效

**位置：** `src/host/apply.ts:193`、`:438-512`、`src/host/service/ledger.ts:594-599`

`needs-recovery` workspace 集合目前主要在插件启动时加载。运行期间如果账本提交失败并落入该状态，当前进程的后续 turn/undo 可能仍继续；确认 HTTP 路由也应在 claim 和执行前重新检查围栏，避免预览期间产生的 plan 在恢复故障后继续执行。

**建议：** 在写入 `needs-recovery` 时同步更新内存集合，并在 baseline、命令入口、confirm route 三处实时检查数据库状态；围栏检查和 plan claim 应处于同一 workspace lock/事务语义内。

#### P1-7 Git/SQLite 大规模操作需要有界并发与忙处理

**位置：** `src/host/service/undo.ts:281-292`、`src/host/service/ledger.ts`、`src/host/service/retention.ts`

`buildPlanEntries()` 使用裸 `Promise.all`，路径数量较大时可能同时启动数千个 Git 子进程，造成 Host 资源耗尽。SQLite 全局 ledger 未显式设置 `busy_timeout`，并发写入遇到瞬时 `SQLITE_BUSY` 可能被误判为恢复故障并触发永久围栏。

**建议：** 引入 8–16（按平台压测调整）的有界并发池，并限制单个 plan 的路径数量/总大小；启动 ledger 时设置 `PRAGMA busy_timeout`，写事务优先使用 `BEGIN IMMEDIATE`，区分瞬时锁冲突与真实状态漂移，必要时带退避重试。

#### P1-8 首次 workspace 初始化必须纳入同一把锁

**位置：** `src/host/apply.ts:232-260`、`src/host/service/retention.ts:87-119`

首次触碰 workspace 时，容量治理可能删除 snapshot repo，崩溃 swap 清扫可能重命名备份，而这些动作若不经过 workspace lock，可能与另一 Host 的 capture/restore 并发运行。

**建议：** 将 `enforceRetention()`、`restoreCrashedSwaps()` 和 snapshot store 初始化纳入 workspace lock；处理锁忙时明确跳过并稍后重试，不能静默继续。

### P2：工程质量与产品优化

#### P2-1 完善 parent/child turn 与 subtree undo

`ledger` 已有 `parent_turn_id` 与 planner 能力，但 turn 插入链路尚未完整接入父子关系，`--subtree` 仍明确返回 MVP 不支持。建议先定义 DSH turn tree 契约，再以同 workspace 后序遍历、重叠路径合并和单次确认实现，避免跨 workspace 聚合。

#### P2-2 统一文档的唯一真相源

当前设计文档、Git worktree 实现说明、历史 JS 审查和项目状态文件可能表达不同能力边界。建议在 `docs/TURN_REWIND.md` 顶部明确“当前实现/实验目标/历史实现”三栏，并在 README、状态文档和发布说明中统一：仅支持 Git worktree、Redo 暂停、单文件大小上限、snapshot 保留策略和恢复限制。

#### P2-3 补齐真实集成测试

现有单元测试覆盖较广，但仍应增加：

- 多进程 workspace lock 竞争、TTL 接管与异常退出；
- Windows junction/reparse point、只读文件和权限位 round-trip；
- restore 中途失败、bak 残留与启动自愈；
- retention 与 capture/undo 并发及重建失败；
- 真实 DSH Host lifecycle、ModuleLoader、slot 注入和路由测试；
- clean install、打包产物发现、`exports` 与 patch manifest 测试。

#### P2-4 优化 Git 与 IO 性能

`captureSnapshot()` 会运行多次 Git 子进程，`stateAt()`/diff 也可能按文件重复调用。建议批量读取 `ls-tree`，缓存同一 plan 生命周期内的 commit/path 元数据，限制并发 Git 子进程数，并将所有长任务纳入可取消的异步队列；不要在 Host 主流程引入新的同步大文件 IO。

#### P2-5 改进可观测性与隐私

增加结构化事件：workspace hash、operation id、阶段、耗时、路径计数、失败分类和 snapshot repo 大小；默认不记录文件内容、完整路径或 diff。为恢复失败提供稳定错误码与用户可行动建议，便于诊断而不泄露敏感源码。

#### P2-6 客户端生命周期与可访问性

当前 dialog 使用 DOM 节点和 `textContent`，生命周期清理方式合理；command view 的轮询也有 AbortController。建议补充焦点陷阱、Escape 关闭、恢复焦点、`aria-labelledby`/`aria-describedby`、按钮 loading 的 `aria-busy`，并将轮询改为退避策略，页面隐藏时暂停，避免大量卡片同时轮询。

#### P2-7 发布与依赖供应链

保持单一 canonical package，避免 legacy 与 TS 包同名造成安装/manifest 歧义；CI 中固定 pnpm lockfile，执行依赖审计、许可证检查、构建后 smoke test，并对 Git 版本、Node 版本和 Windows/macOS/Linux 矩阵进行验证。发布包不得包含测试产物、临时 snapshot 或调试脚本。

#### P2-8 Client 适配层、协议常量与 UI 文档漂移

补充审阅发现客户端存在几项不会直接造成代码执行漏洞、但可能导致功能静默失效或维护风险升高的问题：

- `src/client/index.ts` 的弹窗 runner 通过原始 `ctx.get('sessions')` 读取 sessions，绕过已创建的 `compat(ctx)` 代理；在不同运行时版本下可能导致 `getSnapshot/subscribe` 形状不兼容，弹窗链路失效。
- `/api/turnrewind` 同时在 `client/constants/index.ts`、`shared/constants.ts` 和 Host 路由注册处表达；应只保留 shared 常量，并添加 Host/client 路径契约测试。
- `README.md` 的清理命令指向 `dist/purge-workspace.js`，但当前构建配置并不产生该 entry；应补独立 CLI entry，或改为文档化的现有 API/脚本。
- README 仍描述基于 localStorage 的提示去重，而当前实现采用会话种子逻辑；应同步文档，并将种子状态机提取为纯函数测试首次种子、新提示、会话切换和 sessions 缺省四种场景。
- `command-view.ts` 的 localStorage key 在缺少 `node.id` 时回退到模型输出摘要，可能造成 key 膨胀和不稳定；应只使用稳定且长度受限的节点标识。

#### P2-9 客户端安全边界与请求健壮性

客户端没有发现 XSS：文本通过 React 节点或 `textContent` 渲染，URL 参数使用 `encodeURIComponent`。但确认/取消请求目前没有超时，宿主挂起时按钮可能长期处于提交中状态；建议使用 `AbortSignal.timeout()` 或等价取消机制。对于 loopback HTTP mutation，除 session/plan 校验外，建议在支持场景下增加 Origin/Host allowlist，并补 405/413/403/坏 JSON/重复响应测试。

#### P2-10 生命周期、类型与可测试性

建议将弹窗 runner 的手工 timer/listener 管理收敛到 `createLifecycleController()`；为 HMR 单例 `submitLine` 和 dialog 增加实例 token，避免旧 disposer 清理新实例。移除 `register/command-view.ts` 的 `as never`，将 `CommandViewProps` 集中放入 `client/types/`；将 hard-coded 中文卡片文案接入 locales。另需修复 `prepublishOnly` 对未声明 `nr` 的依赖，使用 `pnpm build`，并增加真实 `dist/client.cjs` ModuleLoader smoke test。

#### P2-11 低层防御与后台清扫

补充 Host 审阅发现：`.turnrewind-restore.bak`/临时文件缺少所有权校验，可能误删用户同名文件或留下残留；`applying` pending plan 缺少启动清扫，成功执行后 plan 状态写回失败也可能重复执行；gitlink/submodule mode 应明确标记 unsupported；来源 ref/commit 应在所有 Git 边界统一调用 `normalizeSnapshotRef()`。此外，startup sweep 应拒绝 junction/reparse point 递归，磁盘文件读取需缩小尺寸检查与读取之间的 TOCTOU，后台 FIFO 任务应统一捕获异常，避免 unhandled rejection。

路由层还应增加响应一次性保护、Content-Type/Origin/Host 校验、请求超时和内部错误脱敏。系统目录/UNC share 判断、无 Git workspace 的 workspace key 归一化、pending plan 定期治理以及统一使用 `ctx.logger` 也应纳入工程整改清单。

## 4. 建议实施顺序

1. 修复 retention 当前 typecheck 错误，并在合并前通过 typecheck/test/build。
2. 修复 client compat 绕过、清理 CLI 文档/entry、弹窗种子逻辑测试。
3. 接入受控文件系统/sandbox bridge，完善 recovery 状态机与诊断向导。
4. 给 retention、restore crash swap 和 workspace lock 增加并发/失败测试，并采用 quarantine 重建。
5. 对旧 pending plan 强制重新预览，增加 plan schema/version 与大小限制。
6. 完成真实 Host/Web 集成测试、路由安全测试和 Windows reparse point 测试。
7. 统一协议常量、i18n、README、canonical package、CI 发布检查。
8. 再推进 subtree undo、消息旁 Undo、性能批处理和 UI 可访问性增强。

## 5. 验证建议

本报告生成时重点静态审阅了以下文件：

- `packages/dsh-tauri-turnrewind-ts/src/host/apply.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/routes/index.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/git-snapshot.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/ledger.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/undo.ts`
- `packages/dsh-tauri-turnrewind-ts/src/host/service/retention.ts`
- `packages/dsh-tauri-turnrewind-ts/src/client/components/command-view.ts`
- `packages/dsh-tauri-turnrewind-ts/src/client/register/dialog.ts`
- `packages/dsh-tauri-turnrewind-ts/src/client/styles/index.ts`

提交前应运行：

```powershell
pnpm --filter dsh-tauri-turnrewind typecheck
pnpm --filter dsh-tauri-turnrewind test
pnpm --filter dsh-tauri-turnrewind build
pnpm exec eslint packages/dsh-tauri-turnrewind-ts
```

## 6. 结论

未发现可直接确认的 Git shell 注入或明显 DOM XSS；当前实现对路径、符号链接、目录删除、计划 claim 和崩溃围栏已有较完整的防御。主要剩余风险不是单个字符串拼接漏洞，而是**文件系统与账本无法天然原子化、TOCTOU 的平台边界、容量重建的并发安全，以及真实集成覆盖不足**。完成 P0/P1 项后，再把插件从“受控 Git worktree 的 MVP 恢复工具”升级为更广泛的生产能力。

## 7. 待办整合与当前状态（2026-09-05）

本报告与 `docs/TURN_REWIND_REVIEW_2026-09-03.md` 的修复状态合并后的统一待办。

### 已完成（本报告核对时确认）

- 报告建议第 1 条：retention 的 typecheck 错误已在 `48ecb96` 前修复，typecheck/test/build/eslint 全绿；
- legacy JS 同名包已删除（canonical package 唯一）；
- 弹窗去重已从 localStorage 迁移为「单会话一次」种子逻辑（P2-8 相关 README 漂移同步修复）；
- P0/P1 主体（递归删除、interrupted 账本、原子事务、redo 冻结、workspace lock、plan 绑定、symlink、mode、TOCTOU 缓解）见 09-03 报告 §1.1。

### 新增待办（按优先级）

**高优先级（正确性/并发）：**

1. needs-recovery 围栏实时化：写入时同步内存集合 + baseline/命令入口/confirm 三处实时查库（P1-6）；
2. retention 与首触初始化纳入 workspace lock；仓库重建改两阶段 quarantine（P1-1/P1-8）；
3. SQLite `busy_timeout` + 写事务 `BEGIN IMMEDIATE` + `buildPlanEntries` 有界并发池（P1-7）；
4. 锁发布竞态：临时文件 fsync 后原子 rename 发布；`EPERM` 视为存活（P1-5）；
5. 旧格式 plan（NULL 绑定列）从严拒绝、强制重新预览（P1-2 政策收紧）；
6. HTTP 路由健壮性：`responded` 一次性 guard、请求超时、Content-Type 校验、`nosniff`/`no-store`、planId/sessionId 格式校验（P1-3）；
7. 路径数/单路径长度/notice 字节/diff 行数硬上限（P1-4）。

**中优先级（工程）：**

8. client sessions 读取改走 `compat(ctx)` 代理，去掉原始 `ctx.get` 绕过（P2-8）；
9. purge CLI：补 `dist/purge-workspace.js` entry 或修正 README 命令（P2-8，已核实 README 现指向不存在文件）；
10. 弹窗种子逻辑提取纯函数并测试四种场景；`prepublishOnly` 改 `pnpm build`（P2-8/P2-10）；
11. 协议常量收敛到 shared + Host/client 路径契约测试；`expandKey` 不再回退到输出摘要（P2-8）；
12. bak/tmp 所有权校验、applying plan 启动清扫、gitlink 标记 unsupported、`normalizeSnapshotRef` 全边界、sweep 拒绝 junction 递归、FIFO 统一异常捕获（P2-11）；
13. 请求超时 + Origin allowlist + 405/413/403/坏 JSON 测试；确认/取消请求加 `AbortSignal.timeout`（P2-9/P1-3）。

**低优先级（产品/体验）：**

14. P2-1 subtree undo（先定 DSH turn tree 契约）；P2-2 文档唯一真相源三栏表；P2-4 批量 ls-tree 与元数据缓存；P2-5 结构化事件；P2-6 可访问性（焦点陷阱/Escape/aria）与轮询退避；P2-7 CI lockfile/依赖审计/平台矩阵；
15. `createLifecycleController` 收敛、HMR 实例 token、`as never` 移除（register/command-view.ts 注释说明为结构性必需）、中文文案入 locales（P2-10）；`ctx.logger` 统一。

### 本轮收尾更新（2026-09-05 晚，复核后修复）

- **新发现并修复**：`restorePath` absent 分支对「空目录」的移除误用了 `rmSync`（无目录语义，必然抛 `ERR_FS_EISDIR`）——turn 把文件换成空目录的场景会把该路径误报为恢复失败。改用 `rmdirSync`（只删空目录，且对 readdir→删除竞态窗口内新放入的文件天然安全）；
- **回归测试补齐**：工作区根恢复拒绝、absent 路径上非空目录拒绝 + 空目录移除、retention 不可达 loose object 回收（可达快照链不受影响）共 3 个测试钉住（22 文件 / 118 测试全绿）；
- **retention 加固收尾**：`enforceRetention` 在 workspace 首触时纳入一次性跨进程 workspace lock（忙则本轮跳过，不再与另一 Host 的 capture 并发写仓库）；执行前 `git prune --expire=now` 回收 diffAgainstDisk 写入的不可达 loose object（冲突预览残留的主要膨胀源），容量测量基于治理后的真实占用；仓库超限重建改**两阶段 quarantine**——先整体 rename 进固定名隔离目录（原子发布点，之后任何死亡都自洽）再删除，崩溃残留由下一轮治理清扫。待办第 2 条到此全部关闭；
- **防御性小修**：`claimRewindNotices` 的 SELECT 移入 `BEGIN IMMEDIATE` 事务内——读与消费在同一写锁内完成，双 Host 并发 claim 不再可能返回同一批 pending notice（补跨连接不双消费测试）；
- **文档/文案漂移修正**：README 测试数字（18/97 → 22/118）与「当前限制」中已过时的容量治理条目；命令 hint 移除已冻结的 `--redo`；
- **中文文案入 locales（待办第 15 条部分关闭）**：undo 卡片全部硬编码中文迁入双语字典（新增 10 个 key），组件经 `setCardTranslator` 注入通道（与 `setSubmitLine` 同一生命周期模式），未注入时回退 zh 字典；提交通道的会话缺失错误同步入字典。剩余：`createLifecycleController` 收敛、HMR 实例 token。

### 实施顺序建议

采纳本报告第 4 节顺序，其中：第 1 条（retention typecheck）已完成（`48ecb96`）；第 2 条（client compat 绕过修复 / purge CLI entry 与 README 修正 / 弹窗种子纯函数化+测试 / prepublishOnly 修复）已完成（`c678750`）。下一个开工项为第 3 条（受控文件系统 bridge 与 recovery 诊断），属平台级工作。
