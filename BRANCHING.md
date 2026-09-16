# BRANCHING.md — Trunk-Based Development（Agent 强制）

面向 agent 的主干开发分支规范。目标：短生命周期分支、独立工作区、尽快把变更推到 **GitHub** 并以 PR 交付。

**Agent 默认交付：** `commit` → `git push` → `gh pr create` → 把 PR URL 回写任务。  
除非用户另行指令，否则 **不要 merge 进 `main`**，也不要执行发版 / 上线脚本。

## 目录与仓库角色

| 路径 / 配置 | 角色 | Agent 可否改 |
|---|---|---|
| `/Users/gaolei/agent-workspace/<taskId>/` | 本 task 的独立工作区（clone 后在此开发） | 是（唯一**开发**目录） |
| 项目 `gitRepoUrl`（GitHub） | **origin**：clone / push / 开 PR 的远程；也是发版的唯一源 | 否（只读配置；用它作 remote） |
| [`kaulie/agent-control-plane-deployment`](https://github.com/kaulie/agent-control-plane-deployment) | **独立部署服务**源码（HTTP + SQLite 契约） | 仅在用户要求改部署系统时（在该仓库改） |
| `~/runtime/agent-control-plane-deployment` | 部署服务安装目录（API `:4220`、packages、sqlite） | 否（install 产物） |
| `~/runtime/web-cursor` | 被部署的应用 runtime（由服务契约描述） | 禁止手改；由部署平台上线 |
| `/Users/gaolei/runtime/web-cursor` | 固定线上运行目录（只收 deploy rsync + 启停） | 禁止改 |
| `/Users/gaolei/Projects/deepseek_web_cursor` | 可选本机 clone（**不是**部署源） | 否 |

若 bootstrap / 项目设置里给出了 `gitRepoUrl`，**必须**用该地址作为 `origin`，不要擅自改用本地 path remote。

**开发 vs 上线：** task workspace 只做开发；构建 / 上线**只由部署平台**完成（`~/runtime/agent-control-plane-deployment`），app 仓库内**没有**任何发版 / 部署入口。

## 标准流程（每 task）

### 1. 进入自己的开发目录

```bash
cd /Users/gaolei/agent-workspace/<taskId>
```

### 2. Clone 形成独立 workspace

若目录为空（尚无 `.git`），用项目配置的 GitHub 地址：

```bash
git clone <gitRepoUrl> .
```

已有 clone 则跳过，执行 `git fetch origin`，并确认 `origin` 指向该 `gitRepoUrl`。

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
禁止改其他 task 的 `agent-workspace`，禁止改 `deployment-<hash>/` 快照 / runtime。

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

### 6. Push 远程分支

```bash
git push -u origin HEAD
```

Push 的是 **task 分支**，不是 `main`。

### 7. 在 GitHub 开 PR（agent 默认终点）

```bash
gh pr create --base main --head "$(git branch --show-current)" --title "<简要标题>" --body "$(cat <<'EOF'
## Summary
- ...

## Test plan
- [ ] ...

EOF
)"
```

也可调用网关 `POST /api/tasks/<taskId>/pull-request`（在 task workspace 内执行同等 `gh` 逻辑）。

然后把 PR URL 回写任务（`PATCH` `prUrl`，或依赖上述 API 自动落库）。  
若任务已有 `prUrl`，不要重复开 PR。

**不要** `gh pr merge`，除非用户明确要求。

## 合入后上线（非 agent 默认步骤，且不在本仓库）

1. 在 GitHub 上把 PR merge 进 `main`
2. 在**部署平台**触发（platform UI 的「流水线」，或 API）：

```bash
# 打包 + 部署（平台从 GitHub ref 取代码自行 build）
curl -sS -X POST http://127.0.0.1:4220/api/deploy-notify \
  -H 'content-type: application/json' \
  -d '{"serviceId":"web-cursor","ref":"main"}'

# 或部署平台已构建好的包
curl -sS -X POST http://127.0.0.1:4220/api/deploys \
  -H 'content-type: application/json' \
  -d '{"serviceId":"web-cursor","deployment":"deployment-<hash>"}'
```

- app 仓库**没有**部署入口：`GET/POST /api/ops/deploy*` 已移除，`scripts/deploy.sh` 已删除。
- 平台按服务契约 rsync 到 runtime 并重启；app 只提供 graceful 契约（`POST /api/ops/restart-notify` + `GET /api/ops/restart-status`）供平台轮询。
- **禁止**在 `agent-workspace/**` 触发部署，**禁止**手工 cp/rsync/改 runtime 文件。

## 硬性约束

1. **一 task 一分支一 workspace**：分支名含 task id，可追溯。
2. **主干干净**：`main` 只接受已审合并（经 GitHub PR）；agent 不直推 `main`。
3. **分支短命**：做完即 commit + push + 开 PR。
4. **开发前同步**：开分支或长时间开发前 `git fetch`，并基于最新 `main`。
5. **冲突在本分支解决**：需要时把 `main` rebase/merge 进自己的分支后再 push。
6. **部署与开发分离**：开发在 workspace；上线 = 部署平台打包 + 部署（app 仓库无部署入口）。

## 反例（禁止）

- 多个 task 共用同一个工作目录改同一份 checkout
- 在 `/Users/gaolei/Projects/deepseek_web_cursor` 上直接改并 commit（应在 task workspace + GitHub PR）
- 分支名不含 task id（如 `tmp`、`dev`、`my-fix`）
- `git push origin main` 或 force push 到 `main`
- 直接改 `/Users/gaolei/runtime/**`，或对 runtime 手工 cp/rsync
- 覆盖 runtime 的 `backend/.env` / `backend/data/`
- 未配置 / 无视项目 `gitRepoUrl`，擅自换远程
- 在 task workspace 里触发部署，或依赖 workspace 的 git 状态换版
- 在 app 仓库里新增任何「发起部署」的接口 / 脚本（统一走部署平台）
- 手改 `deployment-<hash>/` 快照

## 交付检查清单（止于开 PR）

- [ ] 工作区在 `/Users/gaolei/agent-workspace/<taskId>/`
- [ ] `origin` 为项目 GitHub `gitRepoUrl`
- [ ] 当前分支为 `feature|fix|issue/<taskId>`
- [ ] 变更已 commit
- [ ] 已 `git push -u origin HEAD`
- [ ] 已 `gh pr create`（或网关开 PR），任务已有 `prUrl`
- [ ] 未直推 / 未 force push `main`
- [ ] 未擅自 merge、未擅自触发部署（除非用户另行要求）
