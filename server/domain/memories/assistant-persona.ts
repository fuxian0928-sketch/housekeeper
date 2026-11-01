import { database, nowIso } from "../../db.js";
import { safeMemoryText } from "./work-memory.js";
import {
  defaultAssistantPersona,
  upgradeBuiltinCharacterLore,
} from "./assistant-character.js";
export { defaultAssistantPersona } from "./assistant-character.js";
export function getAssistantPersona() {
  let row = database
    .prepare("SELECT * FROM assistant_persona WHERE id=1")
    .get();
  if (!row) {
    const json = JSON.stringify(defaultAssistantPersona),
      at = nowIso();
    database
      .prepare(
        "INSERT OR IGNORE INTO assistant_persona(id,revision,profile_json,updated_at) VALUES(1,1,?,?)",
      )
      .run(json, at);
    database
      .prepare(
        "INSERT OR IGNORE INTO assistant_persona_history(revision,profile_json,created_at) VALUES(1,?,?)",
      )
      .run(json, at);
    row = database.prepare("SELECT * FROM assistant_persona WHERE id=1").get()!;
  }
  let profile = JSON.parse(
    String(row.profile_json),
  ) as typeof defaultAssistantPersona;
  const upgraded = upgradeBuiltinCharacterLore(profile);
  if (upgraded) {
    const revision = Number(row.revision),
      json = JSON.stringify(upgraded),
      at = nowIso();
    database.exec("SAVEPOINT character_lore_upgrade");
    try {
      if (
        database
          .prepare(
            "UPDATE assistant_persona SET revision=revision+1,profile_json=?,updated_at=? WHERE id=1 AND revision=?",
          )
          .run(json, at, revision).changes !== 1
      )
        throw new Error("人设版本冲突。");
      database
        .prepare(
          "INSERT INTO assistant_persona_history(revision,profile_json,created_at) VALUES(?,?,?)",
        )
        .run(revision + 1, json, at);
      database
        .prepare(
          "UPDATE memory_context_revision SET revision=lower(hex(randomblob(16))) WHERE id=1",
        )
        .run();
      database.exec("RELEASE character_lore_upgrade");
    } catch (error) {
      database.exec("ROLLBACK TO character_lore_upgrade");
      database.exec("RELEASE character_lore_upgrade");
      throw error;
    }
    row = database.prepare("SELECT * FROM assistant_persona WHERE id=1").get()!;
    profile = JSON.parse(
      String(row.profile_json),
    ) as typeof defaultAssistantPersona;
  }
  return {
    revision: Number(row.revision),
    profile,
    updatedAt: String(row.updated_at),
  };
}
/** Human settings endpoint only. The learning model has no capability for this mutation. */
export function updateAssistantPersona(input: {
  expectedRevision: number;
  personality?: string;
  purpose?: string;
  principles?: string;
}) {
  if (!input || typeof input !== "object")
    throw Object.assign(new Error("请提供人设内容及当前版本。"), {
      statusCode: 400,
    });
  const current = getAssistantPersona();
  if (input.expectedRevision !== current.revision)
    throw Object.assign(new Error("人设已变化，请重新读取。"), {
      statusCode: 409,
    });
  const profile = { ...current.profile };
  for (const key of ["personality", "purpose", "principles"] as const) {
    if (input[key] === undefined) continue;
    const value = String(input[key]).trim();
    if (!value || value.length > 2000 || safeMemoryText(value, 2000) !== value)
      throw Object.assign(new Error("人设内容需为1至2000字且不能包含凭证。"), {
        statusCode: 400,
      });
    profile[key] = value;
  }
  const json = JSON.stringify(profile),
    at = nowIso();
  database.exec("SAVEPOINT persona_update");
  try {
    if (
      database
        .prepare(
          "UPDATE assistant_persona SET revision=revision+1,profile_json=?,updated_at=? WHERE id=1 AND revision=?",
        )
        .run(json, at, current.revision).changes !== 1
    )
      throw new Error("人设版本冲突。");
    database
      .prepare(
        "INSERT INTO assistant_persona_history(revision,profile_json,created_at) VALUES(?,?,?)",
      )
      .run(current.revision + 1, json, at);
    database
      .prepare(
        "UPDATE memory_context_revision SET revision=lower(hex(randomblob(16))) WHERE id=1",
      )
      .run();
    database.exec("RELEASE persona_update");
  } catch (error) {
    database.exec("ROLLBACK TO persona_update");
    database.exec("RELEASE persona_update");
    throw error;
  }
  return getAssistantPersona();
}
