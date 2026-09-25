// POST /api/presence/:docId — 心跳，body: { anonId }，同时返回在线人数
// GET  /api/presence/:docId — 只返回在线人数
import { getOnline, heartbeat } from '../../../lib/store.js';
import { error, isValidId, json, readJson } from '../../../lib/util.js';

export async function onRequestGet({ params, env }) {
  if (!isValidId(params.docId)) return error('无效的文档 ID', 400);
  return json({ online: await getOnline(env, params.docId) });
}

export async function onRequestPost({ params, env, request }) {
  if (!isValidId(params.docId)) return error('无效的文档 ID', 400);

  const body = await readJson(request);
  if (!body || !isValidId(body.anonId)) return error('缺少 anonId', 400);

  return json({ online: await heartbeat(env, params.docId, body.anonId) });
}
