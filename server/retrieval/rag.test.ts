import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import express from "express";
import { once } from "node:events";
import { buildRagDocument } from "./rag-chunker.js";
import { parseRagUnits } from "./rag-parser.js";
import { ragTokenizer } from "./rag-tokenizer.js";
import { normalizeRagConfig } from "./rag-types.js";
import type { EmbeddingProvider } from "../providers/embedding-provider.js";
import type { AgentModel, AgentModelTurn } from "../domain/agent/types.js";

// This suite must never open the personal database, even when run alone.
const directory = mkdtempSync(join(tmpdir(), "xiwei-rag-"));
process.env.AI_SECRETARY_DB_PATH = join(directory, "test.db");
process.env.AI_SECRETARY_DOCUMENT_ROOT = join(directory, "documents");
process.env.AI_SECRETARY_ARTIFACT_ROOT = join(directory, "artifacts");
process.env.AI_SECRETARY_SECRET_DIRECTORY = join(directory, "secrets");
const { database, initializeDatabase } = await import("../db.js");
initializeDatabase();
const { indexKnowledgeContent, removeKnowledgeContent } = await import(
  "../vault.js"
);
const {
  ragConfig,
  ragDocument,
  activeGeneration,
  ragStatus,
  configHash,
} = await import("./rag-store.js");
const {
  retrieveKnowledge,
  retrieveKnowledgeLocal,
  readKnowledgeEvidence,
  browseKnowledge,
} = await import("./rag-service.js");
const { indexRagSemantic, semanticBoundaries } = await import(
  "./rag-semantic.js"
);
const { embeddingIdentity, cachedQueryEmbedding, clearRagQueryCache } =
  await import("./rag-providers.js");
const { rebuildRagIndex, rollbackRagIndex, recoverRagJobs } = await import(
  "./rag-jobs.js"
);
const seed = (path: string, content: string, title?: string) =>
  indexKnowledgeContent({
    relativePath: path,
    content,
    title,
    modifiedAt: new Date().toISOString(),
  });
const provider = (profile = "test-model"): EmbeddingProvider => ({
  model: "fake",
  dimension: 4,
  version: "v1",
  profileId: profile,
  async embed(texts) {
    return texts.map((text) =>
      text.includes("退款")
        ? [0, 1, 0, 0]
        : text.includes("交付")
          ? [1, 0, 0, 0]
          : [0, 0, 1, 0],
    );
  },
});
beforeEach(() => {
  clearRagQueryCache();
  database.exec(
    "DELETE FROM knowledge_documents; DELETE FROM projects; DELETE FROM rag_jobs; DELETE FROM app_settings WHERE key='rag_config'; DELETE FROM rag_sentence_vectors;",
  );
});
after(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("hierarchical chunks keep exact Unicode source ranges, ownership and token limits", () => {
  const content =
    "# 项目约束\n\n" +
    "必须完成验收，除非负责人书面批准。👩‍💻".repeat(130) +
    "\n\n## 交付\n\n" +
    "交付后保留回滚记录。".repeat(100);
  const built = buildRagDocument({
    id: "one",
    title: "项目约束",
    relativePath: "one.md",
    content,
  });
  assert.ok(built.parents.length > 4);
  const ids = new Set(built.parents.map((parent) => parent.id)),
    ranges = new Set<string>();
  for (const child of built.children) {
    assert.ok(ids.has(child.parentId));
    assert.equal(child.content, content.slice(child.start, child.end));
    assert.ok(child.tokens <= 200);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(child.content));
    assert.ok(!ranges.has(child.start + ":" + child.end));
    ranges.add(child.start + ":" + child.end);
    const parent = built.parents.find((item) => item.id === child.parentId)!;
    assert.ok(child.start >= parent.start && child.end <= parent.end);
  }
  for (const parent of built.parents) {
    assert.equal(
      parent.content,
      content.slice(parent.viewStart, parent.viewEnd),
    );
    assert.ok(parent.tokens <= 800);
    assert.ok(
      !parent.heading.includes("交付") ||
        parent.viewStart >= content.indexOf("交付后"),
    );
  }
  const noExtension = buildRagDocument(
    { id: "one", title: "项目约束", relativePath: "one.md", content },
    { parentTokens: 400, parentMaxTokens: 400 },
  );
  assert.ok(
    noExtension.parents.every(
      (parent) => ragTokenizer.count(parent.content) <= 400,
    ),
  );
});

test("tables, quoted CSV rows, code symbols and JSON paths retain structural locators", () => {
  const content =
    '# 工作表：预算\n\n| 名称 | 金额 |\n| --- | --- |\n| 设备 | 500 |\n| 耗材 | 100 |\n\n## 代码\n\n\x60\x60\x60ts\nimport {readFile} from "node:fs";\nexport function loadBudget(){return readFile;}\n\x60\x60\x60\n\n\x60\x60\x60json\n{"voice":{"timeout":300,"mode":"local"}}\n\x60\x60\x60\n\n\x60\x60\x60csv\nname,note\nA,"first\nsecond"\nB,ok\n\x60\x60\x60';
  const units = parseRagUnits(content),
    table = units.find(
      (unit) => unit.kind === "table" && unit.locator.rowStart === 2,
    )!;
  assert.match(table.prefix, /名称/);
  assert.equal(table.locator.sheet, "预算");
  assert.ok(
    units.some(
      (unit) =>
        unit.locator.symbol === "loadBudget" && unit.prefix.includes("node:fs"),
    ),
  );
  assert.ok(
    units.some(
      (unit) =>
        unit.locator.jsonPath === "$.voice.timeout" &&
        content.slice(unit.start, unit.end) === "300",
    ),
  );
  assert.ok(
    units.some(
      (unit) =>
        unit.prefix === "name,note" &&
        content.slice(unit.start, unit.end).includes("first\nsecond"),
    ),
  );
});

test("same layout stays stable when query budgets change, title changes create new identities", () => {
  const document = {
    id: "x",
    title: "原名",
    relativePath: "x.md",
    content: "# 正文\n\n测试边界。".repeat(80),
  };
  const a = buildRagDocument(document),
    b = buildRagDocument(document, { embeddingMs: 2000, contextTokens: 10000 }),
    c = buildRagDocument({ ...document, title: "新名字" });
  assert.deepEqual(
    a.parents.map((item) => item.id),
    b.parents.map((item) => item.id),
  );
  assert.notEqual(a.parents[0].id, c.parents[0].id);
  assert.equal(
    configHash(normalizeRagConfig()),
    configHash(normalizeRagConfig({ rerankMs: 1000 })),
  );
});

test("child retrieval retains two distant matching parent sections in one document", () => {
  const doc = seed(
    "项目/验收.md",
    "# 验收条件\n\n验收关键字：必须完成支付测试。\n\n" +
      "常规说明。".repeat(200) +
      "\n\n## 特殊验收\n\n验收关键字：如果合规未通过，不得上线。",
  );
  const result = retrieveKnowledgeLocal({ query: "验收关键字", limit: 6 });
  assert.ok(
    result.hits.filter((hit) => hit.documentId === doc.documentId).length >= 2,
  );
  assert.ok(result.hits.some((hit) => hit.excerpt.includes("不得上线")));
  for (const hit of result.hits) {
    const source = ragDocument(hit.documentId)!;
    assert.ok(hit.matchedRanges.length);
    assert.ok(
      hit.excerpt.includes(
        source.content.slice(
          hit.matchedRanges[0].start,
          hit.matchedRanges[0].end,
        ),
      ),
    );
    assert.equal(
      readKnowledgeEvidence(hit.parentId, hit.sourceRevision).sourceRevision,
      hit.sourceRevision,
    );
  }
});

test("exact paths, name browsing and no-evidence queries work without remote models", () => {
  seed(
    "代码/voice-config.ts.md",
    "# 语音参数\n\n\x60\x60\x60ts\nexport const idleTimeoutMs=300000;\n\x60\x60\x60",
  );
  assert.equal(
    retrieveKnowledgeLocal({ query: "打开代码/voice-config.ts.md" }).diagnostics
      .route,
    "exact",
  );
  assert.match(
    retrieveKnowledgeLocal({ query: "idleTimeoutMs" }).hits[0].excerpt,
    /300000/,
  );
  assert.equal(browseKnowledge({ query: "voice-config" }).length, 1);
  assert.equal(
    retrieveKnowledgeLocal({ query: "完全没有的火星矿场" }).hits.length,
    0,
  );
  assert.equal(retrieveKnowledgeLocal({ query: "你好" }).hits.length, 0);
  seed(
    "其他/voice.md",
    "# 其他语音参数\n\nidleTimeoutMs也可能出现在无关文档。",
  );
  const exact = retrieveKnowledgeLocal({
    query: "打开代码/voice-config.ts.md",
  });
  assert.ok(
    exact.hits.every((hit) => hit.relative_path === "代码/voice-config.ts.md"),
  );
  assert.ok(
    retrieveKnowledgeLocal({ query: "idleTimeoutMs", sourcePath: "." }).hits
      .length,
  );
});

test("current-project priority is preserved; explicit strict scope and path restrictions are separate", () => {
  for (const id of ["current", "other"])
    database
      .prepare(
        "INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES(?,?,'','','2026','2026')",
      )
      .run(id, id);
  const a = seed("当前/a.md", "# 当前材料\n\n共同关键词预算。"),
    b = seed("共享/b.md", "# 共享材料\n\n共同关键词预算。"),
    c = seed("其他/c.md", "# 其他材料\n\n共同关键词预算。");
  for (const [project, doc] of [
    ["current", a],
    ["other", c],
  ] as const)
    database
      .prepare(
        "INSERT INTO project_document_links(project_id,document_id,link_source,created_at) VALUES(?,?,'manual','2026')",
      )
      .run(project, doc.documentId);
  const defaultHits = retrieveKnowledgeLocal({
    query: "共同关键词预算",
    projectId: "current",
  }).hits;
  assert.deepEqual(
    defaultHits.map((hit) => hit.documentId),
    [a.documentId, b.documentId, c.documentId],
  );
  assert.ok(
    !retrieveKnowledgeLocal({
      query: "共同关键词预算",
      projectId: "current",
      config: { projectScope: "project" },
    }).hits.some((hit) => hit.documentId === c.documentId),
  );
  assert.deepEqual(
    retrieveKnowledgeLocal({
      query: "共同关键词预算",
      sourcePath: "共享",
    }).hits.map((hit) => hit.documentId),
    [b.documentId],
  );
  assert.throws(
    () =>
      readKnowledgeEvidence(
        defaultHits[2].parentId,
        defaultHits[2].sourceRevision,
        "current",
      ),
    /不属于/,
  );
});

test("updates, title changes, rollback of failed transactions and deletion invalidate old evidence", () => {
  const doc = seed("更新.md", "# 初稿\n\n甲方批准之前不能公开。");
  const old = retrieveKnowledgeLocal({ query: "甲方批准" }).hits[0];
  assert.ok(old);
  seed("更新.md", "# 改稿\n\n乙方批准之前不能公开。", "新标题");
  assert.throws(
    () => readKnowledgeEvidence(old.parentId, old.sourceRevision),
    /失效/,
  );
  assert.equal(
    retrieveKnowledgeLocal({ query: "甲方批准" }).hits.some((hit) =>
      hit.excerpt.includes("甲方"),
    ),
    false,
  );
  const next = retrieveKnowledgeLocal({ query: "乙方批准" }).hits[0];
  assert.equal(next.title, "新标题");
  database.exec("SAVEPOINT failed_edit");
  seed("更新.md", "# 错误版本\n\n绝不该查到的修改。");
  database.exec("ROLLBACK TO failed_edit; RELEASE failed_edit");
  assert.equal(
    readKnowledgeEvidence(next.parentId, next.sourceRevision).sourceRevision,
    next.sourceRevision,
  );
  removeKnowledgeContent(doc.relativePath);
  assert.throws(() => readKnowledgeEvidence(next.parentId), /失效/);
  assert.equal(ragStatus().children, 0);
});

test("context budget truncation preserves the actual matched child and exposes diagnostics", () => {
  seed(
    "长文本.md",
    "# 风险清单\n\n" +
      "这是背景说明，无需重复。".repeat(200) +
      "\n\n## 关键条款\n\n证据定位标识：不得在合同未签署时付款。" +
      "补充说明。".repeat(100),
  );
  const result = retrieveKnowledgeLocal({
    query: "证据定位标识",
    contextCounter: ragTokenizer,
    config: { contextTokens: 500, contextBytes: 2000 },
  });
  assert.ok(result.hits.length);
  assert.ok(result.hits[0].excerpt.includes("不得在合同未签署时付款"));
  assert.ok(result.diagnostics.tokenCount <= 500);
  assert.ok(
    result.hits.reduce((sum, hit) => sum + Buffer.byteLength(hit.excerpt), 0) <=
      2000,
  );
});

test("CRLF fences keep original offsets and byte-budget packing is explicit", () => {
  const content =
    '# 配置\r\n\r\n```typescript\r\nexport function readDevice(){\r\n  return "microphone";\r\n}\r\n```';
  const units = parseRagUnits(content),
    symbol = units.find((unit) => unit.locator.symbol === "readDevice")!;
  assert.ok(symbol);
  assert.match(content.slice(symbol.start, symbol.end), /\r\n/);
  assert.equal(symbol.locator.startLine, 4);
  seed("crlf.md", content);
  const result = retrieveKnowledgeLocal({ query: "readDevice" });
  assert.equal(result.diagnostics.contextTokenizerId, "utf8-byte-budget-v1");
  assert.ok(result.hits.length);
  assert.ok(result.diagnostics.tokenCount <= 6000);
});

test("queries do not build missing layouts and project-tool scope cannot expose unreadable documents", async () => {
  const first = seed("current.md", "# 项目内容\n\n权限检索测试。"),
    other = seed("other.md", "# 其他内容\n\n权限检索测试。");
  database
    .prepare(
      "INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES('scope','scope','','','2026','2026')",
    )
    .run();
  database
    .prepare(
      "INSERT INTO project_document_links(project_id,document_id,link_source,created_at) VALUES('scope',?,'manual','2026')",
    )
    .run(first.documentId);
  const { executeSkillTool } = await import(
    "../domain/skills/skill-tool-registry.js"
  );
  const scoped = (await executeSkillTool(
    "retrieve_knowledge",
    { query: "权限检索测试" },
    { projectId: "scope", vaultPath: "" },
  )) as { hits: Array<{ documentId: string }> };
  assert.deepEqual(
    scoped.hits.map((hit) => hit.documentId),
    [first.documentId],
  );
  database
    .prepare("DELETE FROM rag_active WHERE document_id=?")
    .run(other.documentId);
  const result = retrieveKnowledgeLocal({ query: "其他内容" });
  assert.equal(result.diagnostics.indexPending, 1);
  assert.equal(activeGeneration(other.documentId), undefined);
  assert.ok(result.diagnostics.warnings.length);
  const off = retrieveKnowledgeLocal({
    query: "权限检索测试",
    config: { enabled: false },
  });
  assert.equal(off.hits.length, 0);
  assert.match(off.diagnostics.warnings[0], /停用/);
});

test("invalid or timed-out reranking preserves fused evidence and cancellation propagates", async () => {
  seed("rerank-a.md", "# 第一个\n\n共同证据需要批准。");
  seed("rerank-b.md", "# 第二个\n\n共同证据需要复核。");
  const result = await retrieveKnowledge({
    query: "共同证据",
    config: { rerankMs: 25, totalMs: 200 },
    providers: {
      embeddingProvider: null,
      rerankerProvider: {
        model: "never",
        async rerank() {
          return new Promise(() => {});
        },
      },
    },
  });
  assert.equal(result.diagnostics.rerankFallback, true);
  assert.equal(result.hits.length, 2);
  const invalid = await retrieveKnowledge({
    query: "共同证据",
    providers: {
      embeddingProvider: null,
      rerankerProvider: {
        model: "invalid",
        async rerank() {
          return [
            { index: -1, score: 1 },
            { index: 999, score: Infinity },
          ];
        },
      },
    },
  });
  assert.equal(invalid.diagnostics.rerankFallback, true);
  assert.equal(invalid.hits.length, 2);
});

test("uncompleted embeddings and another provider namespace never leak into semantic results", async () => {
  const doc = seed("向量.md", "# 匿名标题\n\n交付必须书面确认。"),
    model = provider();
  const generation = activeGeneration(doc.documentId)!;
  const child = database
    .prepare("SELECT id FROM rag_children WHERE generation_id=? LIMIT 1")
    .get(String(generation.id))!;
  database
    .prepare(
      "INSERT INTO rag_embeddings(child_id,profile_id,model,dimension,version,embedding_json,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      String(child.id),
      embeddingIdentity(model),
      model.model,
      4,
      "v1",
      JSON.stringify([1, 0, 0, 0]),
      "2026",
    );
  database
    .prepare(
      "INSERT INTO rag_embedding_state(generation_id,profile_id,status,updated_at) VALUES(?,?,'indexing','2026')",
    )
    .run(String(generation.id), embeddingIdentity(model));
  const pending = await retrieveKnowledge({
    query: "release",
    providers: { embeddingProvider: model, rerankerProvider: null },
  });
  assert.equal(pending.hits.length, 0);
  await indexRagSemantic(model, doc.documentId);
  const indexed = await retrieveKnowledge({
    query: "release",
    providers: { embeddingProvider: model, rerankerProvider: null },
  });
  assert.ok(indexed.hits.length);
  const other = await retrieveKnowledge({
    query: "release",
    providers: {
      embeddingProvider: provider("other-profile"),
      rerankerProvider: null,
    },
  });
  assert.equal(other.hits.length, 0);
  const malformed: EmbeddingProvider = {
    ...model,
    profileId: "bad-dim",
    async embed() {
      return [[1, 0]];
    },
  };
  const degraded = await retrieveKnowledge({
    query: "书面确认",
    providers: { embeddingProvider: malformed, rerankerProvider: null },
  });
  assert.ok(degraded.hits.length);
  assert.equal(degraded.diagnostics.embeddingFallback, true);
});

test("remote calls that ignore abort still meet the retrieval fallback deadline", async () => {
  const doc = seed("超时.md", "# 时限\n\n交付必须书面确认。");
  await indexRagSemantic(provider("never"), doc.documentId);
  const never: EmbeddingProvider = {
      ...provider("never"),
      async embed() {
        return new Promise(() => {});
      },
    },
    started = performance.now();
  const result = await retrieveKnowledge({
    query: "书面确认",
    config: { embeddingMs: 30, totalMs: 250, rerankMs: 30 },
    providers: {
      embeddingProvider: never,
      rerankerProvider: {
        model: "never",
        async rerank() {
          return new Promise(() => {});
        },
      },
    },
  });
  assert.ok(performance.now() - started < 450);
  assert.ok(result.hits.length);
  assert.equal(result.diagnostics.embeddingFallback, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    retrieveKnowledge({ query: "书面确认", signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("query vectors are cached per model profile and concurrent readers share one call", async () => {
  let calls = 0;
  const model: EmbeddingProvider = {
    ...provider("shared"),
    async embed(texts) {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return texts.map(() => [1, 0, 0, 0]);
    },
  };
  await Promise.all([
    cachedQueryEmbedding(model, "同一个问题", 100),
    cachedQueryEmbedding(model, "同一个问题", 100),
  ]);
  await cachedQueryEmbedding(model, "同一个问题", 100);
  assert.equal(calls, 1);
  await cachedQueryEmbedding(
    { ...model, profileId: "new-model" },
    "同一个问题",
    100,
  );
  assert.equal(calls, 2);
  await cachedQueryEmbedding({ ...model, version: "v2" }, "同一个问题", 100);
  assert.equal(calls, 3);
});

test("a real topic boundary produces a staged semantic generation with ready vectors", async () => {
  const content =
    "# 合同规则\n\n" +
    "交付验收安排。".repeat(180) +
    "\n\n" +
    "退款审批条件。".repeat(180);
  const model: EmbeddingProvider = {
    ...provider("topic-boundary"),
    async embed(texts) {
      return texts.map((text) =>
        text.includes("退款") ? [0, 1, 0, 0] : [1, 0, 0, 0],
      );
    },
  };
  const boundary = await semanticBoundaries(
    model,
    content,
    normalizeRagConfig(),
  );
  assert.ok(boundary.breaks.length > 0);
  const doc = seed("topic.md", content),
    before = activeGeneration(doc.documentId)!.id;
  const result = await indexRagSemantic(model, doc.documentId);
  assert.equal(result.semantic, true);
  assert.equal(result.stale, false);
  const generation = activeGeneration(doc.documentId)!;
  assert.notEqual(generation.id, before);
  assert.equal(generation.semantic, 1);
  assert.equal(
    database
      .prepare(
        "SELECT status FROM rag_embedding_state WHERE generation_id=? AND profile_id=?",
      )
      .get(String(generation.id), embeddingIdentity(model))?.status,
    "ready",
  );
  await rebuildRagIndex({ config: { embeddingMs: 900, parentLimit: 8 } });
  assert.equal(
    activeGeneration(doc.documentId)!.id,
    generation.id,
    "query-only options must preserve the semantic generation",
  );
});

test("embedding transport rejects duplicated indexes, invalid values and dimensions", async () => {
  const { OpenAICompatibleEmbeddingProvider } = await import(
    "../providers/embedding-provider.js"
  );
  const original = globalThis.fetch,
    model = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://fixture.invalid",
      apiKey: "fixture-only",
      model: "test",
      dimension: 4,
    });
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 0, 0, 0] },
            { index: 0, embedding: [0, 1, 0, 0] },
          ],
        }),
        { status: 200 },
      );
    await assert.rejects(model.embed(["a", "b"]), /返回顺序/);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [0, 0, 0, 0] }] }),
        { status: 200 },
      );
    await assert.rejects(model.embed(["a"]), /数值/);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1, 0, 0] },
            { index: 0, embedding: [1, 0, 0, 0] },
          ],
        }),
        { status: 200 },
      );
    assert.deepEqual(await model.embed(["a", "b"]), [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("a delayed semantic job cannot reactivate a changed or deleted document", async () => {
  const doc = seed("竞争.md", "# 文档\n\n交付必须书面确认。");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const delayed: EmbeddingProvider = {
    ...provider("delayed"),
    async embed(texts) {
      entered();
      await gate;
      return texts.map(() => [1, 0, 0, 0]);
    },
  };
  const pending = indexRagSemantic(delayed, doc.documentId);
  await started;
  seed("竞争.md", "# 文档\n\n退款必须书面确认。");
  const next = activeGeneration(doc.documentId)!.id;
  release();
  assert.equal((await pending).stale, true);
  assert.equal(activeGeneration(doc.documentId)!.id, next);
  const second = indexRagSemantic(delayed, doc.documentId);
  removeKnowledgeContent("竞争.md");
  assert.equal((await second).stale, true);
  assert.equal(activeGeneration(doc.documentId), undefined);
});

test("shadow rebuild fails without activation, swaps atomically and rollback skips changed sources", async () => {
  const a = seed("a.md", "# 甲\n\n交付条款。".repeat(80)),
    b = seed("b.md", "# 乙\n\n退款条款。".repeat(80));
  const original = activeGeneration(a.documentId)!.id;
  await assert.rejects(
    rebuildRagIndex({
      config: { parentTokens: 200 },
      onProgress() {
        throw new Error("simulate crash");
      },
    }),
    /simulate/,
  );
  assert.equal(activeGeneration(a.documentId)!.id, original);
  assert.equal(ragConfig().parentTokens, 400);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(rebuildRagIndex({ signal: controller.signal }), {
    name: "AbortError",
  });
  const rebuilt = await rebuildRagIndex({ config: { parentTokens: 200 } });
  assert.equal(ragConfig().parentTokens, 200);
  assert.notEqual(activeGeneration(a.documentId)!.id, original);
  seed("b.md", "# 乙\n\n退款已修改。");
  const changed = activeGeneration(b.documentId)!.source_hash;
  const rolled = rollbackRagIndex(rebuilt.id);
  assert.equal(rolled.restored, 1);
  assert.equal(activeGeneration(a.documentId)!.id, original);
  assert.equal(activeGeneration(b.documentId)!.source_hash, changed);
  database
    .prepare(
      "INSERT INTO rag_jobs(id,kind,status,created_at,updated_at) VALUES('lost','structure-rebuild','running','2026','2026')",
    )
    .run();
  recoverRagJobs();
  assert.equal(
    database.prepare("SELECT status FROM rag_jobs WHERE id='lost'").get()
      ?.status,
    "interrupted",
  );
});

test("selective semantic boundaries are cached and never split immediately before a condition", async () => {
  let calls = 0;
  const model: EmbeddingProvider = {
    ...provider("semantic"),
    async embed(texts) {
      calls++;
      return texts.map((_, index) => (index % 2 ? [1, 0, 0, 0] : [0, 1, 0, 0]));
    },
  };
  const content =
    "# 合同\n\n" +
    "常规交付说明。".repeat(200) +
    "\n\n但如果验收失败，不得付款。" +
    "退款条件和责任说明。".repeat(180);
  const config = normalizeRagConfig();
  const first = await semanticBoundaries(model, content, config);
  await semanticBoundaries(model, content, config);
  const after = calls;
  await semanticBoundaries(model, content, config);
  assert.equal(calls, after);
  assert.ok(
    first.breaks.every(
      (offset) => !content.slice(offset).trimStart().startsWith("但如果"),
    ),
  );
});

test("RAG routes validate config and return stale-source conflicts with the correct HTTP status", async () => {
  const { registerRagRoutes } = await import("./rag-api.js");
  const app = express();
  app.use(express.json());
  registerRagRoutes(app, () => new AbortController().signal);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number },
    base = "http://127.0.0.1:" + address.port;
  try {
    assert.equal(
      (
        await fetch(base + "/api/knowledge/rag/rebuild", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: { semantic: "yes" } }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(base + "/api/knowledge/rag/evidence/unknown")).status,
      409,
    );
    const status = (await (
      await fetch(base + "/api/knowledge/rag/status")
    ).json()) as { tokenizer: string };
    assert.match(status.tokenizer, /bge-m3/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Agent retrieval → evidence → current read → approval → patch → readback is closed", async () => {
  const { createKnowledgeDocument, getKnowledgeDocument } = await import(
    "../domain/documents/knowledge-document-editor.js"
  );
  const { executeSkillTool } = await import(
    "../domain/skills/skill-tool-registry.js"
  );
  const { createAgentRun, listAgentInvocations } = await import(
    "../domain/agent/run-store.js"
  );
  const { executeOfficeAgent, initialAgentCheckpoint } = await import(
    "../domain/agent/runtime.js"
  );
  const { confirmAction } = await import("../actions/action-service.js");
  const doc = createKnowledgeDocument({
    title: "本周评审",
    content: "# 本周评审\n\n评审定在周五。",
  });
  const goal = "将本周评审改成周六";
  database
    .prepare(
      "INSERT INTO conversations(id,scope_type,title,created_at,updated_at) VALUES('rag-agent','memory',?,'2026','2026')",
    )
    .run(goal);
  const run = createAgentRun({
    conversationId: "rag-agent",
    inputId: "rag-input",
    goal,
    projectId: null,
    model: "test",
    checkpoint: initialAgentCheckpoint([], goal),
  }).run;
  const call = (
    name: string,
    args: Record<string, unknown>,
  ): AgentModelTurn => ({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [
      {
        id: name,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const model: AgentModel = async (messages) => {
    const tools = messages.filter((message) => message.role === "tool"),
      last = tools.at(-1),
      names = messages.flatMap(
        (message) =>
          message.tool_calls?.map((item) => item.function.name) ?? [],
      );
    if (!names.includes("retrieve_knowledge"))
      return call("retrieve_knowledge", { query: "本周评审" });
    if (!names.includes("read_knowledge_evidence")) {
      const result = JSON.parse(last!.content!).result;
      assert.ok(result.hits[0].sourceRevision);
      return call("read_knowledge_evidence", {
        parentId: result.hits[0].parentId,
        sourceRevision: result.hits[0].sourceRevision,
      });
    }
    if (!names.includes("get_document"))
      return call("get_document", { documentId: doc.id });
    if (!names.includes("patch_document"))
      return call("patch_document", {
        documentId: doc.id,
        before: "评审定在周五。",
        after: "评审定在周六。",
      });
    return {
      content: "评审已更新为周六。",
      finishReason: "stop",
      toolCalls: [],
    };
  };
  let result = await executeOfficeAgent({
    runId: run.id,
    modelName: "test",
    model,
  });
  assert.equal(result.run.status, "waiting_approval");
  assert.match(String(getKnowledgeDocument(String(doc.id)).content), /周五/);
  assert.ok(
    result.run.checkpoint.sources.some(
      (source) => source.parentId && source.sourceRevision && !source.revision,
    ),
  );
  assert.ok(
    result.run.checkpoint.sources.some(
      (source) => source.revision && !source.parentId,
    ),
  );
  const pending = listAgentInvocations(run.id).find(
    (item) => item.status === "waiting_approval",
  )!;
  await confirmAction(pending.proposalId!);
  result = await executeOfficeAgent({
    runId: run.id,
    modelName: "test",
    model,
  });
  assert.equal(result.run.status, "completed");
  assert.match(String(getKnowledgeDocument(String(doc.id)).content), /周六/);
  await assert.rejects(
    Promise.resolve().then(() =>
      executeSkillTool(
        "patch_document",
        {
          documentId: doc.id,
          before: "周六",
          after: "周日",
          expectedRevision: "search-hit-is-not-a-read",
        },
        { vaultPath: "", confirmed: true },
      ),
    ),
    /尚未读取|已变化/,
  );
});
