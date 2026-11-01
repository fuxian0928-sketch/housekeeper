import { database, sqliteVecAvailable } from "../db.js";
import { projectDocumentPriorities } from "./project-document-priority.js";
import { ragConfig, pendingRagDocuments, ragDocument } from "./rag-store.js";
import { lineNumber } from "./rag-parser.js";
import {
  ragHash,
  ragTokenizer,
  tokenHead,
  tokenTail,
  utf8ContextCounter,
  type TokenCounter,
} from "./rag-tokenizer.js";
import { cosine, hashVector, lexicalTerms } from "./rag-lexical.js";
import {
  bounded,
  cachedQueryEmbedding,
  configuredRagProviders,
  embeddingIdentity,
  type RagProviders,
} from "./rag-providers.js";
import {
  RAG_VERSION,
  normalizeRagConfig,
  type RagConfig,
  type RagDiagnostics,
  type RagHit,
  type RagLocator,
  type RagResult,
} from "./rag-types.js";
import type { SQLInputValue } from "node:sqlite";

export type SearchInput = {
  query: string;
  accessProjectId?: string | null;
  projectId?: string | null;
  sourcePath?: string | null;
  limit?: number;
  signal?: AbortSignal;
  config?: Partial<RagConfig>;
  providers?: RagProviders;
  contextCounter?: TokenCounter;
};
type Candidate = {
  child_id: string;
  parent_id: string;
  generation_id: string;
  document_id: string;
  title: string;
  relative_path: string;
  heading: string;
  child_content: string;
  child_prefix: string;
  child_start: number;
  child_end: number;
  source_hash: string;
  view_start: number;
  view_end: number;
  core_start: number;
  core_end: number;
  parent_prefix: string;
  locator_json: string;
  hash_vector_json: string;
  score?: number;
  rank?: number;
};
const from = `FROM rag_children c JOIN rag_active a ON a.generation_id=c.generation_id JOIN rag_generations g ON g.id=c.generation_id JOIN rag_parents p ON p.id=c.parent_id JOIN knowledge_documents d ON d.id=g.document_id`;
const columns = `c.id AS child_id,c.parent_id,c.generation_id,g.document_id,d.title,d.relative_path,c.heading,c.content AS child_content,c.prefix AS child_prefix,c.start_offset AS child_start,c.end_offset AS child_end,g.source_hash,p.view_start,p.view_end,p.core_start,p.core_end,p.prefix AS parent_prefix,p.locator_json,c.hash_vector_json`;
const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·。！？!?,，：:]+/g, "");
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });

function scope(input: SearchInput, config: RagConfig) {
  const parts: string[] = [],
    params: SQLInputValue[] = [];
  if (input.accessProjectId) {
    parts.push(
      "EXISTS(SELECT 1 FROM project_document_links access_link WHERE access_link.document_id=d.id AND access_link.project_id=?)",
    );
    params.push(input.accessProjectId);
  }
  if (input.projectId) {
    if (
      !database
        .prepare("SELECT id FROM projects WHERE id=? AND deleted_at IS NULL")
        .get(input.projectId)
    )
      throw fail("检索项目不存在。", 404);
    if (config.projectScope === "project") {
      parts.push(
        "(EXISTS(SELECT 1 FROM project_document_links l WHERE l.document_id=d.id AND l.project_id=?) OR NOT EXISTS(SELECT 1 FROM project_document_links l WHERE l.document_id=d.id))",
      );
      params.push(input.projectId);
    }
  }
  const path = (input.sourcePath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (path && path !== ".") {
    parts.push("(d.relative_path=? OR substr(d.relative_path,1,?)=?)");
    params.push(path, [...path].length + 1, `${path}/`);
  }
  return { where: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}
function exactDocuments(query: string, filter: ReturnType<typeof scope>) {
  const target = normalize(query),
    rows = database
      .prepare(
        `SELECT d.id,d.title,d.relative_path FROM knowledge_documents d JOIN rag_active a ON a.document_id=d.id WHERE 1=1${filter.where}`,
      )
      .all(...filter.params);
  return rows
    .filter((row) => {
      const title = normalize(String(row.title)),
        path = normalize(String(row.relative_path));
      return (
        (title.length >= 3 && (target === title || target.includes(title))) ||
        (path.length >= 5 && target.includes(path))
      );
    })
    .map((row) => String(row.id))
    .slice(0, 4);
}
function prepare(input: SearchInput) {
  const started = Date.now(),
    config = normalizeRagConfig({ ...ragConfig(), ...input.config }),
    deadline = started + config.totalMs,
    query = String(input.query ?? "")
      .trim()
      .slice(0, 2000);
  input.signal?.throwIfAborted();
  const diagnostics: RagDiagnostics = {
    version: RAG_VERSION,
    elapsedMs: 0,
    route: "hybrid",
    embeddingFallback: false,
    rerankFallback: false,
    indexPending: 0,
    candidateCount: 0,
    parentCount: 0,
    tokenCount: 0,
    tokenizerId: ragTokenizer.id,
    truncated: false,
    warnings: [],
  };
  if (!config.enabled)
    diagnostics.warnings.push("分层检索已停用；仍可使用目录与原文读取。");
  if (
    !config.enabled ||
    !query ||
    /^(?:你好|您好|谢谢|晚安|早上好)[呀啊哦呢！!。\s]*$/.test(query)
  )
    return {
      query: "",
      config,
      deadline,
      started,
      diagnostics,
      candidates: [] as Candidate[],
      filter: scope(input, config),
      exact: [] as string[],
    };
  // Queries never parse/rechunk the library. Startup/import jobs prepare layouts.
  diagnostics.indexPending = pendingRagDocuments(10001).length;
  if (diagnostics.indexPending)
    diagnostics.warnings.push(
      "部分文档的检索索引仍在准备，不能据此认定资料不存在。",
    );
  const filter = scope(input, config),
    exact = exactDocuments(query, filter),
    terms = [...new Set(lexicalTerms(query))]
      .filter(
        (term) =>
          ![
            "帮我",
            "请你",
            "一下",
            "什么",
            "这个",
            "那个",
            "现在",
            "需要",
            "是否",
            "查看",
          ].includes(term),
      )
      .slice(0, 40);
  const ranks: Candidate[][] = [];
  if (exact.length) {
    diagnostics.route = "exact";
    ranks.push(
      database
        .prepare(
          `SELECT ${columns} ${from} WHERE d.id IN (${exact.map(() => "?").join(",")})${filter.where} ORDER BY d.modified_at DESC,c.position LIMIT 160`,
        )
        .all(...exact, ...filter.params) as unknown as Candidate[],
    );
  }
  if (terms.length) {
    const match = terms
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" OR ");
    ranks.push(
      database
        .prepare(
          `SELECT ${columns},bm25(rag_children_fts) AS rank FROM rag_children_fts JOIN rag_children c ON c.id=rag_children_fts.child_id JOIN rag_active a ON a.generation_id=c.generation_id JOIN rag_generations g ON g.id=c.generation_id JOIN rag_parents p ON p.id=c.parent_id JOIN knowledge_documents d ON d.id=g.document_id WHERE rag_children_fts MATCH ?${filter.where} ORDER BY rank LIMIT ?`,
        )
        .all(
          match,
          ...filter.params,
          config.candidateLimit,
        ) as unknown as Candidate[],
    );
  }
  const rows = database
    .prepare(
      `SELECT ${columns} ${from} WHERE 1=1${filter.where} ORDER BY d.modified_at DESC,c.position LIMIT 801`,
    )
    .all(...filter.params) as unknown as Candidate[];
  if (rows.length > 800) {
    diagnostics.truncated = true;
    rows.pop();
  }
  const vector = hashVector(query),
    local = rows
      .filter((row) =>
        lexicalTerms(row.child_prefix + " " + row.child_content).some((term) =>
          terms.includes(term),
        ),
      )
      .map((row) => ({
        ...row,
        score: cosine(vector, JSON.parse(row.hash_vector_json)),
      }))
      .filter((row) => row.score! > 0.07)
      .sort((a, b) => b.score! - a.score!)
      .slice(0, config.candidateLimit);
  ranks.push(local);
  const candidates = fuse(ranks).filter(
    (row) => !exact.length || exact.includes(row.document_id),
  );
  diagnostics.candidateCount = candidates.length;
  return {
    query,
    config,
    deadline,
    started,
    diagnostics,
    candidates,
    filter,
    exact,
  };
}
function fuse(lists: Candidate[][]) {
  const rows = new Map<string, Candidate>();
  for (const list of lists)
    list.forEach((item, index) => {
      const prior = rows.get(item.child_id);
      rows.set(item.child_id, {
        ...item,
        score: (prior?.score ?? 0) + 1 / (60 + index + 1),
      });
    });
  return [...rows.values()].sort((a, b) => b.score! - a.score!);
}
function assemble(
  candidates: Candidate[],
  input: SearchInput,
  config: RagConfig,
  diagnostics: RagDiagnostics,
): RagHit[] {
  const counter = input.contextCounter ?? utf8ContextCounter;
  diagnostics.contextTokenizerId = counter.id;
  const priorities = input.projectId
      ? projectDocumentPriorities(input.projectId)
      : null,
    parents = new Map<string, Candidate[]>();
  for (const row of candidates) {
    const group = parents.get(row.parent_id) ?? [];
    group.push(row);
    parents.set(row.parent_id, group);
  }
  const ordered = [...parents.values()].sort((a, b) => {
    const tier = priorities
      ? (priorities.byId.get(a[0].document_id) ?? 2) -
        (priorities.byId.get(b[0].document_id) ?? 2)
      : 0;
    return (
      tier ||
      Math.max(...b.map((row) => row.score ?? 0)) +
        Math.min(b.length - 1, 2) * 0.001 -
        (Math.max(...a.map((row) => row.score ?? 0)) +
          Math.min(a.length - 1, 2) * 0.001)
    );
  });
  const hits: RagHit[] = [],
    covered = new Map<string, Array<{ start: number; end: number }>>();
  let remaining = config.contextTokens,
    remainingBytes = config.contextBytes;
  for (const group of ordered) {
    if (
      hits.length >=
      Math.min(
        config.parentLimit,
        Math.max(1, input.limit ?? config.parentLimit),
      )
    )
      break;
    const best = group[0],
      document = ragDocument(best.document_id);
    if (!document || ragHash(document.content) !== best.source_hash) continue;
    let start = best.view_start,
      end = best.view_end;
    const previous = covered.get(document.id) ?? [];
    for (const range of previous) {
      if (start >= range.start && end <= range.end) {
        start = end;
        break;
      }
      if (start < range.end && end > range.end && best.child_start >= range.end)
        start = range.end;
      if (
        end > range.start &&
        start < range.start &&
        best.child_end <= range.start
      )
        end = range.start;
    }
    if (start >= end) continue;
    const prefix = tokenHead(best.parent_prefix, 180, counter),
      overhead = counter.count(prefix) + 12;
    if (
      remaining < overhead + counter.count(best.child_content) ||
      remainingBytes < Buffer.byteLength(prefix + best.child_content) + 20
    ) {
      diagnostics.truncated = true;
      continue;
    }
    let raw = document.content.slice(start, end),
      excerpt = `${prefix}\n\n${raw}`;
    if (
      counter.count(excerpt) > remaining ||
      Buffer.byteLength(excerpt) > remainingBytes
    ) {
      start = best.child_start;
      end = best.child_end;
      const before = tokenTail(
          document.content.slice(best.view_start, start),
          Math.min(
            50,
            Math.max(
              0,
              remaining - overhead - counter.count(best.child_content),
            ),
          ),
          counter,
        ),
        after = tokenHead(
          document.content.slice(end, best.view_end),
          Math.min(
            50,
            Math.max(
              0,
              remaining - overhead - counter.count(best.child_content + before),
            ),
          ),
          counter,
        );
      start -= before.length;
      end += after.length;
      raw = document.content.slice(start, end);
      excerpt = `${prefix}\n\n${raw}`;
      diagnostics.truncated = true;
      if (
        counter.count(excerpt) > remaining ||
        Buffer.byteLength(excerpt) > remainingBytes
      ) {
        start = best.child_start;
        end = best.child_end;
        excerpt = `${prefix}\n\n${document.content.slice(start, end)}`;
      }
    }
    const tokenCount = counter.count(excerpt);
    if (tokenCount > remaining || Buffer.byteLength(excerpt) > remainingBytes)
      continue;
    const matched = group.filter(
      (row) => row.child_start >= start && row.child_end <= end,
    );
    if (!matched.length) continue;
    hits.push({
      id: document.id,
      documentId: document.id,
      title: document.title,
      relative_path: document.relativePath,
      excerpt,
      score: best.score ?? 0,
      parentId: best.parent_id,
      childIds: matched.map((row) => row.child_id),
      sourceRevision: best.source_hash,
      generationId: best.generation_id,
      startOffset: start,
      endOffset: end,
      locator: JSON.parse(best.locator_json) as RagLocator,
      matchedRanges: matched.map((row) => ({
        childId: row.child_id,
        start: row.child_start,
        end: row.child_end,
      })),
      tokenCount,
      projectTier: priorities?.byId.get(document.id) ?? 1,
      route:
        diagnostics.route === "exact"
          ? "exact"
          : diagnostics.embeddingFallback
            ? "keyword"
            : "hybrid",
    });
    remaining -= tokenCount;
    remainingBytes -= Buffer.byteLength(excerpt);
    covered.set(document.id, [...previous, { start, end }]);
  }
  diagnostics.parentCount = hits.length;
  diagnostics.tokenCount = config.contextTokens - remaining;
  if (!hits.length && diagnostics.truncated && candidates.length)
    diagnostics.warnings.push(
      "上下文预算不足以容纳完整命中子块；请增大预算或通过目录读取原文，不能将此视为资料不存在。",
    );
  return hits;
}
export function retrieveKnowledgeLocal(input: SearchInput): RagResult {
  const prepared = prepare(input);
  prepared.diagnostics.route = prepared.exact.length ? "exact" : "keyword";
  const hits = assemble(
    prepared.candidates,
    input,
    prepared.config,
    prepared.diagnostics,
  );
  prepared.diagnostics.elapsedMs = Date.now() - prepared.started;
  return { hits, diagnostics: prepared.diagnostics };
}
export async function retrieveKnowledge(
  input: SearchInput,
): Promise<RagResult> {
  const prepared = prepare(input),
    { query, config, diagnostics, filter, deadline } = prepared,
    providers = input.providers ?? configuredRagProviders();
  let candidates = prepared.candidates;
  const embedding = providers.embeddingProvider;
  const semanticReady =
    !!embedding &&
    !!query &&
    !prepared.exact.length &&
    !!database
      .prepare(
        `SELECT 1 ${from} JOIN rag_embeddings e ON e.child_id=c.id JOIN rag_embedding_state es ON es.generation_id=c.generation_id AND es.profile_id=e.profile_id AND es.status='ready' WHERE e.profile_id=? AND e.dimension=?${filter.where} LIMIT 1`,
      )
      .get(embeddingIdentity(embedding), embedding.dimension, ...filter.params);
  if (
    query &&
    !prepared.exact.length &&
    embedding &&
    semanticReady &&
    Date.now() < deadline
  ) {
    const provider = embedding;
    try {
      const vector = await cachedQueryEmbedding(
        provider,
        query,
        Math.min(config.embeddingMs, deadline - Date.now()),
        input.signal,
      );
      input.signal?.throwIfAborted();
      let dense: Candidate[] = [];
      const readyJoin =
        " JOIN rag_embedding_state es ON es.generation_id=c.generation_id AND es.profile_id=e.profile_id AND es.status='ready'";
      if (sqliteVecAvailable)
        dense = database
          .prepare(
            `SELECT ${columns},vec_distance_cosine(e.embedding_json,?) AS rank ${from} JOIN rag_embeddings e ON e.child_id=c.id${readyJoin} WHERE e.profile_id=? AND e.dimension=?${filter.where} ORDER BY rank LIMIT ?`,
          )
          .all(
            JSON.stringify(vector),
            embeddingIdentity(provider),
            provider.dimension,
            ...filter.params,
            config.candidateLimit,
          ) as unknown as Candidate[];
      else {
        const rows = database
          .prepare(
            `SELECT ${columns},e.embedding_json ${from} JOIN rag_embeddings e ON e.child_id=c.id${readyJoin} WHERE e.profile_id=? AND e.dimension=?${filter.where} LIMIT 2001`,
          )
          .all(
            embeddingIdentity(provider),
            provider.dimension,
            ...filter.params,
          );
        if (rows.length > 2000) {
          rows.pop();
          diagnostics.truncated = true;
        }
        dense = rows
          .map((row) => ({
            ...row,
            rank: 1 - cosine(vector, JSON.parse(String(row.embedding_json))),
          }))
          .sort((a, b) => a.rank - b.rank)
          .slice(0, config.candidateLimit) as unknown as Candidate[];
      }
      dense = dense.filter((row) => Number.isFinite(row.rank));
      if (!dense.length) {
        diagnostics.embeddingFallback = true;
        diagnostics.warnings.push(
          "当前模型尚无已完成的语义索引，结果来自原文与关键词。",
        );
      }
      candidates = fuse([candidates, dense]);
    } catch {
      input.signal?.throwIfAborted();
      diagnostics.embeddingFallback = true;
      diagnostics.warnings.push(
        "语义检索未在预算内完成，已保留关键词与原文定位结果。",
      );
    }
  } else if (query && !prepared.exact.length) {
    diagnostics.embeddingFallback = true;
    if (embedding && !semanticReady)
      diagnostics.warnings.push(
        "当前模型尚无已完成的语义索引，结果来自原文与关键词。",
      );
  }
  if (
    providers.rerankerProvider &&
    candidates.length > 1 &&
    Date.now() < deadline &&
    !prepared.exact.length
  ) {
    const top = candidates.slice(0, 30);
    try {
      const reranked = await bounded(
        (signal) =>
          providers.rerankerProvider!.rerank(
            query,
            top.map((row) => `${row.child_prefix}\n${row.child_content}`),
            Math.min(12, top.length),
            signal,
          ),
        Math.min(config.rerankMs, deadline - Date.now()),
        input.signal,
      );
      const seen = new Set<number>();
      const accepted = reranked.filter(
        (row) =>
          Number.isInteger(row.index) &&
          row.index >= 0 &&
          row.index < top.length &&
          Number.isFinite(row.score) &&
          !seen.has(row.index) &&
          Boolean(seen.add(row.index)),
      );
      if (!accepted.length) throw new Error("重排没有返回有效候选。");
      candidates = accepted.map((item, index) => ({
        ...top[item.index],
        score: 1 / (index + 1),
      }));
    } catch {
      input.signal?.throwIfAborted();
      diagnostics.rerankFallback = true;
      diagnostics.warnings.push("重排未完成，保留融合后的检索顺序。");
    }
  }
  diagnostics.route = prepared.exact.length
    ? "exact"
    : semanticReady && !diagnostics.embeddingFallback
      ? "hybrid"
      : "keyword";
  diagnostics.candidateCount = candidates.length;
  const hits = assemble(candidates, input, config, diagnostics);
  diagnostics.elapsedMs = Date.now() - prepared.started;
  return { hits, diagnostics };
}
export function browseKnowledge(input: {
  query?: string;
  projectId?: string | null;
  accessProjectId?: string | null;
  sourcePath?: string | null;
  limit?: number;
}) {
  const config = ragConfig(),
    filter = scope({ query: "", ...input }, config),
    query = normalize(input.query ?? "");
  return database
    .prepare(
      `SELECT d.id,d.title,d.relative_path,d.modified_at,d.source_type,a.generation_id FROM knowledge_documents d LEFT JOIN rag_active a ON a.document_id=d.id WHERE 1=1${filter.where} ORDER BY d.modified_at DESC`,
    )
    .all(...filter.params)
    .filter(
      (row) =>
        !query ||
        normalize(`${row.title} ${row.relative_path}`).includes(query),
    )
    .slice(0, Math.min(100, Math.max(1, input.limit ?? 30)))
    .map((row) => ({
      ...row,
      ready: !!row.generation_id,
      headings: row.generation_id
        ? database
            .prepare(
              "SELECT DISTINCT heading FROM rag_parents WHERE generation_id=? LIMIT 30",
            )
            .all(String(row.generation_id))
            .map((item) => item.heading)
        : [],
    }));
}
export function readKnowledgeEvidence(
  parentId: string,
  expectedRevision?: string,
  projectId?: string | null,
) {
  const row = database
    .prepare(
      "SELECT p.*,g.document_id,g.source_hash FROM rag_parents p JOIN rag_generations g ON g.id=p.generation_id JOIN rag_active a ON a.generation_id=g.id WHERE p.id=?",
    )
    .get(parentId);
  if (!row) throw fail("证据已更新、删除或失效，请重新检索。", 409);
  if (
    projectId &&
    !database
      .prepare(
        "SELECT 1 FROM project_document_links WHERE project_id=? AND document_id=?",
      )
      .get(projectId, String(row.document_id))
  )
    throw fail("证据不属于当前项目。", 403);
  const document = ragDocument(String(row.document_id));
  if (
    !document ||
    ragHash(document.content) !== row.source_hash ||
    (expectedRevision && expectedRevision !== row.source_hash)
  )
    throw fail("原文版本已变化，请重新检索。", 409);
  return {
    documentId: document.id,
    title: document.title,
    relativePath: document.relativePath,
    sourceRevision: row.source_hash,
    parentId,
    startOffset: row.view_start,
    endOffset: row.view_end,
    locator: {
      ...JSON.parse(String(row.locator_json)),
      startLine: lineNumber(document.content, Number(row.view_start)),
      endLine: lineNumber(
        document.content,
        Math.max(Number(row.view_start), Number(row.view_end) - 1),
      ),
    },
    adjacent: database
      .prepare(
        "SELECT id AS parentId,heading,kind FROM rag_parents WHERE generation_id=? AND position IN (?,?) ORDER BY position",
      )
      .all(
        String(row.generation_id),
        Number(row.position) - 1,
        Number(row.position) + 1,
      ),
    content: document.content.slice(
      Number(row.view_start),
      Number(row.view_end),
    ),
    notice:
      "这是检索证据读取；修改前仍需 get_document 或原件工具读取当前版本。",
  };
}
