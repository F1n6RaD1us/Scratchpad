// POST /api/doc — 新建文档，body: { content, anonId?, setId?, editKey? }，返回 docId、editKey、updatedAt、viewUrl、editUrl。
// 前端在新文档第一次保存时才调用，打开新文档什么都没写就关掉的话，服务器上不会留下任何东西。
// 两个完整链接是给脚本、AI 这类直接调接口的用的，省得它们自己拼（前端用不到）。
// 带 setId 时建在那个文档集里，要同时带上文档集的 editKey：集里的文档和文档集共用同一个编辑密钥，
// 新文档也沿用它，这样文档集的编辑链接就能改里面每一篇
import { createDoc, getSetKey } from '../../../lib/store.js';
import { MAX_CONTENT_BYTES, error, isValidId, json, randomId, readJson, safeEqual } from '../../../lib/util.js';

export async function onRequestPost({ env, request }) {
  const body = await readJson(request);
  if (!body || typeof body.content !== 'string') return error('请求体格式错误', 400);
  if (new TextEncoder().encode(body.content).byteLength > MAX_CONTENT_BYTES) return error('文档超过 1MB 上限', 413);
  const author = isValidId(body.anonId) ? body.anonId : null;

  let setId = null;
  let setKey = null;
  if (body.setId != null) {
    if (!isValidId(body.setId)) return error('无效的文档集 ID', 400);
    setKey = await getSetKey(env, body.setId);
    if (!setKey) return error('文档集不存在', 404);
    if (!safeEqual(body.editKey, setKey)) return error('编辑密钥错误', 403);
    setId = body.setId;
  }

  // 极小概率撞 ID，撞了就重试
  for (let i = 0; i < 5; i++) {
    const docId = randomId(10);
    const editKey = setKey ?? randomId(24);
    const updatedAt = await createDoc(env, docId, body.content, editKey, author, setId);
    if (!updatedAt) continue;
    const viewUrl = `${new URL(request.url).origin}/doc/${docId}`;
    return json({ docId, editKey, updatedAt, viewUrl, editUrl: `${viewUrl}?key=${encodeURIComponent(editKey)}` }, 201);
  }
  return error('生成文档 ID 失败，请重试', 500);
}
