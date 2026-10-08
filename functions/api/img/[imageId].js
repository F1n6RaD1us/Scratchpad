// GET /api/img/:imageId — 读取上传到本站的图片（任何人可调）。
// 每次调用都算一次 Workers 请求，所以让浏览器长期缓存：图片上传后内容不会变，ID 也不会复用
import { getImage } from '../../../lib/store.js';
import { error, isValidId } from '../../../lib/util.js';

export async function onRequestGet({ params, env }) {
  if (!isValidId(params.imageId)) return error('无效的图片 ID', 400);

  const image = await getImage(env, params.imageId);
  if (!image) return error('图片不存在（可能已被管理员删除）', 404);

  return new Response(new Uint8Array(image.data), {
    headers: {
      'content-type': image.type,
      'cache-control': 'public, max-age=31536000, immutable',
      // 类型是上传时按文件头判断的，不让浏览器再猜；直接打开图片地址时也不执行任何东西
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}
