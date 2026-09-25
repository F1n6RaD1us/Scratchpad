// POST /api/doc — 新建文档，返回 docId 和 editKey
import { createDoc } from '../../../lib/store.js';
import { json, randomId } from '../../../lib/util.js';

const WELCOME = `# 新文档

像写 Word 一样直接编辑，上方工具栏可以设置标题、**加粗**、列表、表格等。

- 停止输入 1.5 秒后自动保存，也可以按 Ctrl+S
- 可以从网页或 Word 里复制内容粘贴进来，格式会尽量保留
- 会写 Markdown 的话，可以在工具栏里切换到「分屏预览」模式
`;

export async function onRequestPost({ env }) {
  // 极小概率撞 ID，撞了就重试
  for (let i = 0; i < 5; i++) {
    const docId = randomId(10);
    const editKey = randomId(24);
    if (await createDoc(env, docId, WELCOME, editKey)) return json({ docId, editKey }, 201);
  }
  return json({ error: '生成文档 ID 失败，请重试' }, 500);
}
