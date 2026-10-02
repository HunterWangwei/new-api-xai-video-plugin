import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as plugin from "./plugin.js";

test("keeps the xAI video routing contract", () => {
  assert.deepEqual(plugin.meta.channelTypes, [48]);
  assert.deepEqual(plugin.meta.models, [
    "grok-imagine-video-1.5",
    "grok-imagine-video-1.5-preview",
    "grok-imagine-video"
  ]);
  assert.equal(plugin.meta.fetchMode, "per_task");
  assert.deepEqual(plugin.meta.protocols, ["openai_video"]);
  assert.equal(typeof plugin.protocols.openai_video.decodeRequest, "function");
  assert.equal(typeof plugin.protocols.openai_video.render, "function");
  assert.equal(plugin.meta.usageSchema.seconds.unit, "second");
  assert.deepEqual(plugin.meta.usageSchema.resolution.enum, ["480p", "720p", "1080p"]);
  assert.equal(plugin.meta.usageSchema.image_count.unit, "count");
  for (const example of plugin.meta.usageExamples) {
    assert.deepEqual(Object.keys(example.facts).sort(), Object.keys(plugin.meta.usageSchema).sort());
  }
});

test("extracts readable duration, resolution, and image facts", () => {
  const usage = (model, requestBody) => plugin.extractUsage({ model, requestBody: { prompt: "test", ...requestBody } });
  assert.deepEqual(usage("grok-imagine-video-1.5", { prompt: "test", seconds: 6, size: "854x480" }), { seconds: 6, resolution: "480p", image_count: 0 });
  assert.deepEqual(usage("grok-imagine-video-1.5-preview", { prompt: "test", seconds: "6", size: "1280x720" }), { seconds: 6, resolution: "720p", image_count: 0 });
  assert.deepEqual(usage("grok-imagine-video-1.5", { seconds: 6, resolution: "1080p", image: "https://example.com/a.png" }), { seconds: 6, resolution: "1080p", image_count: 1 });
  assert.deepEqual(usage("grok-imagine-video", { seconds: 6, size: "1280x720", input_reference: "https://example.com/a.png" }), { seconds: 6, resolution: "720p", image_count: 1 });
  assert.deepEqual(usage("grok-imagine-video", { prompt: "test", seconds: 6, size: "640x480" }), { seconds: 6, resolution: "480p", image_count: 0 });
  assert.deepEqual(usage("grok-imagine-video-1.5", { prompt: "test" }), { seconds: 6, resolution: "720p", image_count: 0 });
});

test("reads official duration and reference image fields", () => {
  assert.deepEqual(plugin.extractUsage({
    model: "grok-imagine-video-1.5",
    requestBody: {
      prompt: "test",
      duration: 15,
      aspect_ratio: "3:2",
      resolution: "720p",
      reference_images: [{ url: "https://example.com/a.png" }]
    }
  }), { seconds: 15, resolution: "720p", image_count: 1 });

  assert.deepEqual(plugin.extractUsage({
    model: "grok-imagine-video-1.5",
    requestBody: {
      prompt: "test",
      duration: 12,
      image: { url: "https://example.com/a.png" },
      last_frame: { url: "https://example.com/b.png" },
      keyframes: [
        { image: { url: "https://example.com/c.png" }, timestamp_s: 4 }
      ]
    }
  }), { seconds: 12, resolution: "480p", image_count: 3 });
});

test("strictly rejects contradictory, unsupported, and out-of-range parameters", () => {
  assert.throws(() => plugin.extractUsage({
    model: "grok-imagine-video-1.5",
    requestBody: { duration: 15, seconds: 6 }
  }), /must agree/);
  assert.throws(() => plugin.extractUsage({
    model: "grok-imagine-video-1.5",
    requestBody: { duration: 16 }
  }), /between 1 and 15/);
  assert.throws(() => plugin.extractUsage({
    model: "grok-imagine-video-1.5",
    requestBody: { duration: 8, unexpected: true }
  }), /Unsupported field/);
  assert.throws(() => plugin.extractUsage({
    model: "grok-imagine-video",
    requestBody: { duration: 8, resolution: "1080p" }
  }), /requires a 1.5/);
});

test("uses mapped upstream model for resolution normalization", () => {
  assert.deepEqual(plugin.extractUsage({
    model: "alias",
    upstreamModel: "grok-imagine-video",
    requestBody: { prompt: "test", seconds: 6, size: "1792x1024" }
  }), { seconds: 6, resolution: "720p", image_count: 0 });
});

test("overlays only explicit completed duration or resolution", () => {
  assert.deepEqual(plugin.extractUsageOnComplete({}, {}, {
    seconds: 8, resolution: "480p"
  }), { seconds: 8, resolution: "480p" });
  assert.deepEqual(plugin.extractUsageOnComplete({}, { data: {
    duration: "10", size: "1280x720"
  } }, null), { seconds: 10, resolution: "720p" });
  assert.deepEqual(plugin.extractUsageOnComplete({ model: "grok-imagine-video" }, {}, {
    size: "1792x1024"
  }), { resolution: "720p" });
  assert.deepEqual(plugin.extractUsageOnComplete({}, {}, {
    video: { duration: 15, resolution: "720p" }
  }), { seconds: 15, resolution: "720p" });
});

test("keeps requested facts when response contains only ticks", () => {
  assert.equal(plugin.extractUsageOnComplete({}, {}, {
    usage: { cost_in_usd_ticks: 4800000000 }
  }), null);
  assert.equal(plugin.extractUsageOnComplete({}, {}, {
    duration: -1, size: "unknown"
  }), null);
});

test("documented expressions charge by seconds and resolution", async () => {
  const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
  const expressions = [...readme.matchAll(/```text\n(u\("resolution"\).*?)\n```/g)].map(match => match[1]);
  assert.equal(expressions.length, 2);
  const price = (expr, facts) => Number(new Function("u", "tier", "return " + expr)(
    key => facts[key], (_label, amount) => amount
  ).toFixed(4));
  assert.equal(price(expressions[0], { seconds: 6, resolution: "480p", image_count: 0 }), 0.48);
  assert.equal(price(expressions[0], { seconds: 6, resolution: "720p", image_count: 0 }), 0.84);
  assert.equal(price(expressions[0], { seconds: 6, resolution: "1080p", image_count: 1 }), 1.51);
  assert.equal(price(expressions[1], { seconds: 6, resolution: "480p", image_count: 0 }), 0.3);
  assert.equal(price(expressions[1], { seconds: 6, resolution: "720p", image_count: 1 }), 0.422);
});

test("preserves submit, status, artifact, and protocol behavior", () => {
  const ctx = {
    baseUrl: "https://proxy.example/",
    apiKey: "placeholder",
    model: "grok-imagine-video-1.5-preview",
    requestBody: { prompt: "test", seconds: 6 }
  };
  const submit = plugin.buildSubmitRequest(ctx);
  assert.equal(submit.url, "https://proxy.example/v1/videos");
  assert.equal(submit.body.model, ctx.model);
  assert.equal(plugin.parseSubmitResponse(ctx, { body: { id: "task_1" } }).taskId, "task_1");
  assert.equal(plugin.buildQueryRequest({ ...ctx, taskId: "task_1" }).method, "GET");
  const task = plugin.parseTaskResult(ctx, {
    status: "completed",
    video: { url: "https://vidgen.x.ai/video.mp4" }
  });
  assert.equal(task.status, "SUCCESS");
  assert.equal(plugin.listArtifacts(task).length, 1);
  assert.deepEqual(plugin.buildContentRequest({
    artifactKey: "video",
    data: task.data
  }), {
    url: "https://vidgen.x.ai/video.mp4",
    method: "GET",
    credentialless: true
  });
  assert.equal(plugin.protocols.openai_video.decodeRequest({
    model: ctx.model,
    body: { kind: "json", value: { prompt: "test" } }
  }).kind, "submit");
});

test("supports the official-format alias without changing the legacy route", () => {
  assert.deepEqual(plugin.meta.routes, [{
    method: "POST",
    path: "/xai/v1/videos/generations",
    type: "submit",
    decode: "generateVideo",
    render: "videoCreated"
  }]);

  const ctx = {
    model: "grok-imagine-video-1.5",
    body: {
      kind: "json",
      value: {
        model: "grok-imagine-video-1.5",
        prompt: "test",
        duration: 15,
        resolution: "720p",
        reference_images: [{ url: "https://example.com/a.png" }]
      }
    }
  };
  const decoded = plugin.native.generateVideo(ctx);
  assert.equal(decoded.kind, "submit");
  assert.equal(decoded.requestBody.model, "grok-imagine-video-1.5");
  assert.equal(decoded.requestBody.duration, 15);
  assert.equal(decoded.requestBody.reference_images.length, 1);
  assert.equal(plugin.native.videoCreated({}, { task_id: "req_1" }).request_id, "req_1");

  const legacy = plugin.protocols.openai_video.decodeRequest({
    model: "grok-imagine-video-1.5",
    body: { kind: "json", value: { prompt: "test", seconds: 6 } }
  });
  assert.equal(legacy.kind, "submit");
  assert.equal(legacy.requestBody.seconds, "6");
});

test("native route avoids rc.37 cross-method static video path conflicts", () => {
  // Mirrors routePatternsIntersect / routeIntersectsStaticRoute in:
  // QuantumNous/new-api v1.0.0-rc.37 router/plugin-router.go.
  // This is a regression model, not an execution of the Go router.
  const intersects = (leftPath, rightPath) => {
    const left = leftPath.replace(/^\//, "").split("/");
    const right = rightPath.replace(/^\//, "").split("/");
    for (let i = 0; ; i++) {
      if (i >= left.length || i >= right.length) {
        return i >= left.length && i >= right.length;
      }
      if (left[i].startsWith("*") || right[i].startsWith("*")) return true;
      const ld = left[i].startsWith(":");
      const rd = right[i].startsWith(":");
      if (!ld && !rd && left[i] !== right[i]) return false;
      if ((ld && right[i] === "") || (rd && left[i] === "")) return false;
    }
  };
  const collides = (path, staticPath) => {
    if (intersects(path, staticPath)) return true;
    const wildcard = staticPath.lastIndexOf("/*");
    if (wildcard >= 0 && wildcard + 2 < staticPath.length) {
      const prefix = staticPath.slice(0, wildcard);
      return intersects(path, prefix) || intersects(path, prefix + "/");
    }
    if (staticPath === "/") return false;
    return intersects(path, staticPath.endsWith("/") ? staticPath.slice(0, -1) : staticPath + "/");
  };
  const staticRoutes = [
    { method: "POST", path: "/v1/videos" },
    { method: "GET", path: "/v1/videos/:task_id" },
    { method: "GET", path: "/v1/videos/:task_id/content" },
    { method: "HEAD", path: "/v1/videos/:task_id/content" }
  ];
  assert.equal(collides("/v1/videos/generations", staticRoutes[1].path), true);
  for (const route of plugin.meta.routes) {
    for (const existing of staticRoutes) {
      assert.equal(collides(route.path, existing.path), false,
        `${route.method} ${route.path} intersects ${existing.method} ${existing.path}`);
    }
  }
  const intent = plugin.native.generateVideo({
    body: { kind: "json", value: {
      model: "grok-imagine-video-1.5", prompt: "test", duration: 15,
      resolution: "720p", reference_images: [{ url: "https://example.com/a.png" }]
    } }
  });
  const ctx = { ...intent, baseUrl: "https://proxy.example", apiKey: "placeholder" };
  assert.equal(plugin.buildSubmitRequest(ctx).url, "https://proxy.example/v1/videos/generations");
  assert.deepEqual(plugin.extractUsage(ctx), { seconds: 15, resolution: "720p", image_count: 1 });
});

test("routes advanced official requests to the native xAI endpoint", () => {
  const submit = plugin.buildSubmitRequest({
    baseUrl: "https://proxy.example/",
    apiKey: "placeholder",
    model: "grok-imagine-video-1.5",
    requestBody: {
      prompt: "test",
      duration: 15,
      reference_images: [{ url: "https://example.com/a.png" }]
    }
  });
  assert.equal(submit.url, "https://proxy.example/v1/videos/generations");
  assert.equal(submit.body.duration, 15);
  assert.equal(submit.body.reference_images.length, 1);
  assert.equal("seconds" in submit.body, false);
});

test("both entry surfaces keep submit body and billing consistent", () => {
  const model = "grok-imagine-video-1.5-preview";
  const image = { url: "https://example.com/a.png" };
  const cases = [
    { duration: 15, reference_images: [image], resolution: "720p", aspect_ratio: "3:2" },
    { duration: 15, seconds: "15", reference_images: [image], resolution: "720p" },
    { seconds: "6", resolution: "720p", image },
    { seconds: 6, image, last_frame: image, resolution: "720p" },
    { duration: 8, resolution: "1080p" },
    {}
  ];
  for (const official of [false, true]) {
    for (const request of cases) {
      const body = { model, prompt: "test", ...request };
      const decode = official ? plugin.native.generateVideo : plugin.protocols.openai_video.decodeRequest;
      const intent = decode({ model, body: { kind: "json", value: body } });
      const ctx = { ...intent, baseUrl: "https://proxy.example", apiKey: "placeholder" };
      const facts = plugin.extractUsage(ctx);
      const submit = plugin.buildSubmitRequest(ctx);
      assert.equal(Number(submit.body.duration || submit.body.seconds), facts.seconds);
      assert.equal(submit.body.resolution, facts.resolution);
      assert.equal(facts.seconds, request.duration || Number(request.seconds) || (official ? 8 : 6));
      assert.equal(facts.image_count, (request.image ? 1 : 0) + (request.last_frame ? 1 : 0) + (request.reference_images || []).length);
      assert.equal(intent.action, facts.image_count ? "image_to_video" : "text_to_video");
      if (official) assert.ok(submit.url.endsWith("/v1/videos/generations"));
    }
  }
});

test("preserves original driver signatures and task statuses", () => {
  for (const [name, arity] of Object.entries({
    buildSubmitRequest: 1, parseSubmitResponse: 2, buildQueryRequest: 1,
    parseTaskResult: 2, listArtifacts: 1, buildContentRequest: 1
  })) assert.equal(plugin[name].length, arity, name);
  for (const [input, output] of Object.entries({
    queued: "QUEUED", pending: "QUEUED",
    in_progress: "IN_PROGRESS", processing: "IN_PROGRESS", running: "IN_PROGRESS",
    completed: "SUCCESS", succeeded: "SUCCESS", success: "SUCCESS", done: "SUCCESS",
    failed: "FAILURE", error: "FAILURE", expired: "FAILURE",
    cancelled: "FAILURE", canceled: "FAILURE", unrecognized: "UNKNOWN"
  })) assert.equal(plugin.parseTaskResult({}, { status: input }).status, output);
  for (const field of ["id", "request_id", "task_id"]) {
    assert.equal(plugin.parseSubmitResponse({}, { body: { [field]: "upstream" } }).taskId, "upstream");
  }
});

test("legacy duration, size, and nested reference aliases are preserved", () => {
  const model = "grok-imagine-video-1.5";
  for (const imageFields of [
    { input_reference: { image_url: "https://example.com/a.png" } },
    { image: { image_url: { url: "https://example.com/a.png" } } },
    { reference_images: [{ image_url: { url: "https://example.com/a.png" } }] },
    { reference_image_urls: ["https://example.com/a.png"] },
    { imageUrl: "https://example.com/a.png" }
  ]) {
    const requestBody = { prompt: "test", duration: 15, size: "1280x720", ...imageFields };
    const ctx = { model, requestBody, baseUrl: "https://proxy.example" };
    assert.deepEqual(plugin.extractUsage(ctx), { seconds: 15, resolution: "720p", image_count: 1 });
    assert.equal(plugin.buildSubmitRequest(ctx).body.duration, 15);
    const intent = plugin.protocols.openai_video.decodeRequest({ model, body: { kind: "json", value: requestBody } });
    assert.deepEqual(plugin.extractUsage({ ...ctx, ...intent }), plugin.extractUsage(ctx));
  }
});

test("rejects invalid arrays, nested fields, and conflicting keyframe slots", () => {
  const ctx = { model: "grok-imagine-video-1.5", body: { kind: "json" } };
  const image = { url: "https://example.com/a.png" };
  for (const fields of [
    { reference_images: Array(8).fill(image) },
    { reference_images: {} },
    { reference_audios: Array(4).fill({ voice_id: "voice" }) },
    { image: { url: "not-a-url" } },
    { image: { ...image, unknown: true } },
    { generate_audio: "false" },
    { seconds: 6, duration: 15 },
    { keyframes: [{ image, timestamp_s: 0 }] },
    { keyframes: [{ image, timestamp_s: 3 }, { image, timestamp_s: 3.1 }] },
    { keyframes: Array(5).fill({ image, timestamp_s: 1 }) },
    { resolution: "1080p", reference_images: [image] },
    { size: "1280x720" },
    { duration: true },
    { duration: 1.5 },
    { duration: 0 },
    { duration: 16 }
  ]) {
    assert.throws(() => plugin.native.generateVideo({
      ...ctx, body: { kind: "json", value: { model: ctx.model, prompt: "test", ...fields } }
    }), undefined, JSON.stringify(fields));
  }
});
