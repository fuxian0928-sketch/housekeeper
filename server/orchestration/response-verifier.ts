import type { KnowledgeCitation } from './context-builder.js';

function terms(value: string) {
  const result = new Set(value.toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? []);
  for (const run of value.match(/[\u3400-\u9fff]+/g) ?? []) for (let index = 0; index < run.length - 1; index += 1) result.add(run.slice(index, index + 2));
  return [...result];
}

export interface SupportVerification {
  factualStatementCount: number;
  supportedStatementCount: number;
  supportRatio: number;
  unsupportedStatements: string[];
  status: 'supported' | 'partial' | 'no_evidence_required';
}

export function verifyAnswerSupport(answer: string, citations: KnowledgeCitation[]): SupportVerification {
  const statements = answer.split(/(?<=[。！？!?；;])|\n+/).map((item) => item.trim()).filter((item) => item.length >= 10 && !/^(?:建议|下一步|可以|如果|资料不足|连接提示|我已|我已经)/.test(item));
  if (!statements.length) return { factualStatementCount: 0, supportedStatementCount: 0, supportRatio: 1, unsupportedStatements: [], status: 'no_evidence_required' };
  const evidenceTerms = new Set(terms(citations.map((citation) => `${citation.document} ${citation.path} ${citation.excerpt}`).join('\n')));
  const supported: boolean[] = statements.map((statement) => {
    const statementTerms = terms(statement);
    if (!statementTerms.length) return true;
    const overlap = statementTerms.filter((term) => evidenceTerms.has(term)).length;
    return overlap >= Math.min(3, Math.max(1, Math.ceil(statementTerms.length * 0.12)));
  });
  const supportedCount = supported.filter(Boolean).length;
  const ratio = supportedCount / statements.length;
  return {
    factualStatementCount: statements.length,
    supportedStatementCount: supportedCount,
    supportRatio: Number(ratio.toFixed(3)),
    unsupportedStatements: statements.filter((_statement, index) => !supported[index]).slice(0, 5),
    status: ratio >= 0.8 ? 'supported' : 'partial'
  };
}
