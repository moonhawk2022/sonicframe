/* =========================================================
   app.js — 主控制器
   流程：载入音频 → 解码 → 读取 ID3 → 解析歌词 → 实时渲染 → 录制导出
   ========================================================= */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return ('0' + Math.floor(sec / 60)).slice(-2) + ':' + ('0' + (sec % 60)).slice(-2);
  }

  function safeName(s) {
    return String(s || 'MV').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60) || 'MV';
  }

  /* ================= 状态 ================= */
  var state = {
    buffer: null,
    duration: 0,
    title: '',
    artist: '',
    coverUrl: null,
    coverImg: null,
    bgMode: 'cover',
    bgImg: null,
    sceneCanvas: null,
    bgFailed: false,
    sceneName: '',
    sceneKeywords: [],
    ratio: '16:9',
    theme: 'ink',
    fontScale: 1,
    accentColor: null,     // 「封面取色」主题：从封面提取的主色
    accent2Color: null,
    loudness: null,        // 响度标准化信息 {from, gainDb}
    res: '1080',
    sizeMode: 'auto',
    options: { title: true, bars: true, progress: true, brand: true },
    lines: [],
    offset: 0,
    lyricMode: 'none'
  };

  var els = {};
  var canvas = null;
  var lyricRows = [];
  var lastActiveLine = -1;
  // 「封面取色」按钮的可用态刷新（init 时被替换为真实实现）
  var refreshAutoThemeBtn = function () {};

  /* ================= 音频引擎 ================= */
  var E = {
    ctx: null, analyser: null, gain: null, dest: null,
    buffer: null, src: null, playing: false, startAt: 0, offset: 0, freq: null
  };

  function ensureAudio() {
    if (E.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    E.ctx = new AC();

    E.analyser = E.ctx.createAnalyser();
    E.analyser.fftSize = 2048;
    E.analyser.smoothingTimeConstant = 0.72;

    E.gain = E.ctx.createGain();
    // 响度已在解码后统一归一化到 -14 LUFS 附近，播放链路不再额外衰减
    E.gain.gain.value = 1.0;

    E.analyser.connect(E.gain);
    E.gain.connect(E.ctx.destination);

    // 录制用的音频分支
    E.dest = E.ctx.createMediaStreamDestination();
    E.gain.connect(E.dest);

    E.freq = new Uint8Array(E.analyser.frequencyBinCount);
  }

  function stopSource() {
    if (!E.src) return;
    var s = E.src;
    E.src = null;
    try { s.onended = null; s.stop(); } catch (e) { /* 已停止 */ }
    try { s.disconnect(); } catch (e) { /* ignore */ }
  }

  function currentTime() {
    if (!E.buffer || !E.ctx) return 0;
    if (E.playing) return Math.min(state.duration, E.offset + (E.ctx.currentTime - E.startAt));
    return Math.min(state.duration, E.offset);
  }

  function play(from) {
    return new Promise(function (resolve) {
      if (!E.buffer) { toast('请先添加歌曲'); resolve(false); return; }
      ensureAudio();

      var start = (typeof from === 'number') ? from : currentTime();
      if (start >= state.duration - 0.06) start = 0;

      var resume = E.ctx.state === 'suspended' ? E.ctx.resume() : Promise.resolve();
      resume.then(function () {
        stopSource();
        var s = E.ctx.createBufferSource();
        s.buffer = E.buffer;
        s.connect(E.analyser);
        s.onended = function () {
          if (E.src !== s) return;      // 手动停止，不算播完
          E.playing = false;
          E.src = null;
          E.offset = state.duration;
          updatePlayUI();
          onPlayEnded();
        };
        try {
          s.start(0, clamp(start, 0, Math.max(0, state.duration - 0.02)));
        } catch (err) {
          toast('播放失败：' + err.message);
          resolve(false);
          return;
        }
        E.src = s;
        E.offset = start;
        E.startAt = E.ctx.currentTime;
        E.playing = true;
        updatePlayUI();
        resolve(true);
      });
    });
  }

  function pause() {
    if (!E.playing) return;
    var t = currentTime();
    stopSource();
    E.playing = false;
    E.offset = t;
    updatePlayUI();
  }

  function togglePlay() {
    if (exporting) { toast('正在生成视频，完成后会自动停止'); return; }
    if (E.playing) pause(); else play();
  }

  function seekTo(t) {
    if (!E.buffer) return;
    if (exporting) return;
    t = clamp(t, 0, state.duration);
    if (E.playing) play(t);
    else { E.offset = t; }
    updateTransport(t);
  }

  function onPlayEnded() {
    updatePlayUI();
    if (exporting) stopRecording();
  }

  /* ================= 画布尺寸 ================= */
  var SIZE_TABLE = {
    '16:9': [1920, 1080],
    '9:16': [1080, 1920],
    '1:1': [1080, 1080],
    '4:5': [1080, 1350]
  };

  function calcSize(quality) {
    var base = SIZE_TABLE[state.ratio] || SIZE_TABLE['16:9'];
    // quality 可能是字符串（来自 select 的 value）也可能是数字，统一转数字比较
    var q = Number(quality);
    var k;
    if (quality === 'preview' || q === 540) k = 0.5;
    else if (q === 720) k = 2 / 3;
    else k = 1;
    return {
      w: Math.round(base[0] * k / 2) * 2,
      h: Math.round(base[1] * k / 2) * 2
    };
  }

  function applyCanvasSize(quality) {
    var s = calcSize(quality);
    if (canvas.width === s.w && canvas.height === s.h) return;
    canvas.width = s.w;
    canvas.height = s.h;
  }

  /* ================= 视图数据 ================= */
  var viewState = {
    title: '', artist: '', duration: 30, lines: [],
    theme: 'ink', bgMode: 'gradient', coverImg: null, bgImg: null,
    fontScale: 1, options: { title: true, bars: true, progress: true, brand: true }
  };

  var idleT = 0;
  var idleView = {
    title: '你的歌曲名称',
    artist: '歌手 · Artist',
    duration: 30,
    lines: [
      { t: 0, end: 4.6, text: '上传歌曲与歌词' },
      { t: 4.6, end: 9.2, text: '自动生成滚动歌词 MV' },
      { t: 9.2, end: 13.8, text: '音频律动柱跟随节拍起伏' },
      { t: 13.8, end: 18.4, text: '支持 16:9 / 9:16 / 1:1 / 4:5' },
      { t: 18.4, end: 23, text: '封面自动推镜 · 一键导出' },
      { t: 23, end: 27.6, text: '本地渲染，文件不上传' },
      { t: 27.6, end: 30, text: '从左侧第 1 步开始 →' }
    ],
    theme: 'ink',
    bgMode: 'gradient',
    coverImg: null,
    bgImg: null,
    fontScale: 1,
    options: { title: true, bars: true, progress: true, brand: true }
  };

  function syncView() {
    viewState.title = state.title || '你的歌曲名称';
    viewState.artist = state.artist || '';
    viewState.duration = state.duration || 30;
    viewState.lines = state.lines;
    viewState.theme = state.theme;
    viewState.bgMode = state.bgMode;
    viewState.coverImg = state.coverImg;
    viewState.bgImg = state.bgMode === 'ai' ? state.sceneCanvas : state.bgImg;
    viewState.plainBg = !!state.bgFailed;
    viewState.fontScale = state.fontScale;
    viewState.options = state.options;
    // 「封面取色」主题：把从封面提出的主色交给渲染器
    viewState.accentColor = state.theme === 'auto' ? state.accentColor : null;
    viewState.accent2Color = state.theme === 'auto' ? state.accent2Color : null;
    return viewState;
  }

  /* 固定步长渲染，供离线导出逐帧调用（dt 决定动画推进速度，保证可复现） */
  function renderFrame(t, spec, dt) {
    viewState.dt = dt || 0;
    MV.render(t, spec, syncView());
  }

  /* ================= 渲染循环 ================= */
  var lastFrame = 0;

  function loop(ts) {
    var now = ts || performance.now();
    var delta = lastFrame ? clamp((now - lastFrame) / 1000, 0, 0.1) : 0.016;
    lastFrame = now;

    // +0.05s：抵消音频输出延迟与一帧渲染滞后，让歌词颜色不落后于人声
    var t = currentTime() + 0.05;
    var spec = null;

    if (E.buffer) {
      // 离线导出时画布由编码器独占：预览循环让位，否则两套渲染互相覆盖、白烧 CPU
      if (exporting && offlineMode) { requestAnimationFrame(loop); return; }
      if (E.playing && E.analyser) {
        E.analyser.getByteFrequencyData(E.freq);
        spec = E.freq;
      }
      MV.render(t, spec, syncView());
      updateTransport(t);
      highlightLine(t);
      // 离线编码时进度由编码器自己汇报，实时录制才用播放进度
      if (exporting && !offlineMode) updateExportProgress(t);
    } else {
      idleT = (idleT + delta) % 30;
      idleView.theme = state.theme;
      // 空闲画面文案跟随当前语言（语言变化时重取翻译）
      var curLang = window.SFI18N ? SFI18N.lang : 'zh';
      if (idleView.__lang !== curLang) {
        idleView.__lang = curLang;
        idleView.title = T('你的歌曲名称');
        idleView.artist = T('歌手 · Artist');
        for (var iv = 0; iv < idleView.lines.length; iv++) idleView.lines[iv].text = T(idleView.lines[iv].text);
      }
      MV.render(idleT, null, idleView);
    }

    requestAnimationFrame(loop);
  }

  /* ================= 音频载入 ================= */
  function loadAudio(file) {
    if (!file) return;
    var isAudio = /^audio\//.test(file.type) || /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|webm)$/i.test(file.name);
    if (!isAudio) { toast('请选择音频文件（MP3 / WAV / M4A / FLAC / OGG）'); return; }
    if (file.size > 45 * 1024 * 1024) toast('文件较大，解码可能需要几秒…');

    ensureAudio();
    var reader = new FileReader();

    reader.onload = function () {
      var ab = reader.result;
      var tags = null;
      try { tags = ID3.parse(ab); } catch (e) { tags = null; }

      E.ctx.decodeAudioData(ab.slice(0), function (buf) {
        finishLoad(buf, tags, file);
      }, function () {
        toast('这个音频无法解码。MP3 / WAV 一定支持；M4A / FLAC / OGG 请用 Chrome 或 Edge 最新版');
      });
    };

    reader.onerror = function () { toast('文件读取失败，请重试'); };
    reader.readAsArrayBuffer(file);
  }

  /* ================= 联网歌词匹配（lrclib.net，免费公开歌词库）=================
     · 无需密钥、支持 CORS，直接从浏览器请求
     · 返回 syncedLyrics（LRC 带时间轴）优先，其次 plainLyrics
     · 用歌曲时长做匹配：结果里挑 |duration - 本曲时长| 最小的那条，
       避免同名不同曲（重名歌很多）
  ---------------------------------------------------------------- */
  var lyricsFetchToken = 0;

  function pickLyricResult(list, dur) {
    if (!list || !list.length) return null;
    var scored = list.map(function (x) {
      var s = 0;
      var d = Number(x.duration) || 0;
      if (dur && d) {
        var diff = Math.abs(d - dur);
        if (diff > 8) s -= 100;                       // 时长差太多，基本是另一首歌
        else s -= diff;                               // 差得越小越好
      }
      if (x.syncedLyrics) s += 50;                    // 带时间轴的优先
      else if (!x.plainLyrics) s -= 80;
      return { x: x, s: s };
    }).sort(function (a, b) { return b.s - a.s; });
    var best = scored[0];
    if (!best || best.s < -50) return null;
    var r = best.x;
    return {
      lrc: (r.syncedLyrics || r.plainLyrics || '').trim(),
      synced: !!r.syncedLyrics,
      name: r.trackName || '',
      artist: r.artistName || ''
    };
  }

  function fetchOnlineLyrics(opts) {
    opts = opts || {};
    var title = (state.title || '').trim();
    var artist = (state.artist || '').trim();
    if (!title || title === '未命名') {
      if (!opts.silent) toast('先填写歌名（第 1 步），再联网找歌词');
      return;
    }
    var token = ++lyricsFetchToken;
    var dur = state.duration || 0;

    var q = 'https://lrclib.net/api/search?track_name=' + encodeURIComponent(title) +
      (artist ? '&artist_name=' + encodeURIComponent(artist) : '');
    fetch(q, { mode: 'cors' })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status)); })
      .then(function (list) {
        if (token !== lyricsFetchToken) return;
        var hit = pickLyricResult(list, dur);
        // 带歌手搜不到时，退回只按歌名搜（同名曲目由时长匹配兜底）
        if ((!hit || !hit.lrc) && artist) {
          return fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(title), { mode: 'cors' })
            .then(function (res) { return res.ok ? res.json() : []; })
            .then(function (list2) {
              if (token !== lyricsFetchToken) return;
              deliverOnlineLyrics(pickLyricResult(list2, dur), opts);
            })
            .catch(function () { deliverOnlineLyrics(null, opts); });
        }
        deliverOnlineLyrics(hit, opts);
      })
      .catch(function () { deliverOnlineLyrics(null, opts); });
  }

  function deliverOnlineLyrics(hit, opts) {
    opts = opts || {};
    if (!hit || !hit.lrc) {
      if (!opts.silent) toast('歌词库没找到《' + (state.title || '') + '》，可手动粘贴歌词');
      return;
    }
    // 用户此刻已自己填了歌词就不抢（手动点按钮时 force=true 允许覆盖）
    if (!opts.force && state.lyricsSource === 'manual' && els.lyricsText.value.trim()) return;
    els.lyricsText.value = hit.lrc;
    state.lyricsSource = 'online';
    rebuildLyrics();
    scheduleSceneFollow();
    scheduleSaveDraft();
    var tag = hit.synced ? '带时间轴' : '纯文本';
    toast('已联网匹配歌词：《' + hit.name + '》· ' + hit.artist + '（' + tag +
      '，' + state.lines.length + ' 行）— 如对不上可自行调整');
  }

  function finishLoad(buf, tags, file) {
    state.buffer = buf;
    E.buffer = buf;
    state.duration = buf.duration;
    E.offset = 0;
    E.playing = false;
    stopSource();

    var guess = ID3.guessFromName(file.name);
    state.title = (tags && tags.title) || guess.title;
    state.artist = (tags && tags.artist) || guess.artist;

    els.titleInput.value = state.title;
    els.artistInput.value = state.artist;
    els.trackName.textContent = state.title || '未命名';
    els.trackInfo.textContent = fmt(state.duration) + ' · ' + (file.size / 1048576).toFixed(1) + ' MB';
    els.trackCard.hidden = false;
    els.dropzone.hidden = true;

    /*
      内嵌歌词：换了一首歌，框里的旧歌词（上一首的 / 草稿恢复的）必然过时，
      只要文件自带歌词就整体替换——这是"导入音乐直接出歌词"的关键路径。
      （对同一首歌反复手改再重导的情况极少，且内容相同，覆盖无害）
    */
    var embeddedLyrics = '';
    if (tags && tags.lyrics && tags.lyrics.trim()) embeddedLyrics = tags.lyrics.trim();
    var lyricsAutoFilled = false;
    // 文件指纹：判断是不是同一首歌重复导入（重复导入保留用户已填内容）
    var fileKey = (file.name || '') + '|' + file.size;
    var sameFile = state.loadedFileKey === fileKey;
    state.loadedFileKey = fileKey;
    if (embeddedLyrics) {
      els.lyricsText.value = embeddedLyrics;
      state.lyricsSource = 'embedded';
      lyricsAutoFilled = true;
    } else if (!sameFile) {
      // 换了一首新歌但没内嵌歌词：清掉上一首的残留，避免配错歌
      els.lyricsText.value = '';
      state.lyricsSource = 'none';
    }

    // 响度标准化：统一到 -14 LUFS 附近，成品发到平台音量一致
    state.loudness = normalizeLoudness(buf);

    // 封面
    if (tags && tags.picture && tags.picture.bytes && tags.picture.bytes.length > 100) {
      var blob = new Blob([tags.picture.bytes], { type: tags.picture.mime || 'image/jpeg' });
      state.coverUrl = URL.createObjectURL(blob);
      var im = new Image();
      im.onload = function () {
        state.coverImg = im;
        // 封面读出来后立刻提主色，供「封面取色」主题使用
        var acc = extractAccent(im);
        state.accentColor = acc ? acc.accent : null;
        state.accent2Color = acc ? acc.accent2 : null;
        refreshAutoThemeBtn();
        syncView();
      };
      im.src = state.coverUrl;
      els.trackCover.src = state.coverUrl;
      els.trackCover.hidden = false;
      els.trackCoverFallback.hidden = true;
    } else {
      // 换歌时必须清掉上一首的封面，否则会被当成新歌的背景
      state.coverImg = null;
      state.accentColor = null;
      state.accent2Color = null;
      refreshAutoThemeBtn();
      if (state.coverUrl) {
        URL.revokeObjectURL(state.coverUrl);
        state.coverUrl = null;
      }
      els.trackCover.removeAttribute('src');
      els.trackCover.hidden = true;
      els.trackCoverFallback.hidden = false;

      // 没有内嵌封面：自动生成 AI 背景当背景，而不是留一块空渐变
      if (window.Scene) {
        generateScene({ seed: contentSeed() });
      }
    }

    // 波形 + 峰值
    var peaks = computePeaks(buf, 800);
    els.seekWrap.style.setProperty('--wave', 'url(' + waveImage(peaks) + ')');

    els.timeTotal.textContent = fmt(state.duration);
    els.timeNow.textContent = '00:00';
    els.btnPlay.disabled = false;

    updateFlow();
    els.audioBadge.textContent = T('已载入');
    els.audioBadge.classList.add('is-on');
    els.stageMode.textContent = T('实际预览');

    rebuildLyrics();
    updateStageBadge();
    updateSizeHint();
    scheduleSaveDraft();

    // 汇总提示（一条 toast 说清所有自动完成的事）
    var bits = ['已载入《' + (state.title || '未命名') + '》· ' + fmt(state.duration)];
    if (lyricsAutoFilled) bits.push('已从音乐文件读取歌词');
    else if (state.title && state.title !== '未命名') bits.push('正在联网匹配歌词…');
    else bits.push('文件内没有歌词，请在第 2 步粘贴');
    if (state.loudness && Math.abs(state.loudness.gainDb) >= 1) {
      bits.push('音量已标准化' + (state.loudness.gainDb > 0 ? ' + ' : ' − ') +
        Math.abs(state.loudness.gainDb).toFixed(1) + 'dB');
    }
    if (!tags || !tags.picture) bits.push('未读到封面，已生成 AI 背景');
    toast(bits.join(' · '));

    // 没有内嵌歌词但有歌名：自动去歌词库联网匹配（免费、无需密钥）
    if (!embeddedLyrics && state.title && state.title !== '未命名') {
      fetchOnlineLyrics({ silent: true });
    }

    // 没读到封面时，直接用歌名生成一张场景图，避免默认画面太素
    if (!state.coverImg && state.bgMode === 'cover') {
      state.bgMode = 'ai';
      $$('#bgGroup .seg__btn').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.bg === 'ai');
      });
      els.scenePanel.hidden = false;
    }
  }

  /* ================= 音频处理 ================= */
  /*
    响度标准化：把解码后的音频统一拉到约 -14 LUFS（流媒体平台基准）。
    用均方根估算响度（LUFS ≈ -0.691 + 10·log10(meanSquare)，未做 K 加权，
    低音重的歌会略偏保守，但比完全不处理强得多——成品忽大忽小是差评重灾区）。
    增益限制 ±12dB，且削波时回退，保证不出现爆音。
  */
  function normalizeLoudness(buf) {
    var TARGET = -14;
    var sum = 0, n = 0, peak = 0;
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < d.length; i += 2) {   // 隔点采样，速度够且误差可忽略
        sum += d[i] * d[i];
        var v = d[i];
        if (v < 0) v = -v;
        if (v > peak) peak = v;
      }
      n += Math.ceil(d.length / 2);
    }
    if (!n) return { from: null, gainDb: 0 };
    var lufs = -0.691 + 10 * Math.log10(sum / n + 1e-12);
    var gainDb = clamp(TARGET - lufs, -12, 12);
    if (Math.abs(gainDb) < 0.4) return { from: lufs, gainDb: 0 };

    var g = Math.pow(10, gainDb / 20);
    if (peak * g > 0.98) g = 0.98 / peak;    // 削波保护
    var appliedDb = 20 * Math.log10(g);

    for (ch = 0; ch < buf.numberOfChannels; ch++) {
      var dd = buf.getChannelData(ch);
      for (var j = 0; j < dd.length; j++) dd[j] *= g;
    }
    return { from: lufs, gainDb: appliedDb };
  }

  /* ---------- 封面主色提取（「封面取色」主题）---------- */
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l };
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h / 6, s: s, l: l };
  }

  function toHex(r, g, b) {
    var f = function (v) { return ('0' + Math.round(clamp(v, 0, 255)).toString(16)).slice(-2); };
    return '#' + f(r) + f(g) + f(b);
  }

  /*
    取色策略：48×48 缩样 → 按 12 个色相桶统计「饱和度 × 明度适中性」加权票数，
    取最高票桶的平均色；饱和度过低（黑白灰封面）时保底给出亮度可读的中性色。
  */
  function extractAccent(img) {
    try {
      var N = 48;
      var c = document.createElement('canvas');
      c.width = N;
      c.height = N;
      var g = c.getContext('2d');
      g.drawImage(img, 0, 0, N, N);
      var data = g.getImageData(0, 0, N, N).data;

      var bins = [];
      for (var i = 0; i < 12; i++) bins.push({ w: 0, r: 0, gg: 0, b: 0, n: 0 });

      for (var p = 0; p < data.length; p += 4) {
        var a = data[p + 3];
        if (a < 128) continue;
        var r = data[p], gg = data[p + 1], b = data[p + 2];
        var hsl = rgbToHsl(r, gg, b);
        // 跳过接近纯黑/纯白的像素（它们撑不起强调色）
        if (hsl.l < 0.08 || hsl.l > 0.94) continue;
        var bin = Math.floor(hsl.h * 12) % 12;
        var weight = hsl.s * (1 - Math.abs(hsl.l - 0.5) * 1.4);
        if (weight <= 0) continue;
        bins[bin].w += weight;
        bins[bin].r += r;
        bins[bin].gg += gg;
        bins[bin].b += b;
        bins[bin].n++;
      }

      var best = null;
      bins.forEach(function (bn) { if (!best || bn.w > best.w) best = bn; });
      if (!best || best.w < 0.9 || !best.n) return null;   // 全图几乎无彩色

      var hex = toHex(best.r / best.n, best.gg / best.n, best.b / best.n);
      var out = rgbToHsl(best.r / best.n, best.gg / best.n, best.b / best.n);
      // 强调色统一提亮到可读区间（L 0.55~0.72，S ≥ 0.35）
      var L = clamp(out.l, 0.55, 0.72);
      var S2 = Math.max(out.s, 0.35);
      var accent = hslToHex(out.h, S2, L);
      var accent2 = hslToHex(out.h, Math.max(0.3, S2 * 0.8), Math.min(0.85, L + 0.2));
      return { accent: accent, accent2: accent2 };
    } catch (e) {
      return null;   // 图片跨域污染等异常：静默放弃
    }
  }

  function hslToHex(h, s, l) {
    var hue2rgb = function (p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return toHex(r * 255, g * 255, b * 255);
  }

  /* ================= 草稿（项目管理·基础版）================= */
  var DRAFT_KEY = 'sf-draft-v1';
  var draftTimer = null;

  // 音频文件本身没法存（体积+安全限制），其余设置全部自动保存
  function saveDraft() {
    if (!els.lyricsText) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        title: state.title,
        artist: state.artist,
        lyrics: els.lyricsText.value,
        ratio: state.ratio,
        theme: state.theme === 'auto' && !state.accentColor ? 'ink' : state.theme,
        bgMode: state.bgMode === 'cover' && !state.coverImg ? 'gradient' : state.bgMode,
        fontScale: state.fontScale,
        offset: state.offset,
        sizeMode: state.sizeMode,
        res: state.res,
        aiSceneType: state.aiSceneType || 'auto',
        options: state.options,
        savedAt: Date.now()
      }));
    } catch (e) { /* 存储满/隐私模式：忽略 */ }
  }

  function scheduleSaveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 700);
  }

  function restoreDraft() {
    var raw = null;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var d;
    try { d = JSON.parse(raw); } catch (e) { return false; }
    if (!d || (!d.lyrics && !d.title)) return false;

    state.title = d.title || '';
    state.artist = d.artist || '';
    els.titleInput.value = state.title;
    els.artistInput.value = state.artist;
    if (d.lyrics) els.lyricsText.value = d.lyrics;
    if (d.ratio && SIZE_TABLE[d.ratio]) state.ratio = d.ratio;
    if (d.theme) state.theme = d.theme;
    if (d.fontScale) state.fontScale = d.fontScale;
    if (typeof d.offset === 'number') state.offset = d.offset;
    if (d.sizeMode) state.sizeMode = d.sizeMode;
    if (d.res) state.res = d.res;
    if (d.aiSceneType) state.aiSceneType = d.aiSceneType;
    if (d.options) state.options = d.options;

    // 恢复 UI 控件状态
    $$('#ratioGroup .seg__btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.ratio === state.ratio);
    });
    $$('.theme-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.theme === state.theme);
    });
    $$('#bgGroup .seg__btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.bg === (state.bgMode === 'cover' ? 'gradient' : state.bgMode));
    });
    if (state.bgMode === 'cover') state.bgMode = 'gradient';   // 封面无法持久化
    els.fontRange.value = Math.round(state.fontScale * 100);
    els.fontVal.textContent = els.fontRange.value + '%';
    els.offsetRange.value = state.offset;
    els.offsetVal.textContent = (state.offset > 0 ? '+' : '') + state.offset.toFixed(1) + 's';
    els.sizeSelect.value = state.sizeMode;
    if (els.resSelect.querySelector('option[value="' + state.res + '"]')) els.resSelect.value = state.res;
    els.optTitle.checked = !!state.options.title;
    els.optBars.checked = !!state.options.bars;
    els.optProgress.checked = !!state.options.progress;
    els.optBrand.checked = !!state.options.brand;
    if (els.sceneTypeGroup) {
      $$('#sceneTypeGroup .seg__btn').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.stype === state.aiSceneType);
      });
    }
    return true;
  }

  function computePeaks(buffer, buckets) {
    var data = buffer.getChannelData(0);
    var step = Math.max(1, Math.floor(data.length / buckets));
    var peaks = new Float32Array(buckets);
    for (var i = 0; i < buckets; i++) {
      var max = 0;
      var start = i * step;
      for (var j = 0; j < step; j += 8) {
        var v = data[start + j];
        if (v < 0) v = -v;
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return peaks;
  }

  function waveImage(peaks) {
    var w = 800, h = 56;
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var g = c.getContext('2d');
    var bw = w / peaks.length;
    g.fillStyle = 'rgba(91,87,245,0.6)';
    for (var i = 0; i < peaks.length; i++) {
      var bh = Math.max(2, Math.min(1, peaks[i] * 1.6) * h * 0.92);
      g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw * 0.72), bh);
    }
    return c.toDataURL();
  }

  /* ================= 歌词 ================= */
  function rebuildLyrics() {
    var raw = els.lyricsText.value;
    if (!raw.trim()) {
      state.lines = [];
      state.lyricMode = 'none';
      els.lyricList.hidden = true;
      els.lyricList.innerHTML = '';
      els.lyricBadge.textContent = T('可选');
      els.lyricBadge.classList.remove('is-on');
      els.lyricCleanHint.hidden = true;
      updateFlow();
      return;
    }

    var built = Lyrics.build(raw, state.duration);
    state.lines = Lyrics.withOffset(built.lines, state.offset, state.duration);
    state.lyricMode = built.mode;

    // 段落标记（[Verse 1] / [Chorus] / [Bridge] …）已在解析时剔除
    if (built.removed) {
      els.lyricCleanHint.hidden = false;
      els.lyricCleanHint.textContent = '已自动忽略 ' + built.removed +
        ' 处段落标记（如 [Verse 1]、[Chorus]、[Bridge]），不会出现在画面里。';
    } else {
      els.lyricCleanHint.hidden = true;
    }

    if (built.mode === 'lrc') {
      els.lyricBadge.textContent = T('已识别 LRC');
      els.lyricBadge.classList.add('is-on');
    } else if (built.mode === 'auto') {
      els.lyricBadge.textContent = T('自动对齐');
      els.lyricBadge.classList.remove('is-on');
    } else {
      els.lyricBadge.textContent = T('等待歌曲');
      els.lyricBadge.classList.remove('is-on');
    }

    renderLyricList();
    updateFlow();
    // AI 背景模式下，歌词变化后背景自动跟着换
    scheduleSceneFollow();
  }

  function renderLyricList() {
    var list = els.lyricList;
    if (!state.lines.length) {
      list.hidden = true;
      list.innerHTML = '';
      lyricRows = [];
      return;
    }

    var frag = document.createDocumentFragment();
    state.lines.forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'lyric-line';

      var tm = document.createElement('time');
      tm.textContent = state.duration ? fmt(l.t) : '--:--';

      var sp = document.createElement('span');
      sp.textContent = l.text;

      row.appendChild(tm);
      row.appendChild(sp);
      row.addEventListener('click', function () { seekTo(l.t); });
      frag.appendChild(row);
    });

    list.innerHTML = '';
    list.appendChild(frag);
    list.hidden = false;
    lyricRows = $$('.lyric-line', list);
    lastActiveLine = -1;
  }

  function highlightLine(t) {
    if (!lyricRows.length) return;
    var idx = -1;
    for (var i = 0; i < state.lines.length; i++) {
      if (state.lines[i].t <= t) idx = i; else break;
    }
    if (idx === lastActiveLine) return;
    lastActiveLine = idx;

    lyricRows.forEach(function (r, i) {
      if (i === idx) r.classList.add('is-active');
      else r.classList.remove('is-active');
    });

    if (idx >= 0 && lyricRows[idx] && els.lyricList.offsetParent) {
      var row = lyricRows[idx];
      var top = row.offsetTop;
      var box = els.lyricList;
      if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) {
        box.scrollTop = top - box.clientHeight / 2 + row.offsetHeight / 2;
      }
    }
  }

  /* ================= UI 同步 ================= */
  function updateTransport(t) {
    els.timeNow.textContent = fmt(t);
    var pct = state.duration ? clamp(t / state.duration, 0, 1) : 0;
    if (document.activeElement !== els.seek) {
      els.seek.value = Math.round(pct * 1000);
    }
    els.seek.style.setProperty('--pct', (pct * 100).toFixed(2) + '%');
  }

  function updatePlayUI() {
    var path = E.playing ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'M8 5v14l11-7z';
    $('#playIcon').setAttribute('d', path);
    els.btnPlay.setAttribute('aria-label', E.playing ? '暂停' : '播放');
  }

  function updateStageBadge() {
    els.stageBadge.textContent = state.ratio + ' · ' + state.res + 'p';
  }

  function updateFlow() {
    els.flowAudio.classList.toggle('is-done', !!state.buffer);
    els.flowLyric.classList.toggle('is-done', state.lines.length > 0);
    els.flowStyle.classList.toggle('is-done', !!state.buffer);
  }

  /* ================= 导出 ================= */
  var exporting = false;
  var rec = null;
  var chunks = [];
  var curMime = '';
  var exportUrl = null;
  var gotData = false;       // 是否真的收到了编码数据（用于识别“空录制”）
  var dataWatchdog = null;   // 长时间无数据时的兜底计时器
  var offlineMode = false;   // 当前走的是离线逐帧编码
  var offlineCancel = false; // 离线编码的取消标记

  /*
    码率规划：控制成片体积。
    默认目标 ≤10MB（短视频平台上传友好）。按歌曲时长反推码率：
    总码率 = 目标体积 × 8 × 0.95 / 时长，先扣音频，剩下的给视频。
    码率过低时由 startExport 自动降低清晰度，保证画面不发糊。
    也可选择 ≤30MB / ≤60MB / 高画质。
  */
  /*
    导出规划：在“目标体积”内尽量保清晰度。
    · 固定 24fps（MV 是缓慢推镜，24fps 比 30fps 每帧多 ~25% 的数据，字更锐）
    · 分辨率按“每像素每帧可用比特(bpp)”挑选：bpp 太低时高分辨率只会更糊，
      所以宁可降分辨率保清晰。阈值 0.018 为实测经验值。
  */
  var RES_DIMS = { '1080': [1920, 1080], '720': [1280, 720], '540': [960, 540] };

  function ratioScale(ratio) {
    // 非 16:9 比例按基准宽度等比缩放，估算像素量用
    var t = SIZE_TABLE[ratio] || SIZE_TABLE['16:9'];
    return t[0] / 1920;
  }

  function pickRes(video, fps, maxRes) {
    var order = maxRes === '720' ? ['720', '540'] : ['1080', '720', '540'];
    for (var i = 0; i < order.length; i++) {
      var d = RES_DIMS[order[i]];
      var k = ratioScale(state.ratio);
      var px = (d[0] * k) * (d[1] * k);
      if (video / (px * fps) >= 0.018) return order[i];
    }
    return '540';
  }

  function planExport() {
    var dur = state.duration || 0;
    var userRes = state.res === '720' ? '720' : '1080';
    var audio = 96000;
    var fps = 24;
    var targetMB = 0;   // 0 表示不限体积（高画质）
    var video;
    var res = userRes;
    var codec = 'avc1';

    if (state.sizeMode === 'max') {
      video = userRes === '1080' ? 4500000 : 2500000;
    } else if (dur > 1) {
      targetMB = state.sizeMode === 'auto' ? 10 : (parseFloat(state.sizeMode) || 60);
      // 0.88：给编码器留 ~12% 波动余量（复杂画面下实际码率会略超请求值）
      var totalBps = targetMB * 1024 * 1024 * 8 / dur * 0.88;
      // 音频固定 96k：浏览器硬件 AAC 编码器普遍不接受更低码率
      // （实测 64k 的配置直接 isConfigSupported=false，会导致离线导出失败）
      video = totalBps - audio;
      video = clamp(video, 160000, 9000000);

      /*
        1080p 小体积模式：预算 bpp 达不到 H.264 的清晰度线（0.018）时，
        若机器支持 AV1 编码（效率约 H.264 的 3~4 倍），就保住 1080p。
        实测 AV1 的 CBR 实际码率比目标高 ~17%，这里按 1.22 倍预留余量，
        并把实际码率折算进总体积（est 仍按目标计，留了双重保险）。
      */
      if (userRes === '1080' && state.av1Ok) {
        var px1080 = RES_DIMS['1080'][0] * ratioScale(state.ratio) * RES_DIMS['1080'][1] * ratioScale(state.ratio);
        if (video / (px1080 * fps) < 0.018) {
          codec = 'av01';
          res = '1080';
          video = Math.max(120000, Math.round(video / 1.22));
        } else {
          res = pickRes(video, fps, userRes);
        }
      } else {
        res = pickRes(video, fps, userRes);
      }
    } else {
      video = userRes === '1080' ? 2400000 : 1500000;
    }

    var est = dur * (video + audio) / 8 / 1048576;
    return {
      video: Math.round(video),
      audio: audio,
      fps: fps,
      res: res,
      codec: codec,
      est: est,
      targetMB: targetMB,
      // 歌曲太长、目标体积装不下时给个提示
      over: !!targetMB && est > targetMB * 1.08
    };
  }

  function updateSizeHint() {
    if (!els.sizeHint) return;
    if (!state.duration) {
      els.sizeHint.textContent = T('预计文件大小：载入歌曲后显示');
      return;
    }
    var p = planExport();
    var label = p.targetMB ? T('目标 ≤' + p.targetMB + 'MB').replace(String(p.targetMB), String(p.targetMB)) : T('高画质');
    var dims = calcSize(p.res);
    els.sizeHint.textContent = '预计 ≈ ' + p.est.toFixed(1) + ' MB（' + label + '） · ' +
      dims.w + '×' + dims.h + ' / ' + p.fps + 'fps · 视频 ' +
      (p.video / 1000000).toFixed(2) + ' Mbps · 音频 ' + (p.audio / 1000) + ' kbps' +
      (p.over ? ' · 歌曲较长，已用最低码率' : '');
  }

  /*
    优先 MP4(H.264+AAC)：抖音/视频号/小红书等平台只接受 MP4，
    WebM 虽然也能录，但用户拿去上传会直接被拒。
    只有在浏览器不支持 MP4 录制时（如部分 Firefox/Safari）才退回 WebM。
  */
  function pickMime() {
    if (!window.MediaRecorder) return '';
    var list = [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (var i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) { /* next */ }
    }
    return '';
  }

  /*
    导出入口：优先走「离线逐帧编码」。
    实时录制（MediaRecorder）只要页面被切到后台、或主线程卡一下，
    画布就会停止产帧，而音轨继续走 —— 成片里会出现几十秒的冻画面。
    离线编码按 1/fps 的固定步长渲染，帧数、时间戳都精确，且不受前后台影响。
  */
  function startExport() {
    if (!E.buffer) { toast('请先添加歌曲再导出'); return; }
    if (exporting) return;

    // 合规底线：导出前必须声明对素材拥有权利（平台要求 + 侵权风险隔离）
    if (els.rightsOk && !els.rightsOk.checked) {
      toast('请先勾选「我确认对所用音乐与素材拥有合法使用权利」');
      els.rightsOk.focus();
      return;
    }

    ensureAudio();

    // 体积目标下码率有限：由计划结果决定最终分辨率（避免高分辨率低码率发糊）
    var plan = planExport();
    if (state.sizeMode !== 'max' && plan.res !== state.res) {
      var want = plan.res;
      state.res = want;
      if (els.resSelect && els.resSelect.querySelector('option[value="' + want + '"]')) {
        els.resSelect.value = want;
      }
      updateStageBadge();
      toast('为把体积压进目标，已自动切换到 ' + (want === '540' ? '540p' : want + 'p'));
    }
    applyCanvasSize(state.res);
    plan = planExport();

    if (window.SFExport && SFExport.supported()) {
      startOfflineExport(plan);
      return;
    }
    startRealtimeExport(plan);
  }

  /* ---------- 离线渲染导出（WebCodecs）---------- */
  function startOfflineExport(plan) {
    exporting = true;
    offlineMode = true;
    offlineCancel = false;

    pause();
    E.offset = 0;
    updateTransport(0);
    lastActiveLine = -2;

    document.body.classList.add('is-exporting');
    els.progressWrap.hidden = false;
    els.btnCancel.hidden = false;
    els.resultCard.hidden = true;
    els.btnExport.disabled = true;
    els.btnExport.textContent = T('正在生成…');
    els.exportHint.textContent = '离线逐帧渲染：可以切到别的窗口，不会掉帧，也不会出现画面卡住。';
    setProgress(0, '准备编码器…');

    var t0 = Date.now();
    var done = false;

    SFExport.run({
      canvas: canvas,
      width: canvas.width,
      height: canvas.height,
      fps: plan.fps,
      duration: state.duration,
      videoBps: plan.video,
      audioBps: plan.audio,
      videoCodec: plan.codec === 'av01' ? 'av1' : 'avc',
      buffer: state.buffer,
      render: renderFrame,
      onProgress: function (pct, text) {
        if (!exporting || done) return;
        var sec = (Date.now() - t0) / 1000;
        setProgress(pct, text + (sec > 2 ? ' · 已用 ' + sec.toFixed(0) + 's' : ''));
      },
      isCancelled: function () { return offlineCancel || !exporting; }
    }).then(function (res) {
      if (!exporting) return;
      done = true;
      deliverBlob(new Blob([res.bytes], { type: 'video/mp4' }), 'video/mp4', res.frames);
    }).catch(function (err) {
      if (!exporting || done) return;
      done = true;
      if (err && err.name === 'AbortError') { cancelExport(); return; }
      // AV1 编码异常时关掉 AV1 通道，按 H.264 重新规划（会自动降到合适分辨率）再导
      if (plan && plan.codec === 'av01' && !plan._retried) {
        console.warn('[导出] AV1 编码失败，改用 H.264 重新规划：', err);
        state.av1Ok = false;
        offlineMode = false;
        exporting = false;
        resetExportUI();
        toast('AV1 编码不可用，已改用 H.264 并自动调整清晰度');
        startExport();
        return;
      }
      // 离线通道不可用（老浏览器 / 显卡编码器异常）时，退回实时录制，不让用户没法导出
      console.warn('[导出] 离线编码失败，回退实时录制：', err);
      offlineMode = false;
      exporting = false;
      resetExportUI();
      els.progressWrap.hidden = true;
      toast('离线编码不可用，已改用兼容模式录制');
      startExportRealtimeCompat(plan);
    });
  }

  function startExportRealtimeCompat(plan) {
    if (!window.MediaRecorder) {
      els.exportHint.textContent = '当前浏览器既不支持离线编码也不支持录制，请换 Chrome / Edge 最新版。';
      return;
    }
    startRealtimeExport(plan);
  }

  function startRealtimeExport(plan) {
    var mime = pickMime();
    if (!mime) { toast('当前浏览器不支持视频录制，请改用 Chrome 或 Edge'); return; }

    var cstream = canvas.captureStream(plan.fps);
    var tracks = cstream.getVideoTracks();
    var audioTracks = E.dest.stream.getAudioTracks();
    if (!audioTracks.length) { toast('音频轨道初始化失败，请重新载入歌曲'); return; }

    var stream = new MediaStream(tracks.concat(audioTracks));

    chunks = [];
    gotData = false;
    curMime = mime;

    try {
      rec = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: plan.video,
        audioBitsPerSecond: plan.audio
      });
    } catch (err) {
      toast('录制初始化失败：' + err.message);
      return;
    }

    rec.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) {
        chunks.push(ev.data);
        gotData = true;
      }
    };
    rec.onstop = finishExport;
    // 录制器本身报错（编码器异常）时立即停止，避免录满整首歌却拿到空文件
    rec.onerror = function (ev) {
      var msg = (ev && ev.error && ev.error.name) || '未知错误';
      failExport('录制器报错（' + msg + '），已中断。请重试，或把清晰度降到 720p。');
    };

    // 回到起点（导出期间 UI 是锁死的，所以直接操作引擎）
    stopSource();
    E.playing = false;
    E.offset = 0;
    updateTransport(0);

    offlineMode = false;
    exporting = true;
    document.body.classList.add('is-exporting');
    els.progressWrap.hidden = false;
    els.btnCancel.hidden = false;
    els.resultCard.hidden = true;
    els.btnExport.disabled = true;
    els.btnExport.textContent = '正在生成…';
    els.exportHint.textContent = '兼容模式录制中：请保持本页面在前台，切到其他标签页可能造成掉帧。';
    setProgress(0, '开始录制…');

    lastActiveLine = -2;
    try { rec.start(400); } catch (e) { cancelExport(); return; }

    // 兜底：正常 1 秒内就该有首包数据。10 秒还没有，说明编码器没工作
    // （常见于切到后台、显卡驱动异常、分辨率过高）。与其录满整首歌拿到空文件，
    // 不如立刻停下并给出可操作的提示。
    dataWatchdog = setTimeout(function () {
      if (exporting && !gotData) {
        failExport('录制没有取到任何画面数据，已中断。请保持页面在前台后重试；若仍失败，把清晰度切到 720p。');
      }
    }, 10000);

    play(0).then(function (ok) {
      if (!ok) cancelExport();
    });
  }

  function stopRecording() {
    if (dataWatchdog) { clearTimeout(dataWatchdog); dataWatchdog = null; }
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch (e) { /* ignore */ }
    }
  }

  function cancelExport() {
    offlineCancel = true;
    offlineMode = false;
    exporting = false;
    if (dataWatchdog) { clearTimeout(dataWatchdog); dataWatchdog = null; }
    if (rec) {
      rec.onstop = null;
      rec.onerror = null;
      try { rec.stop(); } catch (e) { /* ignore */ }
      rec = null;
    }
    chunks = [];
    gotData = false;
    pause();
    resetExportUI();
    els.progressWrap.hidden = true;
    els.exportHint.textContent = '已取消。可以调整画面后重新生成。';
    applyCanvasSize('preview');
  }

  // 导出失败：清状态 + 明确告知原因，绝不把空文件当成功结果给用户
  function failExport(message) {
    if (!exporting) return;
    cancelExport();
    els.resultCard.hidden = true;
    els.exportHint.textContent = message;
    toast(message);
  }

  function resetExportUI() {
    exporting = false;
    document.body.classList.remove('is-exporting');
    els.btnCancel.hidden = true;
    els.btnExport.disabled = false;
    els.btnExport.textContent = T('生成 MV 视频');
  }

  function finishExport() {
    if (dataWatchdog) { clearTimeout(dataWatchdog); dataWatchdog = null; }

    var type = (curMime || 'video/webm').split(';')[0];
    var blob = new Blob(chunks, { type: type });
    var empty = !gotData || blob.size < 4096;
    chunks = [];
    gotData = false;
    rec = null;

    // 空录制绝不能当成功：用户下载到一个打不开的文件比失败更糟
    if (empty) {
      failExport('视频编码失败，没有生成有效文件。请重试，或把清晰度切到 720p 再生成。');
      return;
    }
    deliverBlob(blob, type, 0);
  }

  /* 成片交付：离线编码与实时录制共用这一段 */
  function deliverBlob(blob, type, frames) {
    var empty = !blob || blob.size < 4096;
    if (empty) {
      failExport('视频编码失败，没有生成有效文件。请重试，或把清晰度切到 720p 再生成。');
      return;
    }

    var ext = (type || '').indexOf('mp4') > -1 ? 'mp4' : 'webm';
    var name = safeName(state.title || 'MV') + '-MV.' + ext;

    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(blob);

    els.resultVideo.src = exportUrl;
    els.resultName.textContent = name;
    els.resultSize.textContent = (blob.size / 1048576).toFixed(1) + ' MB · ' + fmt(state.duration) + ' · ' + state.ratio;
    els.downloadLink.href = exportUrl;
    els.downloadLink.download = name;
    els.resultCard.hidden = false;

    resetExportUI();
    els.progressWrap.hidden = true;
    els.exportHint.textContent = '生成完成。如果歌词时间有偏差，用第 2 步的“整体时间微调”改好后重新生成。';
    applyCanvasSize('preview');
    toast('视频已生成，点击「下载视频」保存');
  }

  function setProgress(pct, text) {
    els.progressBar.style.width = clamp(pct, 0, 100).toFixed(1) + '%';
    els.progressText.textContent = T(text);
  }

  function updateExportProgress(t) {
    var pct = state.duration ? clamp(t / state.duration, 0, 1) : 0;
    setProgress(pct * 100, '正在录制 ' + fmt(t) + ' / ' + fmt(state.duration) + ' · ' + Math.round(pct * 100) + '%');
  }

  function exportFrame() {
    ensureAudio();
    applyCanvasSize(state.res);
    MV.render(currentTime(), null, syncView());
    canvas.toBlob(function (blob) {
      if (!blob) { toast('画面导出失败'); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = safeName(state.title || 'MV') + '-画面.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        URL.revokeObjectURL(url);
        applyCanvasSize('preview');
      }, 800);
      toast('已导出当前画面');
    }, 'image/png');
  }

  /* ================= AI 背景（AI 绘图 + 本地构图）================= */
  function sceneSourceText() {
    return [
      state.title || '',
      state.artist || '',
      els.lyricsText.value || ''
    ].join('\n');
  }

  // 内容指纹 → 种子：同样的歌名+歌词得到同样的场景；改了歌词场景就跟着换
  function contentSeed() {
    var s = sceneSourceText();
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 1000000000;
  }

  // 歌词 / 歌名变化后，AI 背景模式下自动重新生成（防抖，避免打字过程频繁请求）
  var sceneRegenTimer = null;
  function scheduleSceneFollow() {
    if (state.bgMode !== 'ai' || !window.Scene) return;
    clearTimeout(sceneRegenTimer);
    sceneRegenTimer = setTimeout(function () {
      if (state.bgMode !== 'ai' || !window.Scene) return;
      var seed = contentSeed();
      // 内容没变（或刚按这份内容生成过）就不重复生成
      if (state.sceneCanvas && state.sceneSeed === seed) return;
      generateScene({ seed: seed });
    }, 1500);
  }

  var sceneGenToken = 0;     // 递增令牌：只采纳最后一次生成的结果
  var lastAiGenAt = 0;       // 上一次发起 AI 绘图的时间（免费限额每 45 秒 1 张）
  var sceneCache = {};       // 类型|比例|种子 → canvas，切比例/类型来回切换不会丢图

  // 当前场景类型：'auto'（按歌词归类）/ 'landscape' / 'people' / 'city'
  function aiSceneType() { return state.aiSceneType || 'auto'; }

  function sceneCacheKey(seed, ratio) { return aiSceneType() + '|' + (ratio || '16:9') + '|' + seed; }

  function generateScene(opts) {
    opts = opts || {};
    if (!window.Scene) { toast('背景模块未加载，请刷新页面重试'); return; }
    var token = ++sceneGenToken;
    var seed = (typeof opts.seed === 'number' && opts.seed)
      ? (opts.seed >>> 0)
      : ((Date.now() % 1000000) * 1000 + Math.floor(Math.random() * 1000)) >>> 0;
    var reqRatio = state.ratio;   // 锁定本次请求的比例（生成期间用户可能已切换）

    els.btnSceneGen.disabled = true;
    els.scenePanel.hidden = false;
    els.bgUpload.hidden = true;
    els.sceneName.textContent = T('AI 绘图中…');
    els.btnSceneGen.textContent = 'AI 绘图中…';

    // 手上还没有背景图时：先切到纯色底（plainBg，不叠歌名大字），
    // 避免生成期间出现“缺省的渐变 + 歌名文字”画面
    if (!state.sceneCanvas) {
      state.bgMode = 'ai';
      state.bgFailed = true;
      $$('#bgGroup .seg__btn').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.bg === 'ai');
      });
    }

    var applyResult = function (canvas, desc, fromCache) {
      state.sceneCanvas = canvas;
      state.sceneName = 'AI 绘图';
      state.sceneKeywords = [];
      state.sceneSeed = seed;
      state.bgMode = 'ai';
      state.bgFailed = false;
      sceneCache[sceneCacheKey(seed, reqRatio)] = canvas;   // 同一比例可复用，换比例不丢图

      els.sceneName.textContent = T('AI 绘图');
      els.sceneTags.textContent = T(desc || '');
      $$('#bgGroup .seg__btn').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.bg === 'ai');
      });
      els.btnSceneGen.disabled = false;
      els.btnSceneGen.textContent = '↻ 重新生成';
      if (fromCache) toast('已恢复这张背景图');
    };

    // 失败处理：有旧图就保留旧图；一张都没有时用纯色底（不叠歌名文字），绝不出现“颜色+文字”画面
    var failOver = function (why) {
      if (token !== sceneGenToken) return;
      els.btnSceneGen.disabled = false;
      els.btnSceneGen.textContent = '↻ 重新生成';
      if (state.sceneCanvas) {
        els.sceneName.textContent = T('AI 绘图');
        els.sceneTags.textContent = T('本次更新失败，仍显示上一张');
        toast('背景更新失败（' + why + '），仍显示上一张');
      } else {
        state.bgMode = 'ai';
        state.bgFailed = true;
        els.sceneName.textContent = T('生成失败');
        els.sceneTags.textContent = why + ' · 点击“重新生成”重试';
        toast('AI 绘图失败（' + why + '），请稍后点“重新生成”');
      }
    };

    // 命中缓存（同一类型 + 同一内容 + 同一比例）：直接复用，省一次网络与额度
    var cached = sceneCache[sceneCacheKey(seed, reqRatio)];
    if (cached) {
      setTimeout(function () {
        if (token !== sceneGenToken) return;
        var t = aiSceneType() === 'auto' ? (Scene.detectAiType ? Scene.detectAiType(sceneSourceText()) : 'landscape') : aiSceneType();
        applyResult(cached, (state.title ? '《' + state.title + '》' : '') + 'AI 场景 · ' + (Scene.aiTypeLabel ? Scene.aiTypeLabel(t) : '') + '（缓存）', true);
      }, 30);
      return;
    }

    // 免费额度排队：每 45 秒 1 张，不到时间就等
    var wait = Math.max(0, Scene.AI_COOLDOWN_MS - (Date.now() - lastAiGenAt));
    if (wait > 0) {
      els.sceneTags.textContent = '免费绘图额度排队中，' + Math.ceil(wait / 1000) + ' 秒后开始生成…';
    } else {
      els.sceneTags.textContent = '正在根据歌词生成场景，约 10~60 秒，请稍候';
    }

    setTimeout(function () {
      if (token !== sceneGenToken) return;
      lastAiGenAt = Date.now();
      Scene.genImage({ text: sceneSourceText(), seed: seed, ratio: reqRatio, sceneType: aiSceneType() })
        .then(function (r) {
          if (token !== sceneGenToken) return;
          applyResult(r.canvas,
            (state.title ? '《' + state.title + '》' : '') + 'AI 场景 · ' + (r.typeLabel || '') +
            (aiSceneType() === 'auto' ? '（按歌词自动归类）' : '') + ' · 换一张请点重新生成');
        })
        .catch(function (err) { failOver(err.message || '网络异常'); });
    }, wait);
  }

  function saveScene() {
    var src = state.sceneCanvas;
    if (!src) { toast('先生成一张背景图'); return; }
    // AI 绘图是 HTMLImageElement，先画到临时画布再导出 PNG
    var target = src;
    if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
      target = document.createElement('canvas');
      target.width = src.naturalWidth;
      target.height = src.naturalHeight;
      target.getContext('2d').drawImage(src, 0, 0);
    }
    target.toBlob(function (blob) {
      if (!blob) { toast('保存失败'); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = safeName(state.title || 'MV') + '-背景-' + safeName(state.sceneName || '') + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      toast('背景图已保存');
    }, 'image/png');
  }

  /* ================= 示例素材 ================= */
  function buildDemoBuffer() {
    var dur = 18;
    var sr = E.ctx.sampleRate;
    var buf = E.ctx.createBuffer(1, Math.floor(dur * sr), sr);
    var d = buf.getChannelData(0);
    var chords = [
      [261.63, 329.63, 392.00],
      [196.00, 246.94, 293.66],
      [220.00, 261.63, 329.63],
      [174.61, 220.00, 261.63]
    ];

    for (var i = 0; i < d.length; i++) {
      var t = i / sr;
      var bar = Math.floor(t / 4) % 4;
      var chord = chords[bar];
      var v = 0;

      for (var k = 0; k < chord.length; k++) {
        v += Math.sin(2 * Math.PI * chord[k] * t + k) * 0.07 * (0.65 + 0.35 * Math.sin(2 * Math.PI * 0.5 * t));
      }
      v += Math.sin(2 * Math.PI * (chord[0] / 2) * t) * 0.13;

      var beat = t % 0.5;
      v += Math.sin(2 * Math.PI * 62 * beat) * Math.exp(-beat * 15) * 0.45;

      var hat = (t + 0.25) % 0.5;
      v += (Math.random() * 2 - 1) * Math.exp(-hat * 65) * 0.1;

      var env = Math.min(1, t / 0.5) * Math.min(1, (dur - t) / 1.2);
      d[i] = Math.tanh(v * env) * 0.92;
    }
    return buf;
  }

  function loadDemo() {
    ensureAudio();
    if (E.ctx.state === 'suspended') E.ctx.resume();

    var buf = buildDemoBuffer();
    finishLoad(buf, { title: T('示例 · 夜行城市'), artist: 'SonicFrame Demo' }, { name: 'demo.mp3', size: buf.length * 2 });

    els.lyricsText.value = [
      '[00:01.00]城市在耳机里慢慢展开',
      '[00:05.20]把心跳交给这一段节拍',
      '[00:09.40]灯光沿着天桥滑下来',
      '[00:13.60]我们正好路过人海',
      '[00:17.00]再唱一遍就不算离开'
    ].join('\n');

    rebuildLyrics();
    toast('示例已载入，点播放看看效果');
  }

  /* 动态文案翻译：中文原文 → 当前语言（i18n.js 提供 tr） */
  function T(s) { return (window.SFI18N && SFI18N.tr) ? SFI18N.tr(s) : s; }

  /* ================= Toast ================= */
  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = T(msg);
    els.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('is-show');
    }, 3200);
  }

  /* ================= 绑定 ================= */
  function bind() {
    // 上传音频
    els.dropzone.addEventListener('click', function () { els.fileInput.click(); });
    els.dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
    });
    els.fileInput.addEventListener('change', function () {
      if (this.files && this.files[0]) loadAudio(this.files[0]);
      this.value = '';
    });
    els.btnReplace.addEventListener('click', function () { els.fileInput.click(); });

    ['dragenter', 'dragover'].forEach(function (type) {
      els.dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        els.dropzone.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      els.dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        els.dropzone.classList.remove('is-over');
      });
    });
    els.dropzone.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadAudio(f);
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    els.btnDemo.addEventListener('click', loadDemo);

    // 元信息
    els.titleInput.addEventListener('input', function () {
      state.title = this.value.trim();
      if (state.buffer) els.trackName.textContent = state.title || '未命名';
      scheduleSceneFollow();  // 歌名也是场景的依据，改了要跟着换
    });
    els.artistInput.addEventListener('input', function () {
      state.artist = this.value.trim();
    });

    // 歌词
    var timer = null;
    els.lyricsText.addEventListener('input', function () {
      state.lyricsSource = 'manual';   // 用户手输：自动填词不得覆盖
      clearTimeout(timer);
      timer = setTimeout(rebuildLyrics, 320);
    });
    els.btnLyricFile.addEventListener('click', function () { els.lyricFile.click(); });
    els.btnLyricOnline.addEventListener('click', function () {
      fetchOnlineLyrics({ force: true });   // 手动点按钮 = 明确要覆盖当前内容
    });
    els.lyricFile.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        els.lyricsText.value = String(r.result || '');
        rebuildLyrics();
        toast('歌词已导入（' + state.lines.length + ' 行）');
      };
      r.readAsText(f, 'utf-8');
      this.value = '';
    });
    els.btnLyricClear.addEventListener('click', function () {
      els.lyricsText.value = '';
      rebuildLyrics();
    });
    els.offsetRange.addEventListener('input', function () {
      state.offset = parseFloat(this.value) || 0;
      els.offsetVal.textContent = (state.offset > 0 ? '+' : '') + state.offset.toFixed(1) + 's';
      rebuildLyrics();
    });

    // 比例
    $$('#ratioGroup .seg__btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('#ratioGroup .seg__btn').forEach(function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        state.ratio = btn.dataset.ratio;
        applyCanvasSize('preview');
        updateStageBadge();
        updateFlow();
        // 换比例保留当前背景图（裁剪自适应）；需要按新比例重绘时点“重新生成”
        if (state.bgMode === 'ai' && state.sceneCanvas) {
          toast('已保留当前背景图；需要按新比例重绘请点“重新生成”');
        }
      });
    });

    // 背景来源
    $$('#bgGroup .seg__btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mode = btn.dataset.bg;
        $$('#bgGroup .seg__btn').forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        state.bgMode = mode;
        els.bgUpload.hidden = mode !== 'image';

        if (mode === 'ai') {
          els.scenePanel.hidden = false;
          if (!state.sceneCanvas) {
            generateScene();
          } else {
            els.sceneName.textContent = state.sceneName || 'AI 背景';
            els.sceneTags.textContent = state.sceneKeywords.length
              ? state.sceneKeywords.slice(0, 3).join(' · ')
              : '已生成';
          }
        } else {
          els.scenePanel.hidden = true;
        }

        if (mode === 'cover' && !state.coverImg) {
          toast('这首歌没有内嵌封面，可以用“AI 背景”或上传图片');
        }
      });
    });

    els.btnSceneGen.addEventListener('click', function () { generateScene(); });
    els.btnSceneSave.addEventListener('click', saveScene);

    // AI 场景类型：自动 / 风景 / 人物 / 城市 —— 切换后立即按新类型重生成
    if (els.sceneTypeGroup) {
      els.sceneTypeGroup.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-stype]');
        if (!btn) return;
        var type = btn.dataset.stype;
        if (type === aiSceneType()) return;
        state.aiSceneType = type;
        $$('#sceneTypeGroup .seg__btn').forEach(function (b) {
          b.classList.toggle('is-active', b.dataset.stype === type);
        });
        if (state.bgMode === 'ai') generateScene({ seed: contentSeed() });
      });
    }

    els.btnBgPick.addEventListener('click', function () { els.bgFile.click(); });
    els.bgFile.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var url = URL.createObjectURL(f);
      var im = new Image();
      im.onload = function () {
        state.bgImg = im;
        els.bgName.textContent = f.name;
        state.bgMode = 'image';
        $$('#bgGroup .seg__btn').forEach(function (b) {
          b.classList.toggle('is-active', b.dataset.bg === 'image');
        });
        els.bgUpload.hidden = false;
        toast('背景图已更新');
      };
      im.onerror = function () { toast('这张图片无法读取，换个 JPG / PNG 试试'); };
      im.src = url;
      this.value = '';
    });

    // 开关
    els.optTitle.addEventListener('change', function () { state.options.title = this.checked; });
    els.optBars.addEventListener('change', function () { state.options.bars = this.checked; });
    els.optProgress.addEventListener('change', function () { state.options.progress = this.checked; });
    els.optBrand.addEventListener('change', function () { state.options.brand = this.checked; });

    // 草稿自动保存：任何设置变化落盘（刷新/关闭浏览器后自动恢复）
    [els.titleInput, els.artistInput, els.lyricsText, els.fontRange, els.offsetRange,
      els.resSelect, els.sizeSelect, els.optTitle, els.optBars, els.optProgress, els.optBrand
    ].forEach(function (el) {
      if (!el) return;
      el.addEventListener('change', scheduleSaveDraft);
      el.addEventListener('input', scheduleSaveDraft);
    });
    [els.ratioGroup, els.bgGroup, els.sceneTypeGroup].forEach(function (grp) {
      if (grp) grp.addEventListener('click', scheduleSaveDraft);
    });

    // 版权声明：勾选状态也记住，避免每次导出都要重勾
    if (els.rightsOk) {
      els.rightsOk.addEventListener('change', function () {
        try { localStorage.setItem('sf-rights-ok', this.checked ? '1' : '0'); } catch (e) { /* ignore */ }
        scheduleSaveDraft();
      });
      try { els.rightsOk.checked = localStorage.getItem('sf-rights-ok') === '1'; } catch (e) { /* ignore */ }
    }

    els.fontRange.addEventListener('input', function () {
      state.fontScale = parseInt(this.value, 10) / 100;
      els.fontVal.textContent = this.value + '%';
    });

    // 播放
    els.btnPlay.addEventListener('click', togglePlay);
    els.seek.addEventListener('input', function () {
      if (!state.duration) return;
      seekTo(parseFloat(this.value) / 1000 * state.duration);
    });

    // 导出
    els.btnExport.addEventListener('click', startExport);
    els.btnTopExport.addEventListener('click', startExport);
    els.btnPng.addEventListener('click', exportFrame);
    els.btnCancel.addEventListener('click', cancelExport);
    els.resSelect.addEventListener('change', function () {
      state.res = this.value;
      updateStageBadge();
      updateSizeHint();
    });
    els.sizeSelect.addEventListener('change', function () {
      state.sizeMode = this.value;
      updateSizeHint();
    });

    // 弹窗
    var navFaq = document.getElementById('navFaq');
    if (navFaq) navFaq.addEventListener('click', function (e) { e.preventDefault(); els.helpDialog.showModal(); });

    els.btnHelp.addEventListener('click', function () { els.helpDialog.showModal(); });

    // 快捷键：空格播放 / 暂停
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    });

    window.addEventListener('beforeunload', function (e) {
      if (exporting) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ================= 初始化 ================= */
  function init() {
    canvas = $('#mv');
    MV.init(canvas);

    els = {
      dropzone: $('#dropzone'),
      fileInput: $('#fileInput'),
      trackCard: $('#trackCard'),
      trackCover: $('#trackCover'),
      trackCoverFallback: $('#trackCoverFallback'),
      trackName: $('#trackName'),
      trackInfo: $('#trackInfo'),
      btnReplace: $('#btnReplace'),
      btnDemo: $('#btnDemo'),
      titleInput: $('#titleInput'),
      artistInput: $('#artistInput'),
      lyricsText: $('#lyricsText'),
      lyricFile: $('#lyricFile'),
      btnLyricFile: $('#btnLyricFile'),
      btnLyricOnline: $('#btnLyricOnline'),
      btnLyricClear: $('#btnLyricClear'),
      lyricList: $('#lyricList'),
      lyricBadge: $('#lyricBadge'),
      lyricCleanHint: $('#lyricCleanHint'),
      audioBadge: $('#audioBadge'),
      offsetRange: $('#offsetRange'),
      offsetVal: $('#offsetVal'),
      ratioGroup: $('#ratioGroup'),
      bgGroup: $('#bgGroup'),
      bgUpload: $('#bgUpload'),
      bgFile: $('#bgFile'),
      btnBgPick: $('#btnBgPick'),
      bgName: $('#bgName'),
      scenePanel: $('#scenePanel'),
      sceneName: $('#sceneName'),
      sceneTags: $('#sceneTags'),
      btnSceneGen: $('#btnSceneGen'),
      btnSceneSave: $('#btnSceneSave'),
      sceneTypeGroup: $('#sceneTypeGroup'),
      sizeSelect: $('#sizeSelect'),
      sizeHint: $('#sizeHint'),
      themeGroup: $('#themeGroup'),
      optTitle: $('#optTitle'),
      optBars: $('#optBars'),
      optProgress: $('#optProgress'),
      optBrand: $('#optBrand'),
      rightsOk: $('#rightsOk'),
      fontRange: $('#fontRange'),
      fontVal: $('#fontVal'),
      stageBadge: $('#stageBadge'),
      stageMode: $('#stageMode'),
      btnPlay: $('#btnPlay'),
      seek: $('#seek'),
      seekWrap: $('#seekWrap'),
      timeNow: $('#timeNow'),
      timeTotal: $('#timeTotal'),
      btnExport: $('#btnExport'),
      btnTopExport: $('#btnTopExport'),
      btnPng: $('#btnPng'),
      btnCancel: $('#btnCancel'),
      resSelect: $('#resSelect'),
      progressWrap: $('#progressWrap'),
      progressBar: $('#progressBar'),
      progressText: $('#progressText'),
      exportHint: $('#exportHint'),
      resultCard: $('#resultCard'),
      resultVideo: $('#resultVideo'),
      resultName: $('#resultName'),
      resultSize: $('#resultSize'),
      downloadLink: $('#downloadLink'),
      helpDialog: $('#helpDialog'),
      btnHelp: $('#btnHelp'),
      flowAudio: $('#flowAudio'),
      flowLyric: $('#flowLyric'),
      flowStyle: $('#flowStyle'),
      toast: $('#toast')
    };

    // 配色按钮
    Object.keys(MV.THEMES).forEach(function (key) {
      var th = MV.THEMES[key];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-btn' + (key === state.theme ? ' is-active' : '');
      btn.dataset.theme = key;
      btn.style.setProperty('--a', th.accent);
      btn.style.setProperty('--b', th.accent2);
      btn.innerHTML = '<i aria-hidden="true"></i>' + T(th.name);
      btn.addEventListener('click', function () {
        state.theme = key;
        $$('.theme-btn').forEach(function (b) { b.classList.toggle('is-active', b.dataset.theme === key); });
        syncView();
        scheduleSaveDraft();
      });
      els.themeGroup.appendChild(btn);
    });

    // 「封面取色」：从歌曲内嵌封面自动提主色当强调色（提取失败自动回墨黑）
    var autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'theme-btn theme-btn--auto' + (state.theme === 'auto' ? ' is-active' : '');
    autoBtn.dataset.theme = 'auto';
    autoBtn.title = '从歌曲封面自动提取主色';
    autoBtn.style.setProperty('--a', '#9aa0b4');
    autoBtn.style.setProperty('--b', '#e2e6f0');
    autoBtn.innerHTML = '<i aria-hidden="true"></i>封面取色';
    autoBtn.addEventListener('click', function () {
      if (!state.coverImg) {
        toast('这首歌没有内嵌封面，无法取色；先换一首带封面的歌');
        return;
      }
      if (!state.accentColor) {
        var acc = extractAccent(state.coverImg);
        state.accentColor = acc ? acc.accent : null;
        state.accent2Color = acc ? acc.accent2 : null;
      }
      if (!state.accentColor) {
        toast('这张封面几乎是黑白灰，取不出主色，请换其它配色');
        return;
      }
      state.theme = 'auto';
      $$('.theme-btn').forEach(function (b) { b.classList.toggle('is-active', b.dataset.theme === 'auto'); });
      syncView();
      toast('已按封面主色生成强调色');
      scheduleSaveDraft();
    });
    els.themeGroup.appendChild(autoBtn);

    refreshAutoThemeBtn = function () {
      autoBtn.style.opacity = state.coverImg ? '1' : '0.45';
    };

    // 语言切换后，把"跟随运行状态"的动态文案按当前状态重写一遍
    window.__sfLangRefresh = function () {
      els.audioBadge.textContent = E.buffer ? T('已载入') : T('必填');
      els.stageMode.textContent = E.buffer ? T('实际预览') : T('示例预览');
      els.btnExport.textContent = exporting ? T('正在生成…') : T('生成 MV 视频');
      updateSizeHint();
      rebuildLyrics();   // 会重写 lyricBadge
    };

    bind();
    window.__sfState = state;   // 调试 / 自动化测试钩子
    window.__sfRender = renderFrame;
    window.__sfPlan = planExport;

    // 恢复上次草稿（设置与歌词；音频文件需要重新选择）
    if (restoreDraft()) {
      rebuildLyrics();
      setTimeout(function () {
        toast('已恢复上次草稿（歌词与设置），重新选择歌曲文件即可继续');
      }, 4000);
    }

    // AV1 编码能力探测：决定「1080p + 小体积」模式是否可用（异步，探测完刷新提示）
    if (window.SFExport && SFExport.supported()) {
      SFExport.av1Supported().then(function (ok) {
        state.av1Ok = ok;
        updateSizeHint();
      });
    }

    applyCanvasSize('preview');
    updateStageBadge();
    updateFlow();
    updateSizeHint();
    els.btnPlay.disabled = true;

    // 给新手一点引导
    toast('三步：加歌曲 → 加歌词 → 选画面，然后点“生成 MV 视频”');

    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
