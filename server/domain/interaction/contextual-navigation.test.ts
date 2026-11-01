import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { NavigationKind, NavigationTarget } from './contextual-navigation.js';

test('contextual navigation uses real, visible SQLite records and bounded evidence', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'contextual-navigation-'));
  const previousPath = process.env.AI_SECRETARY_DB_PATH;
  process.env.AI_SECRETARY_DB_PATH = join(temporary, 'navigation.db');
  const { database, initializeDatabase } = await import('../../db.js');
  const { createContextualNavigationService, MAX_NAVIGATION_CANDIDATES, NAVIGATION_PAGES } = await import('./contextual-navigation.js');
  initializeDatabase();
  const service = createContextualNavigationService(database);
  const { resolveReference, validateNavigationTarget } = service;
  const timestamp = '2026-10-25T00:00:00.000Z';
  const target = (kind: NavigationKind, id: string, title = id): NavigationTarget => ({ kind, id, title });
  const project = (id: string, name: string, sourcePath = '', status = 'active', deletedAt: string | null = null) => {
    database.prepare('INSERT INTO projects(id,name,vault_path,source_path,status,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, name, 'central://documents', sourcePath, status, deletedAt, timestamp, timestamp);
  };
  const document = (id: string, title: string, path = `${title}.md`, content = '# 文档\n\nBODY_SECRET_SHOULD_NOT_LEAK') => {
    database.prepare('INSERT INTO knowledge_documents(id,title,relative_path,content,modified_at,indexed_at) VALUES(?,?,?,?,?,?)')
      .run(id, title, path, content, timestamp, timestamp);
  };
  const task = (id: string, title: string, projectId = 'p1', status = 'todo') => {
    database.prepare('INSERT INTO tasks(id,project_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, projectId, title, status, timestamp, timestamp);
  };
  const link = (documentId: string, projectId = 'p1') => database.prepare('INSERT INTO project_document_links(project_id,document_id,created_at) VALUES(?,?,?)').run(projectId, documentId, timestamp);
  const reset = () => {
    database.exec('DELETE FROM central_source_documents; DELETE FROM central_vaults; DELETE FROM knowledge_documents; DELETE FROM tasks; DELETE FROM projects;');
    project('p1', '发布计划', '项目一');
    project('p2', '产品研究', '项目二');
  };
  const check = async (name: string, callback: () => void) => t.test(name, () => { reset(); callback(); });

  try {
    await check('unique explicit names resolve without relying on focus or modification time', () => {
      document('d1', '上线方案', '项目一/上线方案.md');
      const resolved = resolveReference({ query: '请帮我打开《上线方案》文档', focus: target('project', 'p2') });
      assert.equal(resolved.status, 'resolved');
      assert.deepEqual(resolved.target, target('document', 'd1', '上线方案'));
      assert.equal(resolveReference({ query: '打开发布计划项目' }).target?.id, 'p1');
      assert.equal(resolveReference({ query: 'open PRODUCT RESEARCH', kind: 'project' }).status, 'missing');
      project('english', 'English Project');
      assert.equal(resolveReference({ query: 'english project', kind: 'project' }).target?.id, 'english');
    });

    await check('missing explicit names never fall back to a real focus or history', () => {
      document('d1', '上线方案', '项目一/上线方案.md');
      const missing = resolveReference({ query: '打开《从不存在的方案》文档', focus: target('document', 'd1'), recentTargets: [target('document', 'd1')] });
      assert.equal(missing.status, 'missing');
      assert.equal(missing.target, undefined);
      assert.deepEqual(missing.candidates, []);
    });

    await check('duplicate exact names stay ambiguous even when one is newer or focused', () => {
      task('t1', '确认接口', 'p1'); task('t2', '确认接口', 'p2');
      database.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('2099-01-01', 't2');
      const ambiguous = resolveReference({ query: '确认接口', kind: 'task', focus: target('task', 't2') });
      assert.equal(ambiguous.status, 'ambiguous');
      assert.equal(ambiguous.target, undefined);
      assert.deepEqual(ambiguous.candidates.map(item => item.id).sort(), ['t1', 't2']);
      assert.equal(resolveReference({ query: '确认接口', kind: 'task', projectId: 'p1' }).target?.id, 't1');
    });

    await check('partial matches require confirmation, including a single suggestion', () => {
      document('d1', '完整上线方案'); document('d2', '完整测试方案');
      const single = resolveReference({ query: '上线', kind: 'document' });
      assert.equal(single.status, 'ambiguous'); assert.equal(single.target, undefined);
      assert.deepEqual(single.candidates.map(item => item.id), ['d1']);
      assert.equal(resolveReference({ query: '完整', kind: 'document' }).candidates.length, 2);
    });

    await check('an exact full name wins over a shortened name with a type noun removed', () => {
      document('d1', '上线文档'); document('d2', '上线');
      assert.equal(resolveReference({ query: '打开上线文档' }).target?.id, 'd1');
    });

    await check('project scope cannot be widened by explicit names, focus or recent records', () => {
      document('d1', '本项目资料', '项目一/资料.md');
      document('d2', '跨项目秘密', '项目二/资料.md');
      task('t2', '跨项目任务', 'p2');
      for (const query of ['产品研究', '跨项目秘密', '跨项目任务']) {
        const scoped = resolveReference({ query, projectId: 'p1', focus: target('project', 'p2') });
        assert.equal(scoped.status, 'missing'); assert.deepEqual(scoped.candidates, []);
      }
      const recent = resolveReference({ query: '刚才那份文档', projectId: 'p1', recentTargets: [target('document', 'd2')] });
      assert.equal(recent.status, 'missing');
      assert.equal(validateNavigationTarget(target('project', 'p2'), 'p1').valid, false);
      assert.equal(validateNavigationTarget(target('document', 'd2'), 'p1').valid, false);
      assert.equal(validateNavigationTarget(target('task', 't2'), 'p1').valid, false);
    });

    await check('document scope includes actual manual, task and directory links only', () => {
      document('manual', '手工关联', '公共/手工.md'); link('manual');
      document('task-doc', '任务关联', '公共/任务.md'); task('local-task', '本项目任务');
      database.prepare('INSERT INTO task_document_links(task_id,document_id,created_at) VALUES(?,?,?)').run('local-task', 'task-doc', timestamp);
      document('folder', '目录资料', '项目一/子目录/资料.md');
      document('lookalike', '近似目录', '项目一额外/资料.md');
      document('global', '未关联资料', '公共/未关联.md');
      for (const [id, title] of [['manual', '手工关联'], ['task-doc', '任务关联'], ['folder', '目录资料']]) {
        assert.equal(resolveReference({ query: title, kind: 'document', projectId: 'p1' }).target?.id, id);
      }
      for (const id of ['lookalike', 'global']) assert.equal(validateNavigationTarget(target('document', id), 'p1').valid, false);
      project('wildcard', '含特殊字符路径', '产品_%');
      document('literal-path', '字面路径资料', '产品_%/资料.md');
      document('wildcard-wrong', '通配符近似资料', '产品ab/资料.md');
      assert.equal(validateNavigationTarget(target('document', 'literal-path'), 'wildcard').valid, true);
      assert.equal(validateNavigationTarget(target('document', 'wildcard-wrong'), 'wildcard').valid, false);
    });

    await check('deleted and archived projects and their tasks are not navigable', () => {
      project('deleted', '删除项目', '', 'active', timestamp); project('archived', '归档项目', '', 'archived');
      task('deleted-task', '删除项目任务', 'deleted'); task('archived-task', '归档项目任务', 'archived');
      for (const [kind, id, title] of [
        ['project', 'deleted', '删除项目'], ['project', 'archived', '归档项目'],
        ['task', 'deleted-task', '删除项目任务'], ['task', 'archived-task', '归档项目任务']
      ] as const) {
        assert.equal(validateNavigationTarget(target(kind, id, title)).valid, false);
        assert.equal(resolveReference({ query: title, kind }).status, 'missing');
      }
      for (const projectId of ['deleted', 'archived', 'nonexistent', '']) {
        const scoped = resolveReference({ query: '发布计划', kind: 'project', projectId });
        assert.equal(scoped.status, 'missing'); assert.deepEqual(scoped.candidates, []);
        assert.equal(validateNavigationTarget(target('page', 'settings'), projectId).valid, false);
      }
      task('completed', '已完成任务', 'p1', 'done');
      assert.equal(validateNavigationTarget(target('task', 'completed')).valid, true);
    });

    await check('deleted documents and central tombstones cannot be revived by stale focus', () => {
      document('deleted', '已删除文档');
      database.prepare('DELETE FROM knowledge_documents WHERE id=?').run('deleted');
      assert.equal(resolveReference({ query: '这份文档', focus: target('document', 'deleted') }).status, 'missing');
      document('tombstone', '已删服务器资料', '服务器资料/旧.md');
      database.prepare('INSERT INTO central_vaults(id,name,knowledge_prefix,created_at,updated_at) VALUES(?,?,?,?,?)').run('vault', '测试资料', '服务器资料', timestamp, timestamp);
      database.prepare('INSERT INTO central_source_documents(id,vault_id,relative_path,knowledge_path,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?)')
        .run('source', 'vault', '旧.md', '服务器资料/旧.md', timestamp, timestamp, timestamp);
      assert.equal(validateNavigationTarget(target('document', 'tombstone')).valid, false);
      assert.equal(resolveReference({ query: '已删服务器资料', kind: 'document' }).status, 'missing');
    });

    await check('current demonstratives use verified focus and refresh its real title', () => {
      document('d1', '实际标题', '项目一/文档.md'); document('d2', '历史文档', '项目一/历史.md');
      const resolved = resolveReference({ query: '打开这个文档', projectId: 'p1', focus: target('document', 'd1', '伪造或过期标题'), recentTargets: [target('document', 'd2')] });
      assert.deepEqual(resolved.target, target('document', 'd1', '实际标题'));
      assert.equal(resolveReference({ query: '这个项目', kind: 'document', focus: target('document', 'd1') }).status, 'missing');
    });

    await check('recently read objects resolve only when unambiguous and revalidated', () => {
      document('d1', '刚才的方案', '项目一/方案.md'); document('d2', '另一方案', '项目一/另一.md');
      assert.equal(resolveReference({ query: '调出刚才那份文档', projectId: 'p1', recentTargets: [target('document', 'd1'), target('document', 'd1')] }).target?.id, 'd1');
      const ambiguous = resolveReference({ query: '刚才那个文档', recentTargets: [target('document', 'd2'), target('document', 'd1')], focus: target('document', 'd1') });
      assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.candidates.length, 2);
      task('t1', '上次讨论的事项');
      assert.equal(resolveReference({ query: '上次那件事', recentTargets: [target('task', 't1')] }).target?.id, 't1');
      assert.equal(resolveReference({ query: '上次那件事', focus: target('task', 't1') }).status, 'missing');
    });

    await check('invalid focus can use valid reads but cannot choose the most recently modified record', () => {
      document('d1', '仍可读资料', '项目一/资料.md');
      assert.equal(resolveReference({ query: '这份文档', focus: target('document', 'no-longer-exists'), recentTargets: [target('document', 'd1')] }).target?.id, 'd1');
      const missing = resolveReference({ query: '刚才那份文档', kind: 'document', focus: target('document', 'no-longer-exists') });
      assert.equal(missing.status, 'missing'); assert.equal(missing.target, undefined);
      database.prepare('DELETE FROM knowledge_documents WHERE id=?').run('d1');
      assert.equal(resolveReference({ query: '刚才那份文档', recentTargets: [target('document', 'd1')] }).status, 'missing');
    });

    await check('document aliases are real titles, file basenames, paths or literal frontmatter', () => {
      document('d1', '正式文档名称', '项目一/发布草案.md', '---\naliases: [上线手册, "Release Guide"]\n---\n# 正文\n正文别名不能成为导航名称');
      for (const query of ['上线手册', 'release guide', '发布草案', '发布草案.md', '项目一/发布草案']) {
        assert.equal(resolveReference({ query, kind: 'document', projectId: 'p1' }).target?.id, 'd1');
      }
      document('d2', '列表别名文档', '项目一/列表.markdown', "---\naliases:\n  - 列表别名\n  - 'Single '' Quote'\n---\n# 文档");
      assert.equal(resolveReference({ query: '列表别名', kind: 'document' }).target?.id, 'd2');
      assert.equal(resolveReference({ query: '列表', kind: 'document' }).target?.id, 'd2');
      assert.equal(resolveReference({ query: "Single ' Quote", kind: 'document' }).target?.id, 'd2');
      document('d3', '无缩进列表', '无缩进.md', '---\naliases:\n- 无缩进别名\n---\n# 文档');
      assert.equal(resolveReference({ query: '无缩进别名', kind: 'document' }).target?.id, 'd3');
      assert.equal(resolveReference({ query: '正文别名不能成为导航名称', kind: 'document' }).status, 'missing');
      document('no-frontmatter', '普通正文', '普通.md', '# 普通正文\n\naliases: 不是别名');
      assert.equal(resolveReference({ query: '不是别名', kind: 'document' }).status, 'missing');
    });

    await check('same aliases and filenames remain ambiguous across distinct documents', () => {
      document('d1', '第一文档', '项目一/草案.md', '---\nalias: 共同名称\n---\n# 一');
      document('d2', '第二文档', '项目二/草案.md', '---\naliases: [共同名称]\n---\n# 二');
      assert.equal(resolveReference({ query: '共同名称', kind: 'document' }).status, 'ambiguous');
      assert.equal(resolveReference({ query: '草案', kind: 'document' }).status, 'ambiguous');
      assert.equal(resolveReference({ query: '共同名称', kind: 'document', projectId: 'p1' }).target?.id, 'd1');
      document('d3', '共同名称', '项目一/别的.md');
      assert.equal(resolveReference({ query: '共同名称', kind: 'document', projectId: 'p1' }).status, 'ambiguous');
    });

    await check('navigation targets have a fixed page allowlist and canonical output', () => {
      for (const [id, page] of Object.entries(NAVIGATION_PAGES)) {
        const checked = validateNavigationTarget({ kind: 'page', id, title: '任意声称的标题', url: 'https://example.invalid', command: 'ignored' });
        assert.equal(checked.valid, true);
        assert.deepEqual(checked.target, target('page', id, page.title));
      }
      assert.deepEqual(resolveReference({ query: '打开知识与文档' }).target, target('page', 'knowledge', '知识与文档'));
      assert.deepEqual(resolveReference({ query: '切换到设置页面' }).target, target('page', 'settings', '设置'));
      for (const invalid of [null, [], {}, { kind: 'url', id: 'settings', title: '设置' }, { kind: 'page', id: '__proto__', title: '设置' }, { kind: 'page', id: '/settings', title: '设置' }, { kind: 'page', id: 'https://example.invalid', title: '设置' }, { kind: 'project', title: '发布计划' }]) {
        assert.equal(validateNavigationTarget(invalid).valid, false);
      }
      assert.equal(resolveReference({ query: '打开https://example.invalid', kind: 'page' }).status, 'missing');
    });

    await check('bounded candidates and context never turn truncation into uniqueness', () => {
      for (let index = 0; index < 60; index += 1) document(`many-${index}`, '同名资料', `目录${index}/同名.md`);
      const many = resolveReference({ query: '同名资料', kind: 'document' });
      assert.equal(many.status, 'ambiguous'); assert.equal(many.target, undefined);
      assert.equal(many.candidates.length, MAX_NAVIGATION_CANDIDATES);
      const history = Array.from({ length: 21 }, () => target('document', 'many-0'));
      assert.equal(resolveReference({ query: '刚才那份文档', recentTargets: history }).status, 'ambiguous');
      const output = JSON.stringify(many);
      assert.ok(!output.includes('BODY_SECRET_SHOULD_NOT_LEAK'));
      assert.ok(!output.includes('content')); assert.ok(!output.includes('header'));
      for (const candidate of many.candidates) assert.deepEqual(Object.keys(candidate).sort(), ['id', 'kind', 'title']);
      document('long-label', '长'.repeat(1000));
      const longLabel = resolveReference({ query: 'long-label', kind: 'document' });
      assert.equal(longLabel.status, 'resolved'); assert.equal(longLabel.target?.title.length, 500);
      assert.equal(validateNavigationTarget(longLabel.target).valid, true);
    });

    await check('oversized metadata and malformed or multiple names cannot fabricate a unique target', () => {
      document('large', '超长元数据', '超长.md', `---\nother: ${'x'.repeat(5000)}\naliases: [越界别名]\n---\n`);
      assert.equal(resolveReference({ query: '越界别名', kind: 'document' }).status, 'missing');
      task('t1', '已知事项');
      assert.equal(resolveReference({ query: '打开“已知事项”和“未知事项”', kind: 'task' }).status, 'ambiguous');
      for (const query of ['', ' ', 'x'.repeat(501)]) assert.equal(resolveReference({ query }).status, 'missing');
      assert.equal(resolveReference({ query: '已知事项', kind: 'url' as NavigationKind }).status, 'missing');
      assert.equal(resolveReference({ query: '打开' }).status, 'missing');
    });
  } finally {
    database.close();
    if (previousPath === undefined) delete process.env.AI_SECRETARY_DB_PATH;
    else process.env.AI_SECRETARY_DB_PATH = previousPath;
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('contextual-navigation-'));
    rmSync(temporary, { recursive: true, force: true });
  }
});
