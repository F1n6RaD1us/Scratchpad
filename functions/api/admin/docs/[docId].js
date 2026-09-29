// DELETE /api/admin/docs/:docId — 永久删除文档和它的全部历史版本，需要管理密码，见 ../_middleware.js
import { deleteDoc } from '../../../../lib/store.js';
import { error, isValidId, json } from '../../../../lib/util.js';

export async function onRequestDelete({ params, env }) {
  if (!isValidId(params.docId)) return error('无效的文档 ID', 400);
  if (!(await deleteDoc(env, params.docId))) return error('文档不存在', 404);
  return json({ ok: true });
}
