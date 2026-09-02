# turn-rewind Git 目录模式：当前进度与后续规划

> 状态：**WIP / 实验性开发分支**
>
> 基线：桌面仓库 `6808c65`
>
> 目标：把 turn-rewind 调整为更接近 OpenCode 的 Git snapshot 模型，减少重复的目录扫描和自定义敏感文件规则；本文件描述当前独立实验分支，不代表主功能分支已经采用该方案。

## 1. 方案结论

“Git 目录模式”在本分支中采用 **OpenCode 风格的独立 snapshot Git 仓库**，而不是直接把 turnrewind 的 refs/objects 写入用户项目的 `.git`：

```text
用户项目工作树
  ├─ 用户自己的 .git / HEAD / branch / index
  └─ 用户自己的 .gitignore / global ignore / info/exclude

DSH_HOME
  ├─ ledger.sqlite
  └─ snapshots/<workspace-hash>.git
       ├─ turnrewind refs
       └─ turnrewind 新产生的对象
```

这样可以复用 Git 的对象和 ignore 语义，同时继续保证：

- 不修改用户项目 `HEAD`、branch、index、stash 或提交历史；
- snapshot refs 不进入用户项目的 refs 命名空间；
- 每次 capture 使用临时 `GIT_INDEX_FILE`，不污染用户真实 index；
- 非 Git 工作区明确不可用，不再为普通目录创建私有 Git 基线；
- Undo 仍然执行 workspace-relative 路径检查、冲突检查和恢复失败处理。

## 2. 当前已完成的 WIP 改动

### Host / Git workspace

- 新增 `lib/core/git-workspace.js`：解析真实 Git worktree、worktree git-dir、common-dir、index 和 `info/exclude`；
- `createSnapshotStore()` 要求 workspace 位于 Git worktree；
- session cwd 会 canonicalize 到 Git worktree 根目录，子目录不会被当成另一个恢复域；
- 非 Git 目录会返回 `TURNREWIND_GIT_REQUIRED`，由 turn 记录为不可追踪状态；
- Host 不再调用旧的全目录预算 probe 作为 Git workspace 的进入条件；
- 同一 workspace 的 session FIFO、baseline barrier、冲突检测和 `needs-recovery` 仍保留。

### Snapshot store

- snapshot 仍保存在 `$DSH_HOME/snapshots/<workspace-hash>.git`；
- 私有 snapshot repo 初始化时尝试配置 source Git objects alternates，减少重复复制已经存在的对象；
- 尝试同步 source `.git/info/exclude`；
- capture 使用临时 alternate index，最后在 `finally` 中删除；
- snapshot capture 复用 source workspace 的 `.gitignore` 和 global Git ignore 语义；
- 自定义敏感文件规则已收窄为 Git 元数据和 turnrewind 临时文件，避免把 `token.ts`、`credentials.module.ts` 等合法源码静默排除；
- snapshot refs 仅接受 `refs/turnrewind/` 前缀，并拒绝明显的路径穿越形式；
- Git 路径 diff 继续使用 NUL 分隔；
- **alternates 失效自愈**：每次 capture 后用 `git rev-list --objects --missing=print` 做连通性检查——源仓库 `gc --prune=now`（amend/rebase 的日常残留）可能删除被 snapshot 链借用且不可达的对象；检测到缺对象时自动降级：删除私有 snapshot repo、以**自包含模式**（不再写 alternates、不再复制 source index）重建全新基线。旧 turn 成为死快照走既有的 planner 跳过路径，后续 turn 永久不再借用。检查失败（极老 git/瞬时错误）只跳过自愈并告警，绝不误伤健康链。已在磁盘上的文件会在下次 capture 时因 read-tree 的 stat-less index 被重新哈希而自动补写本地 blob，因此永久性断裂只发生在“文件已删 + blob 是借用 + 源 gc”的组合上，检测正覆盖这一路径。

### 测试

- 新增 `test/git-test-utils.js`，用于创建临时 Git workspace；
- `git-snapshot.test.js`、`lifecycle.test.js`、`barrier.test.js`、`security.test.js` 的 fixture 已全部迁移到真实临时 Git workspace；
- `security.test.js` 的敏感文件测试已改写为新语义：ignore 规则委托给源仓库（被 `.gitignore` 忽略的文件不进快照；未忽略的 secret 命名文件会被捕获，token.ts 等合法源码不再被误伤）；
- `guard.test.js` 已重写为：Git-required（普通目录拒绝）、Git 根目录 canonicalization（子目录 session 归并到同一 worktree/snapshot repo）、系统目录拒绝；
- 旧 `guard.js` 中已无调用方的全目录预算扫描（`scanWithinBudget`/`assessWorkspace`/`defaultBudget` 及 `TURNREWIND_MAX_FILES`/`TURNREWIND_MAX_BYTES` 覆盖）已随测试一并删除，`guard.js` 只保留 `isSystemSensitiveWorkspace`；
- 新增 `test/git-state.test.js`：用户 Git 状态不变断言（必做项 1）——
  - capture 前后 `HEAD`、当前 branch、`symbolic-ref`、`git status --porcelain`、`ls-files -s`（index 内容）、`git diff --cached`、`for-each-ref`、`git log --all`、`git stash list` 全部逐字节不变；
  - restore 只改工作区文件，index/HEAD/refs/stash 不变，且快照捕获的是文件系统内容而非 index；
  - 私有 snapshot repo 的 refs 仅含 `refs/turnrewind/`，用户 refs 命名空间无泄漏，工作区无 `.turnrewind-*` 临时文件残留；
- 新增 `test/git-ignore.test.js`：ignore/attributes 语义——嵌套 `.gitignore` 与 `!` 取反、`.git/info/exclude`（含源规则变更后逐次 capture 的重同步）、global excludes（`GIT_CONFIG_GLOBAL` + `core.excludesFile`）、`.gitattributes`（`text=auto` 入库 LF 归一化、`-text` 字节精确，blob 经 `cat-file` 直接断言）；
- 新增 `test/git-worktree.test.js`：linked worktree 隔离——同一仓库两个 worktree 得到两个独立 snapshot repo 与 refs（互不泄漏、共享同一 common objects alternates）、源仓库 HEAD/branch/status/refs 逐字节不变、worktree 子目录 cwd 归并到该 worktree 的 store；以及打包对象（`git gc --prune=now`）经 alternates 的 capture/restore 读写路径；
- `maintenance.test.js` 新增 purge 安全测试：purge 只删除该 workspace 的 snapshot repo 与账本行，用户 `.git` 目录、HEAD、porcelain status、工作区文件以及其他 workspace 的 snapshot repo 和账本行全部完好；
- `test/git-test-utils.js` 为每个测试仓库显式设置 `core.autocrlf=false`：Git for Windows 系统级默认 `core.autocrlf=true` 会让 worktree checkout/add 发生行尾转换，导致 fixture 依赖机器配置（本机已实测踩到）；
- 新增 `test/git-gc.test.js`：alternates 失效自愈——构造“文件已删除 + blob 从源仓库借用（`hash-object -w` 不可达对象）+ 源 `gc --prune=now`”的真实断裂场景，验证读取路径断（`stateAt` reject）、下一次 capture 检测到父链缺对象并自愈为自包含基线（alternates 消失、对象物理落本地、后续 capture 独立可读）；
- 大文件（>64 MB）行为（2026-09-02 补）：超限 blob 仍会捕获进快照；stateAt 以 kind tooLarge 报告（不再抛异常炸整个预览），预览卡标注 [too large]，执行时 restorePath 对该单文件抛 TURNREWIND_FILE_TOO_LARGE、undo 循环将其计入「未恢复」清单，其余文件照常恢复、turn 照常记为 undone；大项目实测：6000 文件/94MB 已提交仓库首拍 1.6s、稳态 3.5s、快照 repo 82KB（alternates 借用），大量未 ignore 的未跟踪文件首拍可达分钟级——ignore 卫生决定体验；
- 真机 DSH Host 验证已完成（dev 环境：`DSH_HOME=~/.dsh.dev-gitdir`，profile 以 `link:` 挂载本分支插件源码）：
  - 一次 turn 内新建/修改/删除文件 → `snapshots/<hash>.git` 生成、`ledger.sqlite` 有 turns 行；
  - 两阶段 `/undo`（预览红绿 diff → 卡内 ✓）→ 三个文件全部恢复至 turn 前状态；
  - `git status` 在 turn 前后逐字节一致——用户 `.git` 零污染在真机复现；
  - 非 Git 工作区会话：turn 正常执行、undo 拒绝并说明原因（`TURNREWIND_GIT_REQUIRED`）；
  - 连通性巡检真机实测：对私有快照 repo 全量 `rev-list --objects --missing=print --all`，全链零缺失、正常退出；连续多轮正常使用（含 amend + `gc --prune=now`）均无误触发自愈——无假阳性；
  - 自愈触发路径由 `git-gc.test.js` 单测钉死（正常使用中借用的 blob 一般是可达对象，真机强凑“不可达借用 + 删除 + gc”三件套无必要）；
- 桌面端配套修复：上游把 alpha 发布成 latest（漏标 Pre-release label）导致首装在 `DSH_PREVIEW_RELEASE` 上安全中止——`fetch_latest_dsh_pkg_info` 现在回退解析最新稳定版（`de04c6d`），340 项 Rust 测试通过；
- 当前已执行的全量插件回归：

```text
Test Files: 14 passed
Tests:      69 passed
Failed:     0
```

## 3. 当前未完成项

本分支功能与真机验证已完成，可作为实验分支评审；合并前仍需上游评估取舍（Git-only workspace、ignore 委托、预算守卫移除）。

### 已按外部审查修复（2026-09-02）

- P1 README 矛盾：删除旧「默认排除项」清单，改为「快照范围与敏感文件」——明确插件不提供敏感文件保护、未 ignore 的 .env/密钥会被快照，与 Git 目录模式实现一致；
- P1 TURNREWIND_GIT_UNAVAILABLE 死代码：gitWorkspace 区分 spawn ENOENT（git 不在 PATH）与非 worktree，probeWorkspace/createSnapshotStore 报告真实原因（guard.test.js 新增空 PATH 用例）；原先正常 worktree 但没装 git 的用户会看到误导性的 not a Git worktree；
- P2 客户端空格路径：parseUndoOutput 的 (S+) 改为整行匹配并剥离 [conflict]/[too large] 标记，含空格路径正确进入文件清单（client-view.test.js 新增用例）；
- P2 测试超时统一为 120s（package.json 与 vitest.config.js，Windows 实测有用例超 30s）；
- P0 redo 无 operation/回滚/needs-recovery：**按决策暂缓**（功能冻结，README 标注「已知缺陷：redo」与启用条件）。

### 可选优化

1. 连通性检查的性能优化：当前每次 capture 走全链 `rev-list`（O(链上对象总数)）。优化方向：常态走 `--not <parent>` 的增量检查 + 源对象库 mtime 变化时触发全链检查。大仓库上需先实测 capture 耗时；
2. 非 Git 工作区会话创建时即时弹窗（当前 skip 通知走下一轮 step 注入 + 投影弹窗，会话首轮结束前用户无感知）。

### 仍需保留的安全边界

即使采用 Git snapshot 简化模式，也不能删除：

- workspace-relative 路径检查和路径逃逸拒绝；
- symlink、junction、reparse point 的拒绝或明确失败；
- restore 前的磁盘摘要和冲突二次校验；
- pending plan 的原子 claim；
- baseline barrier 与同 session FIFO；
- operation 中断后的 `needs-recovery` fence；
- Git 输出限制、NUL 路径解析和临时文件清理；
- 不触碰用户 HEAD、branch、index、stash 和提交历史。

“减少安全功能”只意味着删除与 Git 已经重复的自定义扫描/规则，不意味着可以取消恢复边界。

## 4. 风险与取舍

| 项目 | 当前取舍 |
| --- | --- |
| 快照存储 | 仍为 DSH_HOME 下的独立 Git repo，不污染用户 `.git` |
| Git 对象复用 | 通过 alternates 借用 source objects；capture 后连通性检查发现被源 gc 削掉的对象时自愈为自包含存储（不再借用）。检查成本：每次 capture 全链 rev-list（优化 TODO） |
| Ignore 规则 | 以 source Git ignore 为主，turnrewind 临时文件额外排除 |
| 非 Git workspace | 不支持，明确记录 `TURNREWIND_GIT_REQUIRED` |
| 大 workspace | 不再做重复的全目录预算扫描；Git ignore 可减少范围，但快照容量和性能风险仍存在 |
| 用户手工修改 | 继续做冲突检测，默认不静默覆盖 |
| 崩溃恢复 | 仍然只有 `needs-recovery` 阻断，尚无自动 journal 重放 |
| 文件替换 | 现有删除后 rename 的非原子窗口仍未解决 |
| purge | 仍需补 workspace lock、可恢复事务和运行中 repo 检查 |

## 5. 验证命令

在本分支根目录执行：

```powershell
pnpm install
pnpm exec vitest run plugins/dsh-tauri-turnrewind/test --testTimeout=120000 --maxWorkers=1
pnpm exec eslint plugins/dsh-tauri-turnrewind
node --input-type=module -e "await import('./plugins/dsh-tauri-turnrewind/lib/index.js')"
```

完整回归达到全绿前，不能把本分支描述为生产就绪。

## 6. 分支说明

本实验位于独立桌面项目目录，使用独立 Git worktree 分支：

```text
branch: dsh/turnrewind-git-dir-undo
base:   6808c65
status: WIP
```

本分支用于把 Git 目录模式实验和主 `feature/turn-rewind` 隔离，后续可以单独评审、继续修复或整体丢弃。
