// POST /api/set — 新建文档集，body: { title }，返回 setId、editKey、updatedAt、viewUrl、editUrl。
// 文档集只有名称，没有正文；往里加文档用 POST /api/doc 带上 setId 和这个 editKey
import { createSet } from '../../../lib/store.js';
import { error, json, randomId, readJson, setTitle } from '../../../lib/util.js';

export async function onRequestPost({ env, request }) {
  const body = await readJson(request);
  const title = setTitle(body?.title);
  if (!title) return error('请填写文档集名称（最多 80 个字）', 400);

  // 极小概率撞 ID，撞了就重试
  for (let i = 0; i < 5; i++) {
    const setId = randomId(10);
    const editKey = randomId(24);
    const updatedAt = await createSet(env, setId, title, editKey);
    if (!updatedAt) continue;
    const viewUrl = `${new URL(request.url).origin}/set/${setId}`;
    return json({ setId, editKey, updatedAt, viewUrl, editUrl: `${viewUrl}?key=${encodeURIComponent(editKey)}` }, 201);
  }
  return error('生成文档集 ID 失败，请重试', 500);
}
