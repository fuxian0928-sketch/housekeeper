import { database } from "../../db.js";
import type { SQLInputValue } from "node:sqlite";

const fail = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });
type Cursor = { time: string; seq: number };
function decodeCursor(value: unknown): Cursor | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > 300)
    throw fail("消息位置无效，请重新打开记录。");
  try {
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Cursor;
    if (
      typeof cursor.time !== "string" ||
      cursor.time.length > 64 ||
      !Number.isFinite(Date.parse(cursor.time)) ||
      !Number.isSafeInteger(cursor.seq) ||
      cursor.seq < 1
    )
      throw Error();
    return cursor;
  } catch {
    throw fail("消息位置无效，请重新打开记录。");
  }
}
export function listConversationRecords(
  input: { query?: unknown; before?: unknown; limit?: unknown } = {},
) {
  if (
    input.query !== undefined &&
    (typeof input.query !== "string" || input.query.length > 200)
  )
    throw fail("搜索内容不能超过200个字符。");
  const query = typeof input.query === "string" ? input.query.trim() : "",
    cursor = decodeCursor(input.before),
    limit = input.limit === undefined ? 40 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw fail("每次读取1到100条消息。");
  const where = ["m.role IN ('user','assistant')", "trim(m.content)<>''"],
    params: SQLInputValue[] = [];
  if (query) {
    if ([...query].length >= 3) {
      where.push(
        "m.id IN (SELECT message_id FROM message_archive_fts WHERE message_archive_fts MATCH ?)",
      );
      params.push('"' + query.replaceAll('"', '""') + '"');
    }
    where.push("instr(lower(m.content),lower(?))>0");
    params.push(query);
  }
  if (cursor) {
    where.push("(m.created_at<? OR (m.created_at=? AND m.rowid<?))");
    params.push(cursor.time, cursor.time, cursor.seq);
  }
  const rows = database
    .prepare(
      `SELECT m.rowid AS seq,m.id,m.conversation_id,m.role,m.content,m.citations_json,m.run_id,m.created_at,c.project_id
    FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE ${where.join(" AND ")}
    ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?`,
    )
    .all(...params, limit + 1);
  const hasMore = rows.length > limit,
    selected = rows.slice(0, limit),
    last = selected.at(-1);
  const messages = selected.reverse().map((row) => {
    let citations: unknown[] = [];
    try {
      const value = JSON.parse(String(row.citations_json ?? "[]"));
      if (Array.isArray(value)) citations = value;
    } catch {
      /* Keep the original text readable when old source metadata is malformed. */
    }
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      role: row.role,
      content: String(row.content),
      createdAt: String(row.created_at),
      runId: row.run_id ?? null,
      citations,
      channel:
        row.project_id === "system-voice-conversations" ? "voice" : "text",
    };
  });
  return {
    messages,
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ time: last.created_at, seq: last.seq }),
          ).toString("base64url")
        : null,
    query,
  };
}
