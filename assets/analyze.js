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
      /* 人声主导轨（mid）：立体声取 (L+R)/2，居中的人声/贝斯保留，两侧乐器衰减 */
      var mid = mono;
      if (chs >= 2) {
        var Ld = buffer.getChannelData(0), Rd = buffer.getChannelData(1);
        var midBuf = new Float32Array(n);
        for (var mi = 0; mi < n; mi++) midBuf[mi] = (Ld[mi] + Rd[mi]) / 2;
        mid = midBuf;
      }
      /* 最多分析 120 秒（性能保护），取中段 */
      var maxLen = Math.min(n, sr * 120);
      var start = Math.max(0, (n - maxLen) >> 1);
      var sig = mono.subarray(start, start + maxLen);
      var sigMid = mid.subarray(start, start + maxLen);
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
      var f0s = [];            // 每帧主唱基频估计（80–1000Hz 峰）
      var chromaHist = [];     // 每帧色度（和声变化率用）
      var chromaSpan = 0;      // 色度帧覆盖时长（秒）
      for (var fr = 0; fr < frameCount; fr++) {
        var o = fr * hop * 8; // 跳取样帧提速
        if (o + fftN > sig.length) break;
        for (var k2 = 0; k2 < fftN; k2++) { re[k2] = sigMid[o + k2] * hann[k2]; im[k2] = 0; }
        fft(re, im);
        var f0Best = 0, f0Max = 0, f0Sum = 0, f0Cnt = 0;
        var frameChroma = new Float64Array(12);
        for (var b = 2; b < fftN / 2; b++) {
          var freq = b * sr / fftN;
          var mag = Math.hypot(re[b], im[b]);
          if (freq >= 65 && freq <= 2100) {
            var midi = 69 + 12 * Math.log2(freq / 440);
            var pc = ((Math.round(midi) % 12) + 12) % 12;
            chroma[pc] += mag;
            frameChroma[pc] += mag;
          }
          /* 主唱音高估计：80–1000Hz 内最强谱峰 */
          if (freq >= 80 && freq <= 1200) {
            if (mag > f0Max) { f0Max = mag; f0Best = freq; }
            f0Sum += mag; f0Cnt++;
          }
        }
        /* 峰显著度 > 5× 均值才算有明确音高（人声/主奏乐器） */
        if (f0Best > 0 && f0Cnt > 0 && f0Max > (f0Sum / f0Cnt) * 5) f0s.push(f0Best);
        chromaHist.push(frameChroma);
        chromaSpan += fftN / sr;
      }
      /* 和声变化率：相邻帧色度余弦距离 > 0.2 记一次和弦/段落变化 */
      var chordJumps = 0;
      var chordSteps = 8; // 比较间隔 ~0.75s，抑制帧间漂移误报
      for (var ch = chordSteps; ch < chromaHist.length; ch++) {
        var dot = 0, na = 0, nb = 0;
        for (var q = 0; q < 12; q++) {
          dot += chromaHist[ch - chordSteps][q] * chromaHist[ch][q];
          na += chromaHist[ch - chordSteps][q] * chromaHist[ch - chordSteps][q];
          nb += chromaHist[ch][q] * chromaHist[ch][q];
        }
        var sim = dot / (Math.sqrt(na * nb) || 1e-9);
        if (1 - sim > 0.45) chordJumps++;
      }
      var chordSpanSec = chromaSpan * (chromaHist.length - chordSteps) / (chromaHist.length || 1);
      var chordRate = chordSpanSec > 0 ? chordJumps / chordSpanSec : 0; // 次/秒
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

      /* --- 4b. 连续音高轨迹（mid 人声轨）→ 唱功技巧 --- */
      var pWin = 2048, pHop = 1024;
      var pFrames = Math.floor((sigMid.length - pWin) / pHop);
      var pF0 = new Float32Array(pFrames);      // 0 = unvoiced
      var pH2H1 = new Float32Array(pFrames);    // 2次谐波/基波能量比
      var hannP = new Float32Array(pWin);
      for (var hp = 0; hp < pWin; hp++) hannP[hp] = 0.5 - 0.5 * Math.cos(2 * Math.PI * hp / (pWin - 1));
      var reP = new Float32Array(pWin), imP = new Float32Array(pWin);
      var binHz = sr / pWin;
      var bMin = Math.ceil(80 / binHz), bMax = Math.min(Math.floor(1200 / binHz), pWin / 2 - 1);
      for (var pf = 0; pf < pFrames; pf++) {
        var po = pf * pHop;
        for (var pk2 = 0; pk2 < pWin; pk2++) { reP[pk2] = sigMid[po + pk2] * hannP[pk2]; imP[pk2] = 0; }
        fft(reP, imP);
        var pmMax = 0, pmBest = 0, pmSum = 0, pmCnt = 0;
        for (var pb = bMin; pb <= bMax; pb++) {
          var pm = reP[pb] * reP[pb] + imP[pb] * imP[pb];
          if (pm > pmMax) { pmMax = pm; pmBest = pb; }
          pmSum += pm; pmCnt++;
        }
        if (pmBest > 0 && pmCnt > 0 && pmMax > (pmSum / pmCnt) * 10) { // 功率域阈值（实验校准：兼顾鼓点鲁棒与人声检出）
          pF0[pf] = pmBest * binHz;
          var h1b = pmBest, h2b = Math.min(pmBest * 2, pWin / 2 - 1);
          var h1 = reP[h1b] * reP[h1b] + imP[h1b] * imP[h1b];
          var h2 = reP[h2b] * reP[h2b] + imP[h2b] * imP[h2b];
          pH2H1[pf] = h1 > 0 ? h2 / h1 : 1;
        }
      }
      /* 声部中位数（覆盖旧估计） */
      var voicedP = [];
      for (var pv = 0; pv < pFrames; pv++) if (pF0[pv] >= 120) voicedP.push(pF0[pv]);
      var voicedRatioP = pFrames > 0 ? voicedP.length / pFrames : 0;
      if (voicedP.length > 8) {
        var vpS = voicedP.slice().sort(function (x, y) { return x - y; });
        medianF0 = vpS[Math.floor(vpS.length * 0.5)];
        var v25 = vpS[Math.floor(vpS.length * 0.1)];
        var v75 = vpS[Math.floor(vpS.length * 0.9)];
        rangeSemi = v25 > 0 ? Math.round(12 * Math.log2(v75 / v25)) : 0;
      }
      /* 转音/换声区：相邻有声帧音高跳变 >5 半音（0.5s 内合并） */
      var flips = 0, lastFlipT = -1;
      var pSec = pHop / sr;
      for (var pj = 2; pj < pFrames - 3; pj++) {
        if (pF0[pj] >= 120 && pF0[pj - 1] >= 120) {
          var dSt = Math.abs(12 * Math.log2(pF0[pj] / pF0[pj - 1]));
          /* 需在新音高上保持 ≥3 帧，排除八度谐波误检 */
          if (dSt > 5) {
            var hold = true;
            for (var hk = 1; hk <= 3; hk++) {
              if (!(pF0[pj + hk] >= 120 && Math.abs(12 * Math.log2(pF0[pj + hk] / pF0[pj])) < 2)) { hold = false; break; }
            }
            if (hold) {
              var tNow = pj * pSec;
              if (tNow - lastFlipT > 0.5) flips++;
              lastFlipT = tNow;
            }
          }
        }
      }
      var flipsPerMin = dur > 0 ? Math.round(flips / dur * 60) : 0;
      /* 假声：音高比中位高 ≥7 半音 且 泛音贫乏（H2/H1 < 0.6） */
      var highFrames = 0, falseFrames = 0;
      var medF = medianF0 > 0 ? medianF0 * Math.pow(2, 7 / 12) : 0;
      for (var pf2 = 0; pf2 < pFrames; pf2++) {
        if (pF0[pf2] >= 120 && medF > 0 && pF0[pf2] >= medF) {
          highFrames++;
          if (pH2H1[pf2] < 0.6) falseFrames++;
        }
      }
      var falsettoPct = highFrames > 10 ? Math.round(falseFrames / highFrames * 100) : 0;

      /* --- 4c. 节奏律动：onset 相位 vs 节拍网格 → 正拍/切分 --- */
      var beatSec = bestBpm > 0 ? 60 / bestBpm : 0.5;
      var onBeat = 0, offHalf = 0, onsetsTotal = 0;
      for (var op = 1; op < fFrames - 1; op++) {
        if (onset[op] > onset[op - 1] && onset[op] >= onset[op + 1] && onset[op] > onsetAvg * 2) {
          onsetsTotal++;
          var phase = (op * fHop / sr / beatSec) % 1;
          if (phase < 0.12 || phase > 0.88) onBeat++;
          else if (phase > 0.38 && phase < 0.62) offHalf++;
        }
      }
      var offbeatPct = onsetsTotal > 0 ? Math.round(offHalf / onsetsTotal * 100) : 0;

      /* --- 5. 主副歌结构：2 秒窗响度分层 --- */
      var wLen = sr * 2, wCount = Math.floor(sig.length / wLen);
      var wRms = [];
      for (var w = 0; w < wCount; w++) {
        var ws = 0;
        for (var wj = 0; wj < wLen; wj += 4) { var wv = sig[w * wLen + wj]; ws += wv * wv; }
        wRms.push(Math.sqrt(ws / (wLen / 4)));
      }
      var wSorted = wRms.slice().sort(function (x, y) { return x - y; });
      var wQuiet = wSorted[Math.floor(wSorted.length * 0.35)] || 1e-6;
      var wLoud = wSorted[Math.floor(wSorted.length * 0.75)] || 1e-6;
      var chorusLift = Math.round(20 * Math.log10(wLoud / wQuiet));
      var wMed = wSorted[Math.floor(wSorted.length * 0.5)] || 0;
      var sectionMoves = 0;
      for (var w2 = 1; w2 < wRms.length; w2++) {
        if ((wRms[w2 - 1] > wMed) !== (wRms[w2] > wMed)) sectionMoves++;
      }
      var sectionSpanSec = wCount * 2;

      /* --- 6. 演唱特征（基于 mid 人声轨音高统计） --- */
      var voicedRatio = frameCount > 0 ? f0s.length / frameCount : 0;
      var medianF0 = 0, rangeSemi = 0;
      if (f0s.length > 4) {
        var f0sorted = f0s.slice().sort(function (x, y) { return x - y; });
        medianF0 = f0sorted[Math.floor(f0sorted.length * 0.5)];
        var p25 = f0sorted[Math.floor(f0sorted.length * 0.25)];
        var p75 = f0sorted[Math.floor(f0sorted.length * 0.75)];
        rangeSemi = p25 > 0 ? Math.round(12 * Math.log2(p75 / p25)) : 0;
      }
      function noteName(fq) {
        var midi = Math.round(69 + 12 * Math.log2(fq / 440));
        return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
      }
      var singNote = medianF0 > 0 ? noteName(medianF0) : '—';

      onProgress(90, '生成提示词…');
      var featIn = { bpm: bestBpm, centroid: centroid, lowPct: pct(bands.low), highPct: pct(bands.high), vocalRatio: vocalRatio, rmsDb: rmsDb, dynDb: dynDb, beatStrength: beatStrength, onsetDensity: onsetDensity, voicedRatio: voicedRatio, medianF0: medianF0, flipsPerMin: flipsPerMin, falsettoPct: falsettoPct, offbeatPct: offbeatPct, rangeSemi: rangeSemi, chordRate: chordRate, chorusLift: chorusLift, sectionMoves: sectionMoves };
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
        voicedRatio: Math.round(voicedRatio * 100),
        singNote: singNote,
        vocalRangeSemi: rangeSemi,
        flipsPerMin: flipsPerMin,
        falsettoPct: falsettoPct,
        offbeatPct: offbeatPct,
        chordRate: Math.round(chordRate * 100) / 100,
        chorusLift: chorusLift,
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
    /* 演唱声部与唱法 */
    if (f.voicedRatio < 0.08 || (f.vocalRatio < 0.3 && f.rangeSemi < 3)) {
      g.vocalStyle = 'no prominent lead vocal — instrumental track, melody carried by instruments';
    } else {
      var reg = f.medianF0 < 140 ? 'deep male vocal register' : f.medianF0 < 200 ? 'male vocal register'
        : f.medianF0 < 300 ? 'female vocal register' : 'high, bright female vocal register';
      var deliv;
      if (f.rangeSemi < 4 && f.onsetDensity > 4) deliv = 'rap-like talk-sing flow, rhythm-driven phrasing';
      else if (f.rangeSemi < 4) deliv = 'narrow-range, intimate close-mic delivery';
      else if (f.rangeSemi > 12) deliv = 'wide-range expressive vocals with dynamic leaps';
      else deliv = 'smooth melodic delivery with a moderate range';
      var tech = '';
      if (f.flipsPerMin >= 4) tech += ', frequent vocal flips/riffs (register switches ~' + f.flipsPerMin + '/min)';
      if (f.falsettoPct >= 15) tech += ', uses falsetto/head-voice passages in the upper register';
      g.vocalStyle = reg + ', ' + deliv + tech + ', lead vocal present in ~' + Math.round(f.voicedRatio * 100) + '% of the song';
    }
    /* 和声复杂度 */
    if (f.chordRate < 0.3) g.harmony = 'simple static chord loop, few harmonic changes';
    else if (f.chordRate < 0.8) g.harmony = 'moderate harmonic movement, chord changes every bar or two';
    else g.harmony = 'rich, fast-changing harmony with frequent modulations';
    /* 主副歌结构 */
    var lift = f.chorusLift > 6 ? 'strong verse-chorus dynamic lift (chorus ~' + f.chorusLift + 'dB louder)'
      : f.chorusLift > 3 ? 'moderate verse-chorus lift (chorus ~' + f.chorusLift + 'dB louder)'
      : 'flat energy arrangement, little verse-chorus contrast';
    var secs = f.sectionMoves >= 6 ? 'frequent section changes' : f.sectionMoves >= 2 ? 'classic verse/chorus sections' : 'long uniform sections';
    g.arrangement = lift + ', ' + secs;
    return g;
  }

  /* ---------- 特征 → Suno 风格英文提示词（含量化特征与防雷同约束） ---------- */
  function buildPrompt(r) {
    var F = r.features;
    var lines = [
      'Genre: ' + F.genre + ', ' + F.energy,
      'Tempo: ' + r.bpm + ' BPM (exact), ' + F.tempo,
      'Rhythm/Groove: ' + F.groove + ', ' + (r.offbeatPct >= 35 ? 'syncopated off-beat feel (' + r.offbeatPct + '% off-beat onsets)' : 'straight on-beat feel'),
      'Key: ' + r.key,
      'Mood: ' + F.mood,
      'Sound: ' + F.timbre + '; ' + F.bass,
      'Vocals: ' + F.vocalStyle,
      'Vocal presence: ' + F.vocal,
      'Harmony: ' + F.harmony,
      'Arrangement: ' + F.arrangement,
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
        var singTxt = r.voicedRatio > 8 ? r.singNote + ' · ' + r.vocalRangeSemi + ' st' : '器乐为主';
        if (r.falsettoPct >= 15) singTxt += ' · 假声';
        if (r.flipsPerMin >= 4) singTxt += ' · 转音 ' + r.flipsPerMin + '/分';
        $('azSing').textContent = singTxt;
        $('azChorus').textContent = r.chorusLift + ' dB';
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
