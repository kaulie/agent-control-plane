/**
 * 构建时把提示词文件拷进产物目录：`backend/src/agent_policy/**` → `backend/dist/agent_policy/**`。
 *
 * 为什么必须拷：**部署里只有 `dist/`**（`~/runtime/web-cursor/backend/` 下是 dist / data / package.json…，
 * 没有 src）。而提示词是**文件**（`src/agent_policy/*.md`），`prompt-files.ts` 又按「模块自己所在目录」
 * 去找它们 —— 所以产物目录里必须有同一份，否则部署上第一条 prompt 就构建不出来。
 *
 * 顺带一个好处：部署上可以直接改 `dist/agent_policy/PROTOCOL.md`（改完下一次会话生效），
 * 不必重新打包 —— 和 autonomy 那边「措辞是文件、部署上可改」同一条规矩。
 *
 *   node scripts/copy-agent-policy.mjs        # 由 `npm run build` 调用
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, "..");
const from = path.join(backendDir, "src", "agent_policy");
const to = path.join(backendDir, "dist", "agent_policy");

if (!fs.existsSync(from)) {
  console.error(`[copy-agent-policy] 提示词目录不存在：${from}`);
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
const files = fs.readdirSync(to).sort();
console.log(`[copy-agent-policy] ${from} → ${to}（${files.length} 个文件：${files.join(", ")}）`);
