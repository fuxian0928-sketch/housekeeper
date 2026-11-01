import type { Express, Request, Response } from "express";
import { ragStatus } from "./rag-store.js";
import { rebuildRagIndex, rollbackRagIndex } from "./rag-jobs.js";
import {
  retrieveKnowledge,
  browseKnowledge,
  readKnowledgeEvidence,
} from "./rag-service.js";
import { DEFAULT_RAG_CONFIG, type RagConfig } from "./rag-types.js";

const fail = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });
function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail("请提供对象参数。");
  return value as Record<string, unknown>;
}
function optionalText(value: unknown, max = 1000) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw fail("文字参数无效或过长。");
  return value;
}
function configInput(value: unknown): Partial<RagConfig> | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  for (const [key, item] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_RAG_CONFIG, key)) throw fail("未知检索配置项。");
    const expected = typeof DEFAULT_RAG_CONFIG[key as keyof RagConfig];
    if (
      typeof item !== expected ||
      (typeof item === "number" && !Number.isFinite(item))
    )
      throw fail("检索配置的类型不正确。");
  }
  if (
    input.projectScope !== undefined &&
    !["priority", "project"].includes(String(input.projectScope))
  )
    throw fail("项目范围配置无效。");
  return input as Partial<RagConfig>;
}
const error = (response: Response, value: unknown) =>
  response
    .status(Number((value as { statusCode?: number })?.statusCode) || 500)
    .json({
      message: value instanceof Error ? value.message : "检索处理未完成。",
    });
export function registerRagRoutes(
  app: Express,
  requestSignal: (request: Request, response: Response) => AbortSignal,
) {
  app.get("/api/knowledge/rag/status", (_request, response) =>
    response.json(ragStatus()),
  );
  app.post("/api/knowledge/rag/search", async (request, response) => {
    try {
      const body = object(request.body),
        query = optionalText(body.query, 2000);
      if (!query?.trim()) throw fail("请输入查询内容。");
      response.json(
        await retrieveKnowledge({
          query,
          projectId: optionalText(body.projectId, 160),
          sourcePath: optionalText(body.sourcePath),
          signal: requestSignal(request, response),
        }),
      );
    } catch (value) {
      error(response, value);
    }
  });
  app.get("/api/knowledge/rag/browse", (request, response) => {
    try {
      response.json(
        browseKnowledge({
          query: optionalText(request.query.query),
          projectId: optionalText(request.query.projectId, 160),
          sourcePath: optionalText(request.query.sourcePath),
        }),
      );
    } catch (value) {
      error(response, value);
    }
  });
  app.get("/api/knowledge/rag/evidence/:parentId", (request, response) => {
    try {
      response.json(
        readKnowledgeEvidence(
          request.params.parentId,
          optionalText(request.query.sourceRevision, 100),
          optionalText(request.query.projectId, 160),
        ),
      );
    } catch (value) {
      error(response, value);
    }
  });
  // Configuration and the new active layout switch atomically after the shadow build succeeds.
  app.post("/api/knowledge/rag/rebuild", async (request, response) => {
    try {
      response.json(
        await rebuildRagIndex({
          config: configInput(request.body?.config),
          signal: requestSignal(request, response),
        }),
      );
    } catch (value) {
      error(response, value);
    }
  });
  app.post("/api/knowledge/rag/rebuild/stream", async (request, response) => {
    try {
      const config = configInput(request.body?.config),
        signal = requestSignal(request, response);
      response.status(200).set({
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      const send = (event: unknown) => {
        if (!response.destroyed && !response.writableEnded)
          response.write(JSON.stringify(event) + "\n");
      };
      try {
        const result = await rebuildRagIndex({
          config,
          signal,
          onProgress: (current, total) =>
            send({ type: "progress", current, total }),
        });
        send({ type: "complete", result });
      } catch (value) {
        send({
          type: signal.aborted ? "cancelled" : "error",
          message: value instanceof Error ? value.message : "重建未完成。",
        });
      }
      response.end();
    } catch (value) {
      error(response, value);
    }
  });
  app.post("/api/knowledge/rag/rollback/:jobId", (request, response) => {
    try {
      response.json(rollbackRagIndex(request.params.jobId));
    } catch (value) {
      error(response, value);
    }
  });
}
