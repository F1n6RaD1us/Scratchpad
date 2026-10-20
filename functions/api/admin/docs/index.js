// GET /api/admin/docs — 所有文档、文档集的列表（含编辑密钥）和图片的统计，需要管理密码，见 ../_middleware.js
import { imageStats, listDocs, listSets } from '../../../../lib/store.js';
import { MAX_TOTAL_IMAGE_BYTES, json, withTitle } from '../../../../lib/util.js';

export async function onRequestGet({ env }) {
  const [docs, sets, images] = await Promise.all([listDocs(env), listSets(env), imageStats(env)]);
  return json({ docs: docs.map(withTitle), sets, images: { ...images, limit: MAX_TOTAL_IMAGE_BYTES } });
}
