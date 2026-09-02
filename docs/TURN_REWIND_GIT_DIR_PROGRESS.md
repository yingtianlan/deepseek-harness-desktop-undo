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
- Git 路径 diff 继续使用 NUL 分隔。

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
- 当前已执行的全量插件回归：

```text
Test Files: 11 passed
Tests:      61 passed
Failed:     0
```

## 3. 当前未完成项

本分支目前仍是 WIP，不能直接合并或作为生产版本使用。

### 必须完成

1. 增加 `.gitignore`、`.git/info/exclude`、global ignore 和 `.gitattributes` 语义测试；
2. 解决 source object alternates、source index 初始化和 snapshot 私有对象之间的兼容性问题；
3. 给同一个 Git common-dir 下的 linked worktree 增加 snapshot 隔离测试；
4. 更新 `maintenance.js`、`purge-workspace.js`、ledger workspace metadata 和 purge 测试，保证只清理 turnrewind 的 snapshot repo，不误删用户 `.git`；
5. 更新插件 README、`docs/TURN_REWIND.md` 和生产审计报告，明确本模式是实验分支、Git-only workspace 和仍未解决的风险（README 中的预算守卫/`TURNREWIND_MAX_*` 章节已过时）；
6. 运行完整插件回归、lint、Node import smoke，以及必要的真实 DSH Host 验证。

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
| Git 对象复用 | 通过 alternates 尝试复用 source objects；失败时应能回退到独立对象 |
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
