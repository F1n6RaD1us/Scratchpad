// GET  /api/doc/:docId — 读取文档（任何人可调，不返回 editKey）
// POST /api/doc/:docId — 保存文档，body: { editKey, content, baseUpdatedAt?, anonId? }
import { getDoc, saveDoc } from '../../../../lib/store.js';
import { MAX_CONTENT_BYTES, error, isValidId, json, readJson, safeEqual } from '../../../../lib/util.js';

const conflict = (doc) => json({ error: '文档已被其他人修改', content: doc.content, updatedAt: doc.updatedAt }, 409);

export async function onRequestGet({ params, env }) {
  if (!isValidId(params.docId)) return error('无效的文档 ID', 400);

  const doc = await getDoc(env, params.docId);
  if (!doc) return error('文档不存在', 404);

  return json({ content: doc.content, updatedAt: doc.updatedAt });
}

export async function onRequestPost({ params, env, request }) {
  const { docId } = params;
  if (!isValidId(docId)) return error('无效的文档 ID', 400);

  const body = await readJson(request);
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
