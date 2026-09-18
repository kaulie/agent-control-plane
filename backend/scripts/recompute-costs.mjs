/**
 * 按 `billing_rules` 表重算历史 run 的 `cost_json`。
 *
 * 口径（与线上写入口完全一致，两边都走 `billing/buildBilledCost`）：
 *   实际成本 = 计费表 > provider/SDK 上报 > 旧估算。
 * - 命中规则（cline / DeepSeek）：按表算，本币金额 + 明细进 `billing`；
 * - 没规则（cursor 等）：实际成本 = 上报值（两个口径同值），DB 里的旧估算被归一掉；
 * - 连上报值都没有：保留旧估算（`costSource: "estimate"`）。
 *
 * 安全策略：
 * - `--data-dir` **必填**（故意不给默认值：先 `sqlite3 .backup` 备份/复制，别直接改运行库）；
 * - 默认 **dry-run**，只打印对照，不写库；
 * - 只写「值真的变了」的行（含 `costSource` / `billing` 明细变化）。
 *
 * Usage:
 *   npx tsx backend/scripts/recompute-costs.mjs --data-dir=/tmp/wc-copy
 *   npx tsx backend/scripts/recompute-costs.mjs --data-dir=/tmp/wc-copy --apply
 */
import fs from "node:fs";
import { Store } from "../src/store/db.ts";
import { createBillingService, resolveBilledCost } from "../src/billing/index.ts";

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

function costChanged(next, prev) {
  if (!prev) return true;
  return (
    next.estimatedCents !== prev.estimatedCents ||
    next.chargedCents !== prev.chargedCents ||
    next.rawCostCents !== prev.rawCostCents ||
    next.costSource !== prev.costSource ||
    JSON.stringify(next.billing ?? null) !== JSON.stringify(prev.billing ?? null)
  );
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const perRule = new Map();
const totals = {
  runs: 0,
  withUsage: 0,
  written: 0,
  unchanged: 0,
  noCost: 0,
  bySource: { rule: 0, reported: 0, estimate: 0 },
  native: 0,
  nativeCurrency: undefined,
  ruleUsdCents: 0,
  reportedUsdCents: 0,
  estimateUsdCents: 0,
  newUsdCents: 0,
  oldUsdCents: 0,
  sdkUsdCents: 0,
  byPeriod: { peak: 0, offpeak: 0 },
  byBusiness: { busy: 0, idle: 0 },
  currencies: new Set(),
};

for (const task of store.listTasks()) {
  for (const run of store.listRuns(task.taskId)) {
    totals.runs += 1;
    if (!run.usage) continue;
    totals.withUsage += 1;
    // `runs.model` 可能是 NULL（自动选模型的 run 没落这一列），这时用 cost_json 里记的模型，
    // 否则这些 run 会被判成「无规则命中」。
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

    if (run.cost?.estimatedCents != null) totals.oldUsdCents += run.cost.estimatedCents;
    if (run.cost?.chargedCents != null) totals.sdkUsdCents += run.cost.chargedCents;

    const resolved = resolveBilledCost(next);
    if (!next || !resolved) {
      totals.noCost += 1;
      continue;
    }
    totals.bySource[resolved.source] += 1;
    totals.newUsdCents += resolved.cents;
    if (resolved.source === "rule") totals.ruleUsdCents += resolved.cents;
    if (resolved.source === "reported") totals.reportedUsdCents += resolved.cents;
    if (resolved.source === "estimate") totals.estimateUsdCents += resolved.cents;

    if (next.billing) {
      totals.native += next.billing.amount;
      totals.nativeCurrency = next.billing.currency;
      totals.currencies.add(next.billing.currency);
      totals.byPeriod[next.billing.period] += next.billing.amount;
      totals.byBusiness[isBusinessBusy(new Date(run.createdAt)) ? "busy" : "idle"] +=
        next.billing.amount;
      const key = `${run.provider}/${model ?? "（自动）"}`;
      const row = perRule.get(key) ?? { runs: 0, native: 0, currency: "", usdCents: 0, sdkCents: 0 };
      row.runs += 1;
      row.native += next.billing.amount;
      row.currency = next.billing.currency;
      row.usdCents += next.billing.usdCents;
      row.sdkCents += run.cost?.chargedCents ?? 0;
      perRule.set(key, row);
    }

    if (apply && costChanged(next, run.cost)) {
      store.updateRun(run.runId, { status: run.status, cost: next });
      totals.written += 1;
    } else if (apply) {
      totals.unchanged += 1;
    }
  }
}

const cur = totals.nativeCurrency ?? "-";
console.log(
  `\nruns：${totals.runs} 个（有 usage ${totals.withUsage}；算不出成本的 ${totals.noCost}）`,
);
console.log(
  `cost 来源：计费表 ${totals.bySource.rule} 轮 · SDK 上报 ${totals.bySource.reported} 轮 · 旧估算 ${totals.bySource.estimate} 轮`,
);
if (perRule.size) {
  console.log(`\n按 provider/model（命中计费表的 run）：`);
  for (const [key, row] of [...perRule.entries()].sort((a, b) => b[1].usdCents - a[1].usdCents)) {
    console.log(
      `  ${key.padEnd(38)} ${String(row.runs).padStart(4)} runs  ${row.currency} ${round(row.native).toFixed(2).padStart(9)}` +
        `  ≈ $${(row.usdCents / 100).toFixed(2).padStart(7)}   [SDK 上报 $${(row.sdkCents / 100).toFixed(2)}]`,
    );
  }
}
console.log(
  `\n合计：${cur} ${round(totals.native).toFixed(2)}（计费表 ≈ $${(totals.ruleUsdCents / 100).toFixed(2)}）` +
    ` + SDK 上报 ≈ $${(totals.reportedUsdCents / 100).toFixed(2)}` +
    ` + 旧估算 ≈ $${(totals.estimateUsdCents / 100).toFixed(2)} = 实际成本 ≈ $${(totals.newUsdCents / 100).toFixed(2)}`,
);
console.log(
  `时段：高峰 ${cur} ${round(totals.byPeriod.peak).toFixed(2)} / 空闲 ${round(totals.byPeriod.offpeak).toFixed(2)}`,
);
console.log(
  `业务忙闲（工作日 9–12 / 14–18 本地时间，仅对账用）：忙 ${round(totals.byBusiness.busy).toFixed(2)} / 闲 ${round(totals.byBusiness.idle).toFixed(2)}`,
);
console.log(
  `\n对比：库内旧 estimatedCents 合计 $${(totals.oldUsdCents / 100).toFixed(2)}（两代旧公式混算）` +
    ` · SDK 上报合计 $${(totals.sdkUsdCents / 100).toFixed(2)}`,
);
console.log(
  apply
    ? `\n已写入 ${totals.written} 个 run（值没变、跳过的 ${totals.unchanged} 个）。`
    : `\n（dry-run：没有写库；加 --apply 才落库）`,
);

store.close();
