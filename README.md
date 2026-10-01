# New API xAI 视频任务插件

通过 New API 的 xAI 渠道调用 CLI Proxy API 账号池生成视频：

用户 -> New API（xAI 渠道）-> CLI Proxy API -> xAI

测试版本：**1.2.0-test.4**。插件适用于 `openai_video` 协议，保持原有的渠道类型 `48`、`per_task` 轮询和三个模型：

- `grok-imagine-video-1.5-preview`
- `grok-imagine-video-1.5`
- `grok-imagine-video`

## 安装与渠道

在 New API 的任务插件管理页面导入以下原始文件地址，并确认 `xai-video` 插件已启用：

```text
https://raw.githubusercontent.com/HunterWangwei/new-api-xai-video-plugin/codex/strict-official-video-test/plugin.js
```

沿用 **xAI 类型（48）** 渠道，无需改成 OpenAI 类型（1）。渠道的 Base URL 填 CLI Proxy API 服务地址，渠道密钥填该服务的 API Key；在渠道中启用需要提供的模型。用户侧使用 New API 的令牌请求 New API 地址，不直接使用渠道密钥。模型在插件中声明并不代表渠道或账号池一定可用，请以实际渠道配置为准。

## 请求接口与严格参数

插件保留旧的 `POST /v1/videos` 请求格式，同时通过 **`POST /xai/v1/videos/generations`** 接收 xAI 官方参数格式，上游请求仍发送到 CPA 的 `/v1/videos/generations`。官方格式使用顶层 `model`、`prompt`、`duration`、`aspect_ratio`、`resolution`、`image`、`reference_images`、`reference_audios`、`last_frame`、`keyframes`、`generate_audio`、`output`、`storage_options` 和 `user` 字段。

### test.3 加载失败与 test.4 修正

线上 New API `v1.0.0-rc.37` 的只读运行时诊断返回：

```text
plugin xai-video rejected from public routes: route POST /v1/videos/generations intersects static route GET /v1/videos/:task_id
```

这是公共路由注册失败，管理页面统一显示为“编译失败”，不是 JavaScript 语法错误。该版本的 `router/plugin-router.go` 在插件与静态路由之间按路径检查交集，不区分 HTTP 方法。因此即使是 POST，也不能注册会命中现有 GET 动态路径的 `/v1/videos/generations`。仅运行 Node 检查或不含公共路由的插件 lint 无法发现这类问题。

`test.4` 仅调整插件原生入口为 `/xai/v1/videos/generations`，保留 `test.3` 的参数校验、时长和参考图计费修复、旧接口及上游官方路径。它**不提供未经转发配置的 `/v1/videos/generations` 客户端入口**；严格使用该原路径需要另行配置反向代理内部重写到别名，或修改宿主路由支持。本仓库未修改服务器或反向代理配置。

从 `test.3` 更新时重新导入同一 raw 地址，并确认显示版本 `1.2.0-test.4`。已有 `seconds` / `resolution` / `image_count` 价格表达式无需因本次路由修正而改变。

### 参数规则

官方格式的 `duration` 支持 1 到 15 秒，默认 8 秒；旧接口的 `seconds` 默认 6 秒。`reference_images` 最多 7 张，`reference_audios` 最多 3 个，`keyframes` 最多 4 个。未知字段、冲突的 `duration`/`seconds`、无效 URL、超出范围的时长及不符合模型限制的组合会被拒绝，不再静默透传。

官方入口、显式 `duration`、首尾帧、keyframes 或官方高级字段走上游 `/v1/videos/generations`。使用 `seconds` 的旧请求（含普通 URL 图片或参考图）继续走 `/v1/videos`。旧接口的 `input_reference`、`image_url`、`imageUrl`、`reference_image_urls` 和 `size` 参数继续兼容；图片支持旧版 `image_url.url` 嵌套形式。`duration` 和 `seconds` 同时提供时必须一致。

官方入口默认分辨率为 `480p`，旧入口默认 `720p`；插件将默认值明确写入上游请求，使计费和提交规格一致。无论是否包含图片，都需要非空 `prompt`。经典模型不支持的 1080p 请求会明确拒绝，不再静默降为 720p。

依赖 New API 的 `meta.routes` / `native` 插件契约和 CLI Proxy API 的原生 `/v1/videos/generations` 路由。若部署版本未提供该上游路由，请升级 CPA；插件不会在失败后自动重试另一入口，避免重复创建和扣费。

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

提交时从请求读取秒数和分辨率；旧接口未提供秒数按 6 秒，官方接口未提供 `duration` 按 8 秒。完成响应中的 `video.duration` 或明确分辨率会更新对应事实；费用 ticks 不会改写插件计费事实。因此账单按请求规格及上述公开表达式计算，不保证与上游实际扣费完全相同。

`image_count` 是插件侧计费字段：当前按 `image`、`reference_images`、`last_frame` 和每个 `keyframes[].image` 的数量计入。它是便于 New API 计费的规则，不代表 xAI 官方账单中的唯一计价口径。

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

### 官方格式示例

向 New API 的 `POST /xai/v1/videos/generations` 发送（注意客户端入口的 `/xai` 前缀，上游仍是官方路径）：

```json
{
  "model": "grok-imagine-video-1.5-preview",
  "prompt": "Animate the scene in the reference image",
  "duration": 15,
  "aspect_ratio": "3:2",
  "resolution": "720p",
  "reference_images": [
    { "url": "https://YOUR_IMAGE_HOST/reference.png" }
  ]
}
```

本例提交用量为 `seconds: 15`、`resolution: "720p"`、`image_count: 1`。创建返回 `{"request_id":"<New API 公共任务 ID>"}`，用这个 ID 查询原有的 `GET /v1/videos/TASK_ID`。查询仍由 New API 的 `openai_video` 协议输出状态和视频数据，不宣称与 xAI SDK 的所有响应细节完全一致。

### 验证范围

本版包含静态检查和本地回归测试，覆盖旧契约、两种入口的参数规范化、截图中的 15 秒参考图请求、计费用量与提交一致性、冲突参数和非法输入拒绝，以及完成态时长、制品处理。新增路由冲突回归模型，按 `rc.37` 的路径交集算法重现 `test.3` 冲突并检查别名；这是源码规则的本地测试，不等同于启动真实宿主。

已通过线上只读 GET 查询确认 `test.3` 源码与发布版本一致、元数据可读取，以及公共路由被拒绝的具体错误。`test.4` 尚未通过真实宿主导入和完整路由注册验证。

**本版未导入真实 New API，也未完成 New API → CPA → xAI 的付费生成和最终扣款验证。** 不应仅凭本地测试就认定线上链路已修复。导入后请先核对上述示例的请求日志、15 秒预扣、参考图数量、最终实际时长与结算；已有错误账单不会自动修正。

## 制品预览与安全设置

插件从轮询结果中持久化的 `video.url` 读取实际视频地址，以**不携带渠道凭据**的 GET 请求获取 `vidgen.x.ai` 视频。旧版通过 CLI Proxy API 的 `/v1/videos/{id}/content` 获取制品，在已验证的环境中该路径不可用。插件不会把渠道密钥发送给视频 CDN。

New API 服务端必须能解析并访问 `vidgen.x.ai`。若开启 SSRF 防护，且启用了“对域名应用 IP 过滤”及 IP 白名单，域名解析出的地址也必须满足白名单规则。请在 **New API 实际运行的容器或主机**中检查解析结果：

```bash
getent ahosts vidgen.x.ai
getent ahostsv6 vidgen.x.ai
```

CDN 地址可能随时间和运行环境变化。按 IP 逐条放行只适合临时验证，不能把某次解析结果当成永久配置。不要为解决制品问题直接关闭 SSRF 防护或开放大段 CDN 地址；应结合实际部署与其他抓取需求设计可信域名及 IP 策略，并限制私网访问。

## 排查

- `test.3` 显示“编译失败”，运行时错误含 `intersects static route GET /v1/videos/:task_id`：更新到 `test.4`，官方参数入口改用 `/xai/v1/videos/generations`；不要修改渠道类型或计费表达式来解决路由冲突。
- `model_not_found` 或没有可用渠道：检查插件是否启用、xAI 类型（48）渠道是否启用对应模型，以及 CLI Proxy API 账号池是否可用。不要把渠道改为类型 1。
- 任务成功但制品返回 `410 artifact_gone`：确认安装的是含制品直链逻辑的版本，任务最新查询响应含 `video.url`，并对新任务重试。
- 制品返回 `502 artifact_request_rejected`：检查 New API 的 SSRF 域名/IP/端口规则与服务端解析结果；插件的无凭据外部 URL 请求仍需通过服务器的抓取安全校验。
- 视频 CDN 访问超时或上游错误：从 New API 实际运行环境检查 DNS、出站网络及 CDN 可达性，不能仅以生成任务成功判断下载可用。

测试密钥不要写入仓库、工单或日志。已公开过的密钥应轮换。
