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
  assert.equal(plugin.meta.usageSchema.cost_units.unit, "credit");
});

test("estimates each resolution and image input", () => {
  const usage = (model, requestBody) => plugin.extractUsage({ model, requestBody });
  assert.deepEqual(usage("grok-imagine-video-1.5", { seconds: 6, size: "854x480" }), { cost_units: 4800 });
  assert.deepEqual(usage("grok-imagine-video-1.5-preview", { seconds: "6", size: "1280x720" }), { cost_units: 8400 });
  assert.deepEqual(usage("grok-imagine-video-1.5", { seconds: 6, resolution: "1080p", image: "image" }), { cost_units: 15100 });
  assert.deepEqual(usage("grok-imagine-video", { seconds: 6, size: "1280x720", input_reference: "image" }), { cost_units: 4220 });
  assert.deepEqual(usage("grok-imagine-video", { seconds: 6, size: "640x480" }), { cost_units: 3000 });
  assert.deepEqual(usage("grok-imagine-video", { seconds: 6, resolution: "1080p" }), { cost_units: 4200 });
  assert.deepEqual(usage("grok-imagine-video-1.5", {}), { cost_units: 15000 });
});

test("uses mapped upstream model for estimation", () => {
  assert.deepEqual(plugin.extractUsage({
    model: "alias",
    upstreamModel: "grok-imagine-video",
    requestBody: { seconds: 6, size: "1280x720" }
  }), { cost_units: 4200 });
});

test("settles from measured ticks, including zero", () => {
  assert.deepEqual(plugin.extractUsageOnComplete({}, {}, {
    usage: { cost_in_usd_ticks: 4800000000 }
  }), { cost_units: 4800 });
  assert.deepEqual(plugin.extractUsageOnComplete({}, { data: {
    usage: { cost_in_usd_ticks: "3000000000" }
  } }, null), { cost_units: 3000 });
  assert.deepEqual(plugin.extractUsageOnComplete({}, {}, {
    usage: { cost_in_usd_ticks: 0 }
  }), { cost_units: 0 });
});

test("keeps reservation when measured ticks are missing or invalid", () => {
  for (const value of [undefined, "", -1, "bad", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(plugin.extractUsageOnComplete({}, {}, {
      usage: { cost_in_usd_ticks: value }
    }), null);
  }
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
