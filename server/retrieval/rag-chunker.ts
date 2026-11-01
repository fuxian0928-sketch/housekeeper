import {
  boundedSpans,
  ragHash,
  ragTokenizer,
  tokenHead,
  tokenTail,
  type TokenCounter,
} from "./rag-tokenizer.js";
import { parseRagUnits, lineNumber } from "./rag-parser.js";
import {
  RAG_VERSION,
  normalizeRagConfig,
  ragLayout,
  type RagBuilt,
  type RagChild,
  type RagConfig,
  type RagDocument,
  type RagParent,
  type RagUnit,
} from "./rag-types.js";

export function buildRagDocument(
  document: RagDocument,
  options: Partial<RagConfig> = {},
  semanticBreaks: number[] = [],
  counter: TokenCounter = ragTokenizer,
): RagBuilt {
  semanticBreaks = [...new Set(semanticBreaks)].sort((a, b) => a - b);
  const config = normalizeRagConfig(options),
    units = parseRagUnits(document.content),
    policy = ragHash(
      JSON.stringify([
        RAG_VERSION,
        ragLayout(config),
        counter.id,
        document.title,
        semanticBreaks,
      ]),
    ),
    sourceHash = ragHash(document.content),
    parents: RagParent[] = [],
    children: RagChild[] = [];
  const fragments: RagUnit[] = [];
  for (const unit of units) {
    const points = [
      unit.start,
      ...semanticBreaks.filter(
        (point) => point > unit.start && point < unit.end,
      ),
      unit.end,
    ];
    for (let index = 1; index < points.length; index++)
      for (const span of boundedSpans(
        document.content,
        points[index - 1],
        points[index],
        unit.kind === "prose" ? config.childTokens : config.childMaxTokens,
        counter,
      ))
        fragments.push({ ...unit, ...span });
  }
  let group: RagUnit[] = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0],
      last = group.at(-1)!,
      start = first.start,
      end = last.end,
      sectionUnits = units.filter(
        (unit) =>
          unit.section === first.section &&
          unit.kind === first.kind &&
          unit.prefix === first.prefix,
      ),
      sectionStart = sectionUnits[0]?.start ?? start,
      sectionEnd = sectionUnits.at(-1)?.end ?? end;
    const extension = Math.min(
        config.overlapTokens,
        Math.max(
          0,
          config.parentMaxTokens -
            counter.count(document.content.slice(start, end)) -
            4,
        ),
      ),
      half = Math.floor(extension / 2);
    let before = tokenTail(
        document.content.slice(Math.max(sectionStart, start - 2400), start),
        half,
        counter,
      ),
      after = tokenHead(
        document.content.slice(end, Math.min(sectionEnd, end + 2400)),
        half,
        counter,
      );
    // Token counts are not additive across boundaries; check the complete source span.
    while (
      (before || after) &&
      counter.count(before + document.content.slice(start, end) + after) >
        config.parentMaxTokens
    ) {
      if (after)
        after = tokenHead(
          after,
          Math.max(0, counter.count(after) - 2),
          counter,
        );
      else
        before = tokenTail(
          before,
          Math.max(0, counter.count(before) - 2),
          counter,
        );
    }
    const viewStart = start - before.length,
      viewEnd = end + after.length;
    const id = ragHash(
        `${document.id}:${sourceHash}:${policy}:p:${start}:${end}`,
      ),
      prefix = [document.title, first.heading, first.prefix]
        .filter(Boolean)
        .join("\n");
    const locator = {
      ...first.locator,
      startLine: lineNumber(document.content, start),
      endLine: lineNumber(document.content, Math.max(start, end - 1)),
      ...(first.locator.rowStart ? { rowEnd: last.locator.rowEnd } : {}),
    };
    parents.push({
      id,
      position: parents.length,
      start,
      end,
      viewStart,
      viewEnd,
      heading: first.heading,
      kind: first.kind,
      prefix,
      content: document.content.slice(viewStart, viewEnd),
      tokens: counter.count(document.content.slice(viewStart, viewEnd)),
      locator,
    });
    for (const fragment of group) {
      const value = document.content.slice(fragment.start, fragment.end);
      if (!value.trim()) continue;
      children.push({
        id: ragHash(
          `${document.id}:${sourceHash}:${policy}:c:${fragment.start}:${fragment.end}`,
        ),
        parentId: id,
        position: children.length,
        start: fragment.start,
        end: fragment.end,
        heading: fragment.heading,
        kind: fragment.kind,
        prefix: [document.title, fragment.heading, fragment.prefix]
          .filter(Boolean)
          .join("\n"),
        content: value,
        tokens: counter.count(value),
        locator: {
          ...fragment.locator,
          startLine: lineNumber(document.content, fragment.start),
          endLine: lineNumber(
            document.content,
            Math.max(fragment.start, fragment.end - 1),
          ),
        },
      });
    }
    group = [];
  };
  for (const fragment of fragments) {
    const first = group[0],
      previous = group.at(-1);
    if (
      first &&
      (first.section !== fragment.section ||
        first.kind !== fragment.kind ||
        first.prefix !== fragment.prefix ||
        semanticBreaks.some(
          (point) => point >= previous!.end && point <= fragment.start,
        ) ||
        counter.count(document.content.slice(first.start, fragment.end)) >
          config.parentTokens)
    )
      flush();
    group.push(fragment);
  }
  flush();
  return {
    sourceHash,
    policy,
    parents,
    children,
    units,
    tokenizerId: counter.id,
    semantic: semanticBreaks.length > 0,
  };
}
