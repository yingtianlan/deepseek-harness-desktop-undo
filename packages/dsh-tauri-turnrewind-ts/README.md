# dsh-tauri-turnrewind

本地开发中的 DSH turn 回滚插件（**TypeScript 重写版**，位于 `packages/`，遵循 workspace 插件规范；旧 JS 版已移除）。

> 当前 `cordis.patch.yml` 已为本地 debug profile 的实验启用而挂载插件。它仍是原型：恢复路径直接使用 Node/Git，尚未接入受控的宿主 sandbox/Tauri bridge；仅可在可丢弃的测试工作区中启用，不能作为生产功能使用。
>
> **Git 目录模式（当前形态）**：工作区**必须**位于 Git worktree（OpenCode 风格）。非 Git 目录显式禁用——turn 记为 `skipped`（`TURNREWIND_GIT_REQUIRED`），`/undo` 说明原因，不再为普通目录建快照。ignore 规则（`.gitignore` / `.git/info/exclude` / global excludes / `.gitattributes`）委托给源仓库；私有 snapshot repo 通过 alternates 借用源对象。设计与进度见 `docs/TURN_REWIND_GIT_DIR_PROGRESS.md`。

## 当前状态

这是 Host MVP 原型，当前实现：

- 为已领取的 Agent turn 建立私有 Git 快照；
- 将快照映射记录到 `$DSH_HOME/ledger.sqlite`；
- **git 子进程模型**：快照、diff、恢复走异步 spawn，不阻塞 Host 事件循环；同一会话的捕获/结算按 FIFO 串行；收到 turn 输入后，before snapshot 通过 `agent/pre-step` barrier 完成后才允许模型和工具执行；同一 workspace 被其他 session 占用时，新 turn 会正常运行但记为 `skipped`，避免共享 snapshot 链互相污染。**仍有两处同步路径**：工作区解析（git-workspace.js 的 rev-parse spawnSync，每次 turn 领取触发数次，单次 <100ms）与冲突检测的磁盘读取（currentState 同步读单个文件，上限 64MB）——超重工作区上可能短暂卡顿，异步化在待办中；
- **git 可用性探测**：系统没有 git 时，turn 显式记为 `skipped`（原因 `TURNREWIND_GIT_UNAVAILABLE`），而不是静默失败；
- **快照链自愈**：私有快照仓库被删/损坏后，下一次捕获自动降级重建基线（日志有一条 warning），后续 turn 照常可撤销；被清空前留下来的旧 turn 会在 `/undo` 选目标时自动识别为死快照并标记跳过（`snapshot ref missing`），不会甩出 git 原始报错；
- **alternates 失效自愈**：私有 repo 通过 alternates 借用源仓库对象，而源仓库 `git gc --prune=now`（amend/rebase 的日常残留）可能删掉被借用且不可达的对象；每次 capture 后做连通性检查（`git rev-list --objects --missing=print`），发现缺对象即降级为自包含存储（不再借用、不再复制源 index）并重建基线，旧 turn 走死快照跳过路径；
- **工作区资格守卫（Git 目录模式）**：会话 cwd 必须位于 Git worktree（子目录自动归并到 worktree 根，共享同一快照域）；家目录、家目录祖先、盘根等系统目录直接拒绝；非 Git 目录记为 `TURNREWIND_GIT_REQUIRED`，不再做全目录预算扫描（见「工作区资格」）；
- **不可用弹窗**：客户端半（`src/client/`）通过 `turnrewind` 会话投影检测到不可用提示时，在 Web UI 内弹出模态对话框（中英双语、跟随应用主题、每个浏览器只弹一次）；
- **两阶段 `/undo`**：先出预览卡（红绿 diff + `+x -y` 徽标 + 文件清单），卡内 ✓/✗ 按钮确认执行或取消——不看预览就不会误执行；计划 5 分钟过期，确认时二次校验磁盘；
- 恢复前比较当前文件与 turn 完成时的快照，发现变化则拒绝覆盖，并给出「turn 产物 → 当前磁盘」的冲突 diff；
- 冲突可用 `--skip-conflicts`（只恢复无冲突文件）或 `--force`（强制覆盖）直接执行；
- `/undo --redo` 重做最近一次已应用的 undo（磁盘在 undo 后被改动则拒绝）；
- 注册人类命令 `/undo`；
- `/undo` 默认处理当前会话最新的单个可恢复 turn，也可指定完整 turn ID；
- 同一 workspace 的活动 turn 或 undo 操作互斥；
- 插件重启时将未完成 turn 标记为 abandoned；未完成的 **Undo** operation 会标记为 `needs-recovery`，对应 workspace 在清理前拒绝新的 rewind 操作，避免未知磁盘状态被继续覆盖；**redo 路径尚未接入该机制**（已知缺陷，功能冻结中，见「已知缺陷：redo」）；当前只能先人工检查 workspace，再停止 Host 并使用 purge 工具（见下文「清理已膨胀的快照数据」）清理该 workspace 的 turnrewind 数据后恢复使用；
- 每次 Undo/Redo 的回退提示独立持久化；下一次模型 step 一次性注入全部 pending notice；
- 不修改用户项目的 HEAD、分支、index、stash 或提交历史。

## 使用方法

在已加载本插件的 DSH 会话中：

```text
/undo
```

默认进入**两阶段流程**：先输出预览卡（每个文件的红绿 diff 与 `+x -y` 徽标），
卡内附两个按钮——**✓ 执行撤销** 与 **✕ 取消**。点 ✓ 才会真正恢复文件；
不点击的话计划 5 分钟后自动过期，不会误执行。确认时还会二次校验磁盘，
预览之后文件又被改动过（冲突）会拒绝执行并提示重新预览。

也可以指定完整 turn ID、或只看计划不动手：

```text
/undo <session-id>:<turn-number>
/undo --dry-run      # 仅输出文件清单与分类，不含 diff
/undo --preview      # 输出内容与 /undo 的预览卡一致
```

磁盘在预览后又被改动（冲突）时，可以选择处理策略：

```text
/undo --skip-conflicts   # 只恢复无冲突文件，跳过的文件会列出
/undo --force            # 强制覆盖冲突文件（执行前仍有回滚点保护）
```

其他：

```text
/undo --redo                # 重做最近一次已应用的 undo
/undo --cancel <plan-id>    # 取消一个待确认的预览计划
```

当前不支持：

```text
/undo --subtree
```

父对话递归撤销、消息旁 Undo 按钮和设置页模式切换尚未实现。

## 工作区资格（Git-only）

曾有用户在 QQ 机器人会话（默认工作目录是家目录、约 250 GB 内容）上触发 `git add --all` 级别的灾难，早期版本因此引入了全目录预算扫描。当前实现以**源仓库的 Git worktree 为快照边界**：**非 Git 目录禁用**（不再做预算扫描，也不再为普通目录建快照）。turn 开始前的资格检查：

1. **系统目录直接拒绝**：家目录本身、家目录的祖先目录（如 `C:\Users`、`C:\`）、以及任何盘符根目录。这类目录无论多小都不做快照。
2. **必须是 Git worktree**：会话 cwd 不在 Git worktree 内的 turn 记为 `skipped`（原因 `TURNREWIND_GIT_REQUIRED`）。子目录会话自动归并到 worktree 根（`git rev-parse --show-toplevel`），共享同一快照域；同一仓库的 linked worktree 各自成域。
3. **快照范围委托给源仓库 ignore 规则**：`.gitignore`、`.git/info/exclude`（每次 capture 重同步）、global excludes 与 `.gitattributes` 语义与源仓库一致；插件自身只额外排除 `.git` 元数据与 turnrewind 临时文件。**不再有自定义敏感文件名单**——未写进 ignore 的文件（含 `.env`、密钥类文件）会被快照；这是有意的取舍：`token.ts`、`credentials.module.ts` 等合法源码曾被旧规则静默排除，导致 undo 永远无法恢复它们。若不希望某些文件进入快照，请把它们加进源仓库的 ignore 规则。

被拒绝的 turn 仍正常执行，只是不提供 undo。同时该会话会收到一条一次性提示（`[Turn rewind unavailable]`），说明工作区被拒绝的原因；每个会话只提示一次，后续 turn 不再重复打扰。提示会以两种形态呈现：

1. **会话内消息**：插件来源的上下文注入消息，模型和用户都可见、可审计；
2. **Web UI 弹窗**：宿主端 `turnrewind` 会话投影（`src/host/service/dialog-projection.ts`）把提示折叠进会话列表快照，客户端半（`src/client/register/dialog.ts`）从 `sessions.list` 的 `projectionValues.turnrewind` 读到后弹出模态对话框，按提示 id 在 `localStorage` 去重——同一浏览器每条提示只弹一次，重装/换浏览器会重弹一次。

大工作区的取舍：不再做预算预扫描，快照耗时与磁盘占用随仓库规模增长（Git ignore 能排除 `node_modules` 等，但容量/性能风险仍由使用者自行承担）；单文件快照/恢复上限为 64 MB——超限文件仍会被捕获进快照，`/undo` 预览会以 `[too large]` 标注并在执行后单文件报告为「未恢复」，**不会**导致整次 undo 失败，其余文件照常恢复。若项目里有此类大文件且不希望被追踪，请把它们加进源仓库的 ignore 规则。

### 清理已膨胀的快照数据

如果某个工作区在旧版本下已经生成过巨大快照，先停止 DSH Host 进程，再执行：

```powershell
node packages\dsh-tauri-turnrewind-ts\dist\purge-workspace.js "C:\Users\<user>"          # release 数据目录 ~/.dsh
node packages\dsh-tauri-turnrewind-ts\dist\purge-workspace.js "C:\Users\<user>" --home "$env:USERPROFILE\.dsh.dev"  # debug
```

（需先 `pnpm --filter dsh-tauri-turnrewind build` 产出 `dist/`。）

该命令删除该工作区对应的私有快照仓库（`$DSH_HOME/snapshots/<hash>.git`）及其全部账本记录（turns / operations / notices / workspaces），其他工作区的数据不受影响。

## Undo 的工作区范围

Undo 的范围是：

```text
当前 session 绑定的 workspace（session header 的 cwd）
```

例如当前 session 的工作区是：

```text
C:\Users\<user>\Desktop\test
```

插件只会比较和恢复该目录以内、且被快照规则允许的文件。它不是“恢复整台电脑”，也不是“恢复所有 Agent 访问过的路径”。

一次 turn 的文件范围是：

```text
turn 开始时的 workspace 快照
        ↓
Agent 执行
        ↓
turn 结束时的 workspace 快照
        ↓
两次快照之间发生变化的文件
```

Undo 只恢复两次快照之间发生变化的文件：

- Agent 修改的文件：恢复到 turn 开始前；
- Agent 新建的文件：Undo 时删除；
- Agent 删除的文件：Undo 时恢复；
- 未发生变化的文件：不处理。

## Workspace 外的文件

如果 Agent 访问或修改了 workspace 外的文件，当前版本**不会捕获，也不会 Undo**。

例如当前 workspace 是：

```text
C:\Users\<user>\Desktop\test
```

Agent 修改了：

```text
C:\Users\<user>\Desktop\test\a.txt
C:\Users\<user>\Desktop\other\b.txt
```

执行 `/undo` 时：

```text
test\a.txt       → 可能被恢复
test 之外的 b.txt → 不会被处理
```

workspace 外的修改不会：

- 写入 turn 的 before/after snapshot；
- 出现在 `/undo --dry-run` 文件列表；
- 被 `/undo` 恢复；
- 出现在 rewind notice 的文件列表中。

在 `workspace-write` 权限模式下，宿主 sandbox 通常会阻止 Agent 写出 workspace；但如果使用 `danger-full-access` 或其他方式允许外部写入，**Agent 能写成功不代表 turnrewind 能回退这些文件**。

插件自己的恢复操作会拒绝以下路径：

```text
../outside.txt
C:\OtherProject\file.txt
workspace 内指向外部的符号链接路径
```

如果确实需要管理多个项目，应将它们作为独立 workspace 分别运行，不要把多个项目目录混成一个恢复域。

## 不同修改方式的捕获规则

当前插件按 workspace 在 turn 前后的实际差异捕获，不按工具名称判断来源。因此以下 Agent 修改方式通常都会被纳入当前 turn：

- Agent `write`；
- Agent `edit`；
- Agent 使用 Git Bash/bash；
- Agent 使用 PowerShell/pwsh；
- Agent 运行格式化工具；
- Agent 运行生成脚本；
- Agent 通过 Git 命令间接修改文件；
- Agent 执行其他会改写 workspace 文件的程序。

准确语义是：

```text
该 workspace 在本 turn 期间发生的允许范围内变化
```

不是：

```text
百分之百证明该变化由 AI 直接写入
```

如果用户或其他程序在 Agent turn 执行期间同时修改同一个 workspace，当前 MVP 可能无法区分来源，也可能把这些变化一起记录到该 turn。建议等待 Agent 完成或打断后，再手动编辑同一 workspace。

如果用户是在 turn 完成后修改文件，Undo 预检会将当前内容与 Agent turn 完成时的快照进行比较。内容不一致时会显示冲突，并默认拒绝覆盖。

## 冲突是什么意思

Undo 不是无条件覆盖。它会检查：

```text
当前文件状态 == Agent turn 完成时的文件状态？
```

如果相等，文件可以安全恢复到 turn 开始前。

如果不相等，就会显示类似：

```text
Undo preflight: turn <turn-id>; 5 file(s); 5 conflict(s): 4.txt, 5.txt, 6.txt, 7.json, 8.md.
```

含义是：

- 目标 turn 涉及 5 个文件；
- 当前文件与该 turn 完成时的快照不一致；
- 插件无法确认这些变化是否来自用户、其他 turn 或外部程序；
- 默认不会覆盖，文件保持当前状态。

Windows 的 `CRLF` 与 Unix 的 `LF` 换行差异会被文本状态比较规范化，不应单独造成冲突。二进制文件仍按原始字节比较。

冲突可用 `--skip-conflicts`（只恢复无冲突文件）或 `--force`（强制覆盖）处理；默认遇到冲突则拒绝并给出「人改了什么」的 diff。

## 多次 Undo 与模型提示

每次 Undo 都会产生一条独立的 pending rewind notice：

```text
Undo C → notice C
Undo B → notice B
Undo A → notice A
```

如果在发送下一条普通消息之前连续执行多次 Undo，下一次模型 step 会一次性收到全部 notice，顺序为：

```text
C、B、A
```

每条 notice 会列出：

- 被撤销的 turn；
- 该次 Undo 涉及的文件；
- “当前磁盘文件是权威状态”；
- “不要假设旧修改仍存在，请重新读取文件”。

notice 只消费一次。下一次模型 step 后不会重复注入。

## Git 与快照存储

### 快照边界与对象借用（Git 目录模式）

私有 snapshot repo 保存于 `$DSH_HOME/snapshots/<workspace-hash>.git`，与用户项目的 `.git` 完全隔离：capture 使用临时 `GIT_INDEX_FILE`（finally 中删除），snapshot refs 仅允许 `refs/turnrewind/` 前缀；不修改用户项目的 `HEAD`、branch、index、stash 或提交历史（有逐字节不变测试钉住）。初始化时通过 `objects/info/alternates` 借用源仓库对象以减少重复存储，并同步源仓库 `.git/info/exclude`；源仓库 `gc --prune=now` 删掉被借用对象时，下一次 capture 的连通性检查会检测到并降级为自包含存储（见「当前状态」中的 alternates 失效自愈）。

家目录防护与 Git worktree 要求互为兜底：会话 cwd 为家目录/盘根等系统目录时直接拒绝；不在 Git worktree 内的目录记为 `TURNREWIND_GIT_REQUIRED`，不做全目录预算扫描，也没有可配置的 `guard` 预算项（旧版本的 `config.guard` / `TURNREWIND_MAX_*` 已随本模式移除）。

快照存放在插件私有目录：

```text
$DSH_HOME/snapshots/<workspace-hash>.git
```

账本存放在：

```text
$DSH_HOME/ledger.sqlite
```

插件不会调用用户项目的：

```bash
git reset --hard
git checkout .
git clean -fd
```

也不会修改用户项目的：

```text
HEAD
当前分支
index
stash
commit history
```

## 快照范围与敏感文件（Git 目录模式）

> ⚠️ **插件不提供敏感文件保护。** 旧版本的自定义排除清单（`.env`、`*.pem`、`credentials.*`、`*token*` 等）已随 Git 目录模式**全部移除**。当前快照范围完全委托给源仓库的 ignore 规则：**未写进 `.gitignore` / `.git/info/exclude` / global excludes 的文件——包括 `.env`、密钥、证书——都会被捕获进私有快照**，并可被 `/undo` 恢复。

插件自身只额外排除（不属于项目内容的部分）：

```text
.git/                # Git 元数据
.turnrewind/         # 插件临时目录
**/*.turnrewind-*.tmp # 恢复过程中的临时文件
```

`node_modules/`、`dist/`、`build/` 等不再由插件排除——由你仓库自己的 `.gitignore` 决定（普通项目都会忽略它们，快照语义因此与源仓库一致）。

两点边界：

- 被源仓库 ignore 的文件不会进入快照，也不会被 undo 恢复；ignore 规则每次 capture 重新读取（`.git/info/exclude` 还会同步进私有 repo）；
- 曾经使用的 `*token*`、`*secret*` 等子串规则已移除——它们会静默排除 `token.ts`、`tokenizer.py` 这类正当源码，且被排除路径不出现在 dry-run 列表中，导致 undo 静默漏恢复。

**如果不希望秘密文件进入快照**：把它们加进源仓库的 ignore 规则（对 git 和本插件同时生效）。也可以在 `/undo --dry-run` 的文件清单里核对实际被追踪的范围。插件仍是实验原型，不应把它当作秘密信息保护工具。

### 已知缺陷：redo（暂缓）

`/undo --redo` 的执行段**尚未**接入 operation 记录与失败回滚：执行中任一文件恢复失败（超大文件、目标路径变为 symlink/目录、rename 失败）会留下「部分 redo」状态，无回滚、无 `needs-recovery` 标记，重启后围栏不会拦截该 workspace。该功能目前按计划冻结、后续启用时与 undo 路径对齐（`createOperation` → 失败回滚 → `needs-recovery`）后再开放；在此之前请勿在含 >64 MB 文件或路径状态复杂的 turn 上使用 redo。

## Debug 安装

TS 版插件位于 `packages/dsh-tauri-turnrewind-ts`，构建产物在 `dist/`。在当前 checkout 中执行：

```powershell
pnpm install
pnpm --filter dsh-tauri-turnrewind build
pnpm --filter dsh-tauri-turnrewind test
```

插件通过 `pnpm add` / `dsh plugin add` 安装（debug 桌面端启动时会自动以 `link:` 方式安装全部内部插件）。修改 Host 代码后需要重新 `pnpm --filter dsh-tauri-turnrewind build` 并重启 DSH debug Host 进程；修改 Client 代码后同理（client bundle 在 Host 启动时发现）。

## 测试

运行插件 lint 与测试：

```powershell
pnpm --filter dsh-tauri-turnrewind exec eslint src
pnpm --filter dsh-tauri-turnrewind typecheck
pnpm --filter dsh-tauri-turnrewind test
```

当前 17 个测试文件、82 个测试，覆盖：Git 快照（增删改恢复、中文路径、CRLF、路径逃逸、符号链接、ignore 委托、alternates 复用与自愈）、原子 bak-swap 恢复与崩溃清扫、Git 状态零污染（HEAD/branch/index/status/refs/stash 不变）、linked worktree 隔离、oversized blob 单文件报告、账本生命周期、pending plan 原子 claim、interrupted turn、barrier 时序、undo/redo 往返、client 纯函数（输出解析/plan 状态判定/会话归属）。

## 当前限制

这是实验性版本，正式启用前仍需要：

- 接入受控的宿主 sandbox/Tauri bridge；
- 完成真实 DSH lifecycle integration tests；
- 快照容量治理：按 turn 数/容量/保留期清理旧 snapshot ref（当前只做断链自愈，不清理历史）；
- 完善多 workspace 并发锁；
- 实现父对话递归 undo；
- 实现消息旁 Undo 按钮；
- 明确二进制、重命名、权限位和特殊文件策略；
- redo 执行段接入 operation 记录与失败回滚（见「已知缺陷：redo」）。
