# dsh-auto-thinking-levels

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 Host 插件：
**自动给每个提供商、每个模型补上完整的思考等级表（`reasoningEfforts`）**，不用再逐模型手写。

> **English TL;DR** — A dsh Host plugin that keeps every `llm-pi-ai` provider route
> offering the full thinking-level set. It writes the missing `reasoningEfforts`
> tables into that namespace's settings layer, so both the model selector *and*
> the request path agree on which levels exist. Add-only and idempotent: it never
> rewrites a level you already spelled, never removes an entry, and never touches
> a model that declares `reasoningEfforts: false`.

```yaml
reasoningEfforts:
  { off: null, minimal: minimal, low: low, medium: medium, high: high, xhigh: xhigh, max: max }
```

## 为什么写配置层，而不是去 patch adapter

`llm-pi-ai` 在**物化模型时**读一次 `reasoningEfforts`，把它翻译成 pi-ai 描述符上的
`thinkingLevelMap`（`resolveModelReasoning`）。之后所有判断都只从这张 map 出发：

- `getSupportedThinkingLevels()` 决定选择器**显示**哪些档位；
- **同一个函数**守着请求路径，map 里没有的档位在发出任何 I/O 之前就以
  `UNSUPPORTED_REASONING_EFFORT` 被拒。

所以只包一层 adapter 的 `resolveModel` 只能改到第一个答案、改不到第二个 —— 用户会选到
一个真正发请求时被拒的档位。把表写进配置层，是让**配置本身正确**，两个答案都从它推导，
且任何一次重载后依然成立，不需要重新打补丁。

写入走 `settings.update`：候选值会先过该命名空间自己的 schema 与 `assertServiceable`
校验，**注入不合法时什么都不落盘**。

## 安装

```sh
dsh plugin --profile <name> add dsh-auto-thinking-levels
```

插件自带 `dsh.bundle.patch`，安装后自动挂一行，不需要手改 `cordis.patch.yml`。

想改配置的话，在 profile 的 `cordis.patch.yml` 里用 id 定向 patch 覆盖那一行即可；
改完用 `set_bundle` 关掉再打开，这一行就会用新配置重新挂载。

## 配置

全部字段可选，默认值见下表。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `namespace` | `llm-pi-ai` | 要配置的 settings 命名空间（`dsh-llm-pi-ai` 的 `NS`） |
| `fill` | `complete` | `complete` 把**档位不足**的模型补齐（已写过的档位保留你的原值）；`missing` 只补完全没有表的模型，尊重刻意的子集 |
| `levels` | 七档全表 | 要写入的表；值是发给网关的线材拼写，`off: null` 表示「支持，但不发送该参数」 |
| `providers` | `[]` | 路由白名单，空 = 全部已注册路由 |
| `enabled` | `true` | `false` 时挂载但不动配置 |

## 行为

只做**新增**，绝不覆盖：

- 已有部分档位的模型（`fill: complete`）：补齐缺失的档位，**已写过的档位保留你的原值**；
- 声明 `reasoningEfforts: false` 的模型：`false` 是「此模型不推理」的明确答复，永不填充；
- 其余任何字段、任何条目都不会被删改。

因此是幂等的：第二遍扫描找不到要补的，就不写、不发事件，自然收敛。

插件会监听该命名空间的变更与 adapter 拓扑变化，所以**你手改 `settings.yaml` 之后它会自己补回来**。

## 两种路由

- **声明了 `models` 的路由**：逐条 entry 补表。
- **没有 `models` 的路由**（catalog 路由）：只能通过 `modelOverrides` 表达，因此按
  `ctx.llm.listModels(route)` **实际服务**的模型逐个补 —— adapter 会拒绝命名
  catalog 里不存在的模型，所以这里用真实服务列表而不是去猜 catalog。
  两种方式互斥：`models` 旁边放 `modelOverrides` 会被 adapter 拒绝。

## 已知边界

本插件只配置 `llm-pi-ai` 命名空间。**其它 adapter 不在作用域内，且有些无法被配置**：

`deepseek-official`（`llm-deepseek` adapter）拿不到七档 —— 它的档位写死在 adapter 里
（`off/low/high/max`），线材校验函数 `reasoningEffort()` 对其余值直接抛
`UNSUPPORTED_REASONING_EFFORT`；它的 settings schema 也只有 provider 级 `reasoningEffort`，
没有 per-model 表。这是官方 API 自己的线材词汇（`medium` 会收敛到 `high`），不是配置能改的。
强行为它注入 `minimal/medium/xhigh` 只会把请求打成必然失败。

## 验证

`verification/probe-result.json` 是一次性探针在运行中的 harness 上抓的实测结果：对每个
已注册路由/模型调用 `llm.resolveModelInfo`（选择器看到的档位）与
`llm.resolveCallConfig`（请求路径是否接受该档位）。

```
## provider: cpa
   deepseek-v4-flash-0731   efforts: off/minimal/low/medium/high/xhigh/max   rejected: none
   glm-5.3-flash            efforts: off/minimal/low/medium/high/xhigh/max   rejected: none
   deepseek-flash           efforts: off/minimal/low/medium/high/xhigh/max   rejected: none
   gpt-6-astra              efforts: off/minimal/low/medium/high/xhigh/max   rejected: none
   claude-fable-5-1         efforts: off/minimal/low/medium/high/xhigh/max   rejected: none
   glm-5.3-flashx           efforts: off/minimal/low/medium/high/xhigh/max   rejected: none

## provider: deepseek-official
   deepseek-flash           efforts: off/low/high/max   rejected: minimal,medium,xhigh
   deepseek-v4-pro          efforts: off/low/high/max   rejected: minimal,medium,xhigh
```

（`resolveModelInfo` 里的 `auto` 由另一个插件注入，不属于本插件。）

## 开发

```sh
npm test          # node:test，20 个用例，零依赖
npm run check:pack   # 断言 npm publish 会打包哪些文件
```

`lib/plan.js` 是纯决策逻辑（可测、无 I/O），`index.js` 只负责读写 settings 与事件触发。

发布走 tag：

```sh
npm version patch
git push --follow-tags
```

`.github/workflows/publish.yml` 会校验 tag 与 `package.json` 版本一致、跑测试、以
provenance 发布到 npm，并开一个 GitHub Release。

### 首次发布前的一次性配置

工作流用 npm 的 [trusted publishing](https://docs.npmjs.com/trusted-publishers)（OIDC）认证，
**不需要 `NPM_TOKEN` secret**。代价是必须在 npmjs.com 上登记一次信任关系
（在包的 Settings → Trusted Publisher → GitHub Actions 填写）：

| 字段 | 值 |
| --- | --- |
| Organization or user | `lolkda` |
| Repository | `dsh-auto-thinking-levels` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

这一步**必须走网页**：`npm trust github` 会被 npm 的策略拒绝
（`403 Granular access tokens that bypass two-factor authentication may not perform this action`）——
能发布包 ≠ 能改包的安全设置，所以命令行配不了。

不想用 OIDC 的话，改成在仓库里加一个 `NPM_TOKEN` secret，并给发布步骤加上
`env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`。

## License

MIT
