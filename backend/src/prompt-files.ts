import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **提示词模板是文件**（`backend/src/agent_policy/*.md`）：改措辞 = 改文件，不是在代码里找字符串。
 *
 * 与 autonomy 的 `src/agent_policy/` 同一条规矩（那边的 `loadPromptFile`），差别只在读法：
 * 这份 runtime 每次调用都**重新读盘**（模板几 KB，代价可以忽略），所以改完文件**下一次会话**就生效，
 * 不用重启；也没有 embed 兜底 —— 模板是启动/生成提示词时的**必需资产**，读不到就**大声失败**
 * （见 `loadPromptFile` 的报错），而不是悄悄退化成一份藏在代码里的旧文案。
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 提示词文件的**基点**：这个模块自己的目录。
 *
 * 于是同一份代码在两种布局下都对：`backend/src`（tsx 直跑）与 `backend/dist`（构建产物、
 * 部署里只有它）—— `agent_policy/` 跟着模块走（构建时由 `scripts/copy-agent-policy.mjs` 拷过去）。
 * `PROMPT_FILES_ROOT` 可以把基点指到别处（测试 / 别的打包布局）。
 */
function promptFilesRoot(): string {
  const override = process.env.PROMPT_FILES_ROOT?.trim();
  if (override) return path.resolve(override);
  return here;
}

/**
 * 读一份提示词模板（**相对本模块目录**，如 `agent_policy/PROTOCOL.md`）。
 *
 * 尾部换行裁掉：文件以换行结尾是编辑器的习惯，渲染结果不该由最后一个字节决定
 * （同 autonomy 的 `applyPromptTemplate`）。读不到就抛 —— 报错里给出绝对路径，
 * 让人知道该建哪个文件，而不是拿到一份空模板。
 */
export function loadPromptFile(rel: string): string {
  const file = path.join(promptFilesRoot(), rel);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `prompt template file is missing: ${file} (${(err as Error).message}) — ` +
        "提示词模板是文件，必须与代码同包（构建会拷 src/agent_policy → dist/agent_policy，见 docs/prompts.md）",
    );
  }
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) {
    throw new Error(`prompt template file is empty: ${file}`);
  }
  return trimmed;
}
