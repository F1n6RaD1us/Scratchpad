(() => {
  'use strict';

  const AUTOSAVE_DELAY_MS = 1500;  // 停止输入多久后自动保存
  // 心跳间隔。一次心跳同时上报在线、拿到在线人数、得知别人有没有保存新内容，
  // 每次都算一次 Workers 请求，别调太密（服务器端的配套设置见 lib/util.js 的 PRESENCE_*）
  const PRESENCE_INTERVAL_MS = 15000;
  const MY_DOCS_KEY = 'shareddoc:mine';
  const LINK_BAR_HIDDEN_KEY = 'shareddoc:linkBarHidden';
  // 编辑模式只留「分屏预览」（默认）和「所见即所得」。去掉的「即时渲染」和所见即所得差别不大，
  // 两者都把行内 HTML（<font color> 之类）拆成单独的标签块，显示不出效果；分屏预览右边的渲染和只读页一样
  const EDIT_MODES = ['sv', 'wysiwyg'];
  // 换了键名：旧键每次关页面都存下当时的模式，老用户存的全是原来的默认值，沿用的话新默认对他们不生效
  const EDIT_MODE_KEY = 'shareddoc:editorMode';
  localStorage.removeItem('shareddoc:editMode');

  // 新文档的初始内容。原样不动就不会保存，服务器上也就不会建这篇文档
  const WELCOME = `# 新文档

左边写 Markdown，右边实时显示排版效果。上方工具栏可以插入标题、**加粗**、列表、表格、图片等，不会 Markdown 也能用。

- 停止输入 1.5 秒后自动保存，也可以按 Ctrl+S
- 可以从网页或 Word 里复制内容粘贴进来，格式会尽量保留
- 想像写 Word 一样直接在排版效果上编辑，可以在工具栏的「切换编辑模式」里选「所见即所得」
`;

  // Vditor 运行时按需加载的文件（解析引擎、语言包、主题等）和主文件在同一个自托管目录下
  const VDITOR_CDN = document.querySelector('script[src*="/vendor/vditor-"]').src.replace(/\/dist\/.*$/, '');
  const CONTENT_THEME_PATH = `${VDITOR_CDN}/dist/css/content-theme`;

  // 「流程图」按钮插入的 Mermaid 模板，不会写语法的人改改方括号、花括号里的文字就能用。
  // 前后各有一个换行：分屏模式下是在光标处插入文字，这样代码块总是从新的一行开始
  const FLOWCHART_TEMPLATE = `
\`\`\`mermaid
flowchart TD
    A[开始] --> B{条件判断}
    B -->|是| C[步骤一]
    B -->|否| D[步骤二]
    C --> E[结束]
    D --> E
\`\`\`
`;
  const FLOWCHART_BUTTON = {
    name: 'flowchart',
    tip: '流程图',
    tipPosition: 's',
    icon: '<i class="icon i-workflow"></i>',
    click: () => {
      vditor.insertMD(FLOWCHART_TEMPLATE);
      // insertMD 插入后不会马上把图画出来（要等下次输入），手动画一下（:not(code) 排除源码，已经画好的有 data-processed）
      for (const el of els.editorPane.querySelectorAll('.language-mermaid:not(code):not([data-processed])')) {
        Vditor.mermaidRender(el.parentElement, VDITOR_CDN);
      }
    },
  };

  // 「插入图片」按钮：填网络图片的网址，或者上传到本站（见下文「插入图片」）。
  // 不用 Vditor 自带的上传：它不能先让用户在两种来源之间选择、确认知道上传的图片可能被删除
  const IMAGE_BUTTON = {
    name: 'insert-image',
    tip: '插入图片',
    tipPosition: 's',
    icon: '<i class="icon i-image"></i>',
    click: () => openImageDialog(),
  };

  // 工具栏：常用格式 + 模式切换；上传、导出、emoji 等用不上的没放。手机屏幕窄，只留最常用的。
  // 提示气泡默认往上弹，会被编辑区卡片的上沿裁掉，所以改成往下（tipPosition: 's'）
  const TOOLBAR = (matchMedia('(max-width: 720px)').matches
    ? ['headings', 'bold', 'italic', 'list', 'ordered-list', 'check', 'link', IMAGE_BUTTON, 'table', 'undo', 'redo', 'edit-mode']
    : [
      'headings', 'bold', 'italic', 'strike', '|',
      'list', 'ordered-list', 'check', 'quote', 'line', '|',
      'link', IMAGE_BUTTON, 'table', FLOWCHART_BUTTON, 'code', 'inline-code', '|',
      'undo', 'redo', '|',
      'edit-mode', 'outline', 'fullscreen',
    ]).map((item) => (typeof item === 'string' && item !== '|' ? { name: item, tipPosition: 's' } : item));

  // 页面上所有带 id 的元素，按 id 取用
  const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el]));

  const params = new URLSearchParams(location.search);
  // /doc/new 是还没保存过的新文档（docId 为 null）：第一次保存时才在服务器上创建，
  // 拿到 docId 后地址栏换成正式的编辑链接（见 onCreated）
  let docId = location.pathname === '/doc/new' ? null : location.pathname.split('/')[2] || '';

  // 匿名身份：用于在线人数统计，以及让服务器把同一个人的连续保存合并成一个历史版本
  let anonId = localStorage.getItem('shareddoc:anonId');
  if (!anonId) {
    anonId = crypto.randomUUID();
    localStorage.setItem('shareddoc:anonId', anonId);
  }

  const state = {
    editKey: params.get('key'),
    canEdit: false,
    updatedAt: null,  // 服务器上当前版本的时间戳，保存时用作乐观锁
    savedContent: '', // 最后一次和服务器一致的内容
    saving: false,
    autosaveTimer: null,
  };

  let vditor = null; // 只在编辑模式下创建

  // ---------- 工具 ----------

  // 站点的浅色 / 深色 → Vditor 的界面、正文、代码高亮主题
  const themes = () => (document.documentElement.dataset.theme === 'dark'
    ? { ui: 'dark', content: 'dark', code: 'github-dark' }
    : { ui: 'classic', content: 'light', code: 'github' });

  function previewOptions() {
    const t = themes();
    return {
      cdn: VDITOR_CDN,
      lang: 'zh_CN',
      mode: t.content,
      theme: { current: t.content, path: CONTENT_THEME_PATH },
      hljs: { style: t.code },
      markdown: { sanitize: true, toc: true }, // sanitize 过滤 <script>、onerror 之类，防止文档里夹带恶意代码；toc 让 [toc] 生成目录
      math: { engine: 'KaTeX' },
      anchor: 0,
    };
  }

  const renderInto = (el, md) => Vditor.preview(el, md, previewOptions());
  const currentContent = () => (state.canEdit ? vditor.getValue() : state.savedContent);
  // 新文档被清空了不算改动：空白内容不值得建一篇文档
  function isDirty() {
    if (!state.canEdit) return false;
    const content = vditor.getValue();
    return content !== state.savedContent && (docId !== null || content.trim() !== '');
  }

  function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.classList.toggle('error', isError);
  }

  function showError(message) {
    els.errorNotice.textContent = message;
    els.errorNotice.hidden = false;
  }

  // 在列表 / 预览区里放一行灰色提示文字
  function note(el, text) {
    const item = document.createElement(el.tagName === 'UL' ? 'li' : 'p');
    item.className = 'empty';
    item.textContent = text;
    el.replaceChildren(item);
  }

  function docTitle(md) {
    const m = md.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/m);
    return m ? m[1].slice(0, 80) : '';
  }

  function updateTitle(md) {
    const title = docTitle(md);
    document.title = title ? `${title} · 共享文档` : '共享文档';
  }

  // 请求最多等 20 秒：服务器卡住时给出提示，而不是页面一直停在“加载中”
  async function api(path, body) {
    const res = await fetch(path, {
      signal: AbortSignal.timeout(20000),
      ...(body && {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function copyText(text, btn) {
    await navigator.clipboard.writeText(text);
    const label = btn.querySelector('span');
    const original = label.textContent;
    label.textContent = '已复制';
    setTimeout(() => (label.textContent = original), 1500);
  }

  // 顶栏和提示条高度会变，编辑区高度要跟着变
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--chrome-height', `${els.chrome.offsetHeight}px`);
  }).observe(els.chrome);

  // ---------- 文档内的锚点链接（手写的目录） ----------

  // 锚点写法各家不同：GitHub 小写、去掉标点、空格变 -；Vditor 保留大小写、标点变 -。
  // 编辑器里的标题 id 还带 wysiwyg- 前缀和 _编号 后缀，按 id 永远找不到。
  // 所以先按 id 精确找，找不到再把链接和标题文字都去掉空白、标点、大小写后比较
  const anchorKey = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

  function findAnchor(root, hash) {
    let name = hash.slice(1);
    try { name = decodeURIComponent(name); } catch { /* 不是合法的百分号编码，按原样找 */ }
    const key = anchorKey(name);
    if (!key) return null;
    return root.querySelector(`[id="${CSS.escape(name)}"]`)
      || [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((h) => anchorKey(h.textContent) === key);
  }

  // 返回 false 表示文档里没有这个锚点
  function jumpToAnchor(root, hash) {
    const target = findAnchor(root, hash);
    target?.scrollIntoView({ block: 'start' });
    return !!target;
  }

  // 只读页、历史预览是静态渲染的，两种目录都在这里接管：
  // - 手写的锚点链接由浏览器处理，链接和标题 id 对不上时浏览器跳不过去
  // - [toc] 生成的目录由 Vditor 处理，但它滚动的是整个窗口，而这里滚动的是正文卡片，点了没反应。
  //   这个监听器比 Vditor 的先注册，stopImmediatePropagation 挡掉它的处理，免得两边的滚动叠在一起
  for (const el of [els.preview, els.versionPreview]) {
    el.addEventListener('click', (e) => {
      const tocItem = e.target.closest('.vditor-toc span[data-target-id]');
      if (tocItem) {
        e.stopImmediatePropagation();
        el.querySelector(`[id="${CSS.escape(tocItem.dataset.targetId)}"]`)?.scrollIntoView({ block: 'start' });
        return;
      }
      const a = e.target.closest('a[href^="#"]');
      if (a && jumpToAnchor(el, a.getAttribute('href'))) e.preventDefault();
    });
  }

  // ---------- 显示内容 ----------

  function setUpdatedAt(ts) {
    state.updatedAt = ts;
    els.updatedLabel.textContent = `更新于 ${new Date(ts).toLocaleString()}`;
  }

  // 用服务器内容替换本地（首次加载、别人改了、冲突时选择放弃本地）
  function applyRemote(content, updatedAt) {
    setUpdatedAt(updatedAt);
    if (state.canEdit) {
      vditor.setValue(content, true);
      state.savedContent = vditor.getValue(); // Vditor 会规范化格式，以它的结果为基准判断有没有改动
    } else {
      state.savedContent = content;
      renderInto(els.preview, content);
    }
    updateTitle(content);
  }

  // 创建编辑器；Vditor 要先加载解析引擎，加载完才算进入编辑模式
  function enterEditMode(content) {
    els.workspace.classList.remove('reading');
    els.readerPane.hidden = true;
    els.editorPane.hidden = false;
    els.editTools.hidden = els.saveBtn.hidden = false;
    els.modeBadge.classList.add('editing');
    els.modeIcon.className = 'icon i-pencil';
    els.modeLabel.textContent = '可编辑';
    setStatus('加载编辑器…');

    const t = themes();
    return new Promise((resolve) => {
      vditor = new Vditor('vditor', {
        cdn: VDITOR_CDN,
        lang: 'zh_CN',
        mode: EDIT_MODES.includes(localStorage.getItem(EDIT_MODE_KEY)) ? localStorage.getItem(EDIT_MODE_KEY) : 'sv',
        value: content,
        height: '100%',
        theme: t.ui,
        toolbar: TOOLBAR,
        counter: { enable: true, type: 'text' }, // 统计正文字数，不算 **、# 这些 Markdown 符号
        cache: { enable: false }, // 内容以服务器为准，不用 Vditor 自带的本地缓存
        placeholder: '开始写点什么吧…',
        preview: {
          theme: { current: t.content, path: CONTENT_THEME_PATH },
          hljs: { style: t.code },
          markdown: { sanitize: true, toc: true },
          math: { engine: 'KaTeX' },
          actions: [], // 分屏预览上方的“桌面 / 平板 / 手机 / 复制到公众号”那排按钮用不上
        },
        // Vditor 默认点任何链接都 window.open，站内锚点（#标题）会在新标签页里再开一遍当前文档。
        // 改成锚点跳到编辑区里的标题，其他链接照旧在新标签页打开
        link: {
          click: (el) => {
            const href = el.getAttribute('href');
            if (href?.startsWith('#')) jumpToAnchor(el.closest('.vditor-reset'), href);
            else if (href) window.open(href, '_blank', 'noopener');
          },
        },
        input: (md) => {
          updateTitle(md);
          scheduleAutosave();
        },
        after: () => {
          // 字数的提示气泡同样改成往下弹（提示文字见 site.css）
          els.editorPane.querySelector('.vditor-counter').classList.replace('vditor-tooltipped__nw', 'vditor-tooltipped__sw');

          state.canEdit = true;
          state.savedContent = vditor.getValue();
          setStatus('已保存');
          resolve();
        },
      });
    });
  }

  // 记住用户选的编辑模式（分屏预览 / 所见即所得），下次打开沿用
  addEventListener('pagehide', () => vditor && localStorage.setItem(EDIT_MODE_KEY, vditor.getCurrentMode()));

  addEventListener('themechange', () => {
    const t = themes();
    if (vditor) vditor.setTheme(t.ui, t.content, t.code);
    else {
      Vditor.setContentTheme(t.content, CONTENT_THEME_PATH);
      Vditor.setCodeTheme(t.code, VDITOR_CDN);
    }
  });

  // 更新“我创建的文档”列表里的标题，方便在文档首页辨认
  function rememberTitle(content) {
    const docs = JSON.parse(localStorage.getItem(MY_DOCS_KEY) || '[]');
    const mine = docs.find((d) => d.docId === docId);
    if (!mine) return;
    mine.title = docTitle(content);
    localStorage.setItem(MY_DOCS_KEY, JSON.stringify(docs));
  }

  // 新文档第一次保存成功：换成正式的编辑链接，记进“我创建的文档”，展开链接栏，开始同步
  function onCreated(data) {
    docId = data.docId;
    state.editKey = data.editKey;
    history.replaceState(null, '', `/doc/${docId}?key=${encodeURIComponent(state.editKey)}`);

    const docs = JSON.parse(localStorage.getItem(MY_DOCS_KEY) || '[]');
    localStorage.setItem(MY_DOCS_KEY, JSON.stringify([{ docId, editKey: state.editKey, createdAt: Date.now() }, ...docs]));

    els.historyBtn.hidden = els.linksBtn.hidden = false;
    setupLinkBar(true);
    startSync();
  }

  // ---------- 保存 ----------

  // create：新文档没改过也立即创建（上传图片要先有文档）
  async function save({ create = false } = {}) {
    clearTimeout(state.autosaveTimer);
    if (!state.canEdit || state.saving) return; // 保存中又有输入的话，保存完会再排一次自动保存

    const content = vditor.getValue();
    if (!isDirty() && !(create && docId === null)) return setStatus(docId === null ? '尚未保存' : '已保存');

    state.saving = true;
    setStatus('保存中…');
    const res = await (docId === null
      ? api('/api/doc', { content, anonId })
      : api(`/api/doc/${docId}`, {
        editKey: state.editKey,
        content,
        baseUpdatedAt: state.updatedAt,
        anonId,
      })
    ).catch(() => null);
    state.saving = false;

    if (!res) return setStatus('保存失败：网络错误', true);
    if (res.status === 409) return resolveConflict(res.data);
    if (res.status === 403) {
      setStatus('无权编辑', true);
      return showError('编辑密钥无效，无法保存。请确认你打开的是完整的编辑链接。');
    }
    if (!res.ok) return setStatus(`保存失败：${res.data.error || res.status}`, true);

    if (docId === null) onCreated(res.data);
    state.savedContent = content;
    setUpdatedAt(res.data.updatedAt);
    rememberTitle(content);
    if (isDirty()) scheduleAutosave();
    else setStatus('已保存');
  }

  // 保存时发现别人在我编辑期间存了新版本：像 git 合并分支一样三方合并（见 merge.js），
  // 底版是我开始改时的服务器版本。两人改的是不同段落就自动合并；改了同一段的，
  // 两种写法都留在文档里，用 <<<<<<< ======= >>>>>>> 标出来，由人来挑。合并完立即保存，谁的修改都不会丢
  function resolveConflict(remote) {
    const { text, conflicts } = mergeText(state.savedContent, vditor.getValue(), remote.content);
    state.savedContent = remote.content;
    setUpdatedAt(remote.updatedAt);
    setValueKeepingCaret(text);
    updateTitle(text);
    vditor.tip(conflicts
      ? `别人刚保存了新版本，有 ${conflicts} 处和你改了同一段。两种写法都保留在文档里，用 <<<<<<< 和 >>>>>>> 标出，请留下需要的内容，再删掉标记`
      : '别人刚保存了新版本，已和你的修改自动合并', conflicts ? 15000 : 4000);
    save();
  }

  // 换掉编辑器全文时尽量让光标、滚动位置留在原处：记下光标前的一小段文字，
  // 换完后在原位置附近找同样的文字，把光标放回它后面。找不到就算了，内容不受影响
  function setValueKeepingCaret(md) {
    const scrolls = [...els.editorPane.querySelectorAll('.vditor-sv, .vditor-wysiwyg, .vditor-preview')].map((el) => [el, el.scrollTop]);
    // 分屏预览的编辑区是 <textarea>，所见即所得是可编辑的 <pre>
    const active = document.activeElement;
    const textarea = active?.matches('#editorPane textarea') ? active : null;
    const sel = getSelection();
    const node = !textarea && sel.rangeCount && els.editorPane.contains(sel.anchorNode) ? sel.anchorNode : null;
    const root = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).closest('[contenteditable="true"]');
    let before = null;
    if (textarea) {
      before = textarea.value.slice(0, textarea.selectionStart);
    } else if (root) {
      const range = document.createRange();
      range.setStart(root, 0);
      range.setEnd(sel.anchorNode, sel.anchorOffset);
      before = range.toString();
    }

    vditor.setValue(md);
    for (const [el, top] of scrolls) el.scrollTop = top;
    if (before === null) return;

    const text = textarea ? textarea.value : root.textContent;
    const context = before.slice(-20);
    let best = context ? -1 : 0;
    for (let k = text.indexOf(context); context && k !== -1; k = text.indexOf(context, k + 1)) {
      const end = k + context.length;
      if (best === -1 || Math.abs(end - before.length) < Math.abs(best - before.length)) best = end;
    }
    if (best === -1) return;
    if (textarea) return textarea.setSelectionRange(best, best);

    // 把字符位置换算成具体的文字节点
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let rest = best;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (rest <= t.data.length) {
        const caret = document.createRange();
        caret.setStart(t, rest);
        sel.removeAllRanges();
        sel.addRange(caret);
        return;
      }
      rest -= t.data.length;
    }
  }

  function scheduleAutosave() {
    clearTimeout(state.autosaveTimer);
    setStatus('未保存');
    state.autosaveTimer = setTimeout(save, AUTOSAVE_DELAY_MS);
  }

  // 用新内容替换全文并立即保存（导入文件、恢复历史版本）；Ctrl+Z 可以撤销
  function replaceContent(text) {
    vditor.setValue(text);
    updateTitle(text);
    save();
  }

  // 捕获阶段监听，免得被编辑器自己的快捷键处理吞掉
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
    // Vditor 切到即时渲染的快捷键（菜单里的按钮已经用 site.css 藏起来了）
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === 'Digit8') {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });

  els.saveBtn.onclick = save;

  // ---------- 导入 / 导出 / 打印 ----------

  function importText(text) {
    if (vditor.getValue().trim() && !confirm('用导入的内容替换当前全部内容？（旧内容可在“历史”里找回）')) return;
    replaceContent(text);
  }

  els.importBtn.onclick = () => els.fileInput.click();
  els.fileInput.onchange = async () => {
    const file = els.fileInput.files[0];
    els.fileInput.value = '';
    if (file) importText(await file.text());
  };

  // 把 .md 文件拖进编辑区当作导入；图片文件打开「插入图片」对话框（见 takeImageFile），其他文件交给 Vditor 自己处理
  els.editorPane.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) els.editorPane.classList.add('dragover');
  }, true);
  els.editorPane.addEventListener('dragleave', () => els.editorPane.classList.remove('dragover'), true);
  els.editorPane.addEventListener('drop', async (e) => {
    els.editorPane.classList.remove('dragover');
    if (takeImageFile(e, e.dataTransfer)) return;
    const file = [...e.dataTransfer.files].find((f) => /\.(md|markdown|txt)$/i.test(f.name));
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    importText(await file.text());
  }, true);
  els.editorPane.addEventListener('paste', (e) => takeImageFile(e, e.clipboardData), true);

  // ---------- 插入图片 ----------

  // 文档是在线分享的，电脑上的图片路径（C:\...、./img.png）别人打不开。图片有两种来源，由用户在对话框里选：
  // - 网络图片：填别的网站上的图片网址，只要那个网站不删就一直能看
  // - 上传到本站：存在 D1 里，上传超过一年的可能被管理员在后台清理（不会自动删），上传前要勾选知道这一点
  const IMAGE_MAX_SIDE = 1920;         // 上传前把长边缩到这么大
  const IMAGE_MAX_BYTES = 1024 * 1024; // 和 lib/util.js 的 MAX_IMAGE_BYTES 一致

  const image = { source: 'url', file: null, previewUrl: null, busy: false };

  const formatSize = (bytes) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${Number((bytes / 1024 / 1024).toFixed(1))} MB`);

  // 粘贴、拖入的图片文件 Vditor 默认会转成 base64 写进文档正文，很快就撑到 1MB 上限，
  // 每次保存、同步、存历史版本也都要带着它，所以改成打开对话框的「上传到本站」。
  // 只管纯图片文件：从网页上复制的图片同时带着 HTML（<img src="网址">），Vditor 会按网址插入，不用管
  function takeImageFile(e, data) {
    if (data.getData('text/html')) return false;
    const file = [...data.files].find((f) => f.type.startsWith('image/'));
    if (!file) return false;
    e.preventDefault();
    e.stopPropagation();
    openImageDialog(file);
    return true;
  }

  // 只接受 http(s) 网址，返回规范化后的地址，不合格返回 null
  function imageUrl(text) {
    try {
      const url = new URL(text.trim());
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  let imagePreviewTimer = null;

  function previewImage() {
    clearTimeout(imagePreviewTimer);
    if (image.source === 'upload') {
      if (!image.file) return note(els.imagePreview, '选择图片后在这里预览');
      const img = new Image();
      img.onerror = () => note(els.imagePreview, '浏览器显示不了这张图片，可能是不支持的格式');
      img.src = image.previewUrl;
      return els.imagePreview.replaceChildren(img);
    }

    const url = imageUrl(els.imageUrlInput.value);
    if (!url) return note(els.imagePreview, els.imageUrlInput.value.trim() ? '请填写 http:// 或 https:// 开头的网址' : '填好网址后在这里预览');
    // 等输入停一下再加载，免得边打字边请求一堆不完整的地址
    imagePreviewTimer = setTimeout(() => {
      note(els.imagePreview, '加载中…');
      const img = new Image();
      // 加载完时网址可能已经改了，旧图片的结果就不要了
      const current = () => image.source === 'url' && imageUrl(els.imageUrlInput.value) === url;
      img.onload = () => {
        if (current()) els.imagePreview.replaceChildren(img);
      };
      img.onerror = () => {
        if (current()) note(els.imagePreview, '图片加载失败：检查网址是否正确，或者对方网站不允许别的网站引用它的图片');
      };
      img.src = url;
    }, 300);
  }

  function setImageSource(source) {
    image.source = source;
    for (const btn of els.imageSource.children) btn.classList.toggle('active', btn.dataset.source === source);
    els.imageUrlPanel.hidden = source !== 'url';
    els.imageUploadPanel.hidden = source !== 'upload';
    els.imageSubmitLabel.textContent = source === 'url' ? '插入' : '上传并插入';
    els.imageError.hidden = true;
    previewImage();
  }

  function setImageFile(file) {
    if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
    image.file = file;
    image.previewUrl = file && URL.createObjectURL(file);
    els.imageFileName.textContent = file
      ? `${file.name || '粘贴的图片'}（${formatSize(file.size)}）`
      : '也可以直接把图片粘贴或拖进编辑区';
    previewImage();
  }

  function setImageBusy(busy) {
    image.busy = busy;
    els.imageSubmit.disabled = els.imageCancel.disabled = busy;
    els.imageSubmitLabel.textContent = busy ? '上传中…' : '上传并插入';
  }

  function showImageError(message) {
    els.imageError.textContent = message;
    els.imageError.hidden = false;
  }

  // file：粘贴、拖进来的图片，直接打开「上传到本站」
  function openImageDialog(file = null) {
    // 「知道可能被删除」在同一个页面里勾过一次就不用再勾
    const accepted = els.imageAccept.checked;
    els.imageForm.reset();
    els.imageAccept.checked = accepted;
    els.imageUrlInput.setCustomValidity('');
    setImageFile(file);
    setImageSource(file ? 'upload' : 'url');
    els.imageDialog.showModal();
  }

  // 上传前压缩：缩到 IMAGE_MAX_SIDE 以内并转成 WebP，手机照片、截图一般只剩几百 KB。
  // GIF 重新编码会变成静止图片，原样上传；浏览器解码不了的格式也原样上传，由服务器判断收不收
  async function compressImage(file) {
    if (file.type === 'image/gif') return file;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return file;
    }
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
    // 不支持 WebP 编码的浏览器会退回 PNG，可能反而比原图大；原图是服务器不收的格式（比如 BMP）时只能用转换后的
    const supported = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
    return blob && (!supported || blob.size < file.size) ? blob : file;
  }

  // 返回图片的完整网址；失败时抛出可以直接显示给用户的错误
  async function uploadImage() {
    if (docId === null) await save({ create: true }); // 新文档要先在服务器上建好，图片才有地方挂
    if (docId === null) throw new Error('文档还没保存成功，请稍后再试');

    const blob = await compressImage(image.file);
    if (blob.size > IMAGE_MAX_BYTES) throw new Error(`图片压缩后仍有 ${formatSize(blob.size)}，超过 1 MB 上限`);
    const form = new FormData();
    form.append('editKey', state.editKey);
    form.append('file', blob);
    const res = await fetch(`/api/doc/${docId}/images`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) })
      .catch(() => { throw new Error('上传失败：网络错误或超时'); });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`上传失败：${data.error || res.status}`);
    // 存完整网址：下载的 .md 文件在别处打开时图片也能显示
    return new URL(data.url, location.origin).href;
  }

  els.imageSource.onclick = (e) => {
    const btn = e.target.closest('[data-source]');
    if (btn && !image.busy) setImageSource(btn.dataset.source);
  };
  els.imageUrlInput.oninput = () => {
    els.imageUrlInput.setCustomValidity('');
    previewImage();
  };
  els.imagePickBtn.onclick = () => els.imageFileInput.click();
  els.imageFileInput.onchange = () => {
    const file = els.imageFileInput.files[0];
    els.imageFileInput.value = '';
    if (file) setImageFile(file);
  };
  els.imageAccept.onchange = () => els.imageAccept.setCustomValidity('');
  els.imageCancel.onclick = () => els.imageDialog.close();
  // 点遮罩关闭。要用花括号：onclick 返回 false 会取消默认动作，「插入」按钮就提交不了表单了。
  // 上传中不能关：传完会插进文档，中途关掉的话用户会以为已经取消了
  els.imageDialog.onclick = (e) => {
    if (e.target === els.imageDialog && !image.busy) els.imageDialog.close();
  };
  els.imageDialog.addEventListener('cancel', (e) => {
    if (image.busy) e.preventDefault();
  });
  // 释放预览用的本地地址。close 事件是异步触发的，到的时候对话框可能已经重新打开了
  els.imageDialog.addEventListener('close', () => {
    if (!els.imageDialog.open) setImageFile(null);
  });

  els.imageForm.onsubmit = async (e) => {
    e.preventDefault();
    els.imageError.hidden = true;
    let url;
    if (image.source === 'url') {
      url = imageUrl(els.imageUrlInput.value);
      if (!url) {
        els.imageUrlInput.setCustomValidity('请填写 http:// 或 https:// 开头的图片网址');
        return els.imageUrlInput.reportValidity();
      }
    } else {
      if (!image.file) return showImageError('请先选择图片');
      if (!els.imageAccept.checked) {
        els.imageAccept.setCustomValidity('上传前请先勾选这一项');
        return els.imageAccept.reportValidity();
      }
      setImageBusy(true);
      try {
        url = await uploadImage();
      } catch (err) {
        return showImageError(err.message);
      } finally {
        setImageBusy(false);
      }
    }
    els.imageDialog.close();
    // 说明里的方括号、尖括号，网址里的括号会把 Markdown 语法截断，说明里的双引号会截断 Vditor 生成的 alt 属性。
    // 说明里的这些字符直接去掉：用反斜杠转义的话，所见即所得模式插入时 Vditor 会解析错
    const alt = els.imageAltInput.value.trim().replace(/[[\]\\<>"]/g, '');
    vditor.insertMD(`![${alt}](${url.replaceAll('(', '%28').replaceAll(')', '%29')})`);
  };

  els.downloadBtn.onclick = () => {
    const content = currentContent();
    const name = (docTitle(content) || docId || '新文档').replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    a.download = `${name}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Ctrl+P / 另存为 PDF 时只打印文档正文（打印样式见 site.css 的 @media print）。
  // 公式、流程图要异步渲染，beforeprint 里来不及重新渲染，所以复制页面上已经渲染好的
  addEventListener('beforeprint', () => {
    if (state.canEdit) {
      // 编辑器导出的 HTML 里公式、流程图还是源码，按出现顺序换成编辑区里渲染好的（:not(code) 排除编辑区里的源码）
      els.printArea.innerHTML = vditor.getHTML();
      const RENDERED = ':is(.language-math, .language-mermaid):not(code)';
      const rendered = els.editorPane.querySelectorAll(RENDERED);
      const sources = els.printArea.querySelectorAll(RENDERED);
      if (rendered.length === sources.length) sources.forEach((el, i) => (el.innerHTML = rendered[i].innerHTML));
      // 代码也没有高亮，按只读页的方式补上。编辑区显示代码块时已经加载过高亮脚本，打印排版前就能完成。
      // style 要传当前主题，否则 Vditor 会把页面上的高亮样式也换掉
      Vditor.highlightRender({ defaultLang: '', style: themes().code }, els.printArea, VDITOR_CDN);
    } else {
      els.printArea.innerHTML = els.preview.innerHTML;
    }
    // 复制出来的图和原图 id 相同，箭头等引用会找到原图里的定义，而原图打印时被隐藏，箭头就画不出来了
    for (const svg of els.printArea.querySelectorAll('.language-mermaid > svg[id]')) {
      svg.outerHTML = svg.outerHTML.replaceAll(svg.id, `print-${svg.id}`);
    }
  });

  // ---------- 链接栏：编辑模式下列出只读链接和编辑链接，收起状态会记住 ----------

  function showLinkBar(visible) {
    els.linkBar.hidden = !visible;
    els.linksBtn.classList.toggle('active', visible);
    localStorage.setItem(LINK_BAR_HIDDEN_KEY, String(!visible));
  }

  els.linksBtn.onclick = () => showLinkBar(els.linkBar.hidden);
  els.linkBarClose.onclick = () => {
    showLinkBar(false);
    els.linkHint.hidden = true;
    els.linkBar.classList.remove('new');
  };
  els.copyViewLink.onclick = () => copyText(els.viewLinkInput.value, els.copyViewLink);
  els.copyEditLink.onclick = () => copyText(els.editLinkInput.value, els.copyEditLink);
  for (const input of [els.viewLinkInput, els.editLinkInput]) input.onfocus = () => input.select();

  // isNew：刚创建的文档，强制展开链接栏并提示保存编辑链接
  function setupLinkBar(isNew = false) {
    const viewUrl = `${location.origin}/doc/${docId}`;
    els.viewLinkInput.value = viewUrl;
    els.editLinkInput.value = `${viewUrl}?key=${encodeURIComponent(state.editKey)}`;
    els.linkHint.hidden = !isNew;
    els.linkBar.classList.toggle('new', isNew);
    showLinkBar(isNew || localStorage.getItem(LINK_BAR_HIDDEN_KEY) !== 'true');
  }

  // ---------- 历史版本 ----------

  let selectedVersion = null;

  async function openHistory() {
    selectedVersion = null;
    els.restoreBtn.hidden = !state.canEdit;
    els.restoreBtn.disabled = true;
    note(els.versionPreview, '点左侧的版本查看内容');
    note(els.versionList, '加载中…');
    els.historyDialog.showModal();

    const { ok, data } = await api(`/api/doc/${docId}/history`);
    if (!ok) return note(els.versionList, `加载失败：${data.error || ''}`);
    if (!data.versions.length) return note(els.versionList, '还没有历史版本，保存一次后就会出现');

    els.versionList.replaceChildren(...data.versions.map((v, i) => {
      const li = document.createElement('li');
      li.textContent = new Date(v.updatedAt).toLocaleString();
      const meta = document.createElement('small');
      meta.textContent = `${v.length} 字${i === 0 ? ' · 当前版本' : ''}`;
      li.append(meta);
      li.onclick = () => showVersion(v.updatedAt, li);
      return li;
    }));
  }

  async function showVersion(updatedAt, li) {
    for (const item of els.versionList.children) item.classList.toggle('active', item === li);
    els.restoreBtn.disabled = true;
    note(els.versionPreview, '加载中…');

    const { ok, data } = await api(`/api/doc/${docId}/history?at=${updatedAt}`);
    if (!ok) return note(els.versionPreview, `加载失败：${data.error || ''}`);
    selectedVersion = data;
    await renderInto(els.versionPreview, data.content);
    els.restoreBtn.disabled = false;
  }

  els.historyBtn.onclick = openHistory;
  els.historyClose.onclick = () => els.historyDialog.close();
  // 点遮罩关闭（内容铺满了 dialog，点到 dialog 本身只可能是点在遮罩上）
  els.historyDialog.onclick = (e) => e.target === els.historyDialog && els.historyDialog.close();
  els.restoreBtn.onclick = () => {
    if (!confirm(`把文档恢复到 ${new Date(selectedVersion.updatedAt).toLocaleString()} 的版本？`)) return;
    els.historyDialog.close();
    replaceContent(selectedVersion.content);
  };

  // ---------- 在线人数 ----------

  // 心跳接口同时返回在线人数和文档当前版本，版本变了才去拉全文
  async function heartbeat({ force = false } = {}) {
    if (document.hidden && !force) return; // 后台标签页不上报，省请求次数和写入额度
    const res = await api(`/api/presence/${docId}`, { anonId }).catch(() => null);
    if (!res?.ok) return;
    els.onlineCount.textContent = res.data.online;
    if (res.data.updatedAt !== state.updatedAt) refresh();
  }

  // ---------- 拉取别人保存的新内容 ----------

  async function refresh() {
    if (document.hidden || state.saving || isDirty()) return; // 有未保存的修改时交给保存时的冲突处理
    const { ok, data } = await api(`/api/doc/${docId}`);
    if (!ok || data.updatedAt === state.updatedAt || isDirty()) return;
    applyRemote(data.content, data.updatedAt);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !docId) return;
    heartbeat(); // 切回来立刻报一次，顺便检查离开期间有没有人保存
  });

  function startSync() {
    heartbeat({ force: true });
    setInterval(heartbeat, PRESENCE_INTERVAL_MS);
  }

  // ---------- 启动 ----------

  async function init() {
    if (docId === null) {
      // 新文档：还没有链接和历史，这两个按钮等第一次保存后再出现
      els.historyBtn.hidden = els.linksBtn.hidden = true;
      updateTitle(WELCOME);
      await enterEditMode(WELCOME);
      setStatus('尚未保存');
      return;
    }
    if (!docId) {
      els.preview.innerHTML = '<p>链接不完整。请从 <a href="/">文档首页</a> 新建或打开文档。</p>';
      return;
    }

    const { ok, status, data } = await api(`/api/doc/${docId}`);
    if (!ok) {
      if (status === 404) els.preview.innerHTML = '<p>文档不存在。<a href="/">新建一个？</a></p>';
      else note(els.preview, `加载失败：${data.error || status}`);
      return;
    }
    let { content, updatedAt } = data;

    let editable = false;
    if (state.editKey) {
      // 用“保存相同内容”校验密钥：内容没变时服务器只比对密钥、不写入
      const check = await api(`/api/doc/${docId}`, { editKey: state.editKey, content, baseUpdatedAt: updatedAt });
      editable = check.ok || check.status === 409;
      if (check.status === 409) ({ content, updatedAt } = check.data); // 刚好有人保存了，用最新的
      if (!editable) showError('编辑密钥无效，已切换为只读模式。');
    }

    if (editable) {
      setUpdatedAt(updatedAt);
      updateTitle(content);
      setupLinkBar();
      await enterEditMode(content);
    } else {
      applyRemote(content, updatedAt);
    }

    startSync();
  }

  init().catch(() => {
    els.readerPane.hidden = false;
    note(els.preview, '加载失败：网络超时或服务器没有响应，请刷新重试');
  });
})();
