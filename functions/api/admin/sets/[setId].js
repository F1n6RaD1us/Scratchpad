// DELETE /api/admin/sets/:setId — 永久删除文档集和里面的全部文档（连同它们的历史版本、上传的图片），
// 需要管理密码，见 ../_middleware.js。返回 { ok, deleted }，deleted 是删掉了几篇文档
import { deleteSet } from '../../../../lib/store.js';
import { error, isValidId, json } from '../../../../lib/util.js';

export async function onRequestDelete({ params, env }) {
  if (!isValidId(params.setId)) return error('无效的文档集 ID', 400);
  const deleted = await deleteSet(env, params.setId);
  if (deleted === null) return error('文档集不存在', 404);
  return json({ ok: true, deleted });
}
