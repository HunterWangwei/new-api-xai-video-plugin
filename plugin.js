export const meta = {
  apiVersion: 1,
  key: "xai-video",
  name: "xAI Video",
  description: {
    en: "xAI Grok video generation through CLI Proxy API",
    zh: "通过 CLI Proxy API 调用 xAI Grok 视频生成"
  },
  version: "1.1.0",
  author: { name: "local" },
  channelTypes: [48],
  models: [
    "grok-imagine-video-1.5",
    "grok-imagine-video-1.5-preview",
    "grok-imagine-video"
  ],
  fetchMode: "per_task",
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
  const taskId = trimmed(ctx.upstreamTaskId);
  if (!taskId) throw new Error("upstream task id is empty");
  return {
    url: baseUrl(ctx.baseUrl) + "/v1/videos/" + encodeURIComponent(taskId) + "/content",
    method: "GET",
    headers: { Authorization: "Bearer " + ctx.apiKey }
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
