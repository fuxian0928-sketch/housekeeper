import { randomUUID } from "node:crypto";
import { setImmediate as yieldWork } from "node:timers/promises";
import { database, nowIso } from "../db.js";
import {
  indexRagDocument,
  ragConfig,
  ragDocument,
  activeGeneration,
  configHash,
  ragStatus,
} from "./rag-store.js";
import { ragHash } from "./rag-tokenizer.js";
import { normalizeRagConfig, type RagConfig } from "./rag-types.js";

let working = false;
let layoutChanged = () => {};
export function configureRagMaintenance(handler: () => void) {
  layoutChanged = handler;
}
function notifyLayoutChanged() {
  queueMicrotask(() => {
    try {
      layoutChanged();
    } catch {
      console.warn("RAG background maintenance could not start.");
    }
  });
}
export async function rebuildRagIndex(
  options: {
    config?: Partial<RagConfig>;
    signal?: AbortSignal;
    onProgress?: (current: number, total: number) => void;
  } = {},
) {
  if (working)
    throw Object.assign(new Error("已有索引任务正在进行。"), {
      statusCode: 409,
    });
  const id = randomUUID(),
    previousConfig = ragConfig(),
    config = normalizeRagConfig({ ...previousConfig, ...options.config }),
    previous = database
      .prepare("SELECT document_id,generation_id FROM rag_active")
      .all(),
    created = nowIso();
  database
    .prepare(
      "INSERT INTO rag_jobs(id,kind,status,created_at,updated_at) VALUES(?,'structure-rebuild','running',?,?)",
    )
    .run(id, created, created);
  working = true;
  try {
    const manifest = new Map<string, string>();
    let complete = false;
    for (let pass = 0; pass < 4 && !complete; pass++) {
      const ids = database
        .prepare("SELECT id FROM knowledge_documents ORDER BY id")
        .all()
        .map((row) => String(row.id));
      let current = 0;
      for (const documentId of ids) {
        options.signal?.throwIfAborted();
        const document = ragDocument(documentId);
        if (!document) continue;
        const known = manifest.get(documentId),
          generation = known
            ? database
                .prepare(
                  "SELECT source_hash,title FROM rag_generations WHERE id=?",
                )
                .get(known)
            : null;
        if (
          !generation ||
          generation.source_hash !== ragHash(document.content) ||
          generation.title !== document.title
        ) {
          const active = activeGeneration(documentId);
          const next =
            active?.config_hash === configHash(config) &&
            active?.source_hash === ragHash(document.content) &&
            active?.title === document.title
              ? String(active.id)
              : indexRagDocument(document, config, false);
          if (next) manifest.set(documentId, next);
        }
        current++;
        database
          .prepare(
            "UPDATE rag_jobs SET current=?,total=?,updated_at=? WHERE id=?",
          )
          .run(current, ids.length, nowIso(), id);
        options.onProgress?.(current, ids.length);
        await yieldWork();
      }
      options.signal?.throwIfAborted();
      database.exec("SAVEPOINT rag_rebuild_swap");
      try {
        const live = database
          .prepare("SELECT id,title,content FROM knowledge_documents")
          .all();
        complete = live.every((row) => {
          const generation = database
            .prepare("SELECT source_hash,title FROM rag_generations WHERE id=?")
            .get(manifest.get(String(row.id)) ?? "");
          return (
            generation?.source_hash === ragHash(String(row.content)) &&
            generation?.title === row.title
          );
        });
        if (complete) {
          const activate = database.prepare(
            "INSERT INTO rag_active(document_id,generation_id) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET generation_id=excluded.generation_id",
          );
          for (const row of live)
            activate.run(String(row.id), manifest.get(String(row.id))!);
          database
            .prepare(
              "INSERT INTO app_settings(key,value,updated_at) VALUES('rag_config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            )
            .run(JSON.stringify(config), nowIso());
          database
            .prepare(
              "UPDATE rag_jobs SET status='completed',detail_json=?,updated_at=? WHERE id=?",
            )
            .run(
              JSON.stringify({ previousConfig, previous, config }),
              nowIso(),
              id,
            );
        }
        database.exec("RELEASE SAVEPOINT rag_rebuild_swap");
      } catch (error) {
        database.exec(
          "ROLLBACK TO SAVEPOINT rag_rebuild_swap; RELEASE SAVEPOINT rag_rebuild_swap",
        );
        throw error;
      }
    }
    if (!complete)
      throw new Error(
        "资料持续变化，影子索引未切换。当前索引仍保留，请稍后重试。",
      );
    notifyLayoutChanged();
    return { id, ...ragStatus() };
  } catch (error) {
    database
      .prepare(
        "UPDATE rag_jobs SET status=?,detail_json=?,updated_at=? WHERE id=?",
      )
      .run(
        options.signal?.aborted ? "cancelled" : "failed",
        JSON.stringify({
          error: error instanceof Error ? error.message : "重建未完成",
        }),
        nowIso(),
        id,
      );
    throw error;
  } finally {
    working = false;
  }
}
export function rollbackRagIndex(jobId: string) {
  if (working)
    throw Object.assign(new Error("索引任务仍在进行。"), { statusCode: 409 });
  const job = database
    .prepare(
      "SELECT detail_json FROM rag_jobs WHERE id=? AND status='completed' AND kind='structure-rebuild'",
    )
    .get(jobId);
  if (!job)
    throw Object.assign(new Error("没有可回退的已完成索引任务。"), {
      statusCode: 404,
    });
  const data = JSON.parse(String(job.detail_json)) as {
    previousConfig: RagConfig;
    previous: Array<{ document_id: string; generation_id: string }>;
  };
  let restored = 0;
  database.exec("SAVEPOINT rag_rollback");
  try {
    database
      .prepare(
        "UPDATE app_settings SET value=?,updated_at=? WHERE key='rag_config'",
      )
      .run(JSON.stringify(data.previousConfig), nowIso());
    for (const item of data.previous) {
      const document = ragDocument(item.document_id),
        generation = database
          .prepare("SELECT source_hash,title FROM rag_generations WHERE id=?")
          .get(item.generation_id);
      if (
        !document ||
        generation?.source_hash !== ragHash(document.content) ||
        generation?.title !== document.title
      )
        continue;
      database
        .prepare(
          "INSERT INTO rag_active(document_id,generation_id) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET generation_id=excluded.generation_id",
        )
        .run(item.document_id, item.generation_id);
      restored++;
    }
    database
      .prepare(
        "UPDATE rag_jobs SET status='rolled_back',updated_at=? WHERE id=?",
      )
      .run(nowIso(), jobId);
    database.exec("RELEASE SAVEPOINT rag_rollback");
    notifyLayoutChanged();
    return { restored, ...ragStatus() };
  } catch (error) {
    database.exec(
      "ROLLBACK TO SAVEPOINT rag_rollback; RELEASE SAVEPOINT rag_rollback",
    );
    throw error;
  }
}
export function recoverRagJobs() {
  database
    .prepare(
      "UPDATE rag_jobs SET status='interrupted',updated_at=? WHERE status='running'",
    )
    .run(nowIso());
  database
    .prepare(
      "UPDATE rag_embedding_state SET status='interrupted',updated_at=? WHERE status='indexing'",
    )
    .run(nowIso());
}
