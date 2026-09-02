# BRANCHING.md — Trunk-Based Development（Agent 强制）

面向 agent 的主干开发分支规范。目标：短生命周期分支、独立工作区、尽快把变更推到远程 task 分支。

**Agent 默认交付止于 `git push`。** 除非用户另行指令，否则不要 merge / 开 PR 合入 `main`，也不要执行 `./scripts/deploy.sh`。合回主干与上线由后续人工或其它流程处理。

## 目录与仓库角色

| 路径 | 角色 | Agent 可否改 |
|---|---|---|
| `/Users/gaolei/agent-workspace/<taskId>/` | 本 task 的独立工作区（clone 后在此开发） | 是（唯一开发目录） |
| `/Users/gaolei/Projects/deepseek_web_cursor` | Canonical / 主干源仓库（`main`） | 否（不要直接改；只作 clone / push 目标） |
| `/Users/gaolei/runtime/web-cursor` | 线上运行目录 | 禁止改 |
| `/Users/gaolei/deployment/web-cursor/...` | 部署快照 | 禁止手改 |

## 标准流程（每 task）

### 1. 进入自己的开发目录

```bash
cd /Users/gaolei/agent-workspace/<taskId>
```

### 2. Clone 形成独立 workspace

若目录为空（尚无 `.git`）：

```bash
git clone /Users/gaolei/Projects/deepseek_web_cursor .
```

已有 clone 则跳过，执行 `git fetch origin`。

### 3. 基于最新主干建开发分支

分支名必须带 task id：

- 功能：`feature/<taskId>`（例：`feature/task-16d4d1b5`）
- 缺陷：`fix/<taskId>` 或 `issue/<taskId>`

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feature/<taskId>
```

禁止：直接在 `main` 上开发或提交。

### 4. 只在本分支开发

所有改动仅发生在当前 task 分支与本 workspace。  
禁止改其他 task 的 `agent-workspace`，禁止改 canonical / runtime。

### 5. 改完后 commit

小步、可审阅的提交；信息说清「为什么」。

```bash
git add -A
git status
git commit -m "$(cat <<'EOF'
简要说明本次改动的原因与效果。

EOF
)"
```

不要提交密钥、`.env`、`backend/data/` 等敏感或运行时数据。

### 6. Push 远程分支（agent 默认终点）

```bash
git push -u origin HEAD
```

Push 的是 **task 分支**，不是 `main`。到此即完成本规范要求的交付，除非用户明确要求继续合主干或部署。

## 硬性约束

1. **一 task 一分支一 workspace**：分支名含 task id，可追溯。
2. **主干干净**：`main` 只接受已审合并；agent 不直推 `main`。
3. **分支短命**：做完即 commit + push，避免长期分叉。
4. **开发前同步**：开分支或长时间开发前 `git fetch`，并基于最新 `main`。
5. **冲突在本分支解决**：需要时把 `main` rebase/merge 进自己的分支后再 push，不把冲突留给主干。
6. **部署与开发分离**：开发在 workspace；上线只走 canonical 上的 `deploy.sh`（且非本规范默认步骤）。

## 反例（禁止）

- 多个 task 共用同一个工作目录改同一份 checkout
- 在 `/Users/gaolei/Projects/deepseek_web_cursor` 上直接改并 commit
- 分支名不含 task id（如 `tmp`、`dev`、`my-fix`）
- `git push origin main` 或 force push 到 `main`
- 直接改 `/Users/gaolei/runtime/**`

## 交付检查清单（止于 push）

- [ ] 工作区在 `/Users/gaolei/agent-workspace/<taskId>/`
- [ ] 当前分支为 `feature|fix|issue/<taskId>`
- [ ] 变更已 commit
- [ ] 已 `git push -u origin HEAD`
- [ ] 未直推 / 未 force push `main`
- [ ] 未擅自 merge 进 `main`、未擅自 `deploy.sh`（除非用户另行要求）
