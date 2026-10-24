/* =========================================================
   renderer.js — Canvas 渲染引擎
   所有画面元素都按画布尺寸等比计算，因此 16:9 / 9:16 / 1:1 共用一套代码
   ========================================================= */
(function (global) {
  'use strict';

  var THEMES = {
    ink:    { name: '墨黑',   accent: '#ffffff', accent2: '#8f93a6', bg: ['#1b1c22', '#08080b'], glow: '#4a4b58' },
    neon:   { name: '霓虹紫', accent: '#bb8cff', accent2: '#45e6ff', bg: ['#2a1259', '#0a0118'], glow: '#8a3bff' },
    sunset: { name: '落日橙', accent: '#ff9a4d', accent2: '#ffd98a', bg: ['#3a1206', '#12060b'], glow: '#ff5f2e' },
    teal:   { name: '电光青', accent: '#2ee6c8', accent2: '#9dfcff', bg: ['#062a33', '#010a0f'], glow: '#00d1c1' },
    rose:   { name: '樱粉',   accent: '#ff85a6', accent2: '#ffd0da', bg: ['#2c0f1e', '#100409'], glow: '#ff4f86' },
    film:   { name: '胶片',   accent: '#f3ead8', accent2: '#c9a86a', bg: ['#262421', '#0b0a09'], glow: '#8a7350' },
    ocean:  { name: '深海蓝', accent: '#6db5ff', accent2: '#a8e6ff', bg: ['#061630', '#02060f'], glow: '#1f6fd8' },
    mint:   { name: '薄荷',   accent: '#7dffb8', accent2: '#d8ffe9', bg: ['#0a2618', '#020c06'], glow: '#21c76f' },
    gold:   { name: '鎏金',   accent: '#ffd257', accent2: '#ffedb8', bg: ['#211803', '#0a0702'], glow: '#c99414' },
    mono:   { name: '极简白', accent: '#ffffff', accent2: '#c8c8d0', bg: ['#3a3a42', '#141418'], glow: '#8a8a95' }
  };

  var canvas = null;
  var ctx = null;
  var barVals = [];
  var scroll = 0;
  var lastNow = 0;
  var lastLines = null;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function hexA(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function font(size, weight) {
    return (weight || 700) + ' ' + Math.round(size) + 'px "PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';
  }

  function rr(x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function init(c) {
    canvas = c;
    ctx = c.getContext('2d', { alpha: false });
  }

  /* ---------- 低频能量（用于渐变背景呼吸）---------- */
  function lowEnergy(spec) {
    if (!spec) return 0;
    var s = 0;
    var n = Math.min(12, spec.length);
    for (var i = 1; i < n; i++) s += spec[i];
    return s / ((n - 1) * 255);
  }

  /* ---------- 背景：图片 ---------- */
  function drawImageBG(img, t, duration, W, H) {
    ctx.fillStyle = '#07070a';
    ctx.fillRect(0, 0, W, H);

    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;

    // 缓慢推镜 + 轻微摇移，避免“静态图贴上去”的廉价感
    var zoom = 1.04 + 0.06 * Math.min(1, t / Math.max(10, duration || 30));
    var scale = Math.max(W / iw, H / ih) * zoom;
    var dw = iw * scale;
    var dh = ih * scale;
    var px = (W - dw) / 2 + Math.sin(t * 0.09) * W * 0.006;
    var py = (H - dh) / 2 + Math.cos(t * 0.07) * H * 0.006;

    ctx.drawImage(img, px, py, dw, dh);

    // 暗角，让文字区域更稳
    var v = ctx.createRadialGradient(W / 2, H * 0.44, Math.min(W, H) * 0.22, W / 2, H * 0.44, Math.max(W, H) * 0.8);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.52)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------- 背景：主题渐变 ---------- */
  function drawGradientBG(th, t, spec, W, H) {
    var g = ctx.createLinearGradient(0, 0, W * 0.9, H);
    g.addColorStop(0, th.bg[0]);
    g.addColorStop(1, th.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var e = lowEnergy(spec);
    var R = Math.max(W, H) * (0.5 + e * 0.16);

    var g1 = ctx.createRadialGradient(W * 0.2, H * 0.2, 0, W * 0.2, H * 0.2, R);
    g1.addColorStop(0, hexA(th.glow, 0.3 + e * 0.3));
    g1.addColorStop(1, hexA(th.glow, 0));
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, W, H);

    var g2 = ctx.createRadialGradient(W * 0.82, H * 0.74, 0, W * 0.82, H * 0.74, R * 0.85);
    g2.addColorStop(0, hexA(th.accent2, 0.14 + e * 0.14));
    g2.addColorStop(1, hexA(th.accent2, 0));
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------- 压暗层 ---------- */
  function drawScrim(W, H, portrait) {
    var g = ctx.createLinearGradient(0, H * (portrait ? 0.14 : 0.08), 0, H);
    g.addColorStop(0, 'rgba(5,6,10,0)');
    g.addColorStop(0.5, 'rgba(5,6,10,0.38)');
    g.addColorStop(1, 'rgba(5,6,10,0.86)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var g2 = ctx.createLinearGradient(0, 0, 0, H * 0.24);
    g2.addColorStop(0, 'rgba(5,6,10,0.5)');
    g2.addColorStop(1, 'rgba(5,6,10,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H * 0.24);
  }

  /* ---------- 顶部歌名（常驻小标）---------- */
  function drawHeader(W, H, S, th, st, t, portrait) {
    var a = clamp((t - 4.2) / 1.5, 0, 1);
    if (a <= 0.02) return;
    a *= 0.95;

    var title = st.title || '未命名歌曲';
    var artist = st.artist || '';
    var tSize = clamp(S * 0.030, 12, 54);
    var aSize = clamp(S * 0.019, 9, 34);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.textBaseline = 'middle';

    if (portrait) {
      var cx = W / 2;
      ctx.textAlign = 'center';
      ctx.font = font(tSize, 700);
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.fillText(fitText(title, W * 0.84), cx, H * 0.075);

      if (artist) {
        ctx.font = font(aSize, 500);
        ctx.fillStyle = hexA(th.accent, 0.72);
        var prev = ctx.letterSpacing;
        if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
        ctx.fillText(artist, cx, H * 0.075 + tSize * 1.5);
        if ('letterSpacing' in ctx) ctx.letterSpacing = prev || '0px';
      }
    } else {
      var x = W * 0.052;
      var y = H * 0.1;
      ctx.textAlign = 'left';

      // 左侧强调竖条
      ctx.fillStyle = th.accent;
      rr(x - S * 0.024, y - tSize * 0.62, S * 0.006, tSize * 1.24, S * 0.004);
      ctx.fill();

      ctx.font = font(tSize, 700);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      var tx = fitText(title, W * 0.5);
      var tw = ctx.measureText(tx).width;
      ctx.fillText(tx, x, y);

      if (artist) {
        var ax = x + tw + S * 0.022;
        var maxAw = W * 0.95 - ax;
        if (maxAw > aSize * 2) {
          ctx.font = font(aSize, 500);
          ctx.fillStyle = hexA(th.accent, 0.72);
          var atext = fitText(artist, maxAw);
          var prev2 = ctx.letterSpacing;
          if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
          ctx.fillText(atext, ax, y + 1);
          if ('letterSpacing' in ctx) ctx.letterSpacing = prev2 || '0px';
        }
      }
    }
    ctx.restore();
  }

  /* 超长文本按可用宽度截断加省略号 */
  function fitText(text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  /* ---------- 片头歌名卡 ---------- */
  function drawIntroCard(W, H, S, th, st, t) {
    var a = 0;
    if (t < 0.9) a = t / 0.9;
    else if (t < 4.6) a = 1;
    else if (t < 5.9) a = 1 - (t - 4.6) / 1.3;
    a = clamp(a, 0, 1);
    a = a * a * (3 - 2 * a); // smoothstep

    if (a <= 0.01) return;

    var title = st.title || '未命名歌曲';
    var artist = st.artist || '';
    var cy = H * 0.32;
    var tSize = clamp(S * 0.075, 20, 150);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 小标签
    ctx.font = font(clamp(S * 0.017, 9, 28), 600);
    ctx.fillStyle = hexA(th.accent, 0.85);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
    ctx.fillText('MUSIC VIDEO', W / 2, cy - tSize * 1.15);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    // 大标题
    ctx.font = font(tSize, 700);
    ctx.fillStyle = '#ffffff';
    var shown = title;
    var maxW = W * 0.82;
    if (ctx.measureText(shown).width > maxW) {
      tSize = tSize * maxW / ctx.measureText(shown).width;
      ctx.font = font(tSize, 700);
    }
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = tSize * 0.35;
    ctx.fillText(shown, W / 2, cy);
    ctx.shadowBlur = 0;

    // 强调线
    ctx.fillStyle = hexA(th.accent, 0.85);
    rr(W / 2 - S * 0.03, cy + tSize * 0.78, S * 0.06, Math.max(2, S * 0.0035), 3);
    ctx.fill();

    // 歌手
    if (artist) {
      ctx.font = font(clamp(S * 0.026, 11, 45), 500);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
      ctx.fillText(artist, W / 2, cy + tSize * 1.16);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }

    ctx.restore();
  }

  /* ---------- 滚动歌词 ---------- */
  function drawLyrics(W, H, S, th, st, t, dt, portrait) {
    var lines = st.lines;
    if (!lines || !lines.length) return;

    var idx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].t <= t + 0.001) idx = i; else break;
    }
    var target = idx < 0 ? 0 : idx;

    if (Math.abs(scroll - target) > 2.2) scroll = target;
    else scroll += (target - scroll) * (1 - Math.exp(-dt * 6.5));

    var size = Math.min(W, H) * 0.052 * (st.fontScale || 1);
    var centerY = H * (portrait ? 0.495 : 0.545);
    var lineH = size * 1.62;
    /*
      竖屏安全区：抖音/TikTok 右侧点赞评论按钮约占右边 18%、
      底部文案区约占下 15%。歌词横向收窄到 76%，不往右侧按钮区挤。
    */
    var maxW = W * (portrait ? 0.76 : 0.72);
    var base = Math.round(scroll);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (var off = -2; off <= 2; off++) {
      var j = base + off;
      if (j < 0 || j >= lines.length) continue;

      var d = Math.abs(j - scroll);
      var alpha = 1 - d * 0.42;
      if (alpha <= 0.05) continue;

      var y = centerY + (j - scroll) * lineH;
      if (y < -lineH || y > H + lineH) continue;

      var isCurrent = (j === idx);
      var text = lines[j].text;
      var fs = size;
      // 最小可读字号：约 46px@1920 宽（含 540p 导出时的等比换算），
      // 再小到了手机上就看不清；配合歌词断行 ≤14 字使用
      fs = Math.max(fs, W * 0.024);

      ctx.font = font(fs, isCurrent ? 700 : 600);
      var w = ctx.measureText(text).width;
      if (w > maxW) {
        fs = size * 0.82;
        ctx.font = font(fs, isCurrent ? 700 : 600);
        w = ctx.measureText(text).width;
      }

      ctx.save();
      // 极端长句：横向压缩，保证不溢出画面
      var sx = w > maxW ? maxW / w : 1;
      if (sx < 1) {
        ctx.translate(W / 2, y);
        ctx.scale(sx, 1);
        ctx.translate(-W / 2, -y);
      }

      /*
        演唱进度 p：按字数估算唱完的时刻（中文约 0.34 秒/字），
        而不是直接用“本行到下一行”的间隔 —— LRC 的间隔里含句尾停顿，
        直接拿它当演唱时长，颜色会明显慢半拍。

        唱完之后如果下一句还很远（间奏），画面会连续十几秒完全静止，
        看起来像视频卡住了。这里给当前行加一个很轻的“呼吸”明暗，
        幅度只有 13%，不刺眼，但能让人看出画面仍在走。
      */
      var p = 0, spoken = 0, restA = 1;
      if (isCurrent) {
        var span = Math.max(0.4, (lines[j].end || 0) - lines[j].t);
        var chars = (text.match(/[^\s，。！？；、,.!?;…—]/g) || []).length || 8;
        spoken = clamp(chars * 0.34, span * 0.45, span * 0.92);
        p = clamp((t - lines[j].t) / spoken, 0, 1);
        var rest = t - lines[j].t - spoken;
        if (rest > 0.8) restA = 1 - 0.13 * (0.5 + 0.5 * Math.sin((rest - 0.8) * 1.05));
      }
      ctx.globalAlpha = restA;

      // 未唱到：暗色底字
      ctx.fillStyle = isCurrent
        ? 'rgba(255,255,255,0.34)'
        : 'rgba(255,255,255,' + (0.3 * alpha).toFixed(3) + ')';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = fs * (isCurrent ? 0.3 : 0.2);
      ctx.shadowOffsetY = fs * 0.04;
      ctx.fillText(text, W / 2, y);

      // 已唱到：强调色逐字填充
      if (isCurrent && p > 0.002) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(W / 2 - w / 2 - fs * 0.2, y - fs * 0.9, (w + fs * 0.4) * p, fs * 1.8);
        ctx.clip();
        ctx.shadowColor = hexA(th.accent, 0.6);
        ctx.shadowBlur = fs * 0.5;
        ctx.fillStyle = th.accent;
        ctx.fillText(text, W / 2, y);
        ctx.restore();
      }
      ctx.restore();
    }

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  /* ---------- 音频律动柱 ---------- */
  function drawBars(W, H, S, th, spec, t, dt, portrait) {
    var count = portrait ? 40 : 76;
    if (barVals.length !== count) {
      barVals = new Array(count);
      for (var z = 0; z < count; z++) barVals[z] = 0;
    }

    var areaW = W * (portrait ? 0.7 : 0.74);
    var x0 = (W - areaW) / 2;
    // 竖屏：底部 15% 是平台文案区，律动柱整体上移避让
    var baseY = H * (portrait ? 0.72 : 0.855);
    var maxH = H * (portrait ? 0.07 : 0.115);
    var slot = areaW / count;
    var bw = Math.max(2, slot * 0.54);
    var n = spec ? spec.length : 0;

    var grad = ctx.createLinearGradient(0, baseY - maxH, 0, baseY);
    grad.addColorStop(0, th.accent);
    grad.addColorStop(1, th.accent2);

    // 底部一条细基线，让柱体有“落地”感
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x0, baseY + 1, areaW, Math.max(1, H * 0.0012));

    for (var i = 0; i < count; i++) {
      var v;
      if (spec) {
        // 对数映射：低频占用更多柱体，视觉上更“跟节奏”
        var bin = Math.floor(Math.pow((i + 1) / count, 1.8) * (n * 0.55)) + 2;
        v = (spec[Math.min(n - 1, bin)] || 0) / 255;
        v = Math.pow(v, 1.5) * 1.5;
      } else {
        v = 0.1 + 0.08 * (0.5 + 0.5 * Math.sin(t * 2.1 + i * 0.55));
      }
      v = clamp(v, 0, 1);

      var cur = barVals[i];
      cur = v > cur ? cur + (v - cur) * 0.62 : cur + (v - cur) * 0.13;
      barVals[i] = cur;

      var h = Math.max(3, cur * maxH);
      var x = x0 + i * slot + (slot - bw) / 2;

      // 倒影
      ctx.globalAlpha = 0.16;
      rr(x, baseY + 4, bw, h * 0.4, bw / 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.globalAlpha = 1;

      // 主柱
      rr(x, baseY - h, bw, h, bw / 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  /* ---------- 底部进度条 ---------- */
  function drawProgress(W, H, th, t, duration) {
    var hgt = Math.max(2, H * 0.004);
    var y = H - hgt;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(0, y, W, hgt);

    var p = duration ? clamp(t / duration, 0, 1) : 0;
    if (p <= 0) return;

    var g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, hexA(th.accent, 0.55));
    g.addColorStop(0.6, th.accent);
    g.addColorStop(1, th.accent2);
    ctx.fillStyle = g;
    ctx.fillRect(0, y, W * p, hgt);
  }

  /* ---------- 品牌角标 ---------- */
  function drawBrand(W, H, S, th, portrait) {
    var fs = clamp(S * 0.016, 8, 26);
    ctx.save();
    ctx.globalAlpha = 0.38;
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(fs, 600);
    ctx.fillStyle = '#ffffff';
    if (portrait) {
      // 竖屏：右下角是平台按钮区，挪到右上角
      ctx.textAlign = 'right';
      ctx.fillText((window.SFI18N && SFI18N.lang === 'en') ? 'SonicFrame' : '音帧 SonicFrame', W - S * 0.045, S * 0.062);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText((window.SFI18N && SFI18N.lang === 'en') ? 'SonicFrame' : '音帧 SonicFrame', W - S * 0.045, H - S * 0.042);
    }
    ctx.restore();
  }

  /* ---------- 主渲染 ---------- */
  function render(t, spec, st) {
    if (!ctx) return;
    var W = canvas.width;
    var H = canvas.height;
    var th = THEMES[st.theme] || THEMES.ink;
    // 「封面取色」模式：用从封面提取的主色替换强调色（app.js 计算后传入）
    if (st.accentColor) {
      th = {
        name: '封面取色',
        accent: st.accentColor,
        accent2: st.accent2Color || st.accentColor,
        bg: th.bg,
        glow: st.accentColor
      };
    }
    var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    // 离线导出时由外部给定固定步长，保证每一帧的动画状态可复现
    var dt = st && st.dt > 0 ? st.dt : (lastNow ? clamp((now - lastNow) / 1000, 0.008, 0.06) : 0.016);
    lastNow = now;

    if (st.lines !== lastLines) {
      lastLines = st.lines;
      scroll = 0;
    }

    var portrait = H > W;
    var S = Math.min(W, H);

    // cover = 歌曲封面；gradient = 纯渐变；image / ai = 用 bgImg（自定义图或生成的场景图）
    var img = st.bgMode === 'cover' ? st.coverImg : (st.bgMode === 'gradient' ? null : st.bgImg);
    if (img) drawImageBG(img, t, st.duration, W, H);
    else drawGradientBG(th, t, spec, W, H);

    drawScrim(W, H, portrait);

    // 背景图生成失败且没有旧图时用纯色兜底：不叠歌名文字，避免出现“颜色+文字”的廉价画面
    if (st.options.title && !st.plainBg) {
      drawIntroCard(W, H, S, th, st, t);
      drawHeader(W, H, S, th, st, t, portrait);
    }

    drawLyrics(W, H, S, th, st, t, dt, portrait);

    if (st.options.bars) drawBars(W, H, S, th, spec, t, dt, portrait);
    if (st.options.progress) drawProgress(W, H, th, t, st.duration);
    if (st.options.brand) drawBrand(W, H, S, th, portrait);
  }

  global.MV = {
    THEMES: THEMES,
    init: init,
    render: render
  };
})(window);
