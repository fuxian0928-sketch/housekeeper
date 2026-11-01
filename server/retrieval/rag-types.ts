export type RagConfig = {
  parentTokens: number;
  parentMaxTokens: number;
  childTokens: number;
  childMaxTokens: number;
  overlapTokens: number;
  semantic: boolean;
  semanticPercentile: number;
  candidateLimit: number;
  parentLimit: number;
  contextTokens: number;
  contextBytes: number;
  embeddingMs: number;
  rerankMs: number;
  totalMs: number;
  projectScope: "priority" | "project";
  enabled: boolean;
};
export const RAG_VERSION = "hierarchical-rag-v1";
export const DEFAULT_RAG_CONFIG: Readonly<RagConfig> = Object.freeze({
  parentTokens: 400,
  parentMaxTokens: 800,
  childTokens: 120,
  childMaxTokens: 200,
  overlapTokens: 100,
  semantic: true,
  semanticPercentile: 85,
  candidateLimit: 40,
  parentLimit: 6,
  contextTokens: 6000,
  contextBytes: 24000,
  embeddingMs: 700,
  rerankMs: 500,
  totalMs: 1500,
  projectScope: "priority",
  enabled: true,
});
export function normalizeRagConfig(value: Partial<RagConfig> = {}): RagConfig {
  const result = { ...DEFAULT_RAG_CONFIG, ...value };
  for (const [key, min, max] of [
    ["parentTokens", 200, 1200],
    ["parentMaxTokens", 400, 2000],
    ["childTokens", 40, 300],
    ["childMaxTokens", 80, 500],
    ["overlapTokens", 0, 200],
    ["semanticPercentile", 50, 99],
    ["candidateLimit", 10, 80],
    ["parentLimit", 1, 12],
    ["contextTokens", 500, 12000],
    ["contextBytes", 2000, 48000],
    ["embeddingMs", 20, 3000],
    ["rerankMs", 20, 3000],
    ["totalMs", 200, 6000],
  ] as const) {
    const number = Number(result[key]);
    result[key] = Number.isFinite(number)
      ? Math.round(Math.min(max, Math.max(min, number)))
      : DEFAULT_RAG_CONFIG[key];
  }
  result.parentMaxTokens = Math.max(
    result.parentTokens,
    result.parentMaxTokens,
  );
  result.childMaxTokens = Math.min(
    result.parentTokens,
    Math.max(result.childTokens, result.childMaxTokens),
  );
  result.childTokens = Math.min(result.childTokens, result.childMaxTokens);
  result.overlapTokens = Math.min(
    result.overlapTokens,
    Math.floor(result.parentTokens / 2),
  );
  result.semantic =
    typeof value.semantic === "boolean"
      ? value.semantic
      : DEFAULT_RAG_CONFIG.semantic;
  result.enabled =
    typeof value.enabled === "boolean"
      ? value.enabled
      : DEFAULT_RAG_CONFIG.enabled;
  result.projectScope =
    value.projectScope === "project" ? "project" : "priority";
  return result;
}
// Query budgets do not change the stored chunk layout.
export function ragLayout(config: RagConfig) {
  return {
    parentTokens: config.parentTokens,
    parentMaxTokens: config.parentMaxTokens,
    childTokens: config.childTokens,
    childMaxTokens: config.childMaxTokens,
    overlapTokens: config.overlapTokens,
    semantic: config.semantic,
    semanticPercentile: config.semanticPercentile,
  };
}
export type RagLocator = {
  kind: string;
  startLine: number;
  endLine: number;
  page?: number;
  slide?: number;
  sheet?: string;
  rowStart?: number;
  rowEnd?: number;
  symbol?: string;
  jsonPath?: string;
  parsedParagraph?: number;
};
export type SourceSpan = { start: number; end: number };
export type RagUnit = SourceSpan & {
  heading: string;
  kind: string;
  prefix: string;
  locator: RagLocator;
  section: string;
};
export type RagParent = SourceSpan & {
  id: string;
  position: number;
  viewStart: number;
  viewEnd: number;
  heading: string;
  kind: string;
  prefix: string;
  content: string;
  tokens: number;
  locator: RagLocator;
};
export type RagChild = SourceSpan & {
  id: string;
  parentId: string;
  position: number;
  heading: string;
  kind: string;
  prefix: string;
  content: string;
  tokens: number;
  locator: RagLocator;
};
export type RagDocument = {
  id: string;
  title: string;
  relativePath: string;
  content: string;
};
export type RagBuilt = {
  sourceHash: string;
  policy: string;
  parents: RagParent[];
  children: RagChild[];
  units: RagUnit[];
  tokenizerId: string;
  semantic: boolean;
};
export type RagHit = {
  id: string;
  documentId: string;
  title: string;
  relative_path: string;
  excerpt: string;
  score: number;
  parentId: string;
  childIds: string[];
  sourceRevision: string;
  generationId: string;
  startOffset: number;
  endOffset: number;
  locator: RagLocator;
  matchedRanges: Array<SourceSpan & { childId: string }>;
  tokenCount: number;
  projectTier: number;
  route: "exact" | "hybrid" | "keyword";
};
export type RagDiagnostics = {
  version: string;
  elapsedMs: number;
  route: string;
  embeddingFallback: boolean;
  rerankFallback: boolean;
  indexPending: number;
  candidateCount: number;
  parentCount: number;
  tokenCount: number;
  tokenizerId: string;
  contextTokenizerId?: string;
  semanticCapped?: boolean;
  truncated: boolean;
  warnings: string[];
};
export type RagResult = { hits: RagHit[]; diagnostics: RagDiagnostics };
