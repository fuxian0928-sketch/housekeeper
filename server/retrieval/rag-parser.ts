import { createRequire } from "node:module";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import type { Root } from "mdast";
import type ts from "typescript";
import type { RagLocator, RagUnit } from "./rag-types.js";

const parser = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm),
  require = createRequire(import.meta.url);
let syntax: typeof ts | undefined,
  lastText = "",
  lineStarts = [0];
export function lineNumber(text: string, offset: number) {
  if (text !== lastText) {
    lastText = text;
    lineStarts = [0];
    for (let index = 0; index < text.length; index++)
      if (text.charCodeAt(index) === 10) lineStarts.push(index + 1);
  }
  let low = 0,
    high = lineStarts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (lineStarts[mid] <= offset) low = mid + 1;
    else high = mid;
  }
  return Math.max(1, low);
}
function csvRows(text: string) {
  const rows: Array<{ start: number; end: number }> = [];
  let quoted = false,
    start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '"') {
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
    }
    if (text[index] === "\n" && !quoted) {
      rows.push({ start, end: index });
      start = index + 1;
    }
  }
  if (start < text.length) rows.push({ start, end: text.length });
  return rows;
}
export function parseRagUnits(content: string): RagUnit[] {
  const tree = parser.parse(content) as Root,
    units: RagUnit[] = [],
    headings: string[] = [],
    sectionCounts = new Map<string, number>();
  let paragraph = 0,
    section = "root";
  const add = (
    start: number,
    end: number,
    kind: string,
    prefix = "",
    extra: Partial<RagLocator> = {},
  ) => {
    if (!content.slice(start, end).trim()) return;
    const heading = headings.filter(Boolean).join(" > "),
      page = heading.match(/第\s*(\d+)\s*页/),
      slide = heading.match(/幻灯片\s*(\d+)/),
      sheet = heading.match(/工作表[：:]\s*([^>]+)/);
    units.push({
      start,
      end,
      heading,
      kind,
      prefix,
      section,
      locator: {
        kind,
        startLine: lineNumber(content, start),
        endLine: lineNumber(content, Math.max(start, end - 1)),
        ...(page ? { page: Number(page[1]) } : {}),
        ...(slide ? { slide: Number(slide[1]) } : {}),
        ...(sheet ? { sheet: sheet[1].trim() } : {}),
        ...extra,
      },
    });
  };
  for (const node of tree.children) {
    const start = node.position?.start.offset ?? 0,
      end = node.position?.end.offset ?? start;
    if (node.type === "heading") {
      headings.splice(node.depth - 1);
      headings[node.depth - 1] = content
        .slice(start, end)
        .replace(/^#{1,6}\s+/, "")
        .trim();
      const path = headings.filter(Boolean).join(" > "),
        count = (sectionCounts.get(path) ?? 0) + 1;
      sectionCounts.set(path, count);
      section = `${path}:${count}`;
      continue;
    }
    if (node.type === "yaml" || node.type === "definition") continue;
    if (node.type === "table") {
      const rows = node.children,
        headerEnd = rows[1]?.position?.start.offset ?? end,
        header = content.slice(start, headerEnd).trim();
      for (let index = 1; index < rows.length; index++) {
        const row = rows[index];
        add(
          row.position?.start.offset ?? start,
          row.position?.end.offset ?? end,
          "table",
          header,
          { rowStart: index + 1, rowEnd: index + 1 },
        );
      }
      continue;
    }
    if (node.type === "code") {
      const priorCount = units.length;
      // mdast normalizes CRLF in node.value; derive offsets from the original fence.
      const raw = content.slice(start, end),
        opening = raw.match(/^[ \t]*(?:`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/),
        bodyStart = opening ? start + opening[0].length : start;
      const closing = opening
          ? content
              .slice(bodyStart, end)
              .match(/\r?\n[ \t]*(?:`{3,}|~{3,})[ \t]*$/)
          : null,
        bodyEnd = closing ? end - closing[0].length : end,
        value = content.slice(bodyStart, bodyEnd);
      const declared = node.lang?.toLowerCase() ?? "",
        language =
          declared === "typescript"
            ? "ts"
            : declared === "javascript"
              ? "js"
              : declared;
      if (
        ["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc"].includes(
          language,
        )
      ) {
        syntax ??= require("typescript") as typeof ts;
        if (language === "json" || language === "jsonc") {
          const json = syntax.parseJsonText("data.json", value);
          const walk = (item: ts.Node, path: string) => {
            if (syntax!.isObjectLiteralExpression(item)) {
              for (const property of item.properties) {
                if (syntax!.isPropertyAssignment(property)) {
                  const key = syntax!.isStringLiteral(property.name)
                    ? property.name.text
                    : property.name.getText(json);
                  walk(
                    property.initializer,
                    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
                      ? `${path}.${key}`
                      : `${path}[${JSON.stringify(key)}]`,
                  );
                }
              }
              return;
            }
            if (syntax!.isArrayLiteralExpression(item)) {
              item.elements.forEach((element, index) =>
                walk(element, `${path}[${index}]`),
              );
              return;
            }
            add(
              bodyStart + item.getStart(json),
              bodyStart + item.end,
              "json",
              `JSONPath: ${path}`,
              { jsonPath: path },
            );
          };
          for (const statement of json.statements)
            if (syntax.isExpressionStatement(statement))
              walk(statement.expression, "$");
        } else {
          const source = syntax.createSourceFile(
            `source.${language}`,
            value,
            syntax.ScriptTarget.Latest,
            true,
            language === "tsx"
              ? syntax.ScriptKind.TSX
              : language === "jsx"
                ? syntax.ScriptKind.JSX
                : language === "ts"
                  ? syntax.ScriptKind.TS
                  : syntax.ScriptKind.JS,
          );
          const imports = source.statements
            .filter((statement) => syntax!.isImportDeclaration(statement))
            .map((statement) => statement.getText(source))
            .join("\n")
            .slice(0, 1200);
          for (const statement of source.statements) {
            const named = statement as unknown as ts.NamedDeclaration,
              symbol = named.name?.getText(source);
            add(
              bodyStart + statement.getFullStart(),
              bodyStart + statement.end,
              "code",
              [symbol ? `符号：${symbol}` : "", imports]
                .filter(Boolean)
                .join("\n"),
              symbol ? { symbol } : {},
            );
          }
        }
        if (units.length > priorCount) continue;
      }
      if (language === "csv" || language === "tsv") {
        const rows = csvRows(value),
          header = rows[0] ? value.slice(rows[0].start, rows[0].end) : "";
        for (let index = 1; index < rows.length; index++)
          add(
            bodyStart + rows[index].start,
            bodyStart + rows[index].end,
            "table",
            header,
            { rowStart: index + 1, rowEnd: index + 1 },
          );
        if (rows.length > 1) continue;
      }
      add(bodyStart, bodyEnd, "code", language ? `语言：${language}` : "");
      continue;
    }
    add(start, end, node.type === "blockquote" ? "quote" : "prose", "", {
      parsedParagraph: ++paragraph,
    });
  }
  if (!units.length && content.trim()) add(0, content.length, "text");
  return units;
}
