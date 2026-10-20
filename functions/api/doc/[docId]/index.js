// GET  /api/doc/:docId — 读取文档（任何人可调，不返回 editKey）。
//      带 ?set=1 时顺带返回它所在的文档集 set: { id, title, updatedAt, docs: [{ id, title, updatedAt }] }，
//      不在集里是 null。编辑页的目录靠它，省一次请求
// POST /api/doc/:docId — 保存文档，body: { editKey, content, baseUpdatedAt?, anonId? }。
//      不带 content 时只校验编辑密钥（打开编辑链接时用），不读写内容
import { getDoc, getEditKey, getSetOfDoc, saveDoc } from '../../../../lib/store.js';
import { MAX_CONTENT_BYTES, error, isValidId, json, readJson, safeEqual, setView } from '../../../../lib/util.js';

const conflict = (doc) => json({ error: '文档已被其他人修改', content: doc.content, updatedAt: doc.updatedAt }, 409);

export async function onRequestGet({ params, env, request }) {
  const { docId } = params;
  if (!isValidId(docId)) return error('无效的文档 ID', 400);

  const withSet = new URL(request.url).searchParams.has('set');
  const [doc, set] = await Promise.all([getDoc(env, docId), withSet && getSetOfDoc(env, docId)]);
  if (!doc) return error('文档不存在', 404);

  return json({ content: doc.content, updatedAt: doc.updatedAt, ...(withSet && { set: set && setView(set) }) });
}

export async function onRequestPost({ params, env, request }) {
  const { docId } = params;
  if (!isValidId(docId)) return error('无效的文档 ID', 400);

  const body = await readJson(request);
  if (body && body.content === undefined) {
    const editKey = await getEditKey(env, docId);
    if (!editKey) return error('文档不存在', 404);
    return safeEqual(body.editKey, editKey) ? json({ ok: true }) : error('编辑密钥错误', 403);
  }
  if (!body || typeof body.content !== 'string') return error('请求体格式错误', 400);
  if (new TextEncoder().encode(body.content).byteLength > MAX_CONTENT_BYTES) return error('文档超过 1MB 上限', 413);

  const doc = await getDoc(env, docId);
  if (!doc) return error('文档不存在', 404);
  if (!safeEqual(body.editKey, doc.editKey)) return error('编辑密钥错误', 403);

  // 乐观锁：客户端基于的版本已经被别人改过，拒绝覆盖。
  // 客户端确认要覆盖时，会带上最新的 updatedAt 重新提交
  if (typeof body.baseUpdatedAt === 'number' && body.baseUpdatedAt !== doc.updatedAt) return conflict(doc);

  if (body.content === doc.content) return json({ updatedAt: doc.updatedAt });

  const author = isValidId(body.anonId) ? body.anonId : null;
  const updatedAt = await saveDoc(env, docId, body.content, author, doc.updatedAt);
  // 读取和写入之间刚好有人抢先保存了
  if (!updatedAt) return conflict(await getDoc(env, docId));

  return json({ updatedAt });
}
