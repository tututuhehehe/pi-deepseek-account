# DeepSeek 账号 —— pi 的 provider 扩展

> A pi provider extension for DeepSeek account login (DSH PKCE) and daily bonus claiming.
> `pi install npm:pi-deepseek-account`

把 DeepSeek Harness（DSH）里「登录 DeepSeek 账号 → 直接用 DeepSeek 模型 → 每天领赠金额度」
这套东西搬到 pi 里：

- **登录**：`/login deepseek-account`。本机已经登录着 DSH 的话直接复用它的账号 token
  （不弹浏览器）；否则走和 DSH 一模一样的浏览器 PKCE 授权。
- **模型**：`deepseek-account/deepseek-flash`、`deepseek-account/deepseek-v4-pro`，目录来自
  平台的 `GET /models`，支持思考档位（low / high / max）和图片输入（flash）。
- **领额度**：每次启动自动读一次平台发放的赠金并确认领取，领到了才弹提示；
  也可以 `/deepseek claim` 手动领。

## 安装

```bash
# 从 npm（推荐）
pi install npm:pi-deepseek-account

# 或直接从 GitHub
pi install git:github.com/tututuhehehe/pi-deepseek-account

# 只想试一次，不写进设置
pi -e npm:pi-deepseek-account
```

装完 `/reload`（或重开 pi）。provider id 固定是 `deepseek-account`，装好就能
`/login deepseek-account`。

> 同一个 provider 只应有一份副本：如果你已经把这个目录当成个人扩展
> （`~/.pi/agent/extensions/deepseek-account/`）加载着，先删掉它或改用
> `pi install` 的版本，别同时加载两份。

## 用法

```
/login deepseek-account         登录（或复用 DSH 的登录）
/model                          选 deepseek-account/deepseek-flash
/deepseek                       账号、余额、赠金状态
/deepseek claim                 立刻领取赠金
/deepseek balance               只看余额
/deepseek bonuses               赠金账单（活动名、金额、发放/到期时间、状态）
/deepseek logout                注销云端 token（本地凭据用 /logout deepseek-account 删）
```

## 它到底做了什么

DSH 的账号路由由 `@deepseek-ai/dsh-deepseek-account-platform` 实现，这里是它的等价移植：

| 用途 | 请求 |
| --- | --- |
| 开始登录 | `POST {platform}/auth-api/v0/dsh/auth_init`（S256 PKCE） |
| 本机回跳 | `http://127.0.0.1:<随机端口>/oauth/callback` |
| 换 token | `POST {platform}/auth-api/v0/dsh/auth_exchange` |
| 账号资料 | `GET {platform}/auth-api/v0/users/current` |
| 余额 | `GET {platform}/api/v0/users/get_user_summary` |
| 未领赠金 | `GET {platform}/api/v0/users/get_unnotified_bonuses` |
| 赠金账单 | `GET {platform}/auth-api/v0/users/get_all_invoice`（`bonus_orders`：活动备注、金额、发放时间、到期时间、ACTIVE/EXPIRED/EXHAUSTED） |
| 领取（标记已展示） | `POST {platform}/api/v0/users/ack_bonus_notified` |
| 注销 | `POST {platform}/auth-api/v0/users/logout` |
| 推理 | `POST https://api.deepseek.com/anthropic/v1/messages`，鉴权头 `x-dsh-auth-token` |
| 模型目录 | `GET https://api.deepseek.com/models`，鉴权头 `x-dsh-auth-token` |

推理复用 pi 内置的 `anthropic-messages` 实现：DSH 用的也是 Messages 协议，区别只在鉴权头
（不是 `x-api-key` / `Authorization`，而是 `x-dsh-auth-token`），以及思考档位用
`output_config.effort` 而不是 `budget_tokens`。所以模型的 `compat` 里开了
`forceAdaptiveThinking`，`thinkingLevelMap` 把 pi 的档位映射到平台的
`low / high / max`。

「每天领额度」= 平台的赠金：平台发放后会在 `get_unnotified_bonuses` 里出现，
DSH 用它渲染「赠金已到账」的提示，确认（ack）之后就不再出现。所以本扩展的「领取」
就是读取 + 确认，领完顺手报一次余额。

赠金**什么时候发、发多少、多久过期，全部由平台活动决定**（服务端逻辑，客户端拿不到规则文本）。
能查到的只有账单事实：`get_all_invoice` 的 `bonus_orders` 里每笔都有活动备注（例如
「Harness 赠金」「服务补偿」）、金额、`inserted_at`、`expires_at` 和状态。
`/deepseek bonuses` 就是这份账单。

注意两点：

- ack 只是「已展示」，不会改变金额或有效期；**不 ack 也不会过期得更慢**。
- 过期/用完的赠金会留在账单里（EXPIRED / EXHAUSTED），不会消失，所以能据此反推规则。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_PLATFORM_ORIGIN` | `https://platform.deepseek.com` | 账号平台地址 |
| `DEEPSEEK_INFERENCE_ORIGIN` | `https://api.deepseek.com` | 推理 origin |
| `DEEPSEEK_ACCOUNT_AUTO_CLAIM` | 开 | 设 `0` 关掉启动时自动领取 |
| `DEEPSEEK_ACCOUNT_CLIENT_VERSION` | `0.2.1-rc.5` | 上报给平台的 `x-client-version` |
| `DEEPSEEK_ACCOUNT_LOCALE` | 系统语言 | `zh_CN` / `en_US` |
| `DEEPSEEK_ACCOUNT_LOGIN_TIMEOUT_MS` | 600000 | 浏览器登录等待上限 |
| `DEEPSEEK_ACCOUNT_REQUEST_TIMEOUT_MS` | 30000 | 单次平台请求超时 |
| `DEEPSEEK_ACCOUNT_CATALOG_TTL_MS` | 600000 | 模型目录进程内缓存 |
| `DSH_HOME` | `~/.dsh` | DSH 的 home（用来复用它的登录） |

## 状态文件

- pi 的凭据：`<agent dir>/auth.json` 里的 `deepseek-account`（token、账号资料、登录方式）。
- 本扩展的小状态：`<agent dir>/deepseek-account.json`（设备 ID、上次领取日期）。

## 已知限制

- 账号 token 没有过期时间，也没有 refresh 流程（DSH 同样如此）。真的失效时请求会 401，
  扩展会提示重新 `/login`，不会自动续。
- 平台不提供模型单价，所以 pi 里的成本显示是 0；真实花费看 `/deepseek` 报的充值/赠金余额。
- 赠金确认是「已展示」语义：在 pi 里领过之后，DSH 的「赠金已到账」提示也不会再弹。
- 复用 DSH 登录只在 `~/.dsh/.credentials.yaml` 的 issuer 与本扩展的平台地址一致时生效。
