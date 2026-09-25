// 自托管第三方依赖：把 node_modules 里用得到的文件复制到 public/vendor/（已 gitignore）。
// build.mjs 构建前会自动运行；本地调试用 npm run dev，也会先跑这一步。
import { cpSync, readFileSync, rmSync } from 'node:fs';

const OUT = 'public/vendor';
const version = (name) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;

rmSync(OUT, { recursive: true, force: true, maxRetries: 5 }); // 开着 npm run dev 时文件可能被占用，重试几次

// ---------- Vditor ----------
// 目录带版本号：升级后路径随之变化，不会被浏览器缓存的旧文件卡住。
// 主文件由 editor.html 引用；其余文件由 Vditor 运行时按 `${cdn}/dist/...` 自己加载。
const vditor = `vditor-${version('vditor')}`;
const VDITOR_FILES = [
  'index.min.js',
  'index.css',
  'js/lute',                     // Markdown 解析引擎，编辑和只读渲染都要用
  'js/i18n/zh_CN.js',
  'js/icons/ant.js',
  'css/content-theme/light.css',
  'css/content-theme/dark.css',
  'js/highlight.js/highlight.min.js',
  'js/highlight.js/third-languages.js',
  'js/highlight.js/styles/github.min.css',
  'js/highlight.js/styles/github-dark.min.css',
  'js/katex',                    // 数学公式
  // 没带 mermaid / echarts / graphviz / mathjax 等大件（加起来十几 MB），
  // 文档里出现这些代码块时按普通代码显示
];
for (const file of VDITOR_FILES) {
  cpSync(`node_modules/vditor/dist/${file}`, `${OUT}/${vditor}/dist/${file}`, { recursive: true });
}

// editor.html 里每一处 Vditor 路径都要是已安装的版本，改漏一处也报错
const html = readFileSync('public/editor.html', 'utf8');
const refs = [...html.matchAll(/\/vendor\/(vditor-[^/]+)\//g)].map((m) => m[1]);
if (!refs.length || refs.some((ref) => ref !== vditor)) {
  throw new Error(`public/editor.html 里引用的 Vditor 路径和已安装的版本（${vditor}）不一致，请同步修改`);
}

// ---------- Lucide 图标：只复制 site.css 里用到的 ----------
const css = readFileSync('public/assets/site.css', 'utf8');
const icons = new Set([...css.matchAll(/\/vendor\/lucide\/([\w-]+)\.svg/g)].map((m) => m[1]));
for (const name of icons) {
  cpSync(`node_modules/lucide-static/icons/${name}.svg`, `${OUT}/lucide/${name}.svg`);
}

console.log(`已复制 ${vditor} 和 ${icons.size} 个图标到 ${OUT}/`);
