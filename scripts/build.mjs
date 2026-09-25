// 生成要发布的 dist/：npm run build
//
// Cloudflare Pages 连着 GitHub，每次推送到 main 都会在云端跑一遍这个脚本，然后发布 dist/。
// functions/ 不用管，Pages 会自己编译，并自动生成只让接口和文档页走 Worker 的 _routes.json。
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// 第三方依赖（Vditor、图标）自托管：没装过就先装好，再复制到 public/vendor/
// （Cloudflare 构建时会先自动 npm ci，这里只是给本地手动运行兜底）
if (!existsSync('node_modules')) execSync('npm ci', { stdio: 'inherit' });
execSync('node scripts/vendor.mjs', { stdio: 'inherit' });

rmSync('dist', { recursive: true, force: true, maxRetries: 5 }); // Windows 上文件偶尔被占用，重试几次
cpSync('public', 'dist', { recursive: true });

// 给 HTML 里引用的 /assets/* 加上内容哈希，如 /assets/site.css?v=ac7dfde4。
// Cloudflare 默认让浏览器把 CSS/JS 缓存 4 小时，不加的话部署后访客会拿到“新 HTML + 旧 CSS”；
// 加了之后文件一改地址就变，部署立即生效。只改 dist/ 里的副本，public/ 源文件不动。
const hashOf = (name) => createHash('sha256').update(readFileSync(`dist/assets/${name}`)).digest('hex').slice(0, 8);
for (const file of readdirSync('dist', { recursive: true })) {
  if (!file.endsWith('.html')) continue;
  const html = readFileSync(`dist/${file}`, 'utf8');
  writeFileSync(`dist/${file}`, html.replace(/(["'])\/assets\/([\w.-]+)\1/g, (_, q, name) => `${q}/assets/${name}?v=${hashOf(name)}${q}`));
}

console.log('\n已生成 dist/');
