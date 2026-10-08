// 三方合并（和 git 合并分支一样）：base 是两边共同的底版，mine、theirs 是各自改过的版本。
// 两边改的是不同的行就都保留；改了同一处的，两种写法都留在文档里，用 <<<<<<< ======= >>>>>>> 标出来，由人来挑。
// 返回 { text, conflicts }，conflicts 是冲突的处数。editor.js 在保存冲突时调用
(() => {
  'use strict';

  // Myers 差分算法最多算到这么多处不同，再多（几乎整篇重写）就把整段当成一处修改，免得卡住页面
  const MAX_EDITS = 2000;

  // a、b 是两组行，返回 b 相对 a 改动的地方：[aStart, aEnd, bStart, bEnd]，表示 a 的这几行换成了 b 的这几行
  function diff(a, b) {
    // 相同的开头、结尾先去掉，Myers 只算中间不同的部分
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    const n = endA - start;
    const m = endB - start;
    if (n === 0 && m === 0) return [];
    if (n === 0 || m === 0) return [[start, endA, start, endB]];

    // v[off + k] 是第 k 条对角线上走得最远的 x。trace 记下每一步开始前的 v，回溯时用；
    // 第 d 步只用得到 k = -d-1..d+1 那一段，只存这一段，内存随改动数平方增长而不是随行数
    const A = (i) => a[start + i];
    const B = (j) => b[start + j];
    const max = Math.min(n + m, MAX_EDITS);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let done = false;
    for (let d = 0; d <= max && !done; d++) {
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && A(x) === B(y)) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) {
          done = true;
          break;
        }
      }
    }
    if (!done) return [[start, endA, start, endB]];

    // 从终点往回走，记下两边相同的行
    const same = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d > 0; d--) {
      const prev = (k) => trace[d][k + d + 1];
      const k = x - y;
      const prevK = k === -d || (k !== d && prev(k - 1) < prev(k + 1)) ? k + 1 : k - 1;
      const prevX = prev(prevK);
      const prevY = prevX - prevK;
      const midX = prevK === k + 1 ? prevX : prevX + 1;
      while (x > midX) same.push([--x, --y]);
      x = prevX;
      y = prevY;
    }
    while (x > 0) same.push([--x, --y]);
    same.reverse();

    // 相同的行之间的空档就是改动
    const hunks = [];
    let i = 0;
    let j = 0;
    for (const [si, sj] of [...same, [n, m]]) {
      if (si > i || sj > j) hunks.push([start + i, start + si, start + j, start + sj]);
      i = si + 1;
      j = sj + 1;
    }
    return hunks;
  }

  const sameLines = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);

  // 返回一串片段：{ lines } 是确定下来的行，{ mine, theirs } 是两边改了同一处、而且改得不一样
  function merge3(base, mine, theirs) {
    const hunks = [
      ...diff(base, mine).map(([s, e, ss, se]) => ({ side: 'mine', s, e, ss, se })),
      ...diff(base, theirs).map(([s, e, ss, se]) => ({ side: 'theirs', s, e, ss, se })),
    ].sort((p, q) => p.s - q.s || p.e - q.e);

    // 底版上重叠或紧挨着的改动归成一组（和 git 一样，紧挨着的两处修改也算冲突）
    const groups = [];
    for (const h of hunks) {
      const last = groups[groups.length - 1];
      if (last && h.s <= last.e) {
        last.hunks.push(h);
        last.e = Math.max(last.e, h.e);
      } else {
        groups.push({ s: h.s, e: h.e, hunks: [h] });
      }
    }

    // offset：底版的行号加上它，就是这一边对应的行号（随着处理过的改动累加）
    const offset = { mine: 0, theirs: 0 };
    const sides = { mine, theirs };
    const out = [];
    let pos = 0;
    for (const g of groups) {
      out.push({ lines: base.slice(pos, g.s) });
      const text = {};
      for (const side of ['mine', 'theirs']) {
        const from = g.s + offset[side];
        for (const h of g.hunks) if (h.side === side) offset[side] += (h.se - h.ss) - (h.e - h.s);
        text[side] = sides[side].slice(from, g.e + offset[side]);
      }
      const changed = new Set(g.hunks.map((h) => h.side));
      if (changed.size === 1) out.push({ lines: text[[...changed][0]] });
      else if (sameLines(text.mine, text.theirs)) out.push({ lines: text.mine }); // 两边改成了一样的
      else out.push({ mine: text.mine, theirs: text.theirs });
      pos = g.e;
    }
    out.push({ lines: base.slice(pos) });
    return out;
  }

  // 代码块、公式块里的空行不是段落的分界
  const FENCE = /^ {0,3}(`{3,}|~{3,}|\$\$)/;

  // 冲突标记放在段落之间：以空行为界把内容分成一段一段，有冲突的整段换成两种写法，
  // 免得标记插进表格、列表中间把结构拆散。段里没冲突的行两边都一样，照原样放进两种写法里
  function toText(chunks) {
    const out = [];
    let run = []; // 当前这一段：行（字符串）或者冲突（{ mine, theirs }）
    let conflicts = 0;
    const flush = () => {
      if (run.some((item) => typeof item !== 'string')) {
        conflicts++;
        const pick = (side) => run.flatMap((item) => (typeof item === 'string' ? [item] : item[side]));
        // 标记前后都空一行，各自成段；>>>>>>> 要转义，不然会被当成引用
        out.push('<<<<<<< 我的修改', '', ...pick('mine'), '', '=======', '', ...pick('theirs'), '', '\\>>>>>>> 别人的修改');
      } else {
        out.push(...run);
      }
      run = [];
    };

    let inFence = false;
    for (const c of chunks) {
      if (!c.lines) {
        run.push(c);
        for (const line of c.mine) if (FENCE.test(line)) inFence = !inFence;
        continue;
      }
      for (const line of c.lines) {
        const fence = FENCE.test(line);
        if (!inFence && !fence && line.trim() === '') {
          flush();
          out.push(line);
        } else {
          run.push(line);
        }
        if (fence) inFence = !inFence;
      }
    }
    flush();
    return { text: out.join('\n'), conflicts };
  }

  window.mergeText = (base, mine, theirs) => {
    const split = (s) => s.split('\n');
    return toText(merge3(split(base), split(mine), split(theirs)));
  };
})();
