/**
 * 按 `billing_rules` 表重算历史 run 的 `cost_json`。
 *
 * 为什么要重算：改造前 `cost_json.estimatedCents` 是两代本地公式混出来的（老的一代
 * 把缓存读按全额输入价又算了一遍），而 `chargedCents` 是 SDK 自己价卡的上报值 ——
 * 两者都不是 DeepSeek 账单口径。计费模块上线后，用同一张表把历史 run 重算一遍，
 * 页面上的钱才和规则表一致。
 *
 * 安全策略：
 * - `--data-dir` **必填**（故意不给默认值，避免顺手改到运行库；先 `sqlite3 .backup` 备份/复制）；
 * - 默认 **dry-run**，只打印对照，不写库；
 * - 只有命中规则的 run 才会被改写（没命中的原样保留，不动）。
 *
 * Usage:
 *   npx tsx backend/scripts/recompute-costs.mjs --data-dir=/tmp/wc-copy
 *   npx tsx backend/scripts/recompute-costs.mjs --data-dir=/tmp/wc-copy --apply
 */
import fs from "node:fs";
import { Store } from "../src/store/db.ts";
import { createBillingService } from "../src/billing/index.ts";

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

const dataDir = argValue("--data-dir");
const apply = process.argv.includes("--apply");
if (!dataDir) {
  console.error(
    "用法：npx tsx backend/scripts/recompute-costs.mjs --data-dir=<数据目录> [--apply]\n" +
      "先把库复制/备份出来（sqlite3 <db> \".backup /tmp/wc-copy/web_cursor.db\"），再指向副本。",
  );
  process.exit(1);
}
if (!fs.existsSync(dataDir)) {
  console.error(`数据目录不存在：${dataDir}`);
  process.exit(1);
}

const store = new Store(dataDir);
const billing = createBillingService(store);
const rules = billing.listRules();
console.log(`数据目录：${dataDir}`);
console.log(`计费规则：${rules.length} 条（${rules.map((r) => r.ruleId).join(", ")}）`);
console.log(apply ? "模式：APPLY（会写库）" : "模式：dry-run（只打印）");

/** 业务忙闲（工作日 9–12 / 14–18，本地时区）—— 只为对账，不参与计费。 */
function isBusinessBusy(date) {
  const day = date.getDay();
  const hour = date.getHours();
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const summary = new Map();
const totals = {
  runs: 0,
  withUsage: 0,
  matched: 0,
  fallback: 0,
  written: 0,
  oldUsdCents: 0,
  matchedUsdCents: 0,
  fallbackUsdCents: 0,
  native: 0,
  nativeCurrency: undefined,
  sdkUsdCents: 0,
  byPeriod: { peak: 0, offpeak: 0 },
  byBusiness: { busy: 0, idle: 0 },
};

for (const task of store.listTasks()) {
  for (const run of store.listRuns(task.taskId)) {
    totals.runs += 1;
    if (!run.usage) continue;
    totals.withUsage += 1;
    // `runs.model` 可能是 NULL（自动选模型的 run 没落这一列），这时用 cost_json 里记的模型，
    // 否则 84 个 vision run 会被判成「无规则命中」。
    const model = run.model ?? run.cost?.model;
    const next = billing.costFor({
      provider: run.provider,
      model,
      usage: run.usage,
      at: run.createdAt,
      reported: {
        ...(run.cost?.chargedCents != null ? { chargedCents: run.cost.chargedCents } : {}),
        ...(run.cost?.rawCostCents != null ? { rawCostCents: run.cost.rawCostCents } : {}),
      },
      ...(run.cost?.estimatedCents != null
        ? { fallbackEstimatedCents: run.cost.estimatedCents }
        : {}),
    });

    const key = `${run.provider}/${model ?? "（自动）"}`;
    const row = summary.get(key) ?? { runs: 0, usdCents: 0, native: 0, currency: "", sdkCents: 0 };

    if (run.cost?.estimatedCents != null) totals.oldUsdCents += run.cost.estimatedCents;
    if (run.cost?.chargedCents != null) totals.sdkUsdCents += run.cost.chargedCents;

    if (!next?.billing) {
      // 没有规则命中（多为 cursor：另一套价目表，还没入库）→ 原样保留旧估算。
      totals.fallback += 1;
      if (next?.estimatedCents != null) totals.fallbackUsdCents += next.estimatedCents;
      continue;
    }

    totals.matched += 1;
    totals.matchedUsdCents += next.billing.usdCents;
    totals.native += next.billing.amount;
    totals.nativeCurrency = next.billing.currency;
    totals.byPeriod[next.billing.period] += next.billing.amount;
    totals.byBusiness[isBusinessBusy(new Date(run.createdAt)) ? "busy" : "idle"] += next.billing.amount;
    row.runs += 1;
    row.usdCents += next.billing.usdCents;
    row.native += next.billing.amount;
    row.currency = next.billing.currency;
    row.sdkCents += run.cost?.chargedCents ?? 0;
    summary.set(key, row);

    if (apply) {
      store.updateRun(run.runId, { status: run.status, cost: next });
      totals.written += 1;
    }
  }
}

console.log(
  `\nruns：${totals.runs} 个（有 usage ${totals.withUsage}；命中规则 ${totals.matched}；未命中保留原值 ${totals.fallback}）`,
);
console.log(`\n按 provider/model（命中规则的 run）：`);
for (const [key, row] of [...summary.entries()].sort((a, b) => b[1].usdCents - a[1].usdCents)) {
  console.log(
    `  ${key.padEnd(38)} ${String(row.runs).padStart(4)} runs  ${row.currency} ${round(row.native).toFixed(2).padStart(9)}` +
      `  ≈ $${(row.usdCents / 100).toFixed(2).padStart(7)}   [SDK 上报 $${(row.sdkCents / 100).toFixed(2)}]`,
  );
}
console.log(
  `\n合计（计费表口径，命中规则的 ${totals.matched} 个 run）：` +
    `${totals.nativeCurrency ?? "-"} ${round(totals.native).toFixed(2)}  ≈ $${(totals.matchedUsdCents / 100).toFixed(2)}`,
);
console.log(
  `未命中规则、原样保留旧估算的 ${totals.fallback} 个 run：≈ $${(totals.fallbackUsdCents / 100).toFixed(2)}（多为 cursor，价目表还没入库）`,
);
console.log(`时段：高峰 ${totals.nativeCurrency ?? "-"} ${round(totals.byPeriod.peak).toFixed(2)} / 空闲 ${round(totals.byPeriod.offpeak).toFixed(2)}`);
console.log(
  `业务忙闲（工作日 9–12 / 14–18 本地时间，仅对账用）：忙 ${round(totals.byBusiness.busy).toFixed(2)} / 闲 ${round(totals.byBusiness.idle).toFixed(2)}`,
);
console.log(
  `\n对比：库内旧 estimatedCents 合计 $${(totals.oldUsdCents / 100).toFixed(2)}（两代旧公式混算）` +
    ` · SDK 上报合计 $${(totals.sdkUsdCents / 100).toFixed(2)}（另一套价卡）` +
    ` · 新口径 $${(totals.matchedUsdCents / 100).toFixed(2)}（命中规则）`,
);
console.log(apply ? `\n已写入 ${totals.written} 个 run 的 cost_json。` : `\n（dry-run：没有写库；加 --apply 才落库）`);

store.close();
