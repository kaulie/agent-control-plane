# 计费模块（billing）

**钱只按一张表算**：SQLite 表 `billing_rules`（模型价目 + 峰谷时段规则）。
provider 适配器不再自带价目表，只把「用量 + 模型 + 时间」交给这里。

## 为什么单独成为模块

一次真实对账（cline / DeepSeek，2026-09）：

| 口径 | 全库合计 | 说明 |
| --- | --- | --- |
| SDK 自己上报的 `totalCost` | ≈ $15 | 用的是 Cline 自带的价卡，**不是** DeepSeek 官方价目 |
| 改造前的本地估算 | ≈ $989 | 两代公式混算（老一代把缓存读按全额输入价又算了一遍） |
| **DeepSeek 官方价目表** | **≈ ¥297（≈$42）** | 就是文档里那张「缓存命中 / 未命中 / 输出 × 高峰 / 空闲」表 |

三个数差一个数量级，说明「钱」不能散落在 provider 里各算一套。于是：

- 规则进表（`billing_rules`），改价不用改代码、不用重启（每次调用现读表）；
- 算法进模块（本目录），provider 只负责把 SDK 的上报值原样交进来（对比口径）；
- 页面/接口分开显示两个口径，**不要相加**（见 `web/src/usage-cost.ts`）。

## 表结构（`billing_rules`）

| 列 | 含义 |
| --- | --- |
| `rule_id` | 主键，例如 `deepseek-v4-flash` |
| `provider` / `model` | 匹配范围：`cline` \| `cursor` \| `*`，模型可写精确 id、包含片段或 `*` |
| `currency` / `usd_per_unit` | 本币（`CNY`）与折算率（`1/7.1`）。**账单口径是本币**，`usd_per_unit` 只用于折算成项目统一的 USD cents 字段 |
| `peak_*` / `offpeak_*` | 两档价格：`cache_hit`（缓存命中输入）、`cache_miss`（未命中输入）、`output`（输出）、可选 `cache_write`（缺省按 `cache_miss` 计）。单位 = **本币 / 1M tokens** |
| `offpeak_start_min` / `offpeak_end_min` | 错峰窗口，**UTC 分钟数** `[start, end)`；跨 0 点就 `start > end`；两列都 NULL = 没有空闲档（永远按 peak 计）。DeepSeek = `990 / 30` = UTC 16:30–00:30 = **北京时间 00:30–08:30** |
| `priority` / `enabled` | 同权重时的次序 / 停用开关 |
| `note` / `updated_at` | 备注（种子里写清时段口径与假设）/ 更新时间 |

种子规则（`DEFAULT_BILLING_RULES`，DeepSeek 官方价目，元 / 1M）：

| 模型 | 时段 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | 高峰 | 0.04 | 2 | 8 |
| | 空闲 | 0.02 | 1 | 4 |
| `deepseek-v4-flash-vision-exp` | 高峰 / 空闲 | 同 flash（官方未单列，暂按 flash 档） | | |
| `deepseek-v4-pro` | 高峰 | 0.30 | 9 | 27 |
| | 空闲 | 0.15 | 4.5 | 13.5 |

种子只在**缺行**时补种（`INSERT OR IGNORE`）：改过的行不会被启动覆盖；想停用内置行请置
`enabled = 0`（删掉会在下次启动补回来）。

## 口径（都会逐项写进 `cost_json.billing`，可核对）

- **计费基准时刻** = run 起始时刻（`runs.created_at`）→ 决定高峰/空闲。时段判定只用
  时刻的 **UTC 分钟**，与服务器时区无关。
- **未命中输入** = `inputTokens − cacheReadTokens − cacheWriteTokens`（SDK 的 `inputTokens`
  已含缓存读，见 `usage/tokens.ts`）。
- **命中优先级**：精确模型 id > 更长的包含片段 > `*`；同档先看 provider 是否精确，再看
  `priority`，最后按 `rule_id` 升序稳定排序。provider 不匹配 / 规则停用 → 不命中。
- **兜底**：没有任何规则命中时**保留旧估算（`estimatedCents`）或 SDK 上报值**，绝不按 0 计。
  cursor 的价目表还没入库，所以 cursor run 目前走的就是这条兜底路径。

## 怎么改价

REST（改完立即生效，`PUT`/`DELETE` 属于写操作，需要 `x-ui-version`）：

```bash
# 看全部规则（含停用行）
curl -s localhost:4211/api/billing/rules | jq

# 新增/覆盖一条：例如把 flash 高峰输出价改成 9 元
curl -s -X PUT localhost:4211/api/billing/rules/deepseek-v4-flash \
  -H 'content-type: application/json' \
  -H "x-ui-version: $(cat VERSION)" \
  -d '{
        "provider": "cline", "model": "deepseek-v4-flash",
        "currency": "CNY", "usdPerUnit": 0.14084507042253522,
        "peak":    { "cacheHit": 0.04, "cacheMiss": 2, "output": 9 },
        "offpeak": { "cacheHit": 0.02, "cacheMiss": 1, "output": 4 },
        "offpeakWindow": { "startMinute": 990, "endMinute": 30 },
        "priority": 10, "enabled": true
      }'
```

校验失败返回 400（数值 ≥ 0、分钟 0–1439、provider/model 非空、设了 `offpeakWindow` 就必须给
`offpeak` 价）。也可以直接改 SQLite：`UPDATE billing_rules SET peak_output = 9 WHERE rule_id = ...`。

## 历史数据重算

`backend/scripts/recompute-costs.mjs` 按表重算历史 run 的 `cost_json`：

```bash
# 先备份/复制（不要直接对运行库跑）
sqlite3 ~/runtime/web-cursor/backend/data/web_cursor.db ".backup /tmp/wc-copy/web_cursor.db"
npx tsx backend/scripts/recompute-costs.mjs --data-dir=/tmp/wc-copy            # dry-run
npx tsx backend/scripts/recompute-costs.mjs --data-dir=/tmp/wc-copy --apply    # 落库
```

只有命中规则的 run 会被改写；没命中的原样保留。脚本同时打印「按 provider/model」
「高峰/空闲」「业务忙闲（工作日 9–12 / 14–18，仅对账用）」三张对照表。

## 文件

| 文件 | 内容 |
| --- | --- |
| `types.ts` | `BillingRule` / `BillingCostInfo` / 时段与匹配类型（不 import 任何模块，避免循环依赖） |
| `rules.ts` | 种子规则、时段判定、命中优先级、写接口校验 |
| `cost.ts` | `billingTokens` / `priceWithRule` / `buildBilledCost`（产出 `cost_json`） |
| `service.ts` | `BillingService`：绑一个规则来源（`Store`），`costFor(input)` |
| `index.ts` | 统一出口 |

测试：`backend/scripts/test-billing.mjs`（种子 / 时段边界 / 计价 / 命中 / 校验 / Store / 统计双口径），
`web/scripts/test-usage-cost.mjs`（页面两个口径的文案）。两者都在 `npm test` 里。
