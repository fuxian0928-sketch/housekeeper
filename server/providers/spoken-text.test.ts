import test from 'node:test';
import assert from 'node:assert/strict';
import {spokenText} from './spoken-text.js';

test('Markdown styles, link destinations and brackets are not pronounced; content stays intact',()=>{
 const raw='## 当前进展\n\n1. **预算**为30万元（待核实）。\n2. 查看[项目文档](https://example.com/a?q=1)。';
 const speech=spokenText(raw);
 assert.doesNotMatch(speech,/[#*()[\]]|https/);assert.match(speech,/预算.*30万元，待核实。/);assert.match(speech,/项目文档/);
 assert.ok(raw.includes('**预算**'));
});
test('dates, decimals, percentages and meaningful identifiers keep their content',()=>{
 const speech=spokenText('评审是2026-10-27 10:30，比例3.14%，版本v2.0，语言是`C#`，计算为`3*4`。');
 for(const value of ['2026-10-27','10:30','3.14%','v2.0','C#','3乘以4'])assert.ok(speech.includes(value),value);
});
test('code is referred to the written original and tables keep cell values',()=>{
 const speech=spokenText('```ts\nconst secret = 123;\n```\n\n| 项目 | 金额 |\n| --- | --- |\n| A | 30万元 |');
 assert.doesNotMatch(speech,/const|secret|```|\|/);assert.match(speech,/代码请看页面/);assert.match(speech,/A，30万元/);
});
