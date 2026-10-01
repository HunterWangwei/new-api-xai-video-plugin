# New API xAI 视频任务插件

通过 New API 的 xAI 渠道调用 CLI Proxy API 账号池生成视频：

用户 -> New API（xAI 渠道）-> CLI Proxy API -> xAI

测试版本：**1.2.0-test.2**。插件适用于 `openai_video` 协议，保持原有的渠道类型 `48`、`per_task` 轮询和三个模型：

- `grok-imagine-video-1.5-preview`
- `grok-imagine-video-1.5`
- `grok-imagine-video`

## 安装与渠道

在 New API 的任务插件管理页面导入以下原始文件地址，并确认 `xai-video` 插件已启用：

```text
https://raw.githubusercontent.com/HunterWangwei/new-api-xai-video-plugin/codex/billing-readable-test/plugin.js
```

沿用 **xAI 类型（48）** 渠道，无需改成 OpenAI 类型（1）。渠道的 Base URL 填 CLI Proxy API 服务地址，渠道密钥填该服务的 API Key；在渠道中启用需要提供的模型。用户侧使用 New API 的令牌请求 New API 地址，不直接使用渠道密钥。模型在插件中声明并不代表渠道或账号池一定可用，请以实际渠道配置为准。

## 计费测试

此分支仅用于计费验证；稳定版仍在 `main`，旧的 ticks 计费测试版仍在 `codex/billing-test`。导入后，在 New API 管理端分别为三个模型设置 xai-video 的任务价格表达式（插件覆盖项的键为 `xai-video::<模型名>`）。`grok-imagine-video-1.5` 和 `grok-imagine-video-1.5-preview` 使用同一表达式：

```text
u("resolution") == "1080p" ? tier("1080p", u("seconds") * 0.25 + u("image_count") * 0.01) : u("resolution") == "720p" ? tier("720p", u("seconds") * 0.14 + u("image_count") * 0.01) : tier("480p", u("seconds") * 0.08 + u("image_count") * 0.01)
```

`grok-imagine-video` 使用：

```text
u("resolution") == "480p" ? tier("480p", u("seconds") * 0.05 + u("image_count") * 0.002) : tier("720p", u("seconds") * 0.07 + u("image_count") * 0.002)
```

用量字段直接显示 `seconds`（秒）、`resolution`（分辨率）和 `image_count`（输入图片数量）。例如 1.5 模型的 6 秒 720p 文生视频为 $0.84，有一张输入图片则为 $0.85。表达式结果是美元/次，再由 New API 按额度换算及分组倍率结算；不要再除以一百万。preview 暂按 1.5 同价，输入视频额外费用不在上述表达式内。

提交时从请求读取秒数和分辨率；未提供秒数按 6 秒，未提供分辨率和尺寸按 720p。无法识别的显式尺寸按该模型已列出的最高档估算。完成响应如有明确的秒数或分辨率才会更新对应事实；目前测试中上游主要返回费用 ticks，**此版本不再据 ticks 改写最终金额**。因此账单按请求规格及上述公开表达式计算，不保证与上游实际扣费完全相同。

旧测试版保存的 `u("cost_units")` 表达式**与本版 schema 不兼容**。导入本版后应立即替换三个模型的插件价格表达式，期间可能出现 `model_price_error`，不要在生产渠道直接切换。仅导入插件不会自动启用按秒计费。**尚未在真实 New API 上验证此新版的定价页面和最终扣款**；先用少量测试任务核对预扣、完成结算、分组倍率及失败退款。

## 请求示例

以下示例中的地址和令牌均为占位值，请替换为自己的 New API 地址与用户令牌：

```bash
curl -X POST 'https://YOUR_NEW_API/v1/videos' \
  -H 'Authorization: Bearer YOUR_NEW_API_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"model":"grok-imagine-video-1.5-preview","prompt":"A kite flying in a clear sky","seconds":"6","size":"1280x720"}'
```

创建接口返回任务 `id`。随后查询任务，直到状态为 `completed`：

```bash
curl -H 'Authorization: Bearer YOUR_NEW_API_TOKEN' \
  'https://YOUR_NEW_API/v1/videos/TASK_ID'
```

完成后的响应包含 `video.url`。New API 的预览和下载也可通过 `GET /v1/videos/TASK_ID/content` 或 `GET /v1/tasks/TASK_ID/artifacts/video/content` 获取；使用 New API 用户令牌访问，不要在浏览器或日志中暴露渠道密钥。

## 制品预览与安全设置

插件从轮询结果中持久化的 `video.url` 读取实际视频地址，以**不携带渠道凭据**的 GET 请求获取 `vidgen.x.ai` 视频。旧版通过 CLI Proxy API 的 `/v1/videos/{id}/content` 获取制品，在已验证的环境中该路径不可用。插件不会把渠道密钥发送给视频 CDN。

New API 服务端必须能解析并访问 `vidgen.x.ai`。若开启 SSRF 防护，且启用了“对域名应用 IP 过滤”及 IP 白名单，域名解析出的地址也必须满足白名单规则。请在 **New API 实际运行的容器或主机**中检查解析结果：

```bash
getent ahosts vidgen.x.ai
getent ahostsv6 vidgen.x.ai
```

CDN 地址可能随时间和运行环境变化。按 IP 逐条放行只适合临时验证，不能把某次解析结果当成永久配置。不要为解决制品问题直接关闭 SSRF 防护或开放大段 CDN 地址；应结合实际部署与其他抓取需求设计可信域名及 IP 策略，并限制私网访问。

## 排查

- `model_not_found` 或没有可用渠道：检查插件是否启用、xAI 类型（48）渠道是否启用对应模型，以及 CLI Proxy API 账号池是否可用。不要把渠道改为类型 1。
- 任务成功但制品返回 `410 artifact_gone`：确认安装的是含制品直链逻辑的版本，任务最新查询响应含 `video.url`，并对新任务重试。
- 制品返回 `502 artifact_request_rejected`：检查 New API 的 SSRF 域名/IP/端口规则与服务端解析结果；插件的无凭据外部 URL 请求仍需通过服务器的抓取安全校验。
- 视频 CDN 访问超时或上游错误：从 New API 实际运行环境检查 DNS、出站网络及 CDN 可达性，不能仅以生成任务成功判断下载可用。

测试密钥不要写入仓库、工单或日志。已公开过的密钥应轮换。
