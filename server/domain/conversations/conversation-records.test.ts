import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { after, beforeEach, test } from "node:test";
import express from "express";

process.env.AI_SECRETARY_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "xiwei-chat-records-")),
  "test.db",
);
const { database, initializeDatabase } = await import("../../db.js");
initializeDatabase();
const { listConversationRecords } = await import("./conversation-records.js");
const stamp = "2026-10-26T12:00:00.000Z";
beforeEach(() => {
  database.exec("DELETE FROM conversations");
  database
    .prepare(
      "INSERT OR IGNORE INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES('system-voice-conversations','语音','','',?,?)",
    )
    .run(stamp, stamp);
  for (const id of ["text-a", "text-b", "voice-a"])
    database
      .prepare(
        "INSERT INTO conversations(id,scope_type,project_id,title,created_at,updated_at) VALUES(?,'memory',?,?,?,?)",
      )
      .run(
        id,
        id === "voice-a" ? "system-voice-conversations" : null,
        id,
        stamp,
        stamp,
      );
});
after(() => database.close());
function message(
  id: string,
  conversation: string,
  content: string,
  role = "user",
  time = stamp,
) {
  database
    .prepare(
      "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)",
    )
    .run(id, conversation, role, content, time);
}
test("one chronological record contains text and voice without selecting or mutating conversations", () => {
  message("text-user", "text-a", "文字提问");
  message("voice-user", "voice-a", "语音提问");
  message("voice-answer", "voice-a", "语音回答", "assistant");
  message("text-answer", "text-b", "文字回答", "assistant");
  const result = listConversationRecords();
  assert.deepEqual(
    result.messages.map((item) => item.id),
    ["text-user", "voice-user", "voice-answer", "text-answer"],
  );
  assert.deepEqual(
    result.messages.map((item) => item.channel),
    ["text", "voice", "voice", "text"],
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS n FROM conversations").get()?.n,
    3,
  );
});
test("pagination with equal timestamps has no gaps or repeated messages", () => {
  for (let index = 0; index < 13; index++)
    message(
      "m" + index,
      index % 2 ? "voice-a" : "text-a",
      "消息 " + index,
      index % 2 ? "assistant" : "user",
    );
  let cursor: string | null = null;
  let ids: string[] = [];
  do {
    const result = listConversationRecords({
      limit: 4,
      before: cursor ?? undefined,
    });
    ids = [...result.messages.map((item) => item.id), ...ids];
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(
    ids,
    Array.from({ length: 13 }, (_, index) => "m" + index),
  );
  assert.equal(new Set(ids).size, 13);
});
test("search finds message contents across old conversations and both roles, including short Chinese words", () => {
  message("one", "text-a", "之前讨论过评审时间");
  message("two", "voice-a", "评审时间改为周六", "assistant");
  message("three", "text-b", "无关记录");
  assert.deepEqual(
    listConversationRecords({ query: "评审时间" }).messages.map(
      (item) => item.id,
    ),
    ["one", "two"],
  );
  assert.equal(listConversationRecords({ query: "评" }).messages.length, 2);
  assert.equal(
    listConversationRecords({ query: "周六" }).messages[0].id,
    "two",
  );
  assert.equal(
    listConversationRecords({ query: "这里没有该内容" }).messages.length,
    0,
  );
});
test("search treats wildcard and quote characters literally and reflects edits and deletions", () => {
  message("one", "text-a", '比例为 100%_；标识 a"b；BuildReport');
  message("two", "text-b", "普通文本", "assistant");
  assert.equal(listConversationRecords({ query: "%_" }).messages.length, 1);
  assert.equal(listConversationRecords({ query: 'a"b' }).messages.length, 1);
  assert.equal(
    listConversationRecords({ query: "buildreport" }).messages.length,
    1,
  );
  assert.equal(
    listConversationRecords({ query: "' OR 1=1 --" }).messages.length,
    0,
  );
  database
    .prepare("UPDATE messages SET content='修订后的内容' WHERE id='one'")
    .run();
  assert.equal(
    listConversationRecords({ query: "BuildReport" }).messages.length,
    0,
  );
  database.prepare("DELETE FROM conversations WHERE id='text-a'").run();
  assert.equal(listConversationRecords({ query: "修订后" }).messages.length, 0);
});
test("record search does not compress away original messages or expose tool/system entries", () => {
  message("old", "text-a", "较早的原始聊天");
  message("tool", "text-a", "内部工具详情", "tool");
  message("system", "text-a", "系统规则", "system");
  message("blank", "text-a", "   ", "assistant");
  database
    .prepare(
      "UPDATE conversations SET compressed_summary='摘要' WHERE id='text-a'",
    )
    .run();
  assert.deepEqual(
    listConversationRecords().messages.map((item) => item.id),
    ["old"],
  );
  assert.equal(
    listConversationRecords({ query: "内部工具" }).messages.length,
    0,
  );
});
test("invalid pagination and query arguments are rejected", () => {
  for (const input of [
    { query: ["a"] },
    { query: "x".repeat(201) },
    { before: "garbage" },
    { before: Buffer.from("{}").toString("base64url") },
    { limit: 0 },
    { limit: 101 },
    { limit: 2.5 },
  ])
    assert.throws(
      () => listConversationRecords(input),
      (error) => (error as { statusCode: number }).statusCode === 400,
    );
});
test("the messages endpoint is registered before the conversation-id route", async () => {
  message("http", "voice-a", "接口搜索内容");
  const { registerConversationRoutes } = await import(
    "../../api/conversations.js"
  );
  const app = express();
  app.use(express.json());
  registerConversationRoutes(app, {
    canUseModel: () => false,
    complete: async () => "",
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number },
    url = "http://127.0.0.1:" + address.port;
  try {
    const response = await fetch(
      url + "/api/conversations/messages?q=" + encodeURIComponent("接口搜索"),
    );
    assert.equal(response.status, 200);
    const data = (await response.json()) as { messages: Array<{ id: string }> };
    assert.equal(data.messages[0].id, "http");
    assert.equal(
      (await fetch(url + "/api/conversations/messages?limit=999")).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
