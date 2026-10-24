/* =========================================================
   lyrics.js — 歌词解析与时间轴构建
   1) 有 [mm:ss.xx] 时间戳 → 按 LRC 精确同步
   2) 纯文本 → 按“字数 + 停顿”加权，把歌词铺满歌曲时长
   3) 长句 → 在标点处切分，避免一行挤爆画面
   ========================================================= */
(function (global) {
  'use strict';

  var TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  var PUNCT = '，。！？；、,.!?;…';
  var MAX_CHARS = 14;          // 中文单行目标字数（手机竖屏一行能读清的上限）
  var MIN_LINE = 1.5;          // 单行最短停留（秒）

  /*
    结构标记：AI 生成的歌词（Suno/Udio 等）常把编曲提示写进歌词，
    例如 [Verse 1] [Chorus] [Pre-Chorus] [Bridge] [Outro] [Final Chorus]。
    这些不是歌词，必须剔除，否则会被当成一句唱词显示在画面上。
    注意：只匹配“整段括号内容 = 结构关键词”，不会误伤 [00:12.00] 时间戳，
    也不会误伤 [沉默中] 这类真正的歌词。
  */
  var STRUCT_WORDS = [
    'verse', 'chorus', 'pre[\\s-]?chorus', 'post[\\s-]?chorus', 'double[\\s-]?chorus',
    'bridge', 'outro', 'intro', 'hook', 'refrain', 'interlude', 'instrumental',
    'solo', 'breakdown', 'drop', 'build(?:[\\s-]?up)?', 'tag', 'ad[\\s-]?libs?',
    'final\\s+chorus', 'main\\s+chorus', 'ending', 'fade(?:[\\s-]?out)?', 'vamp',
    '主歌', '副歌', '前奏', '间奏', '尾奏', '尾声', '桥段', '说唱', '高潮', '结尾', '过门'
  ].join('|');

  // 括号包裹的结构标记：[Verse 1] 【副歌】 (Chorus x2) [Verse 1: 某人]
  var STRUCT_TOKEN = new RegExp(
    '(\\[|【|\\()\\s*((?:' + STRUCT_WORDS + ')(?:\\s*\\d+)?\\s*(?:[:：x×*].*)?)\\s*(\\]|】|\\))',
    'gi'
  );

  // 没有括号的整行结构标记：Verse 1 / Chorus: / 副歌
  var STRUCT_BARE = new RegExp(
    '^[\\s\\-–—·|]*(?:' + STRUCT_WORDS + ')(?:\\s*\\d+)?\\s*[:：]?\\s*[\\-–—·|]*$',
    'i'
  );

  var TIME_ONLY = /^(\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+$/;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /* ---------- 长句切分 ---------- */
  function splitLong(line, max) {
    max = max || MAX_CHARS;
    var text = line.trim();
    if (!text) return [];
    if (text.length <= max) return [text];

    // 按标点切成小片段
    var parts = [];
    var buf = '';
    for (var i = 0; i < text.length; i++) {
      buf += text[i];
      if (PUNCT.indexOf(text[i]) > -1) {
        var p = buf.trim();
        if (p) parts.push(p);
        buf = '';
      }
    }
    if (buf.trim()) parts.push(buf.trim());

    // 合并片段到不超过 max 字
    var merged = [];
    var cur = '';
    parts.forEach(function (p) {
      if (cur && (cur + p).length > max) {
        merged.push(cur);
        cur = p;
      } else {
        cur += p;
      }
    });
    if (cur) merged.push(cur);

    // 仍然超长的（无标点长句）硬切
    var final = [];
    merged.forEach(function (chunk) {
      var c = chunk;
      while (c.length > max * 1.7) {
        final.push(c.slice(0, max));
        c = c.slice(max);
      }
      if (c) final.push(c);
    });
    return final.length ? final : [text];
  }

  /* ---------- LRC 解析 ---------- */
  function parseLRC(text) {
    var lines = [];
    var meta = {};
    var offset = 0;

    text.split(/\r?\n/).forEach(function (raw) {
      var s = raw.trim();
      if (!s) return;

      var om = s.match(/^\[offset:\s*(-?\d+)\]/i);
      if (om) { offset = parseInt(om[1], 10) / 1000; return; }

      var mm = s.match(/^\[(ti|ar|al|by):\s*([^\]]*)\]/i);
      if (mm) { meta[mm[1].toLowerCase()] = mm[2].trim(); return; }

      var tags = [];
      var m;
      TIME_TAG.lastIndex = 0;
      while ((m = TIME_TAG.exec(s)) !== null) {
        var frac = 0;
        if (m[3]) frac = parseInt(m[3], 10) / Math.pow(10, m[3].length);
        tags.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
      }
      if (!tags.length) return;

      var content = s.replace(TIME_TAG, '').trim();
      if (!content) return;

      tags.forEach(function (t) {
        lines.push({ t: Math.max(0, t - offset), text: content });
      });
    });

    lines.sort(function (a, b) { return a.t - b.t; });
    return { lines: lines, meta: meta };
  }

  /* ---------- 纯文本自动对齐 ---------- */
  /*
    策略（这是“没时间戳”时观感好坏的关键）：
    1. 先按字数估一个“自然朗读时长”
    2. 内容比歌短 → 允许适度拉长（最多 2.2 倍），并把剩余时间均分成行间停顿
    3. 内容比歌长 → 整体等比压缩，保证最后一句不越过结尾
    如果直接把整首歌平均分给每行，4 行歌词会出现“一句停 40 秒”，观感很差。
  */
  function autoSync(text, duration) {
    var rows = text.split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);

    var flat = [];
    rows.forEach(function (r) {
      splitLong(r).forEach(function (p) { flat.push(p); });
    });
    if (!flat.length || !duration) return [];

    var intro = clamp(duration * 0.05, 1.2, 5);
    var outro = clamp(duration * 0.045, 1.2, 4.5);
    var avail = Math.max(3, duration - intro - outro);
    var n = flat.length;

    // 自然朗读时长：中文约每字 0.42s，外加起句时间
    var nat = flat.map(function (s) {
      var chars = s.replace(/[\s，。！？；、,.!?;…]/g, '').length;
      return clamp(chars * 0.42 + 1.0, 1.7, 8.5);
    });
    var natTotal = nat.reduce(function (a, b) { return a + b; }, 0);

    var durs;
    var gaps = [];
    var i;

    if (natTotal >= avail) {
      // 歌词比时长多：整体压缩
      var k = avail / natTotal;
      durs = nat.map(function (d) { return Math.max(MIN_LINE * 0.7, d * k); });
      var s2 = durs.reduce(function (a, b) { return a + b; }, 0);
      if (s2 > avail) {
        var kk = avail / s2;
        durs = durs.map(function (d) { return d * kk; });
      }
      for (i = 0; i < n; i++) gaps.push(0);
    } else {
      // 歌词比时长少：拉长到上限，其余时间变成停顿
      var target = Math.min(avail, natTotal * 2.2, n * 6.5);
      if (target < natTotal) target = natTotal;
      var k2 = target / natTotal;
      durs = nat.map(function (d) { return d * k2; });
      var gapEach = Math.min(12, (avail - target) / (n + 1));
      for (i = 0; i < n; i++) gaps.push(gapEach);
    }

    var t = intro + (gaps[0] || 0) * 0.5;
    var lines = [];
    for (var j = 0; j < n; j++) {
      lines.push({
        t: Math.min(t, duration - 0.3),
        end: Math.min(duration, t + durs[j]),
        text: flat[j]
      });
      t += durs[j] + gaps[j];
    }
    return lines;
  }

  /* ---------- 剔除段落 / 编曲标记 ---------- */
  function clean(text) {
    if (!text) return { text: '', removed: 0 };

    var removed = 0;
    var out = text.split(/\r?\n/).map(function (line) {
      var hadToken = false;
      var cleaned = line.replace(STRUCT_TOKEN, function () { hadToken = true; removed++; return ''; });
      cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
      var trimmed = cleaned.trim();

      if (hadToken) {
        // 去掉标记后只剩时间戳或空白 → 整行都不是歌词
        if (!trimmed || TIME_ONLY.test(trimmed)) return '';
        return trimmed.replace(/^[\s\-–—·|:：]+/, '').replace(/[\s\-–—·|]+$/, '');
      }

      if (trimmed && STRUCT_BARE.test(trimmed)) { removed++; return ''; }
      return trimmed;
    });

    return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), removed: removed };
  }

  /* ---------- 合并“同一句连写两遍” ---------- */
  /*
    AI 生成的 LRC 经常把段落标记写进带时间戳的第一句里：
      [00:18.51][Verse 1] 你说散了就散了
      [00:22.74]你说散了就散了
    标记被 clean() 去掉后，这两行文字一模一样，画面上就成了“同一句连唱两遍”，
    观感上很像歌词卡住了。这里把 8 秒内首尾相接的重复句合并为一行，
    前一行自然延长到后一行的位置。
  */
  function dedupe(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var cur = lines[i];
      var prev = out[out.length - 1];
      if (prev && cur.text === prev.text && cur.t - prev.t < 8) continue;
      out.push({ t: cur.t, text: cur.text });
    }
    return out;
  }

  /* ---------- 统一入口 ---------- */
  function build(text, duration) {
    var cleaned = clean(text);
    text = cleaned.text;
    var removed = cleaned.removed;

    if (!text || !text.trim()) return { mode: 'none', lines: [], meta: {}, removed: removed };

    var lrc = parseLRC(text);
    if (lrc.lines.length >= 1) {
      var lines = dedupe(lrc.lines);
      lines.forEach(function (l, i) {
        l.end = i + 1 < lines.length
          ? Math.max(l.t + 0.5, lines[i + 1].t)
          : Math.min(duration || l.t + 6, l.t + 6);
      });
      return { mode: 'lrc', lines: lines, meta: lrc.meta, removed: removed };
    }

    if (!duration) {
      // 还没传歌：只做文本预览，不排时间
      var rows = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      var flat = [];
      rows.forEach(function (r) { splitLong(r).forEach(function (p) { flat.push(p); }); });
      return {
        mode: 'pending',
        lines: flat.map(function (s) { return { t: 0, end: 0, text: s }; }),
        meta: {},
        removed: removed
      };
    }

    return { mode: 'auto', lines: autoSync(text, duration), meta: {}, removed: removed };
  }

  /* ---------- 应用整体偏移 ---------- */
  function withOffset(lines, offset, duration) {
    if (!offset) return lines;
    return lines.map(function (l) {
      var t = Math.max(0, l.t + offset);
      var end = Math.max(t + 0.4, l.end + offset);
      return { t: t, end: duration ? Math.min(duration, end) : end, text: l.text };
    });
  }

  global.Lyrics = {
    build: build,
    clean: clean,
    withOffset: withOffset,
    parseLRC: parseLRC,
    splitLong: splitLong
  };
})(window);
