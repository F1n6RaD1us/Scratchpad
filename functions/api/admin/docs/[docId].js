// DELETE /api/admin/docs/:docId — 永久删除文档和它下面的全部子文档，连同它们的历史版本、上传的图片，
// 需要管理密码，见 ../_middleware.js。返回 { ok, deleted }，deleted 是一共删掉了几篇
import { deleteDoc } from '../../../../lib/store.js';
import { error, isValidId, json } from '../../../../lib/util.js';

export async function onRequestDelete({ params, env }) {
  if (!isValidId(params.docId)) return error('无效的文档 ID', 400);
  const deleted = await deleteDoc(env, params.docId);
  if (!deleted) return error('文档不存在', 404);
  return json({ ok: true, deleted });
}
