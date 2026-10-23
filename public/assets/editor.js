(() => {
  'use strict';

  const AUTOSAVE_DELAY_MS = 1500;  // 停止输入多久后自动保存
  // 心跳间隔。一次心跳同时上报在线、拿到在线人数、得知别人有没有保存新内容，
  // 每次都算一次 Workers 请求，别调太密（服务器端的配套设置见 lib/util.js 的 PRESENCE_*）
  const PRESENCE_INTERVAL_MS = 15000;
  const MY_DOCS_KEY = 'shareddoc:mine';
  const LINK_BAR_HIDDEN_KEY = 'shareddoc:linkBarHidden';
  const SIDEBAR_HIDDEN_KEY = 'shareddoc:sidebarHidden';
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
  // 文档集里新建的文档只放一个标题（用法说明看第一篇就够了），原样不动同样不会保存
  const NEW_DOC_IN_SET = '# 新文档\n';

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

  // 当前显示的内容。在文档集里切换文档不重新加载页面（见下文「切换页面」），这几个值随之改变
  let page = 'doc';      // 'doc' 文档，'set' 文档集的目录页
  // 当前文档。null 是还没保存过的新文档（/doc/new）：第一次保存时才在服务器上创建，
  // 拿到 ID 后地址栏换成正式的编辑链接（见 onCreated）
  let docId = null;
  let newDocSet = null;  // 新文档要建在哪个文档集里（/doc/new?set=文档集ID&key=编辑密钥），不在集里是 null
  // 当前所在的文档集 { id, title, docs: [{ id, title, updatedAt }] }，不在集里是 null；
  // 还没建好的新文档集（/set/new）id 是 null
  let docSet = null;

  // 匿名身份：用于在线人数统计，以及让服务器把同一个人的连续保存合并成一个历史版本
  let anonId = localStorage.getItem('shareddoc:anonId');
  if (!anonId) {
    anonId = crypto.randomUUID();
    localStorage.setItem('shareddoc:anonId', anonId);
  }

  const state = {
    // 文档集里的文档和文档集共用编辑密钥，所以在集里切换时密钥不变，能不能编辑也不变，只在打开页面时校验一次
    editKey: new URLSearchParams(location.search).get('key'),
    canEdit: false,
    editorReady: false, // 编辑器创建好了（编辑模式下第一次打开文档时才创建）
    updatedAt: null,    // 服务器上当前版本的时间戳，保存时用作乐观锁
    savedContent: '',   // 最后一次和服务器一致的内容
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
      markdown: { sanitize: true }, // 过滤 <script>、onerror 之类，防止文档里夹带恶意代码
      math: { engine: 'KaTeX' },
      anchor: 0,
    };
  }

  // after：渲染完之后再做的事。
  // [toc] 以前会在那里生成目录，现在改成只读页右边的大纲（见下文「大纲」），旧文档里单独一行的 [toc]
  // 渲染出来就是这几个字，去掉。按段落整段比较，代码块里写的 [toc] 不受影响
  const renderInto = (el, md, after) => Vditor.preview(el, md, {
    ...previewOptions(),
    after: () => {
      for (const p of el.querySelectorAll('p')) if (p.textContent.trim().toLowerCase() === '[toc]') p.remove();
      after?.();
    },
  });
  // 正在编辑器里改文档（不是只读，也不在文档集的目录页上）
  const editing = () => state.editorReady && page === 'doc';
  const currentContent = () => (editing() ? vditor.getValue() : state.savedContent);
  // 新文档被清空了不算改动：空白内容不值得建一篇文档
  function isDirty() {
    if (!editing()) return false;
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

  function setPageTitle(title) {
    document.title = title ? `${title} · 共享文档` : '共享文档';
  }

  function updateTitle(md) {
    setPageTitle(docTitle(md));
    updateSidebarTitle(md);
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

  // 复制成功时按钮文字变成「已复制」，同时高亮一下：窄屏上顶栏按钮只显示图标，看不到文字
  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      prompt('浏览器不允许自动复制，请手动复制：', text);
      return;
    }
    const label = btn.querySelector('span');
    label.dataset.original ??= label.textContent; // 连点两下时不要把「已复制」当成原文
    label.textContent = '已复制';
    btn.classList.add('active');
    clearTimeout(btn.copiedTimer);
    btn.copiedTimer = setTimeout(() => {
      label.textContent = label.dataset.original;
      btn.classList.remove('active');
    }, 1500);
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

  // 只读页、历史预览是静态渲染的，手写的锚点链接在这里接管：
  // 浏览器自己处理的话，链接和标题 id 对不上时跳不过去
  for (const el of [els.preview, els.versionPreview]) {
    el.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (a && jumpToAnchor(el, a.getAttribute('href'))) e.preventDefault();
    });
  }

  // ---------- 显示内容 ----------

  function setUpdatedAt(ts) {
    state.updatedAt = ts;
    els.updatedLabel.textContent = `更新于 ${new Date(ts).toLocaleString()}`;
  }

  // 显示服务器上的内容（打开文档、在文档集里切换、别人保存了新内容），顺带记进 docCache（见「切换页面」）
  async function showContent(content, updatedAt) {
    docCache.set(docId, { content, updatedAt });
    setUpdatedAt(updatedAt);
    if (state.canEdit) {
      await ensureEditor(content);
    } else {
      state.savedContent = content;
      renderInto(els.preview, content, renderOutline);
    }
    updateTitle(content);
  }

  // 编辑器只创建一次，之后切换文档时换掉里面的内容，同时清掉撤销记录，免得撤销回上一篇的内容。
  // Vditor 要先加载解析引擎才能用，所以存下创建它的 Promise，连着切换时等它加载完
  let editorLoaded = null;

  async function ensureEditor(content) {
    if (editorLoaded) {
      await editorLoaded;
      vditor.setValue(content, true);
    } else {
      editorLoaded = createEditor(content);
      await editorLoaded;
    }
    state.savedContent = vditor.getValue(); // Vditor 会规范化格式，以它的结果为基准判断有没有改动
  }

  function createEditor(content) {
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
          markdown: { sanitize: true },
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

          state.editorReady = true;
          resolve();
        },
      });
    });
  }

  // 有没有编辑权限：打开页面时校验一次密钥，之后不变
  function setEditable(editable) {
    state.canEdit = editable;
    els.editTools.hidden = !editable;
    els.shareBtn.hidden = editable; // 编辑模式下链接栏里已经有复制按钮
    els.modeBadge.classList.toggle('editing', editable);
    els.modeIcon.className = `icon ${editable ? 'i-pencil' : 'i-eye'}`;
    els.modeLabel.textContent = editable ? '可编辑' : '只读';
  }

  // 切换显示文档（'doc'）、文档集的目录页（'set'），或者只显示一行提示（'none'，比如文档不存在），
  // 顶栏只留当前页面用得上的按钮
  function showPage(next) {
    page = next;
    const onDoc = page === 'doc';
    const inEditor = onDoc && state.canEdit;
    els.setPane.hidden = page !== 'set';
    els.editorPane.hidden = !inEditor;
    els.readerPane.hidden = page === 'set' || inEditor;
    els.workspace.classList.toggle('reading', !inEditor);
    els.importBtn.hidden = els.saveBtn.hidden = !inEditor;
    els.downloadBtn.hidden = !onDoc;
    updateSavedButtons();
    renderOutline(); // 只读的文档才有大纲，别的页面收起
  }

  // 链接、历史、在线人数要等文档（文档集）在服务器上建好了才有
  function updateSavedButtons() {
    const docSaved = page === 'doc' && docId !== null;
    els.linksBtn.hidden = !(docSaved || (page === 'set' && docSet?.id));
    els.historyBtn.hidden = els.online.hidden = !docSaved;
  }

  // 只显示一行提示（比如文档不存在），后面跟一个回文档首页的链接
  function showMessage(text) {
    docId = null;
    showPage('none');
    els.updatedLabel.textContent = '';
    const home = document.createElement('a');
    home.href = '/';
    home.textContent = '回文档首页';
    const p = document.createElement('p');
    p.append(`${text} `, home);
    els.preview.replaceChildren(p);
    setStatus('');
    pageShown();
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

  // 「我创建的文档」列表（文档首页显示，只存在这台设备上）：文档记 docId，文档集记 setId
  const loadMine = () => JSON.parse(localStorage.getItem(MY_DOCS_KEY) || '[]');

  function rememberMine(item) {
    localStorage.setItem(MY_DOCS_KEY, JSON.stringify([{ ...item, editKey: state.editKey, createdAt: Date.now() }, ...loadMine()]));
  }

  // 更新列表里的标题，方便在文档首页辨认
  function rememberTitle(id, title) {
    const items = loadMine();
    const mine = items.find((d) => d.docId === id || d.setId === id);
    if (!mine) return;
    mine.title = title;
    localStorage.setItem(MY_DOCS_KEY, JSON.stringify(items));
  }

  // 新文档第一次保存成功：换成正式的编辑链接，开始同步。
  // 单独的文档记进「我创建的文档」，展开链接栏提示保存编辑链接；文档集里的文档不单独记，也不强制展开链接栏：
  // 它的编辑链接和文档集的一样，打开文档集就能在目录里找到
  function onCreated(data) {
    docId = data.docId;
    state.editKey = data.editKey;
    // 保存时可能已经点了浏览器的后退（见「切换页面」），地址栏不再是这篇新文档，就不能替换了
    if (location.pathname === '/doc/new') history.replaceState(null, '', docUrl(docId));
    currentUrl = location.href;

    const inSet = newDocSet !== null;
    newDocSet = null;
    if (inSet) {
      docSet.docs.push({ id: docId, title: listTitle(vditor.getValue()), updatedAt: data.updatedAt });
      renderSidebar();
    } else {
      rememberMine({ docId });
    }
    updateSavedButtons();
    setupLinkBar(!inSet);
    heartbeat({ force: true });
  }

  // ---------- 保存 ----------

  // 正在进行的保存。保存中又调用时返回同一个 Promise，等这次保存（连同冲突合并后的再次保存）全部完成：
  // 切换文档前要靠它确认已经存好了
  let saving = null;

  function save(options) {
    clearTimeout(state.autosaveTimer);
    saving ??= saveNow(options).finally(() => { saving = null; });
    return saving;
  }

  // create：新文档没改过也立即创建（上传图片要先有文档）
  async function saveNow({ create = false } = {}) {
    for (;;) {
      if (!editing()) return;
      const content = vditor.getValue();
      if (!isDirty() && !(create && docId === null)) return setStatus(docId === null ? '尚未保存' : '已保存');

      setStatus('保存中…');
      const res = await (docId === null
        ? api('/api/doc', { content, anonId, ...(newDocSet && { setId: newDocSet, editKey: state.editKey }) })
        : api(`/api/doc/${docId}`, {
          editKey: state.editKey,
          content,
          baseUpdatedAt: state.updatedAt,
          anonId,
        })
      ).catch(() => null);

      if (!res) return setStatus('保存失败：网络错误', true);
      if (res.status === 409) {
        mergeRemote(res.data);
        continue; // 合并完立即再存一次
      }
      if (res.status === 403) {
        setStatus('无权编辑', true);
        return showError('编辑密钥无效，无法保存。请确认你打开的是完整的编辑链接。');
      }
      if (!res.ok) return setStatus(`保存失败：${res.data.error || res.status}`, true);

      if (docId === null) onCreated(res.data);
      state.savedContent = content;
      setUpdatedAt(res.data.updatedAt);
      docCache.set(docId, { content, updatedAt: res.data.updatedAt });
      rememberTitle(docId, docTitle(content));
      if (isDirty()) scheduleAutosave(); // 保存期间又有输入，再排一次
      else setStatus('已保存');
      return;
    }
  }

  // 保存时发现别人在我编辑期间存了新版本：像 git 合并分支一样三方合并（见 merge.js），
  // 底版是我开始改时的服务器版本。两人改的是不同段落就自动合并；改了同一段的，
  // 两种写法都留在文档里，用 <<<<<<< ======= >>>>>>> 标出来，由人来挑。合并完立即保存，谁的修改都不会丢
  function mergeRemote(remote) {
    const { text, conflicts } = mergeText(state.savedContent, vditor.getValue(), remote.content);
    state.savedContent = remote.content;
    setUpdatedAt(remote.updatedAt);
    setValueKeepingCaret(text);
    updateTitle(text);
    vditor.tip(conflicts
      ? `别人刚保存了新版本，有 ${conflicts} 处和你改了同一段。两种写法都保留在文档里，用 <<<<<<< 和 >>>>>>> 标出，请留下需要的内容，再删掉标记`
      : '别人刚保存了新版本，已和你的修改自动合并', conflicts ? 15000 : 4000);
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
    if (editing()) {
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

  // ---------- 链接栏：编辑模式下列出当前文档（文档集）的只读链接和编辑链接，收起状态会记住 ----------

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
  // 只读页的「复制链接」：只复制只读链接，不带地址栏里可能有的（无效的）编辑密钥
  els.shareBtn.onclick = () => copyText(`${location.origin}${location.pathname}`, els.shareBtn);
  els.copyEditLink.onclick = () => copyText(els.editLinkInput.value, els.copyEditLink);
  for (const input of [els.viewLinkInput, els.editLinkInput]) input.onfocus = () => input.select();

  // 切换页面时换成当前页面的链接。还没保存的新文档、新文档集没有链接，先收起（不改记住的收起状态）。
  // isNew：刚创建的，强制展开并提示保存编辑链接
  function setupLinkBar(isNew = false) {
    const id = page === 'doc' ? docId : page === 'set' ? docSet?.id : null;
    if (!state.canEdit || !id) {
      els.linkBar.hidden = true;
      return;
    }
    const viewUrl = `${location.origin}/${page}/${id}`;
    els.viewLinkInput.value = viewUrl;
    els.editLinkInput.value = `${viewUrl}?key=${encodeURIComponent(state.editKey)}`;
    els.linkHintWhat.textContent = page === 'doc' ? '文档' : '文档集';
    els.linkHint.hidden = !isNew;
    els.linkBar.classList.toggle('new', isNew);
    showLinkBar(isNew || localStorage.getItem(LINK_BAR_HIDDEN_KEY) !== 'true');
  }

  // ---------- 目录：文档集里的文档 ----------

  // 在文档集里时左边显示目录：最上面是文档集本身（点了回到目录页），下面是集里的文档，点了在当前页面切换过去。
  // 集里的文档和文档集共用编辑密钥，所以编辑模式下这些链接都带上密钥，切过去照样能编辑
  const narrow = matchMedia('(max-width: 720px)');
  let sidebarShown = false; // 目录第一次出现时决定侧边栏要不要展开，之后由用户自己开关

  const keyParam = () => (state.canEdit ? `?key=${encodeURIComponent(state.editKey)}` : '');
  const docUrl = (id) => `/doc/${id}${keyParam()}`;
  const setUrl = (id) => `/set/${id}${keyParam()}`;
  const newDocUrl = (setId) => `/doc/new?set=${setId}&key=${encodeURIComponent(state.editKey)}`;

  // 和 lib/util.js 的 titleOf 一样：第一个标题，没有标题就用第一行文字
  function listTitle(md) {
    const line = docTitle(md) || md.split('\n').find((l) => l.trim()) || '';
    return line.replace(/^[\s>*+-]+/, '').trim().slice(0, 80);
  }

  function showSidebar(visible) {
    els.sidebar.hidden = !visible;
    els.treeBtn.classList.toggle('active', visible);
  }

  els.treeBtn.onclick = () => {
    showSidebar(els.sidebar.hidden);
    // 窄屏上目录叠在正文上面，每次打开页面都先收起，开关不记
    if (!narrow.matches) localStorage.setItem(SIDEBAR_HIDDEN_KEY, String(els.sidebar.hidden));
  };

  // 目录里的一行。href 为空的是正在新建、还没保存的文档
  function navRow(href, icon, title, current) {
    const a = document.createElement('a');
    a.className = 'tree-row';
    a.dataset.nav = '';
    a.innerHTML = `<i class="icon ${icon}"></i>`;
    if (href) a.href = href;
    if (current) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    }
    const label = document.createElement('span');
    label.className = 'tree-title';
    label.textContent = title || '无标题';
    label.classList.toggle('untitled', !title);
    a.append(label);
    return a;
  }

  // 不在文档集里（单独的文档、还没建好的新文档集）时不显示目录
  function renderSidebar() {
    const inSet = Boolean(docSet?.id);
    els.treeBtn.hidden = !inSet;
    if (!inSet) return showSidebar(false);
    if (!sidebarShown) {
      sidebarShown = true;
      showSidebar(!narrow.matches && localStorage.getItem(SIDEBAR_HIDDEN_KEY) !== 'true');
    }

    els.sidebarSet.replaceChildren(navRow(setUrl(docSet.id), 'i-folder', docSet.title, page === 'set'));
    const rows = docSet.docs.map((d) => navRow(docUrl(d.id), 'i-file', d.title, page === 'doc' && d.id === docId));
    if (page === 'doc' && docId === null) rows.push(navRow(null, 'i-file', listTitle(NEW_DOC_IN_SET), true));
    els.tree.replaceChildren(...rows.map((row) => {
      const li = document.createElement('li');
      li.append(row);
      return li;
    }));
    els.sidebarNew.hidden = !state.canEdit;
    els.sidebarNew.href = newDocUrl(docSet.id);
  }

  // 编辑时目录里当前这篇的标题跟着变
  function updateSidebarTitle(md) {
    if (page !== 'doc' || !docSet?.id) return;
    const title = listTitle(md);
    const item = docSet.docs.find((d) => d.id === docId);
    if (item) item.title = title;
    const label = els.tree.querySelector('[aria-current] .tree-title');
    if (!label) return;
    label.textContent = title || '无标题';
    label.classList.toggle('untitled', !title);
  }

  // ---------- 大纲：只读页右边列出这篇文档的标题 ----------

  // 点标题跳过去，滚动时高亮正在读的那一节。编辑模式下用 Vditor 工具栏自带的「大纲」，这里不显示；
  // 标题少于两个时没什么可列的，也不显示。
  // 宽屏上默认展开，收起后会记住；放不下目录、正文、大纲三栏时默认收起，开关不记；手机上叠在正文上面，点了标题自动收起
  const OUTLINE_HIDDEN_KEY = 'shareddoc:outlineHidden';
  const roomy = matchMedia('(min-width: 1100px)');
  let outlineWanted = roomy.matches && localStorage.getItem(OUTLINE_HIDDEN_KEY) !== 'true';
  let headings = []; // 大纲里列出的标题元素，和 els.outline 里的按钮一一对应

  function showOutline() {
    els.outlinePane.hidden = !(outlineWanted && headings.length);
    els.outlineBtn.classList.toggle('active', !els.outlinePane.hidden);
  }

  els.outlineBtn.onclick = () => {
    outlineWanted = els.outlinePane.hidden;
    if (roomy.matches) localStorage.setItem(OUTLINE_HIDDEN_KEY, String(!outlineWanted));
    showOutline();
    updateOutlineActive();
  };

  // 渲染完正文、切换页面后调用
  function renderOutline() {
    const found = page === 'doc' && !state.canEdit ? [...els.preview.querySelectorAll('h1, h2, h3, h4')] : [];
    headings = found.length >= 2 ? found : [];
    els.outlineBtn.hidden = !headings.length;
    // 按文档里最大的那级标题对齐：只用了 ## 的文档，大纲不会整体往里缩一格
    const top = Math.min(...headings.map((h) => Number(h.tagName[1])));
    els.outline.replaceChildren(...headings.map((h, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'outline-item';
      item.textContent = h.textContent.trim() || '（空标题）';
      item.title = item.textContent;
      item.style.setProperty('--level', Number(h.tagName[1]) - top);
      item.onclick = () => {
        if (narrow.matches) {
          outlineWanted = false;
          showOutline();
        }
        h.scrollIntoView({ block: 'start' });
        setOutlineActive(i);
      };
      const li = document.createElement('li');
      li.append(item);
      return li;
    }));
    showOutline();
    updateOutlineActive();
  }

  function setOutlineActive(index) {
    const items = els.outline.querySelectorAll('.outline-item');
    items.forEach((item, i) => item.classList.toggle('active', i === index));
    // 大纲很长时，让高亮的那一项留在看得见的地方
    const item = items[index];
    const box = els.outlineBody;
    if (!item || box.scrollHeight <= box.clientHeight) return;
    if (item.offsetTop < box.scrollTop || item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = item.offsetTop - box.clientHeight / 3;
    }
  }

  // 正在读的那一节：顶端已经滚到阅读区上沿（留一点余量）的最后一个标题。
  // 宽屏上滚动的是正文卡片，手机上是整个页面，两边都监听；一帧最多算一次
  const readerBody = els.readerPane.querySelector('.pane-body');
  let outlineFrame = 0;

  function updateOutlineActive() {
    if (els.outlinePane.hidden || outlineFrame) return;
    outlineFrame = requestAnimationFrame(() => {
      outlineFrame = 0;
      const line = Math.max(readerBody.getBoundingClientRect().top, 0) + 24;
      let index = 0;
      headings.forEach((h, i) => {
        if (h.getBoundingClientRect().top <= line) index = i;
      });
      setOutlineActive(index);
    });
  }

  readerBody.addEventListener('scroll', updateOutlineActive, { passive: true });
  addEventListener('scroll', updateOutlineActive, { passive: true });

  // ---------- 文档集的目录页 ----------

  // 文档集只有名称，没有正文：目录页列出集里的文档，点了切换过去。
  // 编辑模式下名称是输入框：新文档集（/set/new）起好名字点「创建」才在服务器上建，已有的改完名字自动保存
  let renaming = null; // 正在保存的改名，切换页面前要等它

  const formatTime = (ts) => `更新于 ${new Date(ts).toLocaleString()}`;

  function renderSetPage() {
    const isNew = !docSet.id;
    els.setTitle.hidden = state.canEdit;
    els.setTitle.textContent = docSet.title;
    els.setForm.hidden = !state.canEdit;
    els.setTitleInput.value = docSet.title;
    els.setCreateBtn.hidden = els.setNewHint.hidden = !isNew;
    els.setDocsSection.hidden = isNew;
    els.setUpdatedLabel.textContent = isNew ? '' : formatTime(docSet.updatedAt);
    if (isNew) return els.setTitleInput.focus();

    els.setNewDoc.hidden = !state.canEdit;
    els.setNewDoc.href = newDocUrl(docSet.id);
    if (!docSet.docs.length) return note(els.setDocs, state.canEdit ? '还没有文档，点「新建文档」写第一篇' : '还没有文档');
    els.setDocs.replaceChildren(...docSet.docs.map((d) => {
      const link = document.createElement('a');
      link.className = 'title';
      link.dataset.nav = '';
      link.href = docUrl(d.id);
      link.textContent = d.title || '无标题';
      link.classList.toggle('untitled', !d.title);
      const time = document.createElement('small');
      time.textContent = formatTime(d.updatedAt);
      const li = document.createElement('li');
      li.append(link, time);
      return li;
    }));
  }

  const inputTitle = () => els.setTitleInput.value.trim();

  async function createSet() {
    const title = inputTitle();
    if (!title) return els.setTitleInput.focus();
    els.setCreateBtn.disabled = true;
    setStatus('创建中…');
    const res = await api('/api/set', { title }).catch(() => null);
    els.setCreateBtn.disabled = false;
    if (!res?.ok) return setStatus(`创建失败：${res?.data.error || '网络错误'}`, true);

    state.editKey = res.data.editKey;
    docSet = { id: res.data.setId, title, updatedAt: res.data.updatedAt, docs: [] };
    history.replaceState(null, '', setUrl(docSet.id));
    currentUrl = location.href;
    rememberMine({ setId: docSet.id, title });
    setStatus('');
    setPageTitle(title);
    renderSetPage();
    renderSidebar();
    updateSavedButtons();
    setupLinkBar(true);
  }

  function renameSet() {
    const set = docSet;
    const title = inputTitle();
    if (!title || title === set.title) {
      els.setTitleInput.value = set.title;
      return;
    }
    setStatus('保存中…');
    renaming = api(`/api/set/${set.id}`, { editKey: state.editKey, title }).catch(() => null).then((res) => {
      renaming = null;
      if (!res?.ok) return setStatus(`改名失败：${res?.data.error || '网络错误'}`, true);
      set.title = title;
      set.updatedAt = res.data.updatedAt;
      rememberTitle(set.id, title);
      if (set !== docSet || page !== 'set') return; // 已经切到别的页面了
      setStatus('已保存');
      setPageTitle(title);
      els.setUpdatedLabel.textContent = formatTime(set.updatedAt);
      renderSidebar();
    });
  }

  els.setForm.onsubmit = (e) => {
    e.preventDefault();
    if (docSet.id) renameSet();
    else createSet();
  };
  // 改完名字点别处（输入框失去焦点）就保存
  els.setTitleInput.onchange = () => docSet.id && renameSet();

  // ---------- 切换页面 ----------

  // 文档集里的链接（目录、目录页的文档列表、「新建文档」）都带 data-nav：点了在当前页面切换，不重新加载。
  // 地址栏跟着变，浏览器的后退、前进也能用，复制出去的地址直接打开就是那一页。
  // 切换慢主要慢在等服务器（Worker 加 D1 一趟往返，实例刚启动时更久），前端渲染只要几毫秒，所以：
  // - 按下鼠标（手指）就开始请求，不等松开（见 prefetch）
  // - 看过的文档先显示上次的内容，同时向服务器确认有没有更新（见 docCache）
  // - 点了马上把目录里那一行标成当前、显示加载条，加载完正文淡入，看得出切换了
  let routeSeq = 0;               // 连着点了好几下时，只显示最后点的那个
  let currentUrl = location.href; // 当前显示的页面的地址

  // 看过的文档 docId → { content, updatedAt }：服务器上的版本，打开、保存、拉取新内容时更新。
  // 只存在这个页面里，刷新就没了
  const docCache = new Map();

  // 按下时提前发出的请求 { path, request, at }。只留最近一个，按下了没点（比如拖开了）的下次按下就丢掉；
  // 太久没用上的也不用了，免得拿到旧内容
  let prefetched = null;
  const PREFETCH_MAX_AGE_MS = 10000;

  // 页面地址要请求哪个接口；新建页面不用请求
  function apiPathOf(url) {
    const [, kind, id = ''] = new URL(url, location.href).pathname.split('/');
    if (!id || id === 'new') return null;
    return kind === 'set' ? `/api/set/${id}` : `/api/doc/${id}?set=1`;
  }

  // 优先用按下时提前发出的请求
  function request(path) {
    const ready = prefetched?.path === path && Date.now() - prefetched.at < PREFETCH_MAX_AGE_MS;
    const pending = ready ? prefetched.request : api(path);
    if (prefetched?.path === path) prefetched = null;
    return pending;
  }

  function prefetch(url) {
    const path = apiPathOf(url);
    if (!path || prefetched?.path === path) return;
    const pending = api(path);
    pending.catch(() => {}); // 没用上的请求出错了不用管，用上的照常在 route 里报错
    prefetched = { path, request: pending, at: Date.now() };
  }

  // 点了就先把目录里那一行标成当前，不用等内容加载完
  function markCurrent(url) {
    const { pathname } = new URL(url, location.href);
    for (const a of els.sidebar.querySelectorAll('a.tree-row')) {
      const current = Boolean(a.href) && new URL(a.href).pathname === pathname;
      a.classList.toggle('active', current);
      if (current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  function startLoading(url) {
    markCurrent(url);
    els.workspace.classList.add('loading'); // 正文变淡、顶上显示加载条（见 site.css），网络快的话不会闪
  }

  // 内容显示出来了：去掉加载状态，正文淡入
  function pageShown() {
    els.workspace.classList.remove('loading');
    const pane = [els.setPane, els.editorPane, els.readerPane].find((p) => !p.hidden);
    if (!pane) return;
    pane.classList.remove('page-in');
    void pane.offsetWidth; // 先让浏览器排一次版，同一个元素的动画才能重新播放
    pane.classList.add('page-in');
  }

  // 不切换了（用户选择留在当前文档）：恢复原样
  function cancelLoading() {
    els.workspace.classList.remove('loading');
    renderSidebar();
  }

  // 离开当前页面前把正在改的文档存好；存不了（比如断网）就问一下要不要丢掉修改
  async function leave() {
    await renaming;
    if (saving || isDirty()) await save();
    return !isDirty() || confirm('这篇文档还有修改没保存成功，离开的话这些修改会丢掉。确定离开吗？');
  }

  const showCurrentPage = () => route().catch(() => showMessage('加载失败：网络超时或服务器没有响应，请刷新重试'));

  async function go(url) {
    startLoading(url);
    if (!(await leave())) return cancelLoading();
    history.pushState(null, '', url);
    showCurrentPage();
  }

  const navLinkOf = (e) => {
    const a = e.target.closest('a[data-nav][href]');
    // 按着 Ctrl 等键是要在新标签页打开，照常处理
    return a && e.button === 0 && !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) ? a : null;
  };

  document.addEventListener('pointerdown', (e) => {
    const a = navLinkOf(e);
    if (a && a.href !== location.href) prefetch(a.href);
  });

  document.addEventListener('click', (e) => {
    const a = navLinkOf(e);
    if (!a) return;
    e.preventDefault();
    if (narrow.matches && els.sidebar.contains(a)) showSidebar(false); // 窄屏上目录叠在正文上面，点完收起，好看正文
    if (a.href !== location.href) go(a.href);
  });

  // 后退、前进时地址栏已经变了：先存好当前文档再切过去，用户选择留下的话把地址改回来
  addEventListener('popstate', async () => {
    startLoading(location.href);
    if (await leave()) {
      showCurrentPage();
    } else {
      history.pushState(null, '', currentUrl);
      cancelLoading();
    }
  });

  // 换了一页，滚回开头
  function scrollToTop() {
    scrollTo(0, 0);
    for (const el of els.workspace.querySelectorAll('.pane-body, .vditor-sv, .vditor-wysiwyg, .vditor-preview')) el.scrollTop = 0;
  }

  // 显示文档集的目录页
  function showSet(set) {
    docSet = set;
    docId = null;
    newDocSet = null;
    showPage('set');
    setStatus('');
    setPageTitle(docSet.title || '新建文档集');
    renderSetPage();
    renderSidebar();
    setupLinkBar();
  }

  // 显示一篇文档；isStale：等编辑器加载的时候是不是已经切到别处了
  async function showDoc(id, set, { content, updatedAt }, isStale) {
    docId = id;
    newDocSet = null;
    docSet = set;
    showPage('doc');
    renderSidebar();
    setupLinkBar();
    await showContent(content, updatedAt);
    if (isStale()) return;
    if (state.canEdit) setStatus('已保存');
    scrollToTop();
    pageShown();
    heartbeat({ force: true });
  }

  // 按地址栏显示对应的页面：/doc/ID、/doc/new（带 ?set=文档集ID 是建在集里）、/set/ID、/set/new
  async function route() {
    const seq = ++routeSeq;
    const stale = () => seq !== routeSeq;
    currentUrl = location.href;
    const [, kind, id = ''] = location.pathname.split('/');
    els.onlineCount.textContent = '–';

    if (kind === 'set') {
      if (id === 'new') {
        showSet({ id: null, title: '', updatedAt: null, docs: [] });
        scrollToTop();
        return pageShown();
      }
      const pending = request(`/api/set/${id}`);
      // 从集里的文档回到目录页：手上已经有这个文档集，先显示，拿到最新的再换上
      const known = docSet?.id === id;
      if (known) {
        showSet(docSet);
        scrollToTop();
        pageShown();
      }
      const { ok, status, data } = await pending;
      if (stale()) return;
      if (!ok) return showMessage(status === 404 ? '文档集不存在。' : `加载失败：${data.error || status}`);
      showSet(data);
      if (known) return;
      scrollToTop();
      return pageShown();
    }

    if (id === 'new') {
      const setId = new URLSearchParams(location.search).get('set');
      if (!state.canEdit) return showMessage('编辑密钥无效，不能新建文档。');
      let set = null;
      if (setId) {
        set = docSet?.id === setId ? docSet : null;
        if (!set) {
          const { ok, status, data } = await request(`/api/set/${encodeURIComponent(setId)}`);
          if (stale()) return;
          if (!ok) return showMessage(status === 404 ? '文档集不存在，没法在里面新建文档。' : `加载失败：${data.error || status}`);
          set = data;
        }
      }
      docSet = set;
      docId = null;
      newDocSet = setId;
      state.updatedAt = null;
      showPage('doc');
      renderSidebar();
      setupLinkBar();
      const template = setId ? NEW_DOC_IN_SET : WELCOME;
      await ensureEditor(template);
      if (stale()) return;
      updateTitle(template);
      setStatus('尚未保存');
      scrollToTop();
      return pageShown();
    }

    if (!id) return showMessage('链接不完整，请从文档首页新建或打开文档。');
    const pending = request(`/api/doc/${id}?set=1`);
    // 看过的文档先显示上次的内容（集里切换时文档集不变），拿到最新的再看要不要换
    const cached = docCache.get(id);
    if (cached) await showDoc(id, docSet, cached, stale);
    const { ok, status, data } = await pending;
    if (stale()) return;
    if (!ok) return showMessage(status === 404 ? '文档不存在。' : `加载失败：${data.error || status}`);
    if (!cached) return showDoc(id, data.set, data, stale);

    // 和拉取别人保存的新内容一样：顺带更新目录；正在改的话先不换，保存时会合并
    docSet = data.set;
    renderSidebar();
    if (data.updatedAt !== state.updatedAt && !saving && !isDirty()) await showContent(data.content, data.updatedAt);
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

  // 心跳接口同时返回在线人数和文档当前版本，版本变了才去拉全文。
  // 文档集的目录页、还没保存的新文档不上报
  async function heartbeat({ force = false } = {}) {
    if (page !== 'doc' || !docId) return;
    if (document.hidden && !force) return; // 后台标签页不上报，省请求次数和写入额度
    const id = docId;
    const res = await api(`/api/presence/${id}`, { anonId }).catch(() => null);
    if (!res?.ok || id !== docId) return; // 等结果的时候已经切到别的文档了
    els.onlineCount.textContent = res.data.online;
    if (res.data.updatedAt !== state.updatedAt) refresh();
  }

  // ---------- 拉取别人保存的新内容 ----------

  async function refresh() {
    if (document.hidden || saving || isDirty()) return; // 有未保存的修改时交给保存时的冲突处理
    const id = docId;
    const { ok, data } = await api(`/api/doc/${id}?set=1`);
    if (!ok || id !== docId || page !== 'doc') return;
    // 顺带更新目录：别人可能在集里新建了文档、改了标题
    docSet = data.set;
    renderSidebar();
    if (data.updatedAt === state.updatedAt || isDirty()) return;
    showContent(data.content, data.updatedAt);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !docId) return;
    heartbeat(); // 切回来立刻报一次，顺便检查离开期间有没有人保存
  });

  // ---------- 启动 ----------

  async function init() {
    const [, kind, id = ''] = location.pathname.split('/');
    const setId = new URLSearchParams(location.search).get('set');
    // 新建文档、新建文档集不用密钥（建好了才有）；在文档集里新建文档要用文档集的密钥
    const creating = id === 'new' && !(kind === 'doc' && setId);
    let editable = creating;
    if (!creating && id && state.editKey) {
      // 不带内容（名称）的 POST 只校验密钥，不写入
      const path = kind === 'set' ? `/api/set/${id}` : id === 'new' ? `/api/set/${encodeURIComponent(setId)}` : `/api/doc/${id}`;
      const check = await api(path, { editKey: state.editKey });
      editable = check.ok;
      if (check.status === 403) showError('编辑密钥无效，已切换为只读模式。');
    }
    setEditable(editable);
    await route();
    setInterval(heartbeat, PRESENCE_INTERVAL_MS);
  }

  init().catch(() => showMessage('加载失败：网络超时或服务器没有响应，请刷新重试'));
})();
