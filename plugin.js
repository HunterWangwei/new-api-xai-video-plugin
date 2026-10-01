export const meta = {
  apiVersion: 1,
  key: "xai-video",
  name: "xAI Video",
  description: {
    en: "xAI Grok video generation through CLI Proxy API",
    zh: "通过 CLI Proxy API 调用 xAI Grok 视频生成"
  },
  version: "1.2.0-test.1",
  author: { name: "local" },
  channelTypes: [48],
  models: [
    "grok-imagine-video-1.5",
    "grok-imagine-video-1.5-preview",
    "grok-imagine-video"
  ],
  fetchMode: "per_task",
  usageSchema: {
    cost_units: {
      type: "number",
      unit: "credit",
      description: { en: "Upstream video usage units", zh: "上游视频用量单位" }
    }
  },
  protocols: ["openai_video"]
};

function trimmed(value) {
  return String(value || "").trim();
}

function baseUrl(value) {
  return trimmed(value).replace(/\/$/, "");
}

function videoUrl(body) {
  if (!body || typeof body !== "object") return "";
  return trimmed(body.video_url || (body.video && body.video.url) || body.url);
}

// One usage unit represents 1,000,000 xAI USD ticks, or $0.0001.
function costUnits(usd) {
  return Math.round(usd * 10000);
}

function outputResolution(req, model) {
  const resolution = trimmed(req.resolution).toLowerCase();
  if (resolution === "480p" || resolution === "720p") return resolution;
  if (resolution === "1080p") return model === "grok-imagine-video" ? "720p" : resolution;
  const match = /^(\d+)x(\d+)$/i.exec(trimmed(req.size));
  if (match) {
    const shortSide = Math.min(Number(match[1]), Number(match[2]));
    if (shortSide <= 480) return "480p";
    if (shortSide <= 720) return "720p";
  }
  return model === "grok-imagine-video" ? "720p" : "1080p";
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  const model = ctx.upstreamModel || ctx.model;
  const duration = Number(req.seconds);
  const seconds = Number.isFinite(duration) && duration > 0
    ? Math.min(duration, 3600) : 6;
  const resolution = outputResolution(req, model);
  const rates = model === "grok-imagine-video"
    ? { "480p": 0.05, "720p": 0.07 }
    : { "480p": 0.08, "720p": 0.14, "1080p": 0.25 };
  const image = req.image || req.input_reference || req.image_url || req.imageUrl;
  const imagePrice = image ? (model === "grok-imagine-video" ? 0.002 : 0.01) : 0;
  return { cost_units: costUnits(seconds * rates[resolution] + imagePrice) };
}

export function extractUsageOnComplete(ctx, result, body) {
  const data = body && body.usage ? body : result && result.data || {};
  const ticks = data.usage && data.usage.cost_in_usd_ticks;
  if (ticks === undefined || ticks === null || ticks === "") return null;
  const value = Number(ticks);
  if (!Number.isSafeInteger(value) || value < 0 || value / 1000000 > 2147483647) return null;
  return { cost_units: value / 1000000 };
}

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  return {
    url: baseUrl(ctx.baseUrl) + "/v1/videos",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + ctx.apiKey
    },
    body: Object.assign({}, req, {
      model: ctx.upstreamModel || ctx.model
    })
  };
}

export function parseSubmitResponse(ctx, resp) {
  const body = resp && resp.body || {};
  const taskId = trimmed(body.id || body.request_id || body.task_id);
  if (!taskId) throw new Error("task_id is empty");
  return { taskId: taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return {
    url: baseUrl(ctx.baseUrl) + "/v1/videos/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Authorization: "Bearer " + ctx.apiKey }
  };
}

export function parseTaskResult(ctx, body) {
  const status = trimmed(body && body.status).toLowerCase();
  const result = { data: body || {} };
  if (status === "queued" || status === "pending") {
    result.status = "QUEUED";
    result.progress = "0%";
  } else if (status === "in_progress" || status === "processing" || status === "running") {
    result.status = "IN_PROGRESS";
    result.progress = "50%";
  } else if (status === "completed" || status === "succeeded" || status === "success" || status === "done") {
    result.status = "SUCCESS";
    result.progress = "100%";
    result.url = videoUrl(body);
  } else if (status === "failed" || status === "error" || status === "expired" || status === "cancelled" || status === "canceled") {
    result.status = "FAILURE";
    result.reason = body && body.error && body.error.message ? body.error.message : status;
  } else {
    result.status = "UNKNOWN";
  }
  if (body && body.progress !== undefined && body.progress !== null && body.progress !== "") {
    result.progress = String(body.progress).replace("%", "") + "%";
  }
  return result;
}

export function listArtifacts(task) {
  return task && task.status === "SUCCESS" ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

export function buildContentRequest(ctx) {
  if (!ctx || ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const url = videoUrl(ctx.data);
  if (!/^https:\/\/vidgen\.x\.ai(?::443)?\//i.test(url)) throw new Error("video url is invalid");
  return {
    url: url,
    method: "GET",
    credentialless: true
  };
}

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json" || !ctx.body.value || Array.isArray(ctx.body.value)) {
        throw new Error("JSON object required");
      }
      const req = ctx.body.value;
      return {
        kind: "submit",
        model: ctx.model,
        action: req.image || req.input_reference ? "image_to_video" : "text_to_video",
        requestBody: Object.assign({}, req, { model: ctx.model })
      };
    },
    render: function (ctx, task) {
      return task && task.data || {};
    }
  }
};
