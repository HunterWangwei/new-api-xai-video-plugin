# New API xAI 视频任务插件

通过 New API 的 xAI 渠道调用 CLI Proxy API 账号池生成视频：

用户 -> New API（xAI 渠道）-> CLI Proxy API -> xAI

当前版本：**1.1.1**。插件适用于 `openai_video` 协议，保持原有的渠道类型 `48`、`per_task` 轮询和三个模型：

- `grok-imagine-video-1.5-preview`
- `grok-imagine-video-1.5`
- `grok-imagine-video`

## 安装与渠道

在 New API 的任务插件管理页面导入以下原始文件地址，并确认 `xai-video` 插件已启用：

```text
https://raw.githubusercontent.com/HunterWangwei/new-api-xai-video-plugin/main/plugin.js
```

沿用 **xAI 类型（48）** 渠道，无需改成 OpenAI 类型（1）。渠道的 Base URL 填 CLI Proxy API 服务地址，渠道密钥填该服务的 API Key；在渠道中启用需要提供的模型。用户侧使用 New API 的令牌请求 New API 地址，不直接使用渠道密钥。模型在插件中声明并不代表渠道或账号池一定可用，请以实际渠道配置为准。

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

1.1.1 从轮询结果中持久化的 `video.url` 读取实际视频地址，以**不携带渠道凭据**的 GET 请求获取 `vidgen.x.ai` 视频。旧版通过 CLI Proxy API 的 `/v1/videos/{id}/content` 获取制品，在已验证的环境中该路径不可用。插件不会把渠道密钥发送给视频 CDN。

New API 服务端必须能解析并访问 `vidgen.x.ai`。若开启 SSRF 防护，且启用了“对域名应用 IP 过滤”及 IP 白名单，域名解析出的地址也必须满足白名单规则。请在 **New API 实际运行的容器或主机**中检查解析结果：

```bash
getent ahosts vidgen.x.ai
getent ahostsv6 vidgen.x.ai
```

CDN 地址可能随时间和运行环境变化。按 IP 逐条放行只适合临时验证，不能把某次解析结果当成永久配置。不要为解决制品问题直接关闭 SSRF 防护或开放大段 CDN 地址；应结合实际部署与其他抓取需求设计可信域名及 IP 策略，并限制私网访问。

## 排查

- `model_not_found` 或没有可用渠道：检查插件是否启用、xAI 类型（48）渠道是否启用对应模型，以及 CLI Proxy API 账号池是否可用。不要把渠道改为类型 1。
- 任务成功但制品返回 `410 artifact_gone`：确认安装的是 1.1.1，任务最新查询响应含 `video.url`，并对新任务重试。
- 制品返回 `502 artifact_request_rejected`：检查 New API 的 SSRF 域名/IP/端口规则与服务端解析结果；插件的无凭据外部 URL 请求仍需通过服务器的抓取安全校验。
- 视频 CDN 访问超时或上游错误：从 New API 实际运行环境检查 DNS、出站网络及 CDN 可达性，不能仅以生成任务成功判断下载可用。

测试密钥不要写入仓库、工单或日志。已公开过的密钥应轮换。
