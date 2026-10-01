export const meta = {
  apiVersion: 1,
  key: "xai-video",
  name: "xAI Video",
  description: {
    en: "xAI Grok video generation through CLI Proxy API",
    zh: "通过 CLI Proxy API 调用 xAI Grok 视频生成"
  },
  version: "1.2.0-test.4",
  author: { name: "local" },
  channelTypes: [48],
  models: [
    "grok-imagine-video-1.5",
    "grok-imagine-video-1.5-preview",
    "grok-imagine-video"
  ],
  fetchMode: "per_task",
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" }
    },
    resolution: {
      enum: ["480p", "720p", "1080p"],
      description: { en: "Output video resolution", zh: "输出视频分辨率" }
    },
    image_count: {
      type: "number",
      unit: "count",
      description: { en: "Input image unit price", zh: "输入图片单价" }
    }
  },
  usageExamples: [
    { label: "480p 6s", facts: { seconds: 6, resolution: "480p", image_count: 0 } },
    { label: "720p 6s", facts: { seconds: 6, resolution: "720p", image_count: 0 } }
  ],
  routes: [
    // rc.37 rejects static-path intersections even when HTTP methods differ.
    { method: "POST", path: "/xai/v1/videos/generations", type: "submit", decode: "generateVideo", render: "videoCreated" }
  ],
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

const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
const OFFICIAL_FIELDS = [
  "model", "prompt", "duration", "seconds", "aspect_ratio", "resolution",
  "image", "reference_images", "reference_audios", "last_frame", "keyframes",
  "generate_audio", "output", "storage_options", "user"
];
const LEGACY_FIELDS = OFFICIAL_FIELDS.concat(["size", "input_reference", "image_url", "imageUrl", "reference_image_urls"]);

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(name + " must be a JSON object");
  }
  return value;
}

function onlyKeys(value, keys, name) {
  object(value, name);
  Object.keys(value).forEach(function (key) {
    if (keys.indexOf(key) < 0) throw new Error("Unsupported field: " + name + "." + key);
  });
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(name + " must be a non-empty string");
  return value.trim();
}

function integer(value, name, min, max) {
  if (!(typeof value === "number" || typeof value === "string" && /^\d+$/.test(value))) {
    throw new Error(name + " must be an integer");
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(name + " must be between " + min + " and " + max);
  }
  return number;
}

function mediaUrl(value, name, media) {
  const url = text(value, name);
  if (/^https?:\/\/[^/\s?#]+(?:[/?#][^\s]*)?$/i.test(url)) return url;
  const pattern = media === "image"
    ? /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/
    : /^data:audio\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/;
  if (!pattern.test(url)) throw new Error(name + " must be an HTTP(S) URL or a base64 " + media + " data URI");
  return url;
}

function imageInput(value, name, allowString) {
  if (allowString && typeof value === "string") return { url: mediaUrl(value, name, "image") };
  onlyKeys(value, ["url", "image_url", "file_id"], name);
  if (allowString && value.image_url && typeof value.image_url === "object") {
    onlyKeys(value.image_url, ["url"], name + ".image_url");
    value = Object.assign({}, value, { image_url: value.image_url.url });
  }
  const urlKeys = ["url", "image_url"].filter(function (key) { return has(value, key) && value[key] !== null; });
  const file = has(value, "file_id") && value.file_id !== null;
  if (file) {
    if (urlKeys.length) throw new Error(name + ": file_id and URL are mutually exclusive");
    return { file_id: text(value.file_id, name + ".file_id") };
  }
  if (!urlKeys.length) throw new Error(name + " requires url or file_id");
  const url = mediaUrl(value[urlKeys[0]], name + "." + urlKeys[0], "image");
  if (urlKeys.length > 1 && value[urlKeys[1]] !== url) throw new Error(name + " contains conflicting URLs");
  return { url: url };
}

function list(value, name, max) {
  if (!Array.isArray(value) || value.length > max) throw new Error(name + " must be an array of at most " + max + " entries");
  return value;
}

function sizeSpec(value) {
  const size = text(value, "size");
  const match = /^([1-9]\d{1,4})x([1-9]\d{1,4})$/.exec(size);
  if (!match) throw new Error("size must be WIDTHxHEIGHT");
  const width = Number(match[1]), height = Number(match[2]);
  const shortSide = Math.min(width, height);
  const oldSize = size === "1792x1024" || size === "1024x1792";
  const resolution = oldSize ? "720p" : shortSide + "p";
  if (["480p", "720p", "1080p"].indexOf(resolution) < 0) throw new Error("Unsupported size resolution");
  const ratio = RATIOS.filter(function (r) {
    const parts = r.split(":");
    return Math.abs(width / height - Number(parts[0]) / Number(parts[1])) < 0.04;
  })[0];
  if (!ratio) throw new Error("Unsupported size aspect ratio");
  return { resolution: resolution, aspect_ratio: ratio };
}

// Both submission and billing consume this same validated representation.
function normalizeRequest(input, model, official, driver) {
  onlyKeys(input, official && !driver ? OFFICIAL_FIELDS : LEGACY_FIELDS, "request");
  const req = Object.assign({}, input);
  ["duration", "seconds", "resolution", "aspect_ratio", "image", "output", "storage_options", "user"].forEach(function (key) {
    if (req[key] === null) delete req[key];
  });
  const seconds = has(req, "seconds") ? integer(req.seconds, "seconds", 1, 15) : undefined;
  const duration = has(req, "duration") ? integer(req.duration, "duration", 1, 15) : undefined;
  if (seconds !== undefined && duration !== undefined && seconds !== duration) throw new Error("seconds and duration must agree");
  const length = duration !== undefined ? duration : seconds !== undefined ? seconds : official ? 8 : 6;
  const spec = has(req, "size") ? sizeSpec(req.size) : null;
  const resolution = has(req, "resolution") ? text(req.resolution, "resolution") : spec ? spec.resolution : official ? "480p" : "720p";
  if (["480p", "720p", "1080p"].indexOf(resolution) < 0) throw new Error("resolution must be 480p, 720p, or 1080p");
  if (spec && has(req, "resolution") && resolution !== spec.resolution) throw new Error("size and resolution must agree");
  if (has(req, "aspect_ratio")) {
    const aliases = { square: "1:1", landscape: "16:9", portrait: "9:16" };
    if (!official && has(aliases, req.aspect_ratio)) req.aspect_ratio = aliases[req.aspect_ratio];
    if (RATIOS.indexOf(req.aspect_ratio) < 0) throw new Error("Unsupported aspect_ratio");
    if (spec && spec.aspect_ratio !== req.aspect_ratio) throw new Error("size and aspect_ratio must agree");
  } else if (spec) req.aspect_ratio = spec.aspect_ratio;

  let image;
  ["image", "input_reference", "image_url", "imageUrl"].forEach(function (key) {
    if (!has(req, key)) return;
    const candidate = imageInput(req[key], key, !official || driver);
    if (image && JSON.stringify(image) !== JSON.stringify(candidate)) throw new Error("Conflicting input image aliases");
    image = candidate;
    delete req[key];
  });
  if (image) req.image = image;
  let count = image ? 1 : 0;
  if (has(req, "reference_image_urls")) {
    const aliases = list(req.reference_image_urls, "reference_image_urls", 7).map(function (item, i) {
      return imageInput(item, "reference_image_urls[" + i + "]", true);
    });
    const existing = has(req, "reference_images") ? list(req.reference_images, "reference_images", 7) : [];
    req.reference_images = existing.concat(aliases);
    delete req.reference_image_urls;
  }
  if (has(req, "reference_images")) {
    req.reference_images = list(req.reference_images, "reference_images", 7).map(function (item, i) {
      return imageInput(item, "reference_images[" + i + "]", !official || driver);
    });
    count += req.reference_images.length;
  }
  if (has(req, "last_frame")) {
    req.last_frame = imageInput(req.last_frame, "last_frame", !official);
    count++;
  }
  if (has(req, "keyframes")) {
    const slots = [];
    req.keyframes = list(req.keyframes, "keyframes", 4).map(function (frame, i) {
      onlyKeys(frame, ["image", "timestamp_s"], "keyframes[" + i + "]");
      const time = frame.timestamp_s;
      const slot = Math.round(time * 3);
      if (typeof time !== "number" || !Number.isFinite(time) || time <= 0 || time >= length || slot <= 0 || slot >= length * 3 || slots.indexOf(slot) >= 0) {
        throw new Error("Keyframe timestamps must be inside duration and occupy different 1/3-second slots");
      }
      slots.push(slot);
      return { image: imageInput(frame.image, "keyframes[" + i + "].image", !official), timestamp_s: time };
    });
    count += req.keyframes.length;
  }
  if (has(req, "reference_audios")) {
    req.reference_audios = list(req.reference_audios, "reference_audios", 3).map(function (audio, i) {
      const name = "reference_audios[" + i + "]";
      onlyKeys(audio, ["url", "voice_id"], name);
      const url = audio.url !== undefined && audio.url !== null;
      const voice = audio.voice_id !== undefined && audio.voice_id !== null;
      if (url === voice) throw new Error(name + " requires exactly one of url or voice_id");
      return url ? { url: mediaUrl(audio.url, name + ".url", "audio") } : { voice_id: text(audio.voice_id, name + ".voice_id") };
    });
  }
  if (has(req, "generate_audio") && typeof req.generate_audio !== "boolean") throw new Error("generate_audio must be boolean");
  const references = (req.reference_images || []).length + (req.reference_audios || []).length;
  const pins = !!req.last_frame || (req.keyframes || []).length > 0;
  const referenceMode = references > 0 || pins;
  if (model === "grok-imagine-video" && (pins || (req.reference_audios || []).length || image && references)) {
    throw new Error("This reference/frame combination requires grok-imagine-video-1.5");
  }
  if (resolution === "1080p" && (model === "grok-imagine-video" || referenceMode)) {
    throw new Error("1080p requires a 1.5 text-to-video or single-image request");
  }
  if (has(req, "prompt") && typeof req.prompt !== "string") throw new Error("prompt must be a string");
  if (!trimmed(req.prompt)) throw new Error("prompt is required");
  if (has(req, "user")) text(req.user, "user");
  if (has(req, "output")) {
    onlyKeys(req.output, ["upload_url"], "output");
    const url = mediaUrl(req.output.upload_url, "output.upload_url", "video");
    if (!/^https?:\/\//i.test(url)) throw new Error("output.upload_url must be HTTP(S)");
  }
  if (has(req, "storage_options")) {
    onlyKeys(req.storage_options, ["filename", "expires_after", "public_url"], "storage_options");
    text(req.storage_options.filename, "storage_options.filename");
    if (req.storage_options.expires_after != null) integer(req.storage_options.expires_after, "storage_options.expires_after", 1, 2592000);
    const publicUrl = req.storage_options.public_url;
    if (publicUrl != null && typeof publicUrl !== "boolean") {
      onlyKeys(publicUrl, ["expires_after"], "storage_options.public_url");
      if (publicUrl.expires_after != null) integer(publicUrl.expires_after, "public_url.expires_after", 3600, 2592000);
    }
  }
  req.resolution = resolution;
  // Advanced native fields must not go through CPA's lossy OpenAI converter.
  const nativeBody = official || has(req, "duration") || pins || has(req, "reference_audios") || has(req, "generate_audio") ||
    has(req, "output") || has(req, "storage_options") || (image && image.file_id) ||
    (req.reference_images || []).some(function (item) { return !!item.file_id; }) ||
    (!!image && references > 0) || resolution === "1080p";
  delete req.duration;
  delete req.seconds;
  if (nativeBody) {
    req.duration = length;
    delete req.size;
  } else {
    req.seconds = String(length);
    // CPA accepts only its four legacy sizes; explicit resolution/aspect carry other sizes.
    if (has(req, "size") && ["720x1280", "1280x720", "1024x1792", "1792x1024"].indexOf(req.size) < 0) delete req.size;
  }
  return {
    body: req,
    usage: { seconds: length, resolution: resolution, image_count: count },
    action: count > 0 ? "image_to_video" : "text_to_video",
    nativeBody: nativeBody
  };
}

function driverRequest(ctx) {
  const req = ctx.requestBody || {};
  return normalizeRequest(req, ctx.upstreamModel || ctx.model, !has(req, "seconds") && has(req, "duration"), true);
}

export function extractUsage(ctx) {
  return driverRequest(ctx).usage;
}

export function extractUsageOnComplete(ctx, result, body) {
  const data = body && typeof body === "object" ? body : result && result.data || {};
  const video = data.video && typeof data.video === "object" ? data.video : {};
  const facts = {};
  const raw = video.duration !== undefined ? video.duration : data.duration !== undefined ? data.duration : data.seconds;
  const duration = typeof raw === "number" || typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (Number.isFinite(duration) && duration > 0 && duration <= 15) facts.seconds = duration;
  let resolution = video.resolution || data.resolution;
  if (!resolution && data.size) {
    try {
      resolution = sizeSpec(data.size).resolution;
    } catch (error) {
      resolution = "";
    }
  }
  if (["480p", "720p", "1080p"].indexOf(resolution) >= 0 &&
      !(resolution === "1080p" && (ctx.upstreamModel || ctx.model) === "grok-imagine-video")) facts.resolution = resolution;
  return Object.keys(facts).length ? facts : null;
}

export function buildSubmitRequest(ctx) {
  const normalized = driverRequest(ctx);
  const req = normalized.body;
  return {
    url: baseUrl(ctx.baseUrl) + (normalized.nativeBody ? "/v1/videos/generations" : "/v1/videos"),
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

function decodeVideo(ctx, official) {
  if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON object required");
  const input = object(ctx.body.value, "request");
  const model = official ? text(input.model, "model") : ctx.model;
  if (official && meta.models.indexOf(model) < 0) throw new Error("Unsupported xAI video model");
  const normalized = normalizeRequest(input, ctx.upstreamModel || model, official);
  return {
    kind: "submit",
    model: model,
    action: normalized.action,
    requestBody: Object.assign({}, normalized.body, { model: model })
  };
}

export const native = {
  generateVideo: function (ctx) { return decodeVideo(ctx, true); },
  videoCreated: function (ctx, task) { return { request_id: task.task_id }; }
};

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      return decodeVideo(ctx, false);
    },
    render: function (ctx, task) {
      return task && task.data || {};
    }
  }
};
