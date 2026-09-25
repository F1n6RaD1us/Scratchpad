// POST /api/doc — 新建文档，body: { content, anonId? }，返回 docId、editKey、updatedAt。
// 前端在新文档第一次保存时才调用，打开新文档什么都没写就关掉的话，服务器上不会留下任何东西
import { createDoc } from '../../../lib/store.js';
import { MAX_CONTENT_BYTES, error, isValidId, json, randomId, readJson } from '../../../lib/util.js';

export async function onRequestPost({ env, request }) {
  const body = await readJson(request);
  if (!body || typeof body.content !== 'string') return error('请求体格式错误', 400);
  if (new TextEncoder().encode(body.content).byteLength > MAX_CONTENT_BYTES) return error('文档超过 1MB 上限', 413);
  const author = isValidId(body.anonId) ? body.anonId : null;

  // 极小概率撞 ID，撞了就重试
  for (let i = 0; i < 5; i++) {
    const docId = randomId(10);
    const editKey = randomId(24);
    const updatedAt = await createDoc(env, docId, body.content, editKey, author);
    if (updatedAt) return json({ docId, editKey, updatedAt }, 201);
  }
  return error('生成文档 ID 失败，请重试', 500);
}
