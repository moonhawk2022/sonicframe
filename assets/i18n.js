/*
  SonicFrame 双语支持（默认英文 / 默认 EN，可一键切中文）
  · 静态文案：HTML 里 data-i18n="key"（中文为源），这里维护英文版
  · 占位符：data-i18n-ph="key"
  · 动态文案（app.js 的 toast / 徽标 / 进度）：tr() 按「中文原文→英文」映射，
    按 ' · ' 分段翻译，含《》书名号的片段做轻量规则处理
  · 语言存 localStorage('sf-lang')，默认 'en'
*/
window.SFI18N = (function () {
  'use strict';

  var EN = {
    /* 品牌 / 导航 */
    brandName: 'SonicFrame',
    brandSub: 'AI Music Video Studio',
    navSong: 'Song',
    navLyrics: 'Lyrics',
    navStyle: 'Style',
    navExport: 'Export',
    navFaq: 'FAQ',
    flowAudio: 'Song',
    flowLyric: 'Lyrics',
    flowStyle: 'Style',
    btnHelp: 'Guide',
    btnTopExport: 'Export MV',

    /* Step 1 */
    s1Title: 'Add your song',
    dzTitle: 'Drop an audio file, or click to browse',
    dzSub: 'MP3 / WAV / M4A / FLAC / OGG · Auto-reads title, cover & lyrics',
    btnReplace: 'Replace',
    fTitle: 'Song title',
    fArtist: 'Artist',
    phAuto: 'Auto-read, editable',
    btnDemo: 'No files? Try the built-in demo',
    privacyHint: 'Audio is decoded locally in your browser — never uploaded to any server.',

    /* Step 2 */
    s2Title: 'Add lyrics',
    s2Desc: 'Embedded lyrics are read from the file automatically; if none, we <b>match lyrics online</b> (by title + duration). You can also paste plain lyrics for auto timing. Use “Offset” if lyrics run early or late.',
    phLyrics: '[00:12.00]First line\n[00:16.50]Second line\n\nPlain text without timestamps also works',
    btnLyricOnline: 'Find lyrics online',
    btnLyricFile: 'Upload .lrc / .txt',
    btnClear: 'Clear',
    offsetLabel: 'Timing offset',
    offsetHint: 'Lyrics early? Drag “+”. Late? Drag “−”.',

    /* Step 3 */
    s3Title: 'Visual style',
    fRatio: 'Aspect ratio',
    rLand: 'Landscape',
    rPort: 'Portrait',
    rSq: 'Square',
    r45: 'RED',
    fBg: 'Background',
    bgCover: 'Cover art',
    bgAi: 'AI scene',
    bgImage: 'Custom image',
    bgGrad: 'Gradient',
    sceneType: 'Scene type',
    stAuto: 'Auto',
    stLand: 'Nature',
    stPeople: 'People',
    stCity: 'City',
    btnSceneGen: '↻ Regenerate',
    btnSceneSave: 'Save this image',
    sceneHint: 'Scenes are classified into Nature / People / City from your lyrics (or pick manually). Prompts include album-cover quality guidance and auto music-style matching. Free generation via pollinations.ai (~10–60s each, 1 per 45s, auto-queued); backgrounds follow lyric edits. People are drawn as back views / silhouettes for a cinematic feel.',
    btnBgPick: 'Choose image',

    fTheme: 'Color theme',
    optTitle: 'Title & artist',
    optBars: 'Audio bars',
    optProgress: 'Progress bar',
    optBrand: 'Brand mark',
    fontLabel: 'Lyric size',

    /* 预览 / 导出 */
    preview: 'Preview',
    quality: 'Quality',
    res540: '540p (min)',
    sizeLabel: 'Size',
    sizeAuto: '≤10MB (recommended for shorts)',
    sizeMax: 'Best quality',
    btnExport: 'Generate MV',
    btnPng: 'Export frame',
    btnCancel: 'Cancel',
    rights: 'I confirm I own the legal rights to the music and materials used, and I have read the <a href="https://www.workbuddy.cn" target="_blank" rel="noopener" style="color:inherit">Terms</a> (processed locally only; copyright claims: support@sonicframe.app)',
    exportHint: 'Offline frame-by-frame rendering: every frame is precisely generated — no freezing, unaffected by tab switching. Time depends on your computer.',
    btnDownload: 'Download video',

    /* 页脚 */
    foot1: 'SonicFrame · AI Music Video Studio',
    foot2: 'Decoding, rendering and encoding all happen in your browser. No uploads.',

    /* 首屏动态初始值 */
    bRequired: 'Required', bAligned: 'Auto-aligned', bPainting: 'AI painting…',
    bNone: 'None', bDemoPreview: 'Demo preview', bPreparing: 'Preparing…',
    bSizeHint: 'Estimated size ≈ -- MB', bUntitled: 'Untitled',

    /* 使用指南 */
    helpTitle: 'Create your first MV in 3 steps',
    helpStep1: '<b>Add a song</b>: MP3 / WAV / M4A / FLAC / OGG supported. Title, artist, embedded cover and <b>embedded lyrics</b> are read automatically (most files from music services have them); loudness is normalized to −14 LUFS.',
    helpStep2: '<b>Add lyrics</b>: embedded lyrics fill in automatically; otherwise we <b>match online</b> (closest by title + duration). You can also click “Find lyrics online”, paste plain text, or upload an LRC for frame-accurate sync. Use “Timing offset” if things run early or late.',
    helpStep3: '<b>Style it</b>: pick a ratio (9:16 for TikTok/Reels, 16:9 for YouTube), a color theme, then hit “Generate MV”.',
    helpFaq: 'FAQ',
    faq1q: 'Can I post the exported video straight to TikTok?',
    faq1a: 'Yes. Default export is MP4 (H.264 + AAC) — supported by TikTok, Reels, RED and YouTube. Size is capped at 10MB by default (bitrate auto-computed from duration; quality auto-steps down when needed). Choose ≤30MB / ≤60MB for longer songs.',
    faq2q: 'Export stuttering or corrupted frames?',
    faq2a: 'Realtime recording is performance-sensitive. Try 720p, close other GPU-heavy tabs, and keep this page in the foreground.',
    faq3q: 'Lyrics out of sync?',
    faq3a: 'Make sure it is LRC (with [00:12.00] timestamps). Plain text can only estimate by character count — for fast, dense songs an LRC is recommended.'
  };

  /* 动态文案（app.js）：中文原文 → 英文。tr() 按 ' · ' 分段查表。 */
  var ZH2EN = {
    '必填': 'Required', '可选': 'Optional', '自动对齐': 'Auto-aligned', '已识别 LRC': 'LRC detected',
    '等待歌曲': 'Waiting for song', '已载入': 'Loaded', '实际预览': 'Live preview', '示例预览': 'Demo preview',
    '准备中…': 'Preparing…', '正在生成…': 'Generating…', '取消': 'Cancel',
    '生成 MV 视频': 'Generate MV',
    'AI 绘图中…': 'AI painting…', 'AI 绘图': 'AI scene', '生成失败': 'Generation failed',
    '本次更新失败，仍显示上一张': 'Update failed — keeping previous image',
    '预计文件大小：载入歌曲后显示': 'Estimated size: load a song first',
    '目标 ≤10MB': 'target ≤10MB', '目标 ≤30MB': 'target ≤30MB', '目标 ≤60MB': 'target ≤60MB', '高画质': 'Best quality',
    '准备编码器…': 'Preparing encoder…', '开始录制…': 'Starting recording…',
    'MV.mp4': 'MV.mp4',
    '已导出当前画面': 'Frame exported',
    '示例已载入，点播放看看效果': 'Demo loaded — press play to preview',
    '请先添加歌曲再导出': 'Add a song first',
    '正在联网匹配歌词…': 'Matching lyrics online…',
    '文件内没有歌词，请在第 2 步粘贴': 'No lyrics in file — paste them in step 2',
    '未读到封面，已生成 AI 背景': 'No cover found — AI background generated',
    '音量已标准化': 'Loudness normalized',
    '已从音乐文件读取歌词': 'Lyrics read from file',
    /* 主题名（renderer THEMES）与场景类型 */
    '墨黑': 'Ink', '霓虹紫': 'Neon', '落日橙': 'Sunset', '电光青': 'Teal',
    '樱粉': 'Rose', '胶片': 'Film', '深海蓝': 'Deep Sea', '薄荷': 'Mint',
    '鎏金': 'Gold', '极简白': 'Mono', '封面取色': 'Cover Colors',
    '自动': 'Auto', '风景': 'Nature', '人物': 'People', '城市风景': 'City', '城市': 'City',
    '歌曲较长，已用最低码率': 'long song — minimum bitrate applied',
    /* 画布空闲演示文案 */
    '你的歌曲名称': 'Your Song Title', '歌手 · Artist': 'Artist · Artist Name',
    '上传歌曲与歌词': 'Drop in a song & lyrics',
    '自动生成滚动歌词 MV': 'Auto-generate a lyric MV',
    '音频律动柱跟随节拍起伏': 'Audio bars dance to the beat',
    '支持 16:9 / 9:16 / 1:1 / 4:5': '16:9 / 9:16 / 1:1 / 4:5 supported',
    '封面自动推镜 · 一键导出': 'Auto cover zoom · one-click export',
    '本地渲染，文件不上传': 'Rendered locally — no uploads',
    '从左侧第 1 步开始 →': 'Start from step 1 ←',
    '示例 · 夜行城市': 'Demo · Night City',
    '三步：加歌曲 → 加歌词 → 选画面，然后点“生成 MV 视频”': '3 steps: song → lyrics → style, then hit “Generate MV”'
  };

  /* 正则规则：处理含动态内容的组合消息 */
  var RULES = [
    [/^已载入《(.+)》$/, 'Loaded “$1”'],
    [/^已联网匹配歌词：《(.+)》· (.+)（带时间轴，(\d+) 行）— 如对不上可自行调整$/, 'Matched lyrics: “$1” by $2 (synced, $3 lines) — adjust if needed'],
    [/^已联网匹配歌词：《(.+)》· (.+)（纯文本，(\d+) 行）— 如对不上可自行调整$/, 'Matched lyrics: “$1” by $2 (plain, $3 lines) — adjust if needed'],
    [/^歌词库没找到《(.+)》，可手动粘贴歌词$/, 'Lyrics not found for “$1” — paste manually'],
    [/^先填写歌名（第 1 步），再联网找歌词$/, 'Enter a song title (step 1) first, then search online'],
    [/^已自动填入文件内嵌歌词/, 'Embedded lyrics filled from file'],
    [/^音量已标准化 \+ (.+)$/, 'Loudness normalized +$1dB'],
    [/^音量已标准化 − (.+)$/, 'Loudness normalized −$1dB'],
    [/^为把体积压进目标，已自动切换到 (.+)$/, 'Switched to $1 to fit the size target'],
    [/^离线编码不可用，已改用兼容模式录制$/, 'Offline encoding unavailable — switched to compatibility recording'],
    [/^视频编码失败，没有生成有效文件。请重试，或把清晰度切到 720p 再生成。$/, 'Video encoding failed and produced no valid file. Please retry, or set quality to 720p.'],
    [/^渲染画面 (.+)%（(\d+)\/(\d+)）$/, 'Rendering $1% ($2/$3 frames)'],
    [/^正在录制 (.+) · (\d+)%$/, 'Recording $1 · $2%'],
    [/^预计 ≈ ([\d.]+) MB（(.+)）$/, 'Est. ~$1 MB ($2)'],
    [/^视频 ([\d.]+) Mbps$/, 'video $1 Mbps'],
    [/^音频 (\d+) kbps$/, 'audio $1 kbps'],
    [/^([^\d]*)(\d+)×(\d+) \/ (\d+)fps$/, '$1$2×$3 / $4fps']
  ];

  function trOne(part) {
    if (ZH2EN.hasOwnProperty(part)) return ZH2EN[part];
    // 组合片段：'音量已标准化 + 3.2dB' 之类在 ZH2EN 只有前缀时
    for (var k in ZH2EN) {
      if (part.indexOf(k) === 0 && k.length > 3) {
        return ZH2EN[k] + part.slice(k.length);
      }
    }
    // 《x》 → “x”
    var m = part.match(/^([^《]*?)《([^》]+)》(.*)$/);
    if (m) return m[1] + '“' + m[2] + '”' + m[3];
    return part;
  }

  function tr(msg) {
    if (!msg) return msg;
    var s = String(msg);
    if (cur !== 'en') return s;
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(s)) return s.replace(RULES[i][0], RULES[i][1]);
    }
    // 无 ' · ' 的整串先查
    if (ZH2EN.hasOwnProperty(s)) return ZH2EN[s];
    return s.split(' · ').map(trOne).join(' · ');
  }

  /* ---------- 应用语言到 DOM ---------- */
  var TITLES = {
    'zh-CN': '音帧 SonicFrame · 上传歌曲与歌词，自动生成 MV',
    'en': 'SonicFrame · Turn a song & lyrics into a music video, automatically'
  };

  function apply() {
    var root = document.documentElement;
    root.lang = cur === 'en' ? 'en' : 'zh-CN';
    document.title = TITLES[cur === 'en' ? 'en' : 'zh-CN'];

    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-i18n');
      if (el.dataset.sfZh === undefined) el.dataset.sfZh = el.innerHTML;
      if (cur === 'en' && EN[key] !== undefined) el.innerHTML = EN[key];
      else el.innerHTML = el.dataset.sfZh;
    }
    var phs = document.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < phs.length; j++) {
      var pe = phs[j];
      var pk = pe.getAttribute('data-i18n-ph');
      if (pe.dataset.sfZhPh === undefined) pe.dataset.sfZhPh = pe.getAttribute('placeholder') || '';
      pe.setAttribute('placeholder', (cur === 'en' && EN[pk] !== undefined) ? EN[pk] : pe.dataset.sfZhPh);
    }
    // 语言按钮显示"另一种语言"的名字
    var btn = document.getElementById('btnLang');
    if (btn) btn.textContent = cur === 'en' ? '中文' : 'EN';
  }

  var cur = 'en';
  try { cur = localStorage.getItem('sf-lang') || 'en'; } catch (e) { /* 隐私模式 */ }
  if (cur !== 'en' && cur !== 'zh') cur = 'en';

  function toggle() {
    cur = (cur === 'en') ? 'zh' : 'en';
    try { localStorage.setItem('sf-lang', cur); } catch (e) { /* ignore */ }
    apply();
    // app.js 注册的动态状态刷新（徽标/按钮/体积提示跟随当前状态）
    if (typeof window.__sfLangRefresh === 'function') { try { window.__sfLangRefresh(); } catch (e) { /* ignore */ } }
  }

  /* 导出接口 */
  return {
    tr: tr,
    apply: apply,
    toggle: toggle,
    get lang() { return cur; },
    EN: EN
  };
})();

/* 尽早应用（app.js 之前，避免徽标等先以中文写入） */
window.SFI18N.apply();

/* 语言切换按钮 */
(function () {
  var btn = document.getElementById('btnLang');
  if (btn) btn.addEventListener('click', function () { window.SFI18N.toggle(); });
})();
