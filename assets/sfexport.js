/* =========================================================
   sfexport.js — 离线逐帧导出（WebCodecs + 自研 MP4 封装）
   ---------------------------------------------------------
   为什么不用 MediaRecorder 实时录制？
   实时录制靠画布“每帧变化”产帧，页面被切到后台、或主线程一卡，
   画面就不再更新，而音轨还在走 —— 成片里会出现几十秒的“冻画面”
   （实测某次 47.7s→127.1s 只有 1 帧，且视频轨比音轨短 56 秒）。

   这里的做法完全不同：
   · 按固定时间步长 1/fps 逐帧渲染 → 帧数与时间戳 100% 精确
   · 频谱由音频 PCM 直接算（不依赖实时 AnalyserNode）
   · H.264 / AAC 用 WebCodecs 编码，再自己封装 MP4
   · 速度只取决于机器算力（通常与歌曲长度相当或更快），且与是否切后台无关
   ========================================================= */
(function (global) {
  'use strict';

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function sleep0() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function abortError() {
    var e = new Error('cancelled');
    e.name = 'AbortError';
    return e;
  }

  /* ---------- 迭代基 2 FFT（原地，长度 2 的幂）---------- */
  function fft(re, im, N) {
    var i, j, k, len, half, ang, wr, wi, tr, ti, ur, ui;
    for (i = 1, j = 0; i < N; i++) {
      var bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        tr = re[i]; re[i] = re[j]; re[j] = tr;
        ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (len = 2; len <= N; len <<= 1) {
      half = len >> 1;
      ang = -2 * Math.PI / len;
      wr = Math.cos(ang); wi = Math.sin(ang);
      for (i = 0; i < N; i += len) {
        var cr = 1, ci = 0;
        for (k = 0; k < half; k++) {
          ur = re[i + k]; ui = im[i + k];
          var vr = re[i + k + half] * cr - im[i + k + half] * ci;
          var vi = re[i + k + half] * ci + im[i + k + half] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  /* ---------- 频谱：按 24fps 预先算好，喂给渲染器的律动柱 ---------- */
  function buildSpectrum(buffer, fps, frames, onStep, isCancelled) {
    var sr = buffer.sampleRate;
    var N = 2048;
    var bins = N / 2;
    var ch0 = buffer.getChannelData(0);
    var ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    var len = ch0.length;

    var win = new Float32Array(N);
    for (var w = 0; w < N; w++) win[w] = 0.5 - 0.5 * Math.cos(2 * Math.PI * w / (N - 1));

    var re = new Float32Array(N), im = new Float32Array(N);
    var smooth = new Float32Array(bins);
    var out = new Array(frames);

    // 与 AnalyserNode 默认参数对齐：minDecibels -100 / maxDecibels -30 / smoothing 0.72
    var MIN_DB = -100, MAX_DB = -30, SM = 0.72;

    return new Promise(function (resolve, reject) {
      var f = 0;
      function step() {
        var budget = Date.now() + 24;
        while (f < frames) {
          if (isCancelled && isCancelled()) { reject(abortError()); return; }

          var center = Math.round(f / fps * sr);
          var start = center - (N >> 1);
          for (var i = 0; i < N; i++) {
            var idx = start + i;
            var s = 0;
            if (idx >= 0 && idx < len) {
              s = ch0[idx];
              if (ch1) s = (s + ch1[idx]) * 0.5;
            }
            re[i] = s * win[i];
            im[i] = 0;
          }
          fft(re, im, N);

          var arr = new Uint8Array(bins);
          for (var k = 0; k < bins; k++) {
            var mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (N / 2);
            var db = 20 * Math.log10(mag + 1e-7);
            var v = (db - MIN_DB) / (MAX_DB - MIN_DB) * 255;
            v = clamp(v, 0, 255);
            smooth[k] = smooth[k] * SM + v * (1 - SM);
            arr[k] = smooth[k] | 0;
          }
          out[f] = arr;
          f++;
          if (Date.now() > budget) break;
        }
        if (onStep) onStep(f / frames);
        if (f < frames) setTimeout(step, 0);
        else resolve(out);
      }
      step();
    });
  }

  /* ---------- H.264 编码器配置：恒定码率优先（体积可控），逐级降级 ---------- */
  var AVC_CODECS = ['avc1.640028', 'avc1.4D401F', 'avc1.42E01F', 'avc1.42E01E'];

  function pickAvc(w, h, bitrate, fps) {
    var variants = [];
    // 可变码率(VBR)的实测码率极不可控（同一目标下 9:16 超了 35%），
    // 能用 CBR 就用 CBR，保证“≤10MB”的承诺能兑现。
    AVC_CODECS.forEach(function (codec) {
      variants.push({ codec: codec, bitrateMode: 'constant' });
      variants.push({ codec: codec });
    });
    var i = 0;
    return (function next() {
      if (i >= variants.length) return Promise.resolve(null);
      var v = variants[i++];
      var cfg = {
        codec: v.codec, width: w, height: h, bitrate: bitrate, framerate: fps,
        latencyMode: 'realtime',        // 低延迟模式：不产生 B 帧，MP4 无需 ctts 重排
        avc: { format: 'avc' }          // 带 avcC 描述，MP4 需要
      };
      if (v.bitrateMode) cfg.bitrateMode = v.bitrateMode;
      return global.VideoEncoder.isConfigSupported(cfg).then(function (s) {
        return s && s.supported ? cfg : next();
      }, function () { return next(); });
    })();
  }

  /* ---------- AV1：压缩效率约为 H.264 的 3~4 倍，用于 1080p 小体积模式 ----------
     实测（1080p / 24fps）：CBR 目标 216kbps 时实际 ~245kbps（高约 17%），
     画质 PSNR 31~34dB，观感良好 —— 这是 1080p 压进 10MB 的唯一可行通道。 */
  function pickAv1(w, h, bitrate, fps) {
    var cfg = {
      codec: 'av01.0.08M.08', width: w, height: h, bitrate: bitrate, framerate: fps,
      latencyMode: 'realtime',
      bitrateMode: 'constant'
    };
    return global.VideoEncoder.isConfigSupported(cfg).then(function (s) {
      return s && s.supported ? cfg : null;
    }, function () { return null; });
  }

  // 一次性探测（结果缓存）：机器是否支持 AV1 编码
  var av1Probe = null;
  function av1Supported(w, h) {
    if (!av1Probe) {
      av1Probe = global.VideoEncoder
        ? global.VideoEncoder.isConfigSupported({
            codec: 'av01.0.08M.08', width: w || 1920, height: h || 1080,
            bitrate: 200000, framerate: 24, latencyMode: 'realtime', bitrateMode: 'constant'
          }).then(function (s) { return !!(s && s.supported); }, function () { return false; })
        : Promise.resolve(false);
    }
    return av1Probe;
  }

  /*
    AAC 编码器的声道支持因平台而异：有的只吃 2 声道（单声道 MP3 直接报不支持）。
    按「原始声道 → 2 声道 → 1 声道」依次试，取第一个能用的。
    单声道源被要求 2 声道时，喂数据时复制一份即可。
  */
  function pickAac(sampleRate, want, bitrate) {
    var combos = [];
    [want, 2, 1].forEach(function (n) {
      // 同一码率下换声道；码率本身就是硬件编码器的硬门槛（实测 64k 一律不支持）
      [bitrate, 96000, 128000, 192000].forEach(function (br) {
        if (n >= 1) combos.push({ n: n, br: br });
      });
    });
    return (function next(i) {
      if (i >= combos.length) return Promise.resolve(null);
      var cfg = { codec: 'mp4a.40.2', sampleRate: sampleRate, numberOfChannels: combos[i].n, bitrate: combos[i].br };
      return global.AudioEncoder.isConfigSupported(cfg).then(function (s) {
        return s && s.supported ? cfg : next(i + 1);
      }, function () { return next(i + 1); });
    })(0);
  }

  function supported() {
    return !!(global.VideoEncoder && global.AudioEncoder && global.MP4Mux && global.VideoFrame && global.AudioData);
  }

  /* ---------- av1C 构建 ----------
     Chrome 的 AV1 编码器 output 里 decoderConfig.description 为 null（实测），
     但 MP4 的 av01 样本条目必须要 av1C。做法：从首个关键帧码流里
     解析 OBU，取出 Sequence Header OBU，按 ISOBMFF 规范拼出 av1C。 */
  function parseObus(data) {
    var out = [], i = 0;
    while (i < data.length) {
      var hb = data[i];
      var type = (hb >> 3) & 0xF;
      var ext = (hb >> 2) & 1;
      var hasSize = (hb >> 1) & 1;
      var start = i;
      i += 1 + ext;
      if (hasSize) {
        var size = 0, shift = 0, byte;
        do { byte = data[i++]; size |= (byte & 0x7F) << shift; shift += 7; } while ((byte & 0x80) && i < data.length);
        i += size;
      } else {
        i = data.length;   // 无大小字段：占满当前时间单元剩余部分
      }
      if (i > data.length) break;
      out.push({ type: type, bytes: data.subarray(start, i) });
    }
    return out;
  }

  function buildAv1C(firstFrame) {
    try {
      var obus = parseObus(firstFrame), seq = null, i;
      for (i = 0; i < obus.length; i++) if (obus[i].type === 1) { seq = obus[i]; break; }
      if (!seq) return null;

      // 位读取器（从 OBU 载荷开始，跳过 1 字节头 + 可选扩展字节）
      var b = seq.bytes, p = 1 + (((b[0] >> 2) & 1) ? 1 : 0), pos = 0;
      function bits(n) {
        var v = 0, k;
        for (k = 0; k < n; k++) {
          v = (v << 1) | ((b[p + (pos >> 3)] >> (7 - (pos & 7))) & 1);
          pos++;
        }
        return v;
      }

      var seqProfile = bits(3);
      bits(1);                              // still_picture
      var reduced = bits(1);
      var level0 = 0, tier0 = 0;
      if (reduced) {
        level0 = bits(5);
      } else {
        var timing = bits(1);               // timing_info_present_flag（libaom 恒为 0）
        var initDisp = timing ? 0 : bits(1); // initial_display_delay_present_flag
        bits(5);                            // operating_points_cnt_minus_1
        bits(12);                           // operating_point_idc[0]
        level0 = bits(5);
        if (level0 > 7) tier0 = bits(1);    // seq_tier[0]
        // timing/decoder_model/初始显示延迟字段在默认编码里全 0，忽略后续操作点
        if (timing || initDisp || level0 === undefined) return null;
      }

      var fw = bits(4) + 1, bitsW = fw; bits(bitsW);   // frame_width_minus_1
      var fh = bits(4) + 1, bitsH = fh; bits(bitsH);   // frame_height_minus_1
      if (!reduced) bits(1);                // frame_id_numbers_present_flag

      // color_config（profile 0：8bit 4:2:0 为主，按规范完整解析）
      var highBitdepth = 0, twelveBit = 0, mono = 0, subX = 1, subY = 1, csp = 0;
      if (seqProfile === 0 || seqProfile === 1) {
        highBitdepth = bits(1);
        if (highBitdepth && seqProfile === 0) twelveBit = bits(1);
        mono = seqProfile === 0 ? bits(1) : 0;
        if (!mono) {
          if (bits(1)) { bits(8); bits(8); bits(8); }   // color description
          if (seqProfile === 0) {
            subX = subY = 1;                             // 4:2:0
            csp = bits(2);                               // chroma_sample_position
          } else {
            subX = subY = 0;                             // profile 1: 4:4:4
          }
        } else {
          subX = subY = 1;
        }
      } else {
        return null;   // profile 2 不处理（本产品用不到）
      }

      var c = new Uint8Array(4 + seq.bytes.length);
      c[0] = 0x81;                                        // marker=1, version=1
      c[1] = (seqProfile << 5) | level0;
      c[2] = (tier0 << 7) | (highBitdepth << 6) | (twelveBit << 5) |
             (mono << 4) | (subX << 3) | (subY << 2) | csp;
      c[3] = 0;                                           // 无初始呈现延迟
      c.set(seq.bytes, 4);
      return c;
    } catch (e) { return null; }
  }

  /* =========================================================
     run(opts)
     opts: { canvas, render(t, spec, dt), duration, fps, width, height,
             videoBps, audioBps, buffer, onProgress(pct, text), isCancelled }
     ========================================================= */
  function run(opts) {
    var canvas = opts.canvas;
    var fps = opts.fps || 24;
    var W = opts.width, H = opts.height;
    var duration = opts.duration;
    var frames = Math.max(1, Math.round(duration * fps));
    var frameDurUs = 1000000 / fps;
    var VTS = 90000;                       // 视频时间基：24fps → 每帧 3750，整数
    var vFrameDur = Math.round(VTS / fps);

    var muxer = null, encV = null, encA = null;
    var vDesc = null, aDesc = null;
    var lastVTs = -1, outOfOrder = false;
    var progress = opts.onProgress || function () {};
    var cancelled = false;
    var checkCancel = function () { return (opts.isCancelled && opts.isCancelled()) || cancelled; };

    function cleanup() {
      try { if (encV && encV.state !== 'closed') encV.close(); } catch (e) { /* ignore */ }
      try { if (encA && encA.state !== 'closed') encA.close(); } catch (e) { /* ignore */ }
      encV = encA = null;
    }

    progress(0, '准备编码器…');

    // 1) 频谱
    return buildSpectrum(opts.buffer, fps, frames, function (p) {
      progress(p * 12, '分析音频节拍 ' + Math.round(p * 100) + '%');
    }, checkCancel)
      .then(function (specArr) {
        // 2) 视频编码器：av1（小体积模式）或 h264（默认）
        var wantV = opts.videoCodec === 'av1'
          ? pickAv1(W, H, opts.videoBps, fps).then(function (c) {
              if (!c) throw new Error('当前浏览器不支持 AV1 编码');
              return { vcfg: c, boxType: 'av01' };
            })
          : pickAvc(W, H, opts.videoBps, fps).then(function (c) {
              if (!c) throw new Error('当前浏览器不支持 H.264 编码');
              return { vcfg: c, boxType: 'avc1' };
            });
        return wantV.then(function (v) {
          return pickAac(opts.buffer.sampleRate, Math.min(2, opts.buffer.numberOfChannels), opts.audioBps)
            .then(function (acfg) { return { vcfg: v.vcfg, boxType: v.boxType, acfg: acfg }; });
        }).then(function (cfg) {
          var acfg = cfg.acfg;
          if (!acfg) throw new Error('当前浏览器不支持 AAC 音频编码');

          // 硬件 AAC 可能要求更高码率：多出来的部分从视频码率里扣，避免成片超出目标体积
          var extra = Math.max(0, acfg.bitrate - opts.audioBps);
          if (extra > 0) {
            cfg.vcfg.bitrate = Math.max(160000, opts.videoBps - extra);
          }

          var videoSamples = 0, audioSamples = 0;
          var pendingErr = null;

          return new Promise(function (resolve, reject) {
            muxer = new global.MP4Mux.MP4Muxer({
              video: { width: W, height: H, timescale: VTS, bitrate: opts.videoBps, boxType: cfg.boxType },
              audio: { sampleRate: opts.buffer.sampleRate, channels: acfg.numberOfChannels, bitrate: opts.audioBps }
            });

            encV = new global.VideoEncoder({
              output: function (chunk, meta) {
                if (!vDesc) {
                  if (meta && meta.decoderConfig && meta.decoderConfig.description) {
                    // H.264：编码器直接给 avcC；AV1：description 为 null，需自己构建 av1C
                    vDesc = new Uint8Array(meta.decoderConfig.description);
                  } else if (cfg.boxType === 'av01') {
                    var buf0 = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(buf0);
                    vDesc = buildAv1C(buf0);
                    if (!vDesc) {
                      pendingErr = new Error('无法从 AV1 码流提取序列头');
                      return;
                    }
                  } else {
                    pendingErr = new Error('编码器没有输出解码描述信息');
                    return;
                  }
                }
                // 时间戳必须单调（无 B 帧重排），否则封装的 MP4 会错序
                if (chunk.timestamp <= lastVTs) outOfOrder = true;
                lastVTs = chunk.timestamp;

                var buf = new Uint8Array(chunk.byteLength);
                chunk.copyTo(buf);
                muxer.addVideo(buf, vFrameDur, chunk.type === 'key');
                videoSamples++;
                try { chunk.close(); } catch (e) { /* ignore */ }
              },
              error: function (e) { pendingErr = e; }
            });
            encV.configure(cfg.vcfg);

            function fail(e) { cleanup(); reject(e); }

            // ---- 逐帧渲染 + 编码 ----
            var i = 0;
            function frameStep() {
              if (pendingErr) { fail(pendingErr); return; }
              if (checkCancel()) { fail(abortError()); return; }
              var budget = Date.now() + 30;
              try {
                while (i < frames) {
                  if (encV.encodeQueueSize > 6) break;
                  var t = i / fps;
                  opts.render(t, specArr[i], 1 / fps);
                  var vf = new global.VideoFrame(canvas, {
                    timestamp: Math.round(i * frameDurUs),
                    duration: Math.round(frameDurUs)
                  });
                  encV.encode(vf, { keyFrame: i % (fps * 2) === 0 });
                  vf.close();
                  i++;
                  if (Date.now() > budget) break;
                }
              } catch (err) { fail(err); return; }

              progress(12 + (i / frames) * 68, '渲染画面 ' + Math.round(i / frames * 100) + '%（' + i + '/' + frames + ' 帧）');
              if (i < frames) { setTimeout(frameStep, 0); return; }

              // ---- 视频收尾，接着编码音频 ----
              encV.flush().then(function () {
                if (pendingErr) { fail(pendingErr); return; }
                if (outOfOrder) { fail(new Error('编码出现帧重排，请重试')); return; }

                encA = new global.AudioEncoder({
                  output: function (chunk, meta) {
                    if (!aDesc) {
                      if (!meta || !meta.decoderConfig || !meta.decoderConfig.description) {
                        pendingErr = new Error('音频编码器没有输出 AudioSpecificConfig');
                        return;
                      }
                      aDesc = new Uint8Array(meta.decoderConfig.description);
                    }
                    var buf = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(buf);
                    var dur = chunk.duration
                      ? Math.round(chunk.duration * acfg.sampleRate / 1e6)
                      : 1024;
                    muxer.addAudio(buf, dur);
                    audioSamples++;
                    try { chunk.close(); } catch (e) { /* ignore */ }
                  },
                  error: function (e) { pendingErr = e; }
                });
                encA.configure(cfg.acfg);

                var bufA = opts.buffer;
                var sr = bufA.sampleRate;
                var chs = acfg.numberOfChannels;
                var total = bufA.length;
                var planes = [];
                for (var c = 0; c < chs; c++) {
                  planes.push(bufA.getChannelData(Math.min(c, bufA.numberOfChannels - 1)));
                }
                var CHUNK = 4096;
                var pos = 0;

                function audioStep() {
                  if (pendingErr) { fail(pendingErr); return; }
                  if (checkCancel()) { fail(abortError()); return; }
                  var budget = Date.now() + 30;
                  while (pos < total) {
                    if (encA.encodeQueueSize > 12) break;
                    var n = Math.min(CHUNK, total - pos);
                    var data = new Float32Array(n * chs);
                    for (var c2 = 0; c2 < chs; c2++) {
                      data.set(planes[c2].subarray(pos, pos + n), c2 * n);
                    }
                    var ad = new global.AudioData({
                      format: 'f32-planar',
                      sampleRate: sr,
                      numberOfFrames: n,
                      numberOfChannels: chs,
                      timestamp: Math.round(pos / sr * 1e6),
                      data: data
                    });
                    encA.encode(ad);
                    ad.close();
                    pos += n;
                    if (Date.now() > budget) break;
                  }
                  progress(80 + (pos / total) * 12, '编码音频 ' + Math.round(pos / total * 100) + '%');
                  if (pos < total) { setTimeout(audioStep, 0); return; }

                  encA.flush().then(function () {
                    if (pendingErr) { fail(pendingErr); return; }
                    if (!vDesc || !aDesc) { fail(new Error('编码器缺少解码描述信息')); return; }

                    progress(94, '封装 MP4…');
                    setTimeout(function () {
                      try {
                        muxer.v.avcC = vDesc;
                        muxer.a.asc = aDesc;
                        var bytes = muxer.finalize();
                        cleanup();
                        progress(100, '完成');
                        resolve({
                          bytes: bytes,
                          mime: 'video/mp4',
                          frames: videoSamples,
                          audioFrames: audioSamples
                        });
                      } catch (err) { fail(err); }
                    }, 0);
                  }, function (e) { fail(e); });
                }
                audioStep();
              }, function (e) { fail(e); });
            }

            frameStep();
          });
        });
      })
      .catch(function (e) {
        cleanup();
        throw e;
      })
      .then(function (res) { return res; });
  }

  global.SFExport = { supported: supported, run: run, av1Supported: av1Supported, __v: 4 };
})(window);
