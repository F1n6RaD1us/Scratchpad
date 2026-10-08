// POST /api/doc/:docId/images — 上传图片到本站，FormData: { editKey, file }，返回 { url }。
// 只有拿着编辑链接的人能传；图片存在 D1 的 images 表里，由 GET /api/img/:imageId 读取
import { addImage, getEditKey, imageUsage } from '../../../../lib/store.js';
import {
  MAX_DOC_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, error, isValidId, json, randomId, safeEqual,
} from '../../../../lib/util.js';

// 按文件头判断类型，不信任浏览器报的 type。不收 SVG：它能夹带脚本，
// 而图片和文档同一个域名，读者浏览器里存着他们自己文档的编辑密钥
function imageType(b) {
  const at = (i, text) => [...text].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  return null;
}

const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;

export async function onRequestPost({ params, env, request }) {
  const { docId } = params;
  if (!isValidId(docId)) return error('无效的文档 ID', 400);
  // 先看请求头里的大小，明显超限的不用读进来再拒绝（留一点 FormData 自身的开销）
  if (Number(request.headers.get('content-length')) > MAX_IMAGE_BYTES + 64 * 1024) {
    return error(`图片超过 ${mb(MAX_IMAGE_BYTES)} 上限`, 413);
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return error('请求体格式错误', 400);

  const editKey = await getEditKey(env, docId);
  if (!editKey) return error('文档不存在', 404);
  if (!safeEqual(form.get('editKey'), editKey)) return error('编辑密钥错误', 403);

  const data = await file.arrayBuffer();
  if (data.byteLength > MAX_IMAGE_BYTES) return error(`图片超过 ${mb(MAX_IMAGE_BYTES)} 上限`, 413);
  const type = imageType(new Uint8Array(data, 0, Math.min(12, data.byteLength)));
  if (!type) return error('只支持 PNG、JPEG、WebP、GIF 格式的图片', 415);

  const usage = await imageUsage(env, docId);
  if (usage.doc + data.byteLength > MAX_DOC_IMAGE_BYTES) {
    return error(`这篇文档上传的图片已达 ${mb(MAX_DOC_IMAGE_BYTES)} 上限，请改用网络图片`, 413);
  }
  if (usage.total + data.byteLength > MAX_TOTAL_IMAGE_BYTES) {
    return error('本站的图片存储空间已满，请改用网络图片', 507);
  }

  const id = randomId(16);
  await addImage(env, id, docId, type, data);
  return json({ url: `/api/img/${id}` }, 201);
}
