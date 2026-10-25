/*
  SonicFrame 歌曲特征分析：MP3/WAV 等 → 音乐特征 → AI 音乐提示词
  · 解码（复用 SFConvert.decodeFile）→ 单声道重采样分析
  · 特征：
    - BPM：能量包络自相关（60–180 BPM 搜索窗）
    - 调性：FFT 色度图 × Krumhansl 大/小调轮廓相关
    - 亮度：频谱质心；低/中/高频占比
    - 人声感：300–3500Hz 能量占比 + 谐波度
    - 动态：RMS / 峰值 / 动态范围
  · 输出：结构化特征 + Suno 风格英文提示词
*/
window.SFAnalyzr = (function () {
  'use strict';

  /* ---------- FFT（迭代式 radix-2） ---------- */
  function fft(re, im) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var i2 = 0; i2 < n; i2 += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < len / 2; k++) {
          var ur = re[i2 + k], ui = im[i2 + k];
          var vr = re[i2 + k + len / 2] * cr - im[i2 + k + len / 2] * ci;
          var vi = re[i2 + k + len / 2] * ci + im[i2 + k + len / 2] * cr;
          re[i2 + k] = ur + vr; im[i2 + k] = ui + vi;
          re[i2 + k + len / 2] = ur - vr; im[i2 + k + len / 2] = ui - vi;
          var ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  /* Krumhansl-Kessler 轮廓（大调 / 小调） */
  var KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function corr(a, b) {
    var n = a.length, ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var num = 0, da = 0, db = 0;
    for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return num / (Math.sqrt(da * db) || 1e-9);
  }

  /* ---------- 主分析 ---------- */
  function analyze(file, onProgress) {
    onProgress = onProgress || function () {};
    onProgress(10, '解码中…');
    var SFConvert = window.SFConvert;
    return SFConvert.decodeFile(file).then(function (buffer) {
      onProgress(30, '提取特征…');
      var sr = buffer.sampleRate;
      /* 单声道混合 */
      var n = buffer.length;
      var mono = new Float32Array(n);
      var chs = buffer.numberOfChannels;
      for (var c = 0; c < chs; c++) {
        var d = buffer.getChannelData(c);
        for (var i = 0; i < n; i++) mono[i] += d[i] / chs;
      }
      /* 最多分析 120 秒（性能保护），取中段 */
      var maxLen = Math.min(n, sr * 120);
      var start = Math.max(0, (n - maxLen) >> 1);
      var sig = mono.subarray(start, start + maxLen);
      var dur = buffer.duration;

      /* --- 1. 能量包络（供动态范围用） --- */
      var hop = 512, win = 1024;
      var frames = Math.floor((sig.length - win) / hop);
      var env = new Float32Array(frames);
      for (var f = 0; f < frames; f++) {
        var s = 0, off = f * hop;
        for (var k = 0; k < win; k += 2) { var v = sig[off + k]; s += v * v; }
        env[f] = Math.sqrt(s / (win / 2));
      }

      /* --- 1b. 多频段谱通量 onset → BPM / 律动（比振幅差分更能抓住旋律性律动） --- */
      var fHop = 512, fWin = 1024;
      var fFrames = Math.floor((sig.length - fWin) / fHop);
      var hannF = new Float32Array(fWin);
      for (var hf = 0; hf < fWin; hf++) hannF[hf] = 0.5 - 0.5 * Math.cos(2 * Math.PI * hf / (fWin - 1));
      var freqBins = fWin / 2;
      var prevMag = new Float32Array(freqBins);
      var fluxRaw = new Float32Array(fFrames);
      var reF = new Float32Array(fWin), imF = new Float32Array(fWin);
      var fluxBinMax = Math.min(freqBins - 1, Math.floor(8000 * fWin / sr));
      for (var ff = 0; ff < fFrames; ff++) {
        var oF = ff * fHop;
        for (var kf = 0; kf < fWin; kf++) { reF[kf] = sig[oF + kf] * hannF[kf]; imF[kf] = 0; }
        fft(reF, imF);
        var fl = 0;
        for (var bf = 1; bf <= fluxBinMax; bf++) {
          var mgf = Math.sqrt(reF[bf] * reF[bf] + imF[bf] * imF[bf]);
          var df = mgf - prevMag[bf];
          if (df > 0) fl += df;
          prevMag[bf] = mgf;
        }
        fluxRaw[ff] = fl;
      }
      /* 3 帧平滑 + 去均值 */
      var onset = new Float32Array(fFrames);
      for (var sm = 1; sm < fFrames - 1; sm++) onset[sm] = (fluxRaw[sm - 1] + fluxRaw[sm] + fluxRaw[sm + 1]) / 3;
      var mean = 0; for (var m = 0; m < fFrames; m++) mean += onset[m];
      mean /= fFrames;
      var onsetAvg = mean;
      for (var m2 = 0; m2 < fFrames; m2++) onset[m2] = Math.max(0, onset[m2] - mean);

      /* 律动密度：onset 峰计数（>2×均值且局部极大） */
      var onsets = 0;
      for (var pk = 1; pk < fFrames - 1; pk++) {
        if (onset[pk] > onset[pk - 1] && onset[pk] >= onset[pk + 1] && onset[pk] > onsetAvg * 2) onsets++;
      }
      var analyzeDur = sig.length / sr;
      var onsetDensity = onsets / analyzeDur; // 次/秒

      /* 自相关找 60–180 BPM + 节拍强度（峰显著度） */
      var fps = sr / fHop;
      var minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 60);
      var scores = new Float32Array(maxLag + 2);
      var bestLag = minLag, bestScore = -1, scoreSum = 0, scoreCnt = 0;
      for (var lag = minLag; lag <= maxLag; lag++) {
        var sc = 0;
        for (var t = 0; t + lag < fFrames; t++) sc += onset[t] * onset[t + lag];
        scores[lag] = sc;
        scoreSum += sc; scoreCnt++;
        if (sc > bestScore) { bestScore = sc; bestLag = lag; }
      }
      /* 节拍强度：自相关峰值 / 均值 → 1=无节拍感，越大越强 */
      var beatRatio = scoreCnt > 0 ? bestScore / (scoreSum / scoreCnt) : 1;
      var beatStrength = Math.max(0, Math.min(100, Math.round((beatRatio - 1) / 4 * 100)));
      /* 八度仲裁：检测到过快（>135）时若慢一倍（2×lag）得分仍显著 → 取慢档；
         检测到过慢（<75）时若快一倍（lag/2）得分显著 → 取快档 */
      var bestBpm = 60 * fps / bestLag;
      function scoreAt(l) { return (l >= minLag && l <= maxLag) ? scores[l] : 0; }
      if (bestBpm > 135 && scoreAt(bestLag * 2) >= bestScore * 0.4) { bestLag = bestLag * 2; bestBpm = 60 * fps / bestLag; }
      else if (bestBpm < 75 && scoreAt(Math.round(bestLag / 2)) >= bestScore * 0.4) { bestLag = Math.round(bestLag / 2); bestBpm = 60 * fps / bestLag; }
      /* 折叠到 70–180 常见区间 */
      while (bestBpm < 70) bestBpm *= 2;
      while (bestBpm > 180) bestBpm /= 2;

      onProgress(50, '分析调性…');
      /* --- 2. 色度图 → 调性 --- */
      var fftN = 4096;
      var chroma = new Float64Array(12);
      var frameCount = Math.min(200, Math.floor((sig.length - fftN) / hop));
      var hann = new Float32Array(fftN);
      for (var h = 0; h < fftN; h++) hann[h] = 0.5 - 0.5 * Math.cos(2 * Math.PI * h / (fftN - 1));
      var re = new Float32Array(fftN), im = new Float32Array(fftN);
      for (var fr = 0; fr < frameCount; fr++) {
        var o = fr * hop * 8; // 跳取样帧提速
        if (o + fftN > sig.length) break;
        for (var k2 = 0; k2 < fftN; k2++) { re[k2] = sig[o + k2] * hann[k2]; im[k2] = 0; }
        fft(re, im);
        for (var b = 2; b < fftN / 2; b++) {
          var freq = b * sr / fftN;
          if (freq < 65 || freq > 2100) continue;
          var midi = 69 + 12 * Math.log2(freq / 440);
          var pc = ((Math.round(midi) % 12) + 12) % 12;
          var mag = Math.hypot(re[b], im[b]);
          chroma[pc] += mag;
        }
      }
      /* 归一化色度 */
      var cMax = 0; for (var cc = 0; cc < 12; cc++) if (chroma[cc] > cMax) cMax = chroma[cc];
      if (cMax > 0) for (var cc2 = 0; cc2 < 12; cc2++) chroma[cc2] /= cMax;
      /* 12 个旋转位 × 大/小调，取最高相关 */
      var keyIdx = 0, keyMode = 'major', keyCorr = -2;
      for (var rot = 0; rot < 12; rot++) {
        var shifted = new Array(12);
        for (var p = 0; p < 12; p++) shifted[p] = chroma[(p + rot) % 12];
        var cm = corr(shifted, KK_MAJ), cn = corr(shifted, KK_MIN);
        if (cm > keyCorr) { keyCorr = cm; keyIdx = rot; keyMode = 'major'; }
        if (cn > keyCorr) { keyCorr = cn; keyIdx = rot; keyMode = 'minor'; }
      }
      var keyName = NOTE_NAMES[keyIdx] + ' ' + keyMode;

      onProgress(70, '分析音色与人声…');
      /* --- 3. 频谱统计（质心 + 频段占比 + 人声感） --- */
      var bands = { low: 0, mid: 0, high: 0, vocal: 0, total: 0, centroidW: 0 };
      var frameCount2 = Math.min(400, Math.floor((sig.length - fftN) / hop));
      for (var fr2 = 0; fr2 < frameCount2; fr2++) {
        var o2 = fr2 * hop * 8;
        if (o2 + fftN > sig.length) break;
        for (var k3 = 0; k3 < fftN; k3++) { re[k3] = sig[o2 + k3] * hann[k3]; im[k3] = 0; }
        fft(re, im);
        for (var b2 = 2; b2 < fftN / 2; b2++) {
          var fq = b2 * sr / fftN;
          var mg = re[b2] * re[b2] + im[b2] * im[b2];
          bands.total += mg;
          bands.centroidW += fq * mg;
          if (fq < 250) bands.low += mg;
          else if (fq < 2000) bands.mid += mg;
          else bands.high += mg;
          if (fq >= 300 && fq <= 3500) bands.vocal += mg;
        }
      }
      var centroid = bands.total > 0 ? bands.centroidW / bands.total : 0;
      var pct = function (x) { return bands.total > 0 ? x / bands.total : 0; };
      var vocalRatio = pct(bands.vocal);

      /* --- 4. 响度与动态 --- */
      var sum = 0, peak = 0;
      for (var i3 = 0; i3 < sig.length; i3++) {
        var v3 = Math.abs(sig[i3]);
        sum += sig[i3] * sig[i3];
        if (v3 > peak) peak = v3;
      }
      var rms = Math.sqrt(sum / sig.length);
      var rmsDb = 20 * Math.log10(rms || 1e-9);
      /* 响度分层：取 10% 分位作为安静段 → 动态范围 */
      var envSorted = Array.prototype.slice.call(env).sort(function (a, b) { return a - b; });
      var quiet = envSorted[Math.floor(envSorted.length * 0.1)] || 1e-6;
      var loud = envSorted[Math.floor(envSorted.length * 0.9)] || 1e-6;
      var dynDb = 20 * Math.log10(loud / quiet);

      onProgress(90, '生成提示词…');
      var featIn = { bpm: bestBpm, centroid: centroid, lowPct: pct(bands.low), highPct: pct(bands.high), vocalRatio: vocalRatio, rmsDb: rmsDb, dynDb: dynDb, beatStrength: beatStrength, onsetDensity: onsetDensity };
      return {
        bpm: Math.round(bestBpm),
        key: keyName,
        keyConfidence: keyCorr,
        duration: dur,
        sampleRate: sr,
        channels: chs,
        brightnessHz: Math.round(centroid),
        lowPct: pct(bands.low),
        midPct: pct(bands.mid),
        highPct: pct(bands.high),
        vocalRatio: vocalRatio,
        rmsDb: Math.round(rmsDb),
        peak: peak,
        dynamicRangeDb: Math.round(dynDb),
        beatStrength: beatStrength,
        onsetDensity: Math.round(onsetDensity * 10) / 10,
        features: interpret(featIn)
      };
    });
  }

  /* ---------- 特征 → 风格描述（细粒度分桶，提高区分度） ---------- */
  function interpret(f) {
    var g = {};
    /* 节奏感：BPM 分 6 档 */
    if (f.bpm < 75) g.tempo = 'very slow, floating pace';
    else if (f.bpm < 90) g.tempo = 'slow, laid-back groove';
    else if (f.bpm < 108) g.tempo = 'relaxed mid-tempo groove';
    else if (f.bpm < 125) g.tempo = 'steady mid-tempo pulse';
    else if (f.bpm < 145) g.tempo = 'energetic, driving beat';
    else g.tempo = 'fast, urgent rhythm';
    /* 律动：节拍强度 × 律动密度 */
    if (f.beatStrength >= 60) {
      g.groove = f.onsetDensity >= 5 ? 'punchy, densely layered percussion with a strong four-on-the-floor feel'
        : f.onsetDensity >= 2.5 ? 'clear steady backbeat, tight and danceable'
        : 'bold sparse hits with heavy space between beats';
    } else if (f.beatStrength >= 30) {
      g.groove = f.onsetDensity >= 5 ? 'flowing busy rhythm with light syncopation'
        : 'moderate groove, rhythm felt more than hammered';
    } else {
      g.groove = 'soft rhythmic pulse, ambient and floating, drums barely present';
    }
    /* 音色亮度：分 5 档 */
    if (f.centroid < 900) g.timbre = 'deep, dark, bass-dominated timbre';
    else if (f.centroid < 1500) g.timbre = 'warm, mellow timbre';
    else if (f.centroid < 2300) g.timbre = 'balanced, natural timbre';
    else if (f.centroid < 3200) g.timbre = 'bright, open timbre';
    else g.timbre = 'very bright, airy, crystalline timbre';
    /* 配比：用量化数值组合 */
    var lp = Math.round(f.lowPct * 100), hp = Math.round(f.highPct * 100);
    if (f.lowPct > 0.5) g.bass = lp + '% of the energy in the low end — sub-heavy mix';
    else if (f.highPct > 0.25) g.bass = hp + '% energy in highs — shiny mix with sparkling highs';
    else g.bass = 'balanced spectrum (~' + lp + '% lows / ~' + hp + '% highs)';
    /* 人声感 */
    var vp = Math.round(f.vocalRatio * 100);
    if (f.vocalRatio > 0.55) g.vocal = 'expressive lead vocals dominating the mix (vocal band ~' + vp + '%)';
    else if (f.vocalRatio > 0.4) g.vocal = 'vocal-forward but blended with instruments (vocal band ~' + vp + '%)';
    else g.vocal = 'instrumental-leaning texture, vocals sparse (vocal band ~' + vp + '%)';
    /* 力度 */
    if (f.dynDb > 14) g.dynamics = 'wide dynamics, quiet-loud contrast';
    else if (f.dynDb > 8) g.dynamics = 'moderate dynamics';
    else g.dynamics = 'dense, compressed, radio-style loudness';
    /* 能量等级 */
    g.energy = f.rmsDb > -15 ? 'high energy' : f.rmsDb > -23 ? 'medium energy' : 'low energy, intimate';
    /* 粗略流派猜测：加入律动与能量维度 */
    if (f.bpm >= 120 && f.bpm < 135 && f.lowPct > 0.45) g.genre = 'dance / electronic-pop';
    else if (f.bpm >= 70 && f.bpm < 100 && f.vocalRatio > 0.5) g.genre = 'R&B / soul ballad';
    else if (f.bpm >= 100 && f.bpm < 130 && f.vocalRatio > 0.45) g.genre = 'pop';
    else if (f.bpm >= 135) g.genre = 'upbeat dance / EDM';
    else if (f.centroid < 1200) g.genre = 'lo-fi / chill hip-hop';
    else g.genre = 'contemporary pop';
    /* 情绪 */
    g.mood = f.centroid > 2200 && f.rmsDb > -20 ? 'uplifting and energetic'
      : f.centroid < 1400 ? 'mellow and introspective' : 'warm and emotional';
    return g;
  }

  /* ---------- 特征 → Suno 风格英文提示词（含量化特征与防雷同约束） ---------- */
  function buildPrompt(r) {
    var F = r.features;
    var lines = [
      'Genre: ' + F.genre + ', ' + F.energy,
      'Tempo: ' + r.bpm + ' BPM (exact), ' + F.tempo,
      'Rhythm/Groove: ' + F.groove,
      'Key: ' + r.key,
      'Mood: ' + F.mood,
      'Sound: ' + F.timbre + '; ' + F.bass,
      'Vocals: ' + F.vocal,
      'Dynamics: ' + F.dynamics,
      'Production: modern mixing, clean master, in the same STYLE as the reference track only',
      'IMPORTANT: compose a brand-new ORIGINAL song in this style — do NOT reuse the melody, lyrics, chord progression or hooks of any existing song'
    ];
    return lines.join('\n');
  }

  return { analyze: analyze, buildPrompt: buildPrompt, interpret: interpret };
})();

/* ============ UI 绑定（歌曲分析分区） ============ */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  var ZH = {
    azCopied: '已复制', azAnalyzing: '分析中…', azNeedFile: '请先选择歌曲文件',
    azFail: '分析失败：{msg}'
  };
  function T(key, params) {
    var dict = (window.SFI18N && window.SFI18N.lang === 'en') ? window.SFI18N.EN : ZH;
    var str = (dict && dict[key]) || ZH[key] || key;
    Object.keys(params || {}).forEach(function (k) { str = str.split('{' + k + '}').join(params[k]); });
    return str;
  }
  function fmtSize(b) { return b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(2) + ' MB'; }

  function init() {
    if (!$('step-analyze') || !$('azFile')) return;
    var file = null, busy = false;
    var fileInput = $('azFile');

    $('azPick').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      file = fileInput.files[0];
      $('azResult').hidden = true;
      $('azPromptWrap').hidden = true;
      $('azStatus').textContent = '';
      $('azProgress').hidden = true;
      $('azFileInfo').textContent = file.name + ' · ' + fmtSize(file.size);
    });

    function run() {
      if (busy) return;
      if (!file) { $('azStatus').textContent = T('azNeedFile'); return; }
      busy = true;
      $('azProgress').hidden = false;
      $('azBar').style.width = '10%';
      $('azStatus').textContent = T('azAnalyzing');
      $('azResult').hidden = true;
      $('azPromptWrap').hidden = true;
      window.SFAnalyzr.analyze(file, function (pct) {
        $('azBar').style.width = pct + '%';
      }).then(function (r) {
        busy = false;
        $('azProgress').hidden = true;
        $('azBar').style.width = '0%';
        $('azStatus').textContent = '';
        $('azBpm').textContent = r.bpm + ' BPM';
        $('azKey').textContent = r.key;
        $('azBright').textContent = r.brightnessHz + ' Hz';
        $('azVocal').textContent = Math.round(r.vocalRatio * 100) + '%';
        $('azDyn').textContent = r.dynamicRangeDb + ' dB';
        $('azBeat').textContent = r.beatStrength + '%';
        $('azGroove').textContent = r.onsetDensity + ' /s';
        $('azGenre').textContent = r.features.genre;
        $('azResult').hidden = false;
        $('azPrompt').value = window.SFAnalyzr.buildPrompt(r);
        $('azPromptWrap').hidden = false;
      }).catch(function (err) {
        busy = false;
        $('azProgress').hidden = true;
        $('azStatus').textContent = T('azFail', { msg: err && err.message || err });
      });
    }

    /* 选完文件即开始分析 */
    fileInput.addEventListener('change', function () { run(); });
    $('azPick').addEventListener('dblclick', function () { run(); });

    $('azCopy').addEventListener('click', function () {
      var ta = $('azPrompt');
      ta.removeAttribute('readonly');
      ta.select();
      try { document.execCommand('copy'); } catch (e) {
        if (navigator.clipboard) navigator.clipboard.writeText(ta.value);
      }
      ta.setAttribute('readonly', '');
      var old = $('azCopy').textContent;
      $('azCopy').textContent = T('azCopied');
      setTimeout(function () { $('azCopy').textContent = old; }, 1200);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
