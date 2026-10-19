// POST /api/doc — 新建文档，body: { content, anonId?, parentId?, editKey? }，返回 docId、editKey、updatedAt、viewUrl、editUrl。
// 前端在新文档第一次保存时才调用，打开新文档什么都没写就关掉的话，服务器上不会留下任何东西。
// 两个完整链接是给脚本、AI 这类直接调接口的用的，省得它们自己拼（前端用不到）。
// 带 parentId 时建成那篇文档的子文档，要同时带上它的 editKey：一棵树里的文档共用同一个编辑密钥，
// 新文档也沿用它，这样一个编辑链接就能改整棵树
import { createDoc, getEditKey } from '../../../lib/store.js';
import { MAX_CONTENT_BYTES, error, isValidId, json, randomId, readJson, safeEqual } from '../../../lib/util.js';

export async function onRequestPost({ env, request }) {
  const body = await readJson(request);
  if (!body || typeof body.content !== 'string') return error('请求体格式错误', 400);
  if (new TextEncoder().encode(body.content).byteLength > MAX_CONTENT_BYTES) return error('文档超过 1MB 上限', 413);
  const author = isValidId(body.anonId) ? body.anonId : null;

  let parentId = null;
  let parentKey = null;
  if (body.parentId != null) {
    if (!isValidId(body.parentId)) return error('无效的父文档 ID', 400);
    parentKey = await getEditKey(env, body.parentId);
    if (!parentKey) return error('父文档不存在', 404);
    if (!safeEqual(body.editKey, parentKey)) return error('编辑密钥错误', 403);
    parentId = body.parentId;
  }

  // 极小概率撞 ID，撞了就重试
  for (let i = 0; i < 5; i++) {
    const docId = randomId(10);
    const editKey = parentKey ?? randomId(24);
    const updatedAt = await createDoc(env, docId, body.content, editKey, author, parentId);
    if (!updatedAt) continue;
    const viewUrl = `${new URL(request.url).origin}/doc/${docId}`;
    return json({ docId, editKey, updatedAt, viewUrl, editUrl: `${viewUrl}?key=${encodeURIComponent(editKey)}` }, 201);
  }
  return error('生成文档 ID 失败，请重试', 500);
}
