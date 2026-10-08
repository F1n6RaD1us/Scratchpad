// GET /api/admin/docs — 所有文档的列表（含编辑密钥）和图片的统计，需要管理密码，见 ../_middleware.js
import { imageStats, listDocs } from '../../../../lib/store.js';
import { MAX_TOTAL_IMAGE_BYTES, json } from '../../../../lib/util.js';

// 标题取第一个 Markdown 标题（和 editor.js 的 docTitle 一样）；没有标题就用第一行文字
function titleOf(head) {
  const m = head.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/m);
  const line = m ? m[1] : head.split('\n').find((l) => l.trim()) || '';
  return line.replace(/^[\s>*+-]+/, '').trim().slice(0, 80);
}

export async function onRequestGet({ env }) {
  const [docs, images] = await Promise.all([listDocs(env), imageStats(env)]);
  return json({ docs: docs.map(({ head, ...doc }) => ({ ...doc, title: titleOf(head) })), images: { ...images, limit: MAX_TOTAL_IMAGE_BYTES } });
}
