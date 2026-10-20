// GET  /api/set/:setId — 读取文档集：名称和里面的文档 { id, title, updatedAt, docs: [{ id, title, updatedAt }] }，
//      文档按创建时间排（任何人可调，不返回 editKey）
// POST /api/set/:setId — 改名，body: { editKey, title }，返回 updatedAt。不带 title 时只校验编辑密钥
import { getSet, getSetKey, renameSet } from '../../../lib/store.js';
import { error, isValidId, json, readJson, safeEqual, setTitle, setView } from '../../../lib/util.js';

export async function onRequestGet({ params, env }) {
  if (!isValidId(params.setId)) return error('无效的文档集 ID', 400);
  const set = await getSet(env, params.setId);
  return set ? json(setView(set)) : error('文档集不存在', 404);
}

export async function onRequestPost({ params, env, request }) {
  const { setId } = params;
  if (!isValidId(setId)) return error('无效的文档集 ID', 400);

  const body = await readJson(request);
  if (!body) return error('请求体格式错误', 400);
  const editKey = await getSetKey(env, setId);
  if (!editKey) return error('文档集不存在', 404);
  if (!safeEqual(body.editKey, editKey)) return error('编辑密钥错误', 403);
  if (body.title === undefined) return json({ ok: true });

  const title = setTitle(body.title);
  if (!title) return error('请填写文档集名称（最多 80 个字）', 400);
  const updatedAt = await renameSet(env, setId, title);
  return updatedAt ? json({ updatedAt }) : error('文档集不存在', 404);
}
