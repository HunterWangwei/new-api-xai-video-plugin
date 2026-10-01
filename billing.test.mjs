import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("./plugin.js", import.meta.url), "utf8");
const plugin = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

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
  const usage = (model, requestBody) => plugin.extractUsage({ model, requestBody });
  assert.deepEqual(usage("grok-imagine-video-1.5", { seconds: 6, size: "854x480" }), { seconds: 6, resolution: "480p", image_count: 0 });
  assert.deepEqual(usage("grok-imagine-video-1.5-preview", { seconds: "6", size: "1280x720" }), { seconds: 6, resolution: "720p", image_count: 0 });
  assert.deepEqual(usage("grok-imagine-video-1.5", { seconds: 6, resolution: "1080p", image: "image" }), { seconds: 6, resolution: "1080p", image_count: 1 });
  assert.deepEqual(usage("grok-imagine-video", { seconds: 6, size: "1280x720", input_reference: "image" }), { seconds: 6, resolution: "720p", image_count: 1 });
  assert.deepEqual(usage("grok-imagine-video", { seconds: 6, size: "640x480" }), { seconds: 6, resolution: "480p", image_count: 0 });
  assert.deepEqual(usage("grok-imagine-video", { seconds: 6, resolution: "1080p" }), { seconds: 6, resolution: "720p", image_count: 0 });
  assert.deepEqual(usage("grok-imagine-video-1.5", {}), { seconds: 6, resolution: "720p", image_count: 0 });
});

test("uses mapped upstream model for resolution normalization", () => {
  assert.deepEqual(plugin.extractUsage({
    model: "alias",
    upstreamModel: "grok-imagine-video",
    requestBody: { seconds: 6, size: "1920x1080" }
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
    size: "1920x1080"
  }), { resolution: "720p" });
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
