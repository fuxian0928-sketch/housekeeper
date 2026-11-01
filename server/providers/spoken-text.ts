import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

type Node = {type:string;value?:string;alt?:string;children?:Node[]};
const parser=unified().use(remarkParse).use(remarkGfm);
function read(node:Node):string {
  const children=()=>node.children?.map(read)??[];
  switch(node.type){
    case 'text':return node.value??'';
    case 'inlineCode':return node.value??'';
    case 'code':return '代码请看页面上的文字内容。';
    case 'image':return node.alt??'';
    case 'html':case 'definition':case 'footnoteDefinition':case 'footnoteReference':return '';
    case 'break':case 'thematicBreak':return '\n';
    case 'root':case 'list':case 'listItem':case 'table':return children().join('\n');
    case 'tableRow':return children().join('，');
    default:return children().join('');
  }
}
/** Speech projection only. Never save this over the original answer/document. */
export function spokenText(markdown:string):string {
  if(markdown.length>30000)throw Error('VOICE_TEXT_LIMIT');
  return read(parser.parse(markdown) as Node)
    .replace(/https?:\/\/[^\s，。！？；）)<>]+/g,'链接见页面')
    .replace(/[（(\[【「『《“‘]/g,'，').replace(/[）)\]】」』》”’]/g,'，')
    .replace(/([\dA-Za-z])\s*\*\s*(?=[\dA-Za-z])/g,'$1乘以')
    .replace(/[*`~]/g,'').replace(/(^|\s)#{1,6}(?=\s|$)/g,'$1')
    .replace(/[\t ]+/g,' ').replace(/ *\n+ */g,'。\n')
    .replace(/[，,]*(?:[。.]\s*){2,}/g,'。').replace(/[，,]+([。！？；])/g,'$1')
    .replace(/([。！？；])[，,]+/g,'$1').replace(/[，,]{2,}/g,'，')
    .replace(/^[，。\s]+|[，\s]+$/g,'').trim();
}
