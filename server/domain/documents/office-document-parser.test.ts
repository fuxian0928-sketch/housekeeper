import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { strToU8, zipSync } from 'fflate';

function docxFixture() {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word 项目计划</w:t></w:r></w:p><w:p><w:r><w:t>完成 Office 导入能力</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')
  }));
}

function pptxFixture() {
  return Buffer.from(zipSync({
    'ppt/slides/slide1.xml': strToU8('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>季度计划</a:t><a:t>发布桌面安装包</a:t></p:sld>'),
    'ppt/notesSlides/notesSlide1.xml': strToU8('<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>确认发布时间</a:t></p:notes>')
  }));
}

test('导入 DOCX、XLSX、PPTX 后保存原件并建立结构化知识文档', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-secretary-office-'));
  process.env.AI_SECRETARY_DB_PATH = join(directory, 'office.db');
  process.env.AI_SECRETARY_DOCUMENT_ROOT = join(directory, 'raw');
  const { database, initializeDatabase } = await import('../../db.js');
  initializeDatabase();
  context.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const { importOfficeDocument, officeCapabilityStatus } = await import('./office-document-parser.js');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('任务');
  sheet.addRow(['事项', '状态']); sheet.addRow(['解析表格', '完成']);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const inputs = [
    { filename: '项目计划.docx', content: docxFixture(), expected: /完成 Office 导入能力/ },
    { filename: '任务表.xlsx', content: xlsx, expected: /工作表：任务[\s\S]*解析表格/ },
    { filename: '汇报.pptx', content: pptxFixture(), expected: /幻灯片 1[\s\S]*发布桌面安装包[\s\S]*演讲者备注/ }
  ];
  for (const input of inputs) {
    const result = await importOfficeDocument({ filename: input.filename, contentBase64: input.content.toString('base64') });
    const document = database.prepare('SELECT content,source_type FROM knowledge_documents WHERE id=?').get(result.document.id) as { content: string; source_type: string };
    assert.match(document.content, input.expected);
    assert.equal(document.source_type, 'office');
  }
  const duplicate = await importOfficeDocument({ filename: '任务表副本.xlsx', contentBase64: xlsx.toString('base64') });
  assert.equal(duplicate.deduplicated, true);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM office_document_imports').get() as { count: number }).count, 3);
  assert.deepEqual(officeCapabilityStatus().formats, ['docx', 'xlsx', 'pptx']);
});
