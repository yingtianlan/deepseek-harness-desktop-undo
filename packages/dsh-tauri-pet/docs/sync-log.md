# dsh-tauri-pet 同步日志

用于记录 `source/dsh-pet`、`source/dsh-dafeiyu` 能力同步到 `packages/dsh-tauri-pet` 的进度，避免后续重复对比或遗漏实现。

## 同步基线

- 参考项目：[`PC2005-cloud/dsh-pet`](https://github.com/PC2005-cloud/dsh-pet)（工作状态 6 档 + 预设资产）
- 本次对比版本：`v0.2.6`
- 本次对比提交：`e1ff8c1`
- 气泡文案参考：[`dsh-dafeiyu`](https://github.com/dsh-tauri-desk/dsh-dafeiyu) `v0.1.9`（`f4f4482`，仅参考不下载资产）
- 预设清单 ref：`src-tauri/resources/preset-pets.json` 的 `ref` = `e1ff8c1e4001878cbb80441262d530e16541f138`
  （新工作状态 WebM 在 dsh-pet `903dfde` 才入库，ref 必须 ≥ 该提交）
- 记录更新时间：2026-09-07

## 已同步

### P0（预设资产与工作状态 6 档）

- [x] 预设 ref 升级 `f0f772e` → `e1ff8c1`，下载到 6 个新工作状态 WebM（思考冒泡/忙碌点按/清点归档/原地踱步张望/雀跃庆祝/垂头叹气冒汗）。
- [x] host reducer 细分档位：`PetWorkStatus = thinking | working | result | waiting | success | error`，事件映射
  （turn/start→thinking；tool/call→working（`ask_user_question` 例外→waiting）；tool/result→result/working；
  approval→waiting；turn/end：completed→success、error/max-tokens/timeout→error、blocked→waiting、其余→清回空闲）。
- [x] 工具级错误不再写 `lastAgentError`，不污染回合级终态；`turn/start` 清上一回合 `lastAgentError`。
- [x] 动画档位接线：`PRESET_SESSION_ANIMATIONS` 指向 6 个新动画名，`isLoopingAnimation` /
  `spriteStatusFallback`（thinking→waiting、working→running、result→review、success→waving、error→failed）。

### P1（气泡对齐 dsh-dafeiyu）

- [x] 新增 `src/pet/hooks/bubble-copy.ts`：`seedNumber` / `statusCopy` / `activityCopy` / `taskCopy` /
  `toolActivityGroup`，**句式精确对齐 dsh-dafeiyu**（`正在${value}呢`，无空格）。
- [x] `use-bubble.ts` `STATUS_PRIORITY` 对齐 dsh-dafeiyu 档位：
  waiting=60 > error=50 > failed=45 > review=40 > working=30 > result=25 > thinking=20 > running=12 > success=10 > idle 族=0。
- [x] `sessionStatus` 优先 `workStatus`；修复 bug：`session.running === true` 时 lastAgentError/粗 error 不判 failed
  （会话还在跑时 toast 不消失）。
- [x] `app.tsx` loop 判定改 `isLoopingAnimation`；成功/失败终态动画播一次后回收。

### P2（宠物更新）

- [x] Rust：`.preset-ref` 记录已安装版本；`preset_update_available` 判定更新可用；`install_staging(replace)` 两步
  rename + 备份回滚；`update_preset_pet` 命令：快照 `get_pet_status` → 在用则 `set_pet_enabled(false)` 强制停用 →
  `run_preset_download(replace=true)` → 成功 `reload_pet_window` → `was_enabled` 时 `set_pet_enabled(true)` 重新启用。
- [x] 前端：设置页「已选」按钮左侧「更新」按钮（`dshp-pet__card-actionUpdate`），复用 `pollPresetDownload`
  下载/解压进度条；`resolvePresetCardUpdate` 控制显隐；i18n `update` / `updateFailed`。
- [x] 宿主壳 `use-iframe-invoke.ts` `ALLOWED_INVOKE_CMDS` 增 `update_preset_pet`。
- [x] Rust `validate_preset_pet_config` 对未知字段自动放行，无需改动。

## 明确未同步（含原因）

- dsh-pet `workStatusTick` 1s 轮询 `/dsh-pet-7340/work-status`（`ea0ca7e`）：不需要——本仓库已有事件驱动 host reducer。
- dsh-pet 其余提交（`33ca8f2` renderer 拆分、`12d9f44` 气泡样式、`26d8017` 透明窗黑框、`e1ff8c1` maxTokens、
  `a8c2cd0` reasoning-off）：属其 Electron helper 或 host LLM 侧，与本仓库无关。
- dsh-dafeiyu TASK 消息（todo/write → `taskCopy(task)` + 已完成 a/b 步）与 multi-session `#select()`：本仓库会话
  气泡是一对一定位（各自 toast），未采纳其多会话顶选渲染方案；`taskCopy` 句式已吸收。
- 预设下载/更新安装目录内的其他备份清理：`update_preset_pet` 成功路径已清理备份，失败路径保留备份以便回滚判断。

## 验证记录

最近一次本地验证（PR #414 + #415 合并后全量）：

```text
cargo test --lib                        # 493 passed
pnpm test -- --run                      # 109 passed (17 files)
pnpm --filter dsh-tauri-pet typecheck
pnpm typecheck
pnpm --filter dsh-tauri-pet build
pnpm exec eslint src/pet packages/dsh-tauri-pet/src/client packages/dsh-tauri-pet/src/host --max-warnings=0
git diff --check
```

PR #414、#415 的 GitHub CI 均已通过。

## 后续同步流程

1. 获取参考仓库最新版本与提交：`git -C source/dsh-pet fetch origin && git -C source/dsh-pet log --oneline e1ff8c1..origin/main`（dsh-dafeiyu 同理）。
2. 若 dsh-pet 有新版本：评估影响面（`src/shared/work-status.ts`、`src/host/work-status.ts`、client 轮询、资产入库 commit），
   确认新 WebM/config 字段后升级 `preset-pets.json` 的 ref。
3. 先更新本文件「同步基线」和「待同步」，再修改 host/client 实现。
4. 同步协议时同时检查：
   - `src-tauri/resources/preset-pets.json`
   - `src-tauri/src/bridge/preset_pet.rs`
   - `packages/dsh-tauri-pet/src/host/reducer.ts`
   - `packages/dsh-tauri-pet/src/client/{types,constants,service,components}/**`
   - `src/pet/{pet-config.ts,hooks/use-bubble.ts,hooks/bubble-copy.ts}`
5. 完成后运行 lint、typecheck、test、build、cargo check/test，并回填「验证记录」。
6. 将已完成项从「待同步」移到「已同步」，保留未实施项及原因。

## 待同步项

当前没有已确认、且适用于桌面端的需求在案。下一次参考仓库更新时，从新的 changelog 重新评估；用户如提出新的宠物交互需求，先在此登记再实施。