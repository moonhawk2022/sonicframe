/* =========================================================
   scene.js — 根据歌名 / 歌词自动生成 MV 背景图
   · AI 文生图（默认）：把歌名 + 歌词交给在线 AI 画出真实背景图，
     使用 pollinations.ai 免费服务，无需 API Key，支持中文提示词
   · 本地构图（离线兜底）：程序化生成，无需联网
   · 同样的 seed 生成同样的图；换 seed 即换一张（可无限重生成）
   ========================================================= */
(function (global) {
  'use strict';

  /* ---------- 随机数（可复现）---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function withAlpha(hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /* ---------- 关键词 → 场景 ---------- */
  var GROUPS = [
    {
      scene: 'rain',
      name: '雨夜光斑',
      words: ['雨', '湿', '伞', '淋', '水汽', '潮湿', '泪', 'rain', 'wet', 'umbrella', 'storm', 'drizzle', 'tears']
    },
    {
      scene: 'sea',
      name: '海边黄昏',
      words: ['海', '浪', '岸', '沙滩', '潮', '日落', '黄昏', '夕阳', '港口', '船', 'sea', 'ocean', 'wave', 'beach', 'sunset', 'shore', 'tide', 'harbor', 'sail']
    },
    {
      scene: 'mountain',
      name: '山谷星空',
      words: ['山', '森林', '树', '谷', '峰', '湖', '雪', '北方', '草原', 'mountain', 'forest', 'tree', 'peak', 'lake', 'valley', 'hill', 'snow', 'wild']
    },
    {
      scene: 'city',
      name: '城市夜色',
      words: ['城市', '街', '霓虹', '楼', '地铁', '广场', '车', '窗', '灯', '都市', '天桥', '路口', 'city', 'street', 'neon', 'downtown', 'road', 'taxi', 'subway', 'building', 'window', 'town']
    },
    {
      scene: 'star',
      name: '星河夜空',
      words: ['星', '夜', '月', '银河', '宇宙', '天空', '光年', '梦', '星尘', 'star', 'night', 'moon', 'galaxy', 'space', 'dream', 'sky', 'universe', 'cosmos']
    }
  ];

  // 关键词匹配不上时的兜底顺序（不再提供无具体内容的抽象场景）
  var FALLBACK = ['star', 'city', 'mountain', 'sea'];

  function analyze(text) {
    var t = String(text || '').toLowerCase();
    if (!t.trim()) {
      var pick = FALLBACK[0];
      return { scene: pick, name: nameOf(pick), keywords: [], score: 0 };
    }

    var best = null;
    var bestScore = 0;

    GROUPS.forEach(function (g) {
      var score = 0;
      var hits = [];
      g.words.forEach(function (w) {
        var idx = 0;
        var c = 0;
        while ((idx = t.indexOf(w, idx)) > -1) { c++; idx += w.length; }
        if (c) { score += c; hits.push(w); }
      });
      // 标题权重更高（第一行通常是歌名）
      if (score > bestScore) {
        bestScore = score;
        best = { scene: g.scene, name: g.name, keywords: hits.slice(0, 4), score: score };
      }
    });

    if (!best) {
      var f = FALLBACK[0];
      return { scene: f, name: nameOf(f), keywords: [], score: 0 };
    }
    return best;
  }

  function nameOf(scene) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].scene === scene) return GROUPS[i].name;
    return '星河夜空';
  }

  /* ---------- 调色板 ---------- */
  var PALETTES = {
    city: [
      { sky: ['#070b18', '#152045', '#3b2a5e'], near: '#0b1122', far: '#131d3c', win: ['#ffd39a', '#ffe9c9', '#8fd8ff'], glow: '#5a63ff', moon: '#fff3d6' },
      { sky: ['#0a0a12', '#251a34', '#4d2340'], near: '#120b1c', far: '#221432', win: ['#ffc48a', '#ff8fb8', '#9be7ff'], glow: '#ff5f8a', moon: '#ffe6ef' },
      { sky: ['#04101a', '#0b2637', '#14424f'], near: '#06131c', far: '#0c2430', win: ['#9ff5e2', '#ffd9a0', '#c7f0ff'], glow: '#2ee6c8', moon: '#e8fffb' }
    ],
    sea: [
      { sky: ['#241b3f', '#7b3a56', '#ff9d63'], sun: '#fff0c9', glow: '#ff8f4d', water: ['#5c3468', '#150a20'] },
      { sky: ['#1b2340', '#4a4f7a', '#e7a3a0'], sun: '#fff6e2', glow: '#ffb6a0', water: ['#3c4268', '#12142a'] },
      { sky: ['#2a1430', '#6d2b4a', '#f0724f'], sun: '#ffe0b0', glow: '#ff6b3d', water: ['#461a34', '#140610'] }
    ],
    mountain: [
      { sky: ['#05070f', '#0d1a33', '#25405f'], ridge: ['#14243c', '#0d1929', '#080f1a', '#04070d'], moon: '#eef4ff' },
      { sky: ['#0a0616', '#1d1237', '#3a2358'], ridge: ['#241a3a', '#180f28', '#0e0818', '#06030c'], moon: '#f6ecff' },
      { sky: ['#04100e', '#0a2a24', '#1d4a3c'], ridge: ['#122a24', '#0b1d18', '#061110', '#030807'], moon: '#eafff7' }
    ],
    rain: [
      { sky: ['#05090f', '#0b1622', '#1d3040'], light: ['#ffb46b', '#7fb7ff', '#ff8fa8'], wet: '#0a1420' },
      { sky: ['#06070f', '#131226', '#2a2044'], light: ['#9db9ff', '#ffd39a', '#c7a4ff'], wet: '#0a0a16' }
    ],
    star: [
      { sky: ['#04030d', '#0d0a26', '#241041'], neb: ['#7b4dff', '#2ad4ff', '#ff5fa2'], moon: '#f0eaff' },
      { sky: ['#05070c', '#111a2e', '#20304d'], neb: ['#4d8bff', '#8de8ff', '#b98cff'], moon: '#f4f8ff' }
    ],
  };

  function pick(arr, rnd) { return arr[Math.floor(rnd() * arr.length)]; }

  /* ---------- 通用绘制 ---------- */
  function drawSky(ctx, W, H, colors) {
    var g = ctx.createLinearGradient(0, 0, W * 0.25, H);
    g.addColorStop(0, colors[0]);
    g.addColorStop(0.55, colors[1]);
    g.addColorStop(1, colors[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function stars(ctx, W, H, rnd, count, alpha) {
    var s = W / 1280;
    for (var i = 0; i < count; i++) {
      var x = rnd() * W;
      var y = rnd() * H * 0.82;
      var big = rnd() > 0.93;
      var r = Math.max(0.4, (big ? 1.2 + rnd() * 1.3 : 0.35 + rnd() * 0.8) * s);
      ctx.fillStyle = 'rgba(255,255,255,' + (alpha * (0.25 + rnd() * 0.75)).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (big) {
        var g = ctx.createRadialGradient(x, y, 0, x, y, r * 6);
        g.addColorStop(0, 'rgba(255,255,255,0.35)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r * 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function glowDisc(ctx, x, y, r, color, glow) {
    glow = glow || color;
    var g = ctx.createRadialGradient(x, y, 0, x, y, r * 7);
    g.addColorStop(0, withAlpha(glow, 0.55));
    g.addColorStop(0.3, withAlpha(glow, 0.18));
    g.addColorStop(1, withAlpha(glow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r * 7, y - r * 7, r * 14, r * 14);

    var d = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.05, x, y, r);
    d.addColorStop(0, '#ffffff');
    d.addColorStop(0.7, color);
    d.addColorStop(1, withAlpha(color, 0.75));
    ctx.fillStyle = d;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function softClouds(ctx, W, H, rnd, yFrom, yTo, count, color) {
    for (var i = 0; i < count; i++) {
      var y = yFrom + rnd() * (yTo - yFrom);
      var w = W * (0.2 + rnd() * 0.7);
      var h = w * (0.05 + rnd() * 0.09);
      var x = rnd() * W;
      var g = ctx.createRadialGradient(x, y, 0, x, y, w / 2);
      g.addColorStop(0, withAlpha(color, 0.10 + rnd() * 0.10));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, h / (w / 2));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function skyline(ctx, W, H, rnd, o) {
    var x = -o.wMax;
    while (x < W) {
      var bw = o.wMin + rnd() * (o.wMax - o.wMin);
      var bh = H * (o.minH + rnd() * (o.maxH - o.minH));
      var top = o.base - bh;

      ctx.fillStyle = o.color;
      ctx.fillRect(x, top, bw, bh + H * 0.06);
      ctx.fillStyle = 'rgba(140,170,230,0.07)';
      ctx.fillRect(x, top, bw, Math.max(1, H * 0.0018));

      if (o.win) {
        var cw = Math.max(4, W * 0.0072);
        var ch = Math.max(6, H * 0.0115);
        var gapX = cw * 0.85;
        var gapY = ch * 1.05;
        var cols = Math.floor((bw - gapX) / (cw + gapX));
        var rows = Math.floor((bh - gapY) / (ch + gapY));
        for (var r = 0; r < rows; r++) {
          for (var c = 0; c < cols; c++) {
            if (rnd() > o.winChance) continue;
            var wx = x + gapX + c * (cw + gapX);
            var wy = top + gapY + r * (ch + gapY);
            var col = o.win[Math.floor(rnd() * o.win.length)];
            ctx.fillStyle = withAlpha(col, o.winAlpha * (0.3 + rnd() * 0.7));
            ctx.fillRect(wx, wy, cw, ch);
          }
        }
      }
      x += bw + 3 + rnd() * (o.wMax * 0.22);
    }
  }

  function ridge(ctx, W, H, rnd, yBase, amp, color, freq) {
    var p1 = rnd() * Math.PI * 2;
    var p2 = rnd() * Math.PI * 2;
    var p3 = rnd() * Math.PI * 2;
    var step = Math.max(4, W / 260);

    ctx.beginPath();
    ctx.moveTo(0, H);
    for (var x = 0; x <= W; x += step) {
      var nx = x / W;
      var y = yBase
        + Math.sin(nx * Math.PI * 2 * freq + p1) * amp
        + Math.sin(nx * Math.PI * 2 * freq * 2.3 + p2) * amp * 0.45
        + Math.sin(nx * Math.PI * 2 * freq * 5.1 + p3) * amp * 0.16;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function fogBand(ctx, W, H, y, height, color, alpha) {
    var g = ctx.createLinearGradient(0, y, 0, y + height);
    g.addColorStop(0, withAlpha(color, 0));
    g.addColorStop(0.55, withAlpha(color, alpha));
    g.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, y, W, height);
  }

  /* ---------- 场景：城市 ---------- */
  function sceneCity(ctx, W, H, rnd, pal) {
    drawSky(ctx, W, H, pal.sky);
    stars(ctx, W, H, rnd, Math.round(W * H / 26000), 0.5);
    glowDisc(ctx, W * 0.78, H * 0.16, Math.min(W, H) * 0.032, pal.moon, pal.glow);

    skyline(ctx, W, H, rnd, {
      base: H * 1.02, minH: 0.14, maxH: 0.32,
      color: pal.far, win: pal.win, winAlpha: 0.4, winChance: 0.14,
      wMin: W * 0.025, wMax: W * 0.06
    });
    skyline(ctx, W, H, rnd, {
      base: H * 1.05, minH: 0.26, maxH: 0.55,
      color: pal.near, win: pal.win, winAlpha: 0.78, winChance: 0.26,
      wMin: W * 0.04, wMax: W * 0.1
    });

    var g = ctx.createRadialGradient(W * 0.5, H * 1.0, 0, W * 0.5, H * 1.0, H * 0.62);
    g.addColorStop(0, withAlpha(pal.glow, 0.42));
    g.addColorStop(0.5, withAlpha(pal.glow, 0.1));
    g.addColorStop(1, withAlpha(pal.glow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    fogBand(ctx, W, H, H * 0.62, H * 0.3, '#0a1020', 0.55);
  }

  /* ---------- 场景：海边黄昏 ---------- */
  function sceneSea(ctx, W, H, rnd, pal) {
    var horizon = H * 0.545;

    drawSky(ctx, W, H, pal.sky);
    stars(ctx, W, H, rnd, Math.round(W * H / 60000), 0.35);

    // 云层
    softClouds(ctx, W, H, rnd, H * 0.1, horizon, 10, '#ffffff');
    softClouds(ctx, W, H, rnd, horizon - H * 0.12, horizon, 6, pal.sun);

    // 太阳
    var sunX = W * (0.42 + rnd() * 0.2);
    var sunR = Math.min(W, H) * 0.068;
    var sunY = horizon - sunR * 1.15;
    glowDisc(ctx, sunX, sunY, sunR, pal.sun, pal.glow);

    // 海面
    var wg = ctx.createLinearGradient(0, horizon, 0, H);
    wg.addColorStop(0, pal.water[0]);
    wg.addColorStop(1, pal.water[1]);
    ctx.fillStyle = wg;
    ctx.fillRect(0, horizon, W, H - horizon);

    // 海平线亮边
    ctx.fillStyle = withAlpha(pal.glow, 0.55);
    ctx.fillRect(0, horizon - H * 0.002, W, Math.max(1.2, H * 0.003));

    // 太阳倒影
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var y = horizon; y < H; y += Math.max(2, H * 0.004)) {
      var p = (y - horizon) / (H - horizon);
      var alpha = 0.5 * (1 - p) * (0.4 + rnd() * 0.6);
      var w = W * (0.02 + p * 0.16) * (0.5 + rnd() * 0.8);
      var x = sunX - w / 2 + (rnd() - 0.5) * W * 0.035;
      ctx.fillStyle = withAlpha(pal.sun, alpha);
      ctx.fillRect(x, y, w, Math.max(1, H * 0.0022));
    }
    ctx.restore();

    // 波纹
    ctx.globalAlpha = 0.12;
    for (var i = 0; i < 60; i++) {
      var yy = horizon + rnd() * (H - horizon);
      var ww = W * (0.02 + rnd() * 0.12);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(rnd() * W, yy, ww, Math.max(1, H * 0.0018));
    }
    ctx.globalAlpha = 1;

    fogBand(ctx, W, H, H * 0.72, H * 0.28, '#0a0612', 0.5);
  }

  /* ---------- 场景：山谷星空 ---------- */
  function sceneMountain(ctx, W, H, rnd, pal) {
    drawSky(ctx, W, H, pal.sky);

    // 银河
    ctx.save();
    ctx.translate(W * 0.46, H * 0.28);
    ctx.rotate(-0.42);
    var mg = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.8);
    mg.addColorStop(0, 'rgba(170,150,255,0.20)');
    mg.addColorStop(0.45, 'rgba(110,90,200,0.09)');
    mg.addColorStop(1, 'rgba(80,60,160,0)');
    ctx.fillStyle = mg;
    ctx.beginPath();
    ctx.ellipse(0, 0, W * 0.8, H * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    stars(ctx, W, H, rnd, Math.round(W * H / 9000), 0.85);
    glowDisc(ctx, W * 0.22, H * 0.18, Math.min(W, H) * 0.028, pal.moon, '#cfe0ff');

    var layers = pal.ridge;
    var baseY = H * 0.58;
    for (var i = 0; i < layers.length; i++) {
      var t = i / (layers.length - 1);
      ridge(ctx, W, H, rnd, baseY + t * H * 0.13, H * (0.075 - t * 0.012), layers[i], 1.2 + i * 0.35);
      if (i < layers.length - 1) {
        fogBand(ctx, W, H, baseY + t * H * 0.13 + H * 0.02, H * 0.14, i % 2 ? '#8fa8d8' : '#6d87bb', 0.14);
      }
    }

    fogBand(ctx, W, H, H * 0.72, H * 0.3, '#050810', 0.65);
  }

  /* ---------- 场景：雨夜光斑 ---------- */
  function sceneRain(ctx, W, H, rnd, pal) {
    drawSky(ctx, W, H, pal.sky);

    // 远处建筑剪影
    skyline(ctx, W, H, rnd, {
      base: H * 0.98, minH: 0.16, maxH: 0.4,
      color: 'rgba(6,10,18,0.85)', win: pal.light, winAlpha: 0.2, winChance: 0.07,
      wMin: W * 0.03, wMax: W * 0.08
    });

    // 光斑
    for (var i = 0; i < 26; i++) {
      var x = rnd() * W;
      var y = H * (0.18 + rnd() * 0.68);
      var r = Math.min(W, H) * (0.012 + rnd() * 0.055);
      var c = pal.light[Math.floor(rnd() * pal.light.length)];
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, withAlpha(c, 0.6));
      g.addColorStop(0.5, withAlpha(c, 0.18));
      g.addColorStop(1, withAlpha(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 湿地面反射
    for (var j = 0; j < 16; j++) {
      var rx = rnd() * W;
      var rw = W * (0.01 + rnd() * 0.05);
      var rh = H * (0.08 + rnd() * 0.22);
      var col = pal.light[Math.floor(rnd() * pal.light.length)];
      var rg = ctx.createLinearGradient(0, H - rh, 0, H);
      rg.addColorStop(0, withAlpha(col, 0));
      rg.addColorStop(0.45, withAlpha(col, 0.16));
      rg.addColorStop(1, withAlpha(col, 0.03));
      ctx.fillStyle = rg;
      ctx.fillRect(rx, H - rh, rw, rh);
    }

    // 雨丝
    ctx.lineCap = 'round';
    for (var k = 0; k < 240; k++) {
      var sx = rnd() * W * 1.1;
      var sy = rnd() * H;
      var len = H * (0.02 + rnd() * 0.07);
      ctx.strokeStyle = 'rgba(200,225,255,' + (0.04 + rnd() * 0.12).toFixed(3) + ')';
      ctx.lineWidth = Math.max(0.8, W * 0.0009);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - len * 0.14, sy + len);
      ctx.stroke();
    }

    fogBand(ctx, W, H, H * 0.55, H * 0.45, '#0a1420', 0.5);
  }

  /* ---------- 场景：星河 ---------- */
  function sceneStar(ctx, W, H, rnd, pal) {
    drawSky(ctx, W, H, pal.sky);

    // 星云
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (var i = 0; i < 4; i++) {
      var bx = W * (0.15 + rnd() * 0.7);
      var by = H * (0.1 + rnd() * 0.55);
      var br = Math.max(W, H) * (0.15 + rnd() * 0.25);
      var c = pal.neb[i % pal.neb.length];
      var g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, withAlpha(c, 0.3));
      g.addColorStop(0.45, withAlpha(c, 0.07));
      g.addColorStop(1, withAlpha(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    stars(ctx, W, H, rnd, Math.round(W * H / 6000), 0.9);
    glowDisc(ctx, W * 0.7, H * 0.24, Math.min(W, H) * 0.022, pal.moon, '#b7c8ff');

    // 地平线剪影
    ridge(ctx, W, H, rnd, H * 0.86, H * 0.06, 'rgba(3,4,10,0.95)', 1.1);
    fogBand(ctx, W, H, H * 0.78, H * 0.24, '#0a0a1a', 0.6);
  }

  /* ---------- 场景：抽象光晕 ---------- */
  /* ---------- 胶片颗粒 + 暗角 ---------- */
  function grain(ctx, W, H, rnd) {
    var n = document.createElement('canvas');
    n.width = 90;
    n.height = 90;
    var nc = n.getContext('2d');
    var img = nc.createImageData(90, 90);
    for (var i = 0; i < img.data.length; i += 4) {
      var v = 128 + (rnd() - 0.5) * 70;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    nc.putImageData(img, 0, 0);

    var pat = ctx.createPattern(n, 'repeat');
    if (!pat) return;
    ctx.save();
    ctx.globalAlpha = 0.055;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function vignette(ctx, W, H) {
    var g = ctx.createRadialGradient(W * 0.5, H * 0.44, Math.min(W, H) * 0.22, W * 0.5, H * 0.44, Math.max(W, H) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 底部压暗，保证歌词可读
    var b = ctx.createLinearGradient(0, H * 0.5, 0, H);
    b.addColorStop(0, 'rgba(0,0,0,0)');
    b.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = b;
    ctx.fillRect(0, H * 0.5, W, H * 0.5);
  }

  /* ---------- 尺寸 ---------- */
  function dims(ratio) {
    var LONG = 1280;
    switch (ratio) {
      case '9:16': return { w: 720, h: 1280 };
      case '1:1': return { w: 1024, h: 1024 };
      case '4:5': return { w: 1024, h: 1280 };
      default: return { w: LONG, h: 720 };
    }
  }

  /* ---------- 主入口 ---------- */
  function generate(opts) {
    opts = opts || {};
    var seed = (typeof opts.seed === 'number' && isFinite(opts.seed)) ? opts.seed : Math.floor(Math.random() * 1e9);
    var rnd = mulberry32(seed);
    var mood = analyze(opts.text || '');
    var scene = mood.scene;

    var paletteList = PALETTES[scene] || PALETTES.star;
    var pal = paletteList[Math.floor(rnd() * paletteList.length)] || paletteList[0];

    var d = dims(opts.ratio || '16:9');
    var canvas = document.createElement('canvas');
    canvas.width = d.w;
    canvas.height = d.h;
    var ctx = canvas.getContext('2d');
    var W = d.w;
    var H = d.h;

    switch (scene) {
      case 'city': sceneCity(ctx, W, H, rnd, pal); break;
      case 'sea': sceneSea(ctx, W, H, rnd, pal); break;
      case 'mountain': sceneMountain(ctx, W, H, rnd, pal); break;
      case 'rain': sceneRain(ctx, W, H, rnd, pal); break;
      case 'abstract': /* 已移除，按星河处理 */
      default: sceneStar(ctx, W, H, rnd, pal);
    }

    grain(ctx, W, H, rnd);
    vignette(ctx, W, H);

    return {
      canvas: canvas,
      scene: scene,
      name: mood.name,
      keywords: mood.keywords || [],
      seed: seed
    };
  }

  /* 导出统一放在文件末尾：AI 常量（AI_COOLDOWN_MS 等）定义在后面，
     提前导出会拿到 undefined（历史上这让 45 秒排队悄悄失效） */

  /* =========================================================
     AI 文生图：pollinations.ai 免费服务（无需密钥）
     · 免费限额：每 IP 每 45 秒 1 张，调用方需自行排队
     · 场景三分类：风景 / 人物 / 城市风景 —— 每类一个英文模板库，
       按歌词自动归类（也可在面板手动指定），seed 决定模板内取哪一款
     · 不直接喂中文歌词（模型会把汉字画进图里）
     · crossOrigin='anonymous'，服务端带 CORS 头，画布不会被污染，
       视频导出 / 保存 PNG 均可用（已实测）
     · 图片加载后裁掉底部 10%，去除右下角服务水印
     ========================================================= */
  var AI_SIZES = {
    '16:9': [1280, 720],
    '9:16': [720, 1280],
    '1:1': [1024, 1024],
    '4:5': [896, 1120]
  };
  var AI_COOLDOWN_MS = 45000;   // 免费额度：每 45 秒 1 张

  /* ---------- 场景三分类 ---------- */
  var AI_TYPES = {
    landscape: {
      label: '风景',
      words: [
        '山', '海', '浪', '河', '湖', '溪', '桥', '船', '林', '森林', '树', '原野', '草原',
        '麦田', '旷野', '星', '夜空', '月', '银河', '云', '风', '花', '樱', '雪', '冬',
        '秋', '枫', '落日', '夕阳', '黄昏', '日出', '田野', '天空', '岛', '瀑布', '沙漠',
        'sea', 'ocean', 'mountain', 'sky', 'star', 'cloud', 'river', 'snow', 'field',
        'sunset', 'sunrise', 'nature', 'forest', 'flower', 'wind', 'moon'
      ],
      prompts: [
        'vast misty mountain valley with layered ridges in morning sunlight',
        'endless sea horizon with gentle waves at golden hour, sparkling water',
        'starry night sky over a quiet mirror lake, milky way glowing above soft moonlit shore',
        'rolling green meadow with wildflowers under soft drifting clouds, sunny',
        'snow-covered pine forest in bright pale winter light, sunbeams between trees',
        'lonely country road stretching to the horizon through golden sunlit fields',
        'calm river with an old wooden bridge at dawn, warm golden mist',
        'cherry blossom petals drifting over a spring hillside in bright sunshine'
      ]
    },
    people: {
      label: '人物',
      words: [
        '我', '你', '他', '她', '爱', '恋', '吻', '抱', '拥抱', '背影', '眼', '泪', '心',
        '思念', '别', '离', '散', '忘', '牵手', '寂寞', '孤单', '等', '遇见', '人',
        '姑娘', '少年', '爱人', 'love', 'heart', 'tears', 'miss', 'goodbye',
        'together', 'lonely', 'wait', 'girl', 'boy', 'kiss', 'hug'
      ],
      // 人物类统一「背影 / 剪影」：AI 正脸容易画崩，背影更有 MV 故事感
      prompts: [
        'lone person seen from behind, standing by a warm glowing train window at dusk',
        'silhouette of a girl with flowing hair standing on a windy sunlit hilltop',
        'person walking alone on a bright empty beach leaving footprints, morning light',
        'young man from behind looking at distant city lights from a rooftop at blue hour',
        'two people sitting apart on a bench under golden autumn trees, soft warm light',
        'figure with an umbrella seen from behind, standing in soft rainy light with glowing street lamps',
        'back view of a person on a night bus, warm city lights bokeh through the glass',
        'person standing at the edge of the sea, wind blowing their coat, golden sunset glow'
      ]
    },
    city: {
      label: '城市',
      words: [
        '城市', '街', '街道', '霓虹', '楼', '地铁', '广场', '车', '窗', '灯', '都市',
        '天桥', '路口', '站台', '公路', '夜市', '出租', 'highway', 'city', 'street',
        'neon', 'downtown', 'building', 'subway', 'urban', 'traffic', 'crossroad'
      ],
      prompts: [
        'neon city street at night after rain, vivid glowing reflections on wet asphalt',
        'city skyline at dusk with thousands of lit windows, warm orange and teal sky',
        'empty pedestrian crossing downtown at night, vivid cinematic street lights',
        'rooftop view over the city at blue hour, glowing tower lights and warm windows',
        'subway platform with vivid passing light trails, bright station lights',
        'narrow old town alley with warm glowing lanterns and colorful hanging signs',
        'highway overpass at night with long exposure car light trails, vivid colors',
        'rainy city crosswalk with umbrellas and colorful neon sign bokeh, bright lights'
      ]
    }
  };
  var AI_TYPE_ORDER = ['landscape', 'people', 'city'];

  function aiTypeLabel(type) {
    return (AI_TYPES[type] || AI_TYPES.landscape).label;
  }

  // 按歌词关键词自动归类；城市词是强信号（加权 1.3），无命中默认风景
  function detectAiType(text) {
    var t = String(text || '').toLowerCase();
    if (!t.trim()) return 'landscape';
    var best = 'landscape', bestScore = 0;
    AI_TYPE_ORDER.forEach(function (k) {
      var score = 0;
      AI_TYPES[k].words.forEach(function (w) {
        var idx = 0, c = 0;
        while ((idx = t.indexOf(w, idx)) > -1) { c++; idx += w.length; }
        score += c;
      });
      if (k === 'city') score *= 1.3;
      if (score > bestScore) { bestScore = score; best = k; }
    });
    return best;
  }

  /* 时间 / 氛围修饰（从歌词里取，让画面跟着情绪走） */
  var TIME_MAP = [
    { re: /黄昏|夕阳|晚霞|落日|暮/, en: 'at golden sunset' },
    { re: /黎明|清晨|朝阳|晨|日出/, en: 'at dawn with soft morning light' },
    { re: /夜|月|星|深夜|午夜/, en: 'at night' }
  ];
  var MOOD_MAP = [
    { re: /孤单|眼泪|心碎|离别|遗憾|散|忘|孤独|沉默/, en: 'melancholic mood, soft muted blue tones with gentle ambient light' },
    { re: /爱|温暖|拥抱|阳光|笑|幸福|甜/, en: 'warm and tender mood, golden soft light' },
    { re: /奔跑|年少|热血|追|梦想|燃烧/, en: 'vibrant energetic atmosphere, vivid colors' },
    { re: /回忆|旧|从前|时光|曾经/, en: 'nostalgic faded tones, vintage film look' }
  ];
  /* 曲风 / 题材引导：命中后加进提示词，让画面风格跟音乐类型匹配 */
  var STYLE_MAP = [
    { re: /古风|江湖|侠|长安|水墨|红尘|桃花|明月|相思/, en: 'chinese ink painting aesthetic, ancient oriental atmosphere, flowing silk and mist' },
    { re: /说唱|嘻哈|rap|beat|flow|兄弟|街头/, en: 'gritty urban hip-hop vibe, raw street energy, high contrast' },
    { re: /电子|电音|节奏|dj|edm|techno|蹦/, en: 'futuristic neon glow, electronic music aesthetic, cyber haze' },
    { re: /民谣|吉他|弹唱|南方|小城|故乡|老街/, en: 'warm folk acoustic vibe, analog film photography look' },
    { re: /摇滚|吉他solo|嘶吼|热血|燃|梦想/, en: 'dramatic rock concert energy, bold lighting, smoke and stage haze' }
  ];

  /*
    画质引导尾缀：把「音乐封面」当画质锚点——
    专辑封面级构图与调色、专业摄影感，同时禁止文字/水印。
    亮度引导必须显式写（实测不同模板出的图普遍偏暗，尤其是 night/rain 场景）。
  */
  var TAIL_COMMON = ', cinematic music video background still, album cover art quality, ' +
    'professional music photography, vivid saturated colors, bright cinematic lighting, ' +
    'well-lit scene, luminous, atmospheric haze, soft depth of field, ' +
    'rich atmosphere, ultra detailed, sharp focus, no text, no letters, no watermark';
  var TAIL_NO_PEOPLE = ', empty scene with no people';

  /* type：'landscape' | 'people' | 'city' | 'auto'（默认，按歌词归类）
     seed：决定同一类里取哪一款模板（换 seed 即换同类的另一款） */
  function buildPrompt(text, type, seed) {
    var t = String(text || '').replace(/\[[^\]]*\]/g, ' ');
    var k = (type && AI_TYPES[type]) ? type : detectAiType(t);
    var def = AI_TYPES[k];
    var s = Math.abs((seed >>> 0) || 0);
    var parts = [def.prompts[s % def.prompts.length]];

    var i;
    for (i = 0; i < TIME_MAP.length; i++) {
      if (TIME_MAP[i].re.test(t)) { parts.push(TIME_MAP[i].en); break; }
    }
    for (i = 0; i < MOOD_MAP.length; i++) {
      if (MOOD_MAP[i].re.test(t)) { parts.push(MOOD_MAP[i].en); break; }
    }
    for (i = 0; i < STYLE_MAP.length; i++) {
      if (STYLE_MAP[i].re.test(t)) { parts.push(STYLE_MAP[i].en); break; }
    }
    if (k === 'people') {
      // 人物类：只允许背影/剪影，避免 AI 画出的正脸违和
      parts.push('shot from behind, faceless silhouette, no visible face');
      return parts.join(', ') + TAIL_COMMON;
    }
    return parts.join(', ') + TAIL_COMMON + TAIL_NO_PEOPLE;
  }

  function genImage(opts) {
    opts = opts || {};
    var usedType = null;
    return new Promise(function (resolve, reject) {
      var size = AI_SIZES[opts.ratio] || AI_SIZES['16:9'];
      var t = String(opts.text || '').replace(/\[[^\]]*\]/g, ' ');
      usedType = (opts.sceneType && AI_TYPES[opts.sceneType]) ? opts.sceneType : detectAiType(t);
      var prompt = opts.prompt || buildPrompt(opts.text, usedType, opts.seed);
      var seed = (opts.seed >>> 0) % 1000000 || 1;
      var url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) +
        '?width=' + size[0] + '&height=' + size[1] +
        '&seed=' + seed + '&nologo=true';

      var img = new Image();
      img.crossOrigin = 'anonymous';
      var done = false;
      var objUrl = null;

      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        img.src = '';
        reject(new Error('AI 绘图超时（网络较慢或服务繁忙）'));
      }, 90000);

      function cleanup() {
        if (objUrl) { setTimeout(function () { URL.revokeObjectURL(objUrl); }, 2000); objUrl = null; }
      }

      /*
        用 fetch 而不是直接 <img>.src：限流时 pollinations 会返回一张
        「Free limit reached」占位图（HTTP 402），<img> 会把它当正常图收下，
        背景就变成了广告牌；fetch 能检查状态码，402 直接按失败处理。
      */
      img.onload = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        if (img.naturalWidth < 64) { reject(new Error('AI 返回的图片无效')); return; }
        // 裁掉底部 10%，去除右下角水印；画布保持可用（CORS 已通过）
        var cw = img.naturalWidth;
        var ch = Math.round(img.naturalHeight * 0.9);
        var out = document.createElement('canvas');
        out.width = cw;
        out.height = ch;
        var octx = out.getContext('2d');
        octx.drawImage(img, 0, 0, cw, img.naturalHeight, 0, 0, cw, ch);

        /*
          亮度兜底：提示词里的 bright 词不是每次都管用（尤其夜/雨模板）。
          实测缩样平均亮度 < 72/255 时画面会明显发闷——按比例提亮到 ~100，
          并轻微加饱和，保证背景不会"暗淡"。纯提示词层 + 这一层双保险。
        */
        try {
          var probe = document.createElement('canvas');
          probe.width = 48; probe.height = 48;
          var pctx = probe.getContext('2d');
          pctx.drawImage(out, 0, 0, 48, 48);
          var px = pctx.getImageData(0, 0, 48, 48).data;
          var sum = 0;
          for (var pi = 0; pi < px.length; pi += 4) {
            sum += 0.2126 * px[pi] + 0.7152 * px[pi + 1] + 0.0722 * px[pi + 2];
          }
          var mean = sum / (px.length / 4);
          if (mean < 72) {
            var gain = Math.min(1.9, Math.max(1, 100 / Math.max(mean, 20)));
            octx.filter = 'brightness(' + gain.toFixed(2) + ') saturate(1.18)';
            octx.drawImage(out, 0, 0);
            octx.filter = 'none';
          }
        } catch (e) { /* 像素读取失败不影响交付 */ }

        resolve({ canvas: out, prompt: prompt, seed: seed, type: usedType, typeLabel: aiTypeLabel(usedType) });
      };
      img.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error('AI 图片解码失败'));
      };

      fetch(url, { mode: 'cors' }).then(function (res) {
        if (!res.ok) {
          var why = res.status === 402
            ? '免费额度已达上限（每 45 秒 1 张）'
            : 'AI 绘图服务返回 ' + res.status;
          throw new Error(why);
        }
        return res.blob();
      }).then(function (blob) {
        if (done) return;
        if (!blob || blob.type.indexOf('image/') !== 0) throw new Error('AI 返回的不是图片');
        objUrl = URL.createObjectURL(blob);
        img.src = objUrl;
      }).catch(function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('AI 绘图服务连接失败'));
      });
    });
  }

  /* ---------- 导出（必须放在所有定义之后）---------- */
  global.Scene = {
    generate: generate,
    analyze: analyze,
    buildPrompt: buildPrompt,
    genImage: genImage,
    aiTypeLabel: aiTypeLabel,
    detectAiType: detectAiType,
    AI_TYPES: AI_TYPES,
    AI_COOLDOWN_MS: AI_COOLDOWN_MS
  };
})(window);
