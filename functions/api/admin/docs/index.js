// GET /api/admin/docs — 所有文档的列表（含编辑密钥）和图片的统计，需要管理密码，见 ../_middleware.js
import { imageStats, listDocs } from '../../../../lib/store.js';
import { MAX_TOTAL_IMAGE_BYTES, json, withTitle } from '../../../../lib/util.js';

export async function onRequestGet({ env }) {
  const [docs, images] = await Promise.all([listDocs(env), imageStats(env)]);
  return json({ docs: docs.map(withTitle), images: { ...images, limit: MAX_TOTAL_IMAGE_BYTES } });
}
