// /doc/ — 以前的文档首页地址，现在首页在根路径
export function onRequestGet({ request }) {
  return Response.redirect(new URL('/', request.url), 301);
}
