/*
  SonicFrame 音频转换工具：M4A / WAV / FLAC / OGG 等 → MP3
  · 纯浏览器本地完成：AudioContext 解码 → （必要时）OfflineAudioContext 重采样
    → Int16 PCM → lamejs Mp3Encoder 分块编码 → 下载
  · 支持采样率：8000/11025/12000/16000/22050/24000/32000/44100/48000
    （其它采样率自动重采样到 44100）
  · 进度分块回调，保持页面可响应
*/
window.SFConvert = (function () {
  'use strict';

  var LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  function fmtSize(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* 解码任意浏览器支持的音频 → AudioBuffer */
  function decodeFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) { reject(new Error('AudioContext unavailable')); return; }
        var ctx = new Ctx();
        ctx.decodeAudioData(reader.result, function (buf) {
          ctx.close && ctx.close();
          resolve(buf);
        }, function (err) {
          ctx.close && ctx.close();
          reject(new Error('解码失败 / decode failed: ' + (err && err.message || err)));
        });
      };
      reader.onerror = function () { reject(new Error('文件读取失败 / read failed')); };
      reader.readAsArrayBuffer(file);
    });
  }

  /* 若采样率 lame 不支持，用 OfflineAudioContext 重采样到 44100 */
  function ensureSampleRate(buffer) {
    if (LAME_RATES.indexOf(buffer.sampleRate) >= 0) return Promise.resolve(buffer);
    var target = 44100;
    var frames = Math.ceil(buffer.duration * target);
    var off = new OfflineAudioContext(buffer.numberOfChannels, frames, target);
    var src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  /* Float32 多声道 → Int16（≤2 声道，多余声道均值下混） */
  function toInt16(buffer) {
    var chCount = Math.min(2, buffer.numberOfChannels);
    var len = buffer.length;
    var chans = [];
    for (var c = 0; c < chCount; c++) chans.push(buffer.getChannelData(c));
    var extra = buffer.numberOfChannels - 2; // >2 声道时平均进前两声道
    var out = new Int16Array(len * chCount);
    for (var i = 0; i < len; i++) {
      for (var c2 = 0; c2 < chCount; c2++) {
        var v = chans[c2][i];
        if (extra > 0) {
          var sum = v, n = 1;
          for (var e = 0; e < extra; e++) { sum += chans[2 + e][i]; n++; }
          v = sum / n;
        }
        var s = Math.max(-1, Math.min(1, v));
        out[i * chCount + c2] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
    }
    return { data: out, channels: chCount };
  }

  /*
    主流程：convert(file, kbps, onProgress)
    onProgress(phase, pct, info) — phase: 'decode'|'encode'
    返回 { blob, size, duration, sampleRate }
  */
  function convert(file, kbps, onProgress) {
    kbps = kbps || 192;
    onProgress = onProgress || function () {};
    if (typeof lamejs === 'undefined') return Promise.reject(new Error('lamejs 未加载 / lamejs not loaded'));

    onProgress('decode', 0);
    return decodeFile(file)
      .then(function (buf) {
        onProgress('decode', 60);
        return ensureSampleRate(buf).then(function (b2) {
          onProgress('decode', 100);
          return b2;
        });
      })
      .then(function (buffer) {
        var pcm = toInt16(buffer);
        var encoder = new lamejs.Mp3Encoder(pcm.channels, buffer.sampleRate, kbps);
        var blockSize = 1152 * 20; // 每块 ~0.5s，兼顾速度与响应
        var chunks = [];
        var total = pcm.data.length;
        var pos = 0;

        return new Promise(function (resolve, reject) {
          function step() {
            try {
              var end = Math.min(pos + blockSize * pcm.channels, total);
              var slice = pcm.data.subarray(pos, end);
              var buf;
              if (pcm.channels === 1) buf = encoder.encodeBuffer(slice);
              else buf = encoder.encodeBuffer(slice.subarray(0, slice.length >> 1), slice.subarray(slice.length >> 1));
              if (buf.length > 0) chunks.push(new Int8Array(buf));
              pos = end;
              onProgress('encode', Math.round(pos / total * 100));
              if (pos < total) {
                setTimeout(step, 0);
              } else {
                var tail = encoder.flush();
                if (tail.length > 0) chunks.push(new Int8Array(tail));
                var blob = new Blob(chunks, { type: 'audio/mpeg' });
                resolve({
                  blob: blob,
                  size: blob.size,
                  sizeText: fmtSize(blob.size),
                  duration: buffer.duration,
                  sampleRate: buffer.sampleRate
                });
              }
            } catch (err) {
              reject(err);
            }
          }
          step();
        });
      });
  }

  return { convert: convert, decodeFile: decodeFile };
})();

/* ============ UI 绑定（转换弹窗） ============ */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }

  /* 双语提示（与站点语言联动） */
  var ZH = {
    cvDecoding: '解码中…', cvEncoding: '编码中 {pct}%', cvDone: '转换完成 — {info}',
    cvFail: '转换失败：{msg}', cvPickFirst: '请先选择音频文件', cvWorking: '转换中…',
    cvMeta: '{name} · {dur} 秒 · 以 {kbps} kbps 转换', cvReady: '已就绪，可开始转换'
  };
  function T(key, params) {
    var dict = (window.SFI18N && window.SFI18N.lang === 'en') ? window.SFI18N.EN : ZH;
    var str = (dict && dict[key]) || ZH[key] || key;
    Object.keys(params || {}).forEach(function (k) { str = str.split('{' + k + '}').join(params[k]); });
    return str;
  }
  function fmtDur(sec) { return Math.round(sec); }

  var file = null, converting = false;

  function setInfo(text) { $('cvFileInfo').textContent = text; }
  function setStatus(text) { $('cvStatus').textContent = text; }
  function setBar(pct) { $('cvBar').style.width = pct + '%'; }

  function baseName(name) { return name.slice(0, name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length); }

  function init() {
    if (!$('step-convert') || !$('cvFile')) return;

    var pick = $('cvPick'), fileInput = $('cvFile');
    if (pick && fileInput) pick.addEventListener('click', function () { fileInput.click(); });
    if (fileInput) fileInput.addEventListener('change', function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      file = fileInput.files[0];
      $('cvStart').disabled = false;
      $('cvDownload').hidden = true;
      setStatus('');
      setInfo(T('cvMeta', { name: file.name, dur: '…', kbps: $('cvKbps').value }));
      // 读时长：借助 convert 的解码（轻量 WAV 也很快）；此处先展示文件名与大小
      var kb = file.size / 1024;
      setInfo(file.name + ' · ' + (kb < 1024 ? kb.toFixed(0) + ' KB' : (kb / 1024).toFixed(2) + ' MB'));
    });

    var start = $('cvStart');
    if (start) start.addEventListener('click', function () {
      if (converting) return;
      if (!file) { setStatus(T('cvPickFirst')); return; }
      converting = true;
      start.disabled = true;
      $('cvDownload').hidden = true;
      $('cvProgress').hidden = false;
      setStatus(T('cvWorking'));
      var kbps = parseInt($('cvKbps').value, 10) || 192;

      window.SFConvert.convert(file, kbps, function (phase, pct) {
        if (phase === 'decode') { setBar(Math.round(pct * 0.2)); setStatus(T('cvDecoding')); }
        else { setBar(20 + Math.round(pct * 0.8)); setStatus(T('cvEncoding', { pct: pct })); }
      }).then(function (r) {
        converting = false;
        start.disabled = false;
        $('cvProgress').hidden = true;
        setBar(0);
        setStatus(T('cvDone', { info: r.sizeText + ' · ' + r.sampleRate + ' Hz' }));
        var url = URL.createObjectURL(r.blob);
        var a = $('cvDownload');
        a.href = url;
        a.download = baseName(file.name) + '.mp3';
        a.hidden = false;
      }).catch(function (err) {
        converting = false;
        start.disabled = false;
        $('cvProgress').hidden = true;
        setStatus(T('cvFail', { msg: err && err.message || err }));
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
