// 生成 Cloudflare Dashboard「上传资产」用的 shared-docs.zip：node scripts/build-zip.mjs
//
// Dashboard 拖拽上传不会编译 functions/，但支持 _worker.js（advanced mode）。
// 所以先用 wrangler 把 functions/ 打包成单个 _worker.js，再和 public/ 一起压缩：
//   dist/
//     _worker.js    ← functions/ 编译结果
//     _routes.json  ← 只让 /doc、/doc/*、/api/doc*、/api/presence/* 走 Worker，
//                     其余请求（首页、样式、Vditor 文件等）直接按静态文件返回，不消耗 Functions 调用次数
//     ...public/ 的全部文件
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ZIP = 'shared-docs.zip';

// 第三方依赖（Vditor、图标）自托管：第一次打包时先装好，再复制到 public/vendor/
if (!existsSync('node_modules')) execSync('npm ci', { stdio: 'inherit' });
execSync('node scripts/vendor.mjs', { stdio: 'inherit' });

rmSync('dist', { recursive: true, force: true, maxRetries: 5 }); // Windows 上文件偶尔被占用，重试几次
rmSync(ZIP, { force: true });
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

mkdirSync('dist/.worker');
execSync(
  'npx wrangler pages functions build --outdir dist/.worker --output-routes-path dist/_routes.json --minify',
  { stdio: 'inherit' },
);
// 打包结果只有一个 index.js，放成单文件 _worker.js（Dashboard 上传文档里写的就是这种形式）
renameSync('dist/.worker/index.js', 'dist/_worker.js');
rmSync('dist/.worker', { recursive: true });

// Windows 自带的 bsdtar 能直接写 zip（Git Bash 里的 GNU tar 不行，所以写死系统路径）
const tar = process.platform === 'win32' ? `${process.env.SystemRoot}\\System32\\tar.exe` : 'tar';
execFileSync(tar, ['-a', '-cf', `../${ZIP}`, ...readdirSync('dist')], { cwd: 'dist', stdio: 'inherit' });

console.log(`\n已生成 ${ZIP}，在 Pages 项目里「创建新部署」上传即可。`);
