// GET /api/doc/:docId/history — 历史版本列表（最新在前）
// 只读访客本来就能看到当前内容，历史版本同样对所有人开放。
// 不带 ?at= 时只返回时间和字数，带 ?at=<updatedAt> 时返回该版本全文。
import { getDoc, getVersion, listHistory } from '../../../../lib/store.js';
import { error, isValidId, json } from '../../../../lib/util.js';

export async function onRequestGet({ params, env, request }) {
  const { docId } = params;
  if (!isValidId(docId)) return error('无效的文档 ID', 400);

  // 先读一次文档：既判断存不存在，也会把还在 KV 里的旧文档连同历史搬进 D1
  if (!(await getDoc(env, docId))) return error('文档不存在', 404);

  const at = new URL(request.url).searchParams.get('at');
  if (at !== null) {
    const version = await getVersion(env, docId, Number(at));
    return version ? json(version) : error('版本不存在', 404);
  }

  return json({ versions: await listHistory(env, docId) });
}
