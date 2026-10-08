// DELETE /api/admin/images — 永久删除上传超过一年的图片（见 lib/util.js 的 IMAGE_KEEP_MS），需要管理密码，见 ./_middleware.js。
// 图片不会自动删除，只有管理员在后台点了按钮才会调用这里
import { deleteExpiredImages } from '../../../lib/store.js';
import { json } from '../../../lib/util.js';

export async function onRequestDelete({ env }) {
  return json({ deleted: await deleteExpiredImages(env) });
}
