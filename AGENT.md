# Agent 开发规范（Web Cursor）

本文是 agent 在本仓库开发时必须遵守的约定。

## 三个目录的职责

| 目录 | 含义 | 谁改 |
|---|---|---|
| `/Users/gaolei/Projects/deepseek_web_cursor` | 开发目录（git 仓库） | agent 在这里改代码 |
| `/Users/gaolei/deployment/web-cursor/deployment-<hash>` | 待上线版本（用 git 短 hash 命名） | 每次上线前生成，一般不改 |
| `/Users/gaolei/runtime/web-cursor` | 线上当前运行目录 | 只保留运行相关内容，**不要直接改** |

## 端口规范（重要）

- **线上（runtime）端口固定为 `4211`**，开发阶段必须避开，改用其它端口（例如 `4212`）。
- 切换开发端口需要**同时改两处**：
  1. `backend/.env` → `PORT=4212`
  2. `web/vite.config.ts` → 代理目标改成 `http://127.0.0.1:4212` 与 `ws://127.0.0.1:4212`
- 永远不要占用 `4211`，避免与线上冲突。

## 版本管理

- 改动后提交 git：`git add -A && git commit -m "描述"`。
- 每次「待上线」对应一个 deployment 版本，用 git 短 hash 命名（如 `deployment-d7198f15`）：
  - 在 dev 打 tag：`git tag deployment-$(git rev-parse --short=8 HEAD)`
  - 生成目录快照：`deployment/web-cursor/deployment-<hash>/`
- 上线 = 把某个 `deployment-<hash>` 部署到 `runtime/web-cursor` 并重启（必须遵守下方「部署动作约束」）。

## 部署动作约束（重要，基于事故教训）

部署**只允许**走下面的固定流程，禁止任何「手工复制/直接改文件」的做法：

1. **runtime 目录禁止直接改文件**：runtime 只能通过 git 同步到某个 `deployment-<hash>`：
   - 允许：`cd /Users/gaolei/runtime/web-cursor && git fetch origin && git reset --hard <hash>`
   - **禁止**：`cp` / `rsync` 复制源码、用编辑器或脚本直接写 runtime 里的文件。

2. **部署必须按顺序执行，每步校验，失败即停**：
   ```
   ① git fetch origin && git reset --hard <hash>
   ② npm run build              —— 必须构建成功
   ③ 重启进程                    —— 先 kill 旧进程，再启动新进程
   ④ curl http://127.0.0.1:4211/health   —— 必须返回 200
   ```
   任一步失败就立刻停下，不要继续，并向用户报告。

3. **重启进程必须确认「新进程存活」才算完成**：禁止只 kill 不启动，或启动失败却当作部署成功。

4. **禁止触碰 runtime 的 `backend/data/`（数据库）和 `backend/.env`（API key）**：部署只更新代码，不迁移、不覆盖数据与密钥。

5. **部署完成后必须自查**：`curl /health` 返回 200、打开首页能正常加载，才算上线完成。

## 安全

- **不要提交** `backend/.env`（含 API key）与 `backend/data/`（本地数据库），两者已在 `.gitignore` 中。
- `CURSOR_API_KEY` 是敏感信息：不要打印、不要写进日志、不要提交。

## 目录结构

- `backend/` —— Agent Gateway（Fastify + `@cursor/sdk` + `node:sqlite`）
- `web/` —— 前端（React + Vite）
- `workspace/` —— agent 默认工作沙盒

## 开发与上线流程

1. 在**开发目录**改代码、本地自测（避开 4211）。
2. `git add -A && git commit -m "..."` 提交。
3. 生成 deployment-<hash>（tag + 目录快照）。
4. 将 `deployment-<hash>` 部署到 `runtime/web-cursor` 并重启，完成上线。

