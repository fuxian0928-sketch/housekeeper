import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { strFromU8, unzipSync } from 'fflate';
import { database, databaseDirectory, nowIso } from '../../db.js';
import { createKnowledgeDocument, getKnowledgeDocument, setProjectDocumentLink, setTaskDocumentLink } from './knowledge-document-editor.js';

const rawRoot = resolve(process.env.AI_SECRETARY_DOCUMENT_ROOT?.trim() || join(databaseDirectory, '..', 'raw-documents'));
const maximumBytes = Number(process.env.AI_SECRETARY_MAX_DOCUMENT_BYTES ?? 15 * 1024 * 1024);
const supportedExtensions = new Set(['.docx', '.xlsx', '.pptx']);

export type OfficeImportResult = {
  importId: string;
  document: Record<string, unknown> & { id: string; sourceType: 'office' };
  filename: string;
  format: 'docx' | 'xlsx' | 'pptx';
  sha256: string;
  warnings: string[];
  stats: Record<string, number>;
  deduplicated?: boolean;
};

function httpError(message: string, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function decodeXml(value: string) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}
function cleanFilename(value: unknown) {
  const name = basename(String(value ?? '').trim()).replace(/[\0<>:"/\\|?*]/g, '').slice(0, 180);
  if (!name) throw httpError('请选择需要导入的 Office 文件。');
  return name;
}
function titleFromFilename(filename: string) { return filename.replace(/\.(docx|xlsx|pptx)$/i, '').trim().slice(0, 120) || '导入的 Office 文档'; }
function escapeCell(value: string) { return value.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim(); }

export function assertSafeOfficeArchive(buffer: Buffer) {
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw httpError('文件扩展名与内容不一致，未读取这个文件。', 422);
  let entries = 0; let expandedBytes = 0;
  try {
    unzipSync(new Uint8Array(buffer), { filter(file) {
      entries += 1; expandedBytes += file.originalSize;
      if (entries > 20_000 || expandedBytes > 120 * 1024 * 1024) throw httpError('Office 文件解压后的体积过大，已停止处理。', 413);
      return false;
    } });
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error) throw error;
    throw httpError('文件不是有效的 Office Open XML 文档。', 422);
  }
}

function htmlToMarkdown(html: string) {
  let value = html;
  value = value.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_table, inner: string) => {
    const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => escapeCell(decodeXml(cell[1].replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, ''))))
    ).filter((row) => row.length);
    if (!rows.length) return '';
    const width = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
    return `\n| ${normalized[0].join(' | ')} |\n| ${Array(width).fill('---').join(' | ')} |\n${normalized.slice(1).map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`;
  });
  value = value.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, text) => `\n${'#'.repeat(Number(level) + 1)} ${text.replace(/<[^>]+>/g, '')}\n`);
  value = value.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, text) => `\n- ${text.replace(/<[^>]+>/g, '')}`);
  value = value.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, text) => `\n${text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')}\n`);
  return decodeXml(value.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n')).trim();
}

async function parseDocx(buffer: Buffer) {
  const converted = await mammoth.convertToHtml({ buffer });
  const markdown = htmlToMarkdown(converted.value);
  if (!markdown) throw httpError('这个 Word 文件没有读取到可索引的文字。', 422);
  return { markdown, warnings: converted.messages.map((message) => message.message).slice(0, 20), stats: { characters: markdown.length } };
}

function excelCellText(cell: ExcelJS.Cell) {
  if (cell.value == null) return '';
  if (typeof cell.value === 'object') {
    if ('result' in cell.value && cell.value.result != null) return String(cell.value.result);
    if ('richText' in cell.value && Array.isArray(cell.value.richText)) return cell.value.richText.map((item) => item.text).join('');
    if ('text' in cell.value && cell.value.text != null) return String(cell.value.text);
  }
  return cell.text || String(cell.value);
}

async function parseXlsx(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const parts: string[] = [];
  let rows = 0; let cells = 0;
  workbook.eachSheet((sheet) => {
    parts.push(`## 工作表：${sheet.name}`);
    const table: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, column) => { while (values.length < column - 1) values.push(''); values.push(escapeCell(excelCellText(cell))); });
      if (values.some(Boolean)) { table.push(values); rows += 1; cells += values.filter(Boolean).length; }
    });
    if (!table.length) { parts.push('_空工作表_'); return; }
    const width = Math.min(100, Math.max(...table.map((row) => row.length)));
    const normalized = table.map((row) => [...row.slice(0, width), ...Array(Math.max(0, width - row.length)).fill('')]);
    parts.push(`| ${normalized[0].join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`));
  });
  if (!parts.length) throw httpError('这个 Excel 文件没有读取到可索引的工作表。', 422);
  return { markdown: parts.join('\n\n'), warnings: [] as string[], stats: { sheets: workbook.worksheets.length, rows, cells } };
}

function slideNumber(path: string) { return Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? Number.MAX_SAFE_INTEGER); }
function xmlTexts(xml: string) { return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((item) => decodeXml(item[1]).trim()).filter(Boolean); }
function parsePptx(buffer: Buffer) {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(new Uint8Array(buffer)); } catch { throw httpError('PowerPoint 文件结构损坏或不是有效的 PPTX。', 422); }
  const slides = Object.keys(files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path)).sort((a, b) => slideNumber(a) - slideNumber(b));
  const notes = Object.keys(files).filter((path) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(path)).sort((a, b) => slideNumber(a) - slideNumber(b));
  const parts: string[] = []; let characters = 0;
  slides.forEach((path, index) => {
    const texts = xmlTexts(strFromU8(files[path]));
    const noteTexts = notes[index] ? xmlTexts(strFromU8(files[notes[index]])).filter((text) => !/^\d+$/.test(text)) : [];
    parts.push(`## 幻灯片 ${index + 1}`, texts.length ? texts.map((text) => `- ${text}`).join('\n') : '_此页没有文字_');
    if (noteTexts.length) parts.push(`### 演讲者备注\n\n${noteTexts.join('\n\n')}`);
    characters += texts.join('').length + noteTexts.join('').length;
  });
  if (!slides.length) throw httpError('这个 PowerPoint 文件没有读取到幻灯片。', 422);
  return { markdown: parts.join('\n\n'), warnings: [] as string[], stats: { slides: slides.length, characters } };
}

export function officeCapabilityStatus() {
  return { id: 'office-document-reader', name: 'Office 文档阅读', version: '1.0.0', status: 'ready', bundled: true, formats: ['docx', 'xlsx', 'pptx'], permissions: ['读取用户明确上传的文件', '写入受控原件目录', '写入知识库索引'], limits: { maximumBytes }, runtime: { mammoth: true, exceljs: true, pptxParser: true } };
}

export async function parseOfficeBuffer(buffer:Buffer,format:'docx'|'xlsx'|'pptx') {
  assertSafeOfficeArchive(buffer);
  return format==='docx'?parseDocx(buffer):format==='xlsx'?parseXlsx(buffer):parsePptx(buffer);
}

export async function importOfficeDocument(input: { filename?: unknown; contentBase64?: unknown; projectId?: unknown; taskId?: unknown }): Promise<OfficeImportResult> {
  const filename = cleanFilename(input.filename);
  const extension = extname(filename).toLowerCase();
  if (!supportedExtensions.has(extension)) throw httpError('目前支持 .docx、.xlsx 和 .pptx 文件。旧版 .doc、.xls、.ppt 请先另存为新版格式。', 415);
  const encoded = String(input.contentBase64 ?? '').replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length) throw httpError('上传的文件内容为空。');
  if (buffer.length > maximumBytes) throw httpError(`单个文件不能超过 ${Math.floor(maximumBytes / 1024 / 1024)}MB。`, 413);
  assertSafeOfficeArchive(buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const format = extension.slice(1) as 'docx' | 'xlsx' | 'pptx';
  const existing = database.prepare(`SELECT id,document_id,warnings_json,stats_json FROM office_document_imports WHERE content_hash=? AND status='ready' ORDER BY created_at LIMIT 1`).get(sha256) as { id: string; document_id: string; warnings_json: string; stats_json: string } | undefined;
  if (existing) {
    if (typeof input.projectId === 'string' && input.projectId) setProjectDocumentLink(input.projectId, existing.document_id, true);
    if (typeof input.taskId === 'string' && input.taskId) setTaskDocumentLink(input.taskId, existing.document_id, true);
    return { importId: existing.id, document: { ...(getKnowledgeDocument(existing.document_id) as unknown as Record<string, unknown> & { id: string }), sourceType: 'office' }, filename, format, sha256, warnings: JSON.parse(existing.warnings_json), stats: JSON.parse(existing.stats_json), deduplicated: true };
  }
  const parsed = await parseOfficeBuffer(buffer,format);
  const title = titleFromFilename(filename);
  const content = `# ${title}\n\n> 来源文件：${filename}\n> 文件指纹：${sha256}\n> 解析格式：${format.toUpperCase()}\n\n${parsed.markdown}`;
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw httpError('解析后的内容超过 2MB，请拆分工作簿或演示文稿后再导入。', 413);
  const document = createKnowledgeDocument({ title, content, projectId: input.projectId, taskId: input.taskId }) as unknown as Record<string, unknown> & { id: string };
  const importId = randomUUID(); const timestamp = nowIso();
  const storagePath = join('imports', sha256.slice(0, 2), `${sha256}${extension}`);
  const absolutePath = join(rawRoot, storagePath);
  await mkdir(resolve(absolutePath, '..'), { recursive: true });
  await writeFile(absolutePath, buffer, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  database.prepare(`UPDATE knowledge_documents SET source_type='office' WHERE id=?`).run(document.id);
  database.prepare(`INSERT INTO office_document_imports(id,document_id,filename,format,content_hash,storage_path,bytes,warnings_json,stats_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'ready',?,?)`).run(importId, document.id, filename, format, sha256, storagePath.replaceAll('\\', '/'), buffer.length, JSON.stringify(parsed.warnings), JSON.stringify(parsed.stats), timestamp, timestamp);
  return { importId, document: { ...document, sourceType: 'office' }, filename, format, sha256, warnings: parsed.warnings, stats: parsed.stats };
}

export function listOfficeImports() {
  return database.prepare(`SELECT i.id,i.document_id AS documentId,i.filename,i.format,i.bytes,i.warnings_json AS warningsJson,i.stats_json AS statsJson,i.status,i.created_at AS createdAt,d.title FROM office_document_imports i JOIN knowledge_documents d ON d.id=i.document_id ORDER BY i.created_at DESC LIMIT 200`).all().map((row: Record<string, unknown>) => ({ ...row, warnings: JSON.parse(String(row.warningsJson ?? '[]')), stats: JSON.parse(String(row.statsJson ?? '{}')), warningsJson: undefined, statsJson: undefined }));
}
