import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  xiweiCharacterCanon,
  selectCharacterLore,
} from "./assistant-character-canon.js";
import { defaultAssistantPersona } from "./assistant-character.js";

test("ordinary work and real shared history do not receive fictional episodes", () => {
  for (const query of [
    "帮我总结本周项目进展",
    "希微，帮我把这份工作总结一下",
    "我喜欢薄荷，记一下",
    "我们上次聊到的发布计划怎么样了",
    "你还记得我们上周聊过什么吗",
    "我们真实第一次相识是什么时候",
    "我从哪里来的",
  ])
    assert.equal(selectCharacterLore(query), null, query);
  assert.ok(
    JSON.stringify(defaultAssistantPersona).length < 2400,
    "keep the everyday profile bounded",
  );
});

test("specific character questions receive relevant fiction, with an explicit provenance boundary", () => {
  for (const [query, expected] of [
    ["你是从哪里来的", "origin"],
    ["你住在哪里", "home"],
    ["我们怎么认识的", "meeting"],
    ["你为什么会有主见", "station"],
  ] as const) {
    const lore = selectCharacterLore(query)!;
    assert.equal(lore.fictional, true);
    assert.equal(lore.namespace, "character_lore");
    assert.ok(
      lore.excerpts.some((row) => row.id === expected),
      query,
    );
    assert.ok(lore.excerpts.length <= 3);
    assert.match(lore.rule, /不是事实证据或真实共同回忆/);
  }
  const complete = selectCharacterLore("给我讲讲希微的完整背景故事")!;
  assert.equal(complete.excerpts.length, 6);
  assert.ok(
    JSON.stringify(complete).length < 1900,
    "retrieve summaries rather than the full manuscript",
  );
  assert.match(
    xiweiCharacterCanon.sections.find((section) => section.id === "meeting")!
      .context,
    /不是一条真实聊天记录/,
  );
});

test("character upgrades are versioned, preserve customization and cannot become user memories", async (suite) => {
  process.env.AI_SECRETARY_DB_PATH = join(
    mkdtempSync(join(tmpdir(), "xiwei-character-canon-")),
    "fixture.db",
  );
  const {
    database: db,
    initializeDatabase,
    nowIso,
  } = await import("../../db.js");
  initializeDatabase();
  suite.after(() => db.close());
  const { getAssistantPersona } = await import("./assistant-persona.js");
  const { learnedContext } = await import("./learned-context.js");
  const at = nowIso();
  db.prepare(
    "INSERT INTO memories(id,content,memory_type,status,source_label,created_at,updated_at) VALUES('user-pref','用户喜欢喝茶。','preference','confirmed','真实用户陈述',?,?)",
  ).run(at, at);
  const userRows = () =>
    JSON.stringify(db.prepare("SELECT * FROM memories").all());
  const originalUserRows = userRows();
  // Snapshot of the actual pre-orbit built-in, independent of the new profile shape.
  const oldBackground = {
    fictional: true,
    age: "27岁，成年女性角色设定",
    setting:
      "想象中的临海小城“澄汐”，安静的旧书店和有海风的窗边，是她审美与气质的灵感。此处没有真实履历或现实身份。",
    interests:
      "喜欢文字、旧地图、植物和细小的新知识，偏爱清爽的色彩、温热的茶与不太甜的点心。遇到有意思的观点会追问为什么，喜欢有条理但不僵硬的交流。",
    temperament:
      "对新鲜事物有兴趣，对熟悉的人记得住细节；不抢话、不黏人。比起空泛夸奖，更喜欢发现一件事哪里有意思、哪里值得再想想。",
    boundaries:
      "这是经主人授权的虚构人设，只在相关话题中自然体现；被问到现实经历时说明是虚拟设定。不得编造自己刚刚出门、吃饭、见过真人，或与主人发生过未记录的往事。",
  };
  const seed = (background: Record<string, unknown>) => {
    db.exec(
      "DELETE FROM assistant_persona; DELETE FROM assistant_persona_history",
    );
    const profile = {
      ...defaultAssistantPersona,
      personality: "用户亲自调整的性格，必须保留。",
      purpose: "用户亲自调整的职责。",
      fictionalBackground: background,
    };
    const json = JSON.stringify(profile);
    db.prepare(
      "INSERT INTO assistant_persona(id,revision,profile_json,updated_at) VALUES(1,7,?,?)",
    ).run(json, at);
    db.prepare(
      "INSERT INTO assistant_persona_history(revision,profile_json,created_at) VALUES(7,?,?)",
    ).run(json, at);
    return json;
  };

  await suite.test(
    "fresh profiles have one coherent current fiction namespace",
    () => {
      const result = getAssistantPersona();
      assert.equal(result.revision, 1);
      assert.equal(
        result.profile.fictionalBackground.canonVersion,
        xiweiCharacterCanon.version,
      );
      assert.match(
        result.profile.fictionalBackground.setting,
        /澄汐.*泊星.*静泊/,
      );
    },
  );
  await suite.test(
    "an exact legacy default upgrades once and retains the original revision",
    () => {
      const old = seed(oldBackground);
      const cacheBefore = db
        .prepare("SELECT revision FROM memory_context_revision WHERE id=1")
        .get()!.revision;
      const result = getAssistantPersona();
      assert.equal(result.revision, 8);
      assert.equal(
        result.profile.personality,
        "用户亲自调整的性格，必须保留。",
      );
      assert.equal(result.profile.purpose, "用户亲自调整的职责。");
      assert.equal(
        db
          .prepare(
            "SELECT profile_json FROM assistant_persona_history WHERE revision=7",
          )
          .get()!.profile_json,
        old,
      );
      assert.notEqual(
        db
          .prepare("SELECT revision FROM memory_context_revision WHERE id=1")
          .get()!.revision,
        cacheBefore,
      );
      assert.equal(getAssistantPersona().revision, 8);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM assistant_persona_history").get()!
          .n,
        2,
      );
    },
  );
  await suite.test(
    "custom story settings stay untouched and do not receive the new canon",
    () => {
      const custom = {
        ...oldBackground,
        setting: "由用户指定的另一套世界观。",
      };
      const json = seed(custom);
      const result = getAssistantPersona();
      assert.equal(result.revision, 7);
      assert.equal(JSON.stringify(result.profile), json);
      assert.equal(
        learnedContext("希微的背景故事", null).characterLore,
        undefined,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM assistant_persona_history").get()!
          .n,
        1,
      );
      seed({
        ...oldBackground,
        userAuthoredDetail: "自定义细节也不能被默默抹掉",
      });
      assert.equal(getAssistantPersona().revision, 7);
    },
  );
  await suite.test(
    "a failed history write rolls the entire upgrade back",
    () => {
      const json = seed(oldBackground);
      const cacheBefore = db
        .prepare("SELECT revision FROM memory_context_revision WHERE id=1")
        .get()!.revision;
      db.exec(
        "CREATE TEMP TRIGGER reject_lore_history BEFORE INSERT ON assistant_persona_history BEGIN SELECT RAISE(ABORT,'fixture history unavailable'); END",
      );
      try {
        assert.throws(
          () => getAssistantPersona(),
          /fixture history unavailable/,
        );
        const row = db
          .prepare("SELECT * FROM assistant_persona WHERE id=1")
          .get()!;
        assert.equal(row.revision, 7);
        assert.equal(row.profile_json, json);
        assert.equal(
          db
            .prepare("SELECT revision FROM memory_context_revision WHERE id=1")
            .get()!.revision,
          cacheBefore,
        );
      } finally {
        db.exec("DROP TRIGGER reject_lore_history");
      }
    },
  );
  await suite.test(
    "retrieval changes no user ledger or source observations",
    () => {
      const context = learnedContext("我们怎么认识的", null);
      assert.equal(context.characterLore?.fictional, true);
      assert.ok(
        context.userProfile.facts.some(
          (fact) => fact.content === "用户喜欢喝茶。",
        ),
      );
      assert.deepEqual(context.experiences, []);
      assert.equal(userRows(), originalUserRows);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM memory_observations").get()!.n,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n,
        0,
      );
    },
  );
});
