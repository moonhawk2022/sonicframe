/* =========================================================
   mp4mux.js — 极简 MP4 封装器（H.264 + AAC，渐进式 / 单 mdat）
   用途：把 WebCodecs 编好的帧按「精确时间戳」写成标准 MP4，
   彻底摆脱 MediaRecorder 的实时录制依赖（掉帧就会冻画面）。

   设计取舍：
   · 一条轨道一个 chunk，结构最简单，播放器兼容性最好
   · 不支持 B 帧重排（编码时要求 dts 单调），所以不需要 ctts
   · moov 放在 mdat 前面（faststart），网页/手机拖动进度条都即时
   ========================================================= */
(function (global) {
  'use strict';

  function be(n, bytes) {
    var a = new Uint8Array(bytes);
    for (var i = bytes - 1; i >= 0; i--) { a[i] = n & 255; n = Math.floor(n / 256); }
    return a;
  }

  function ascii(s) {
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255;
    return a;
  }

  function zeros(n) { return new Uint8Array(n); }

  function cat(list) {
    var n = 0, i;
    for (i = 0; i < list.length; i++) n += list[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }

  function box(type, parts) {
    var body = cat(parts || []);
    return cat([be(8 + body.length, 4), ascii(type), body]);
  }

  function fullbox(type, ver, flags, parts) {
    return box(type, [be((ver << 24) | flags, 4)].concat(parts || []));
  }

  // 32 位定点单位矩阵（16.16，末列 2.30）
  var MATRIX = cat([
    be(0x00010000, 4), be(0, 4), be(0, 4),
    be(0, 4), be(0x00010000, 4), be(0, 4),
    be(0, 4), be(0, 4), be(0x40000000, 4)
  ]);

  /* ---------- ES 描述符（AAC 的 esds 需要）---------- */
  function desc(tag, body) {
    // 4 字节扩展长度（0x80 0x80 0x80 len），body 一定 < 256 字节
    return cat([new Uint8Array([tag, 0x80, 0x80, 0x80, body.length & 255]), body]);
  }

  function esds(asc, channels, bitrate) {
    var dsi = desc(0x05, asc);                        // DecoderSpecificInfo
    var dcd = desc(0x04, cat([                        // DecoderConfigDescriptor
      new Uint8Array([0x40, 0x15]),                   // AAC / AudioStream
      be(0, 3),                                       // bufferSizeDB
      be(bitrate, 4), be(bitrate, 4),
      dsi
    ]));
    var sl = desc(0x06, new Uint8Array([0x02]));      // SLConfigDescriptor
    var es = desc(0x03, cat([be(1, 2), new Uint8Array([0]), dcd, sl]));
    return fullbox('esds', 0, 0, [es]);
  }

  /* ---------- 样本表 ---------- */
  function stts(samples, ts) {
    var runs = [], i;
    for (i = 0; i < samples.length; i++) {
      var d = Math.round(samples[i].dur);
      var last = runs[runs.length - 1];
      if (last && last.d === d) last.c++;
      else runs.push({ c: 1, d: d });
    }
    var parts = [be(runs.length, 4)];
    for (i = 0; i < runs.length; i++) parts.push(be(runs[i].c, 4), be(runs[i].d, 4));
    return fullbox('stts', 0, 0, parts);
  }

  function stss(samples) {
    var keys = [], i;
    for (i = 0; i < samples.length; i++) if (samples[i].key) keys.push(i + 1);
    if (!keys.length || keys.length === samples.length) return null;  // 全关键帧不需要 stss
    var parts = [be(keys.length, 4)];
    for (i = 0; i < keys.length; i++) parts.push(be(keys[i], 4));
    return fullbox('stss', 0, 0, parts);
  }

  function stsz(samples) {
    var parts = [be(0, 4), be(samples.length, 4)];
    for (var i = 0; i < samples.length; i++) parts.push(be(samples[i].data.length, 4));
    return fullbox('stsz', 0, 0, parts);
  }

  function stsc(samples) {
    return fullbox('stsc', 0, 0, [be(1, 4), be(1, 4), be(samples.length, 4), be(1, 4)]);
  }

  function stco(offset) {
    return fullbox('stco', 0, 0, [be(1, 4), be(offset, 4)]);
  }

  /* ---------- 样本条目 ---------- */
  function avc1(w, h, avcC) {
    var name = new Uint8Array(32);
    name.set(ascii('AVC Coding'), 0);
    return box('avc1', [
      zeros(6), be(1, 2),                        // reserved + data_reference_index
      zeros(16),                                 // pre_defined / reserved
      be(w, 2), be(h, 2),
      be(0x00480000, 4), be(0x00480000, 4),      // 72 dpi
      zeros(4), be(1, 2), name,
      be(0x0018, 2), be(0xFFFF, 2),
      box('avcC', [avcC])
    ]);
  }

  // AV1 样本条目（WebCodecs 的 decoderConfig.description 就是 av1C 载荷）
  function av01(w, h, av1C) {
    var name = new Uint8Array(32);
    name.set(ascii('AV01 Coding'), 0);
    return box('av01', [
      zeros(6), be(1, 2),
      zeros(16),
      be(w, 2), be(h, 2),
      be(0x00480000, 4), be(0x00480000, 4),
      zeros(4), be(1, 2), name,
      be(0x0018, 2), be(0xFFFF, 2),
      box('av1C', [av1C])
    ]);
  }

  function mp4a(rate, channels, asc, bitrate) {
    return box('mp4a', [
      zeros(6), be(1, 2),
      zeros(8),
      be(channels, 2), be(16, 2), be(0, 2), be(0, 2),
      be(rate << 16, 4),
      esds(asc, channels, bitrate)
    ]);
  }

  function dinf() {
    return box('dinf', [fullbox('dref', 0, 0, [be(1, 4), fullbox('url ', 0, 1, [])])]);
  }

  function hdlr(type, name) {
    return fullbox('hdlr', 0, 0, [be(0, 4), ascii(type), zeros(12), ascii(name), new Uint8Array([0])]);
  }

  /* ---------- 轨道 ---------- */
  function trak(cfg) {
    var s = cfg.samples;
    var durTk = 0;
    for (var i = 0; i < s.length; i++) durTk += Math.round(s[i].dur);
    var durSec = durTk / cfg.timescale;

    var tkhd = fullbox('tkhd', 0, 3, [
      be(0, 4), be(0, 4), be(cfg.id, 4), be(0, 4), be(Math.round(durSec * 1000), 4),
      zeros(8),
      be(0, 2), be(0, 2), be(cfg.kind === 'soun' ? 0x0100 : 0, 2), be(0, 2),
      MATRIX,
      be(Math.round(cfg.width * 65536), 4), be(Math.round(cfg.height * 65536), 4)
    ]);

    var stblParts = [
      fullbox('stsd', 0, 0, [be(1, 4), cfg.entry]),
      stts(s, cfg.timescale),
      stss(s),
      stsc(s),
      stsz(s),
      stco(cfg.offset)
    ].filter(Boolean);

    var minf = box('minf', [
      cfg.kind === 'vide'
        ? fullbox('vmhd', 0, 1, [be(0, 2), be(0, 2), be(0, 2), be(0, 2)])
        : fullbox('smhd', 0, 0, [be(0, 2), be(0, 2)]),
      dinf(),
      box('stbl', stblParts)
    ]);

    var mdia = box('mdia', [
      fullbox('mdhd', 0, 0, [
        be(0, 4), be(0, 4), be(cfg.timescale, 4), be(durTk, 4),
        new Uint8Array([0x55, 0xC4]), be(0, 2)
      ]),
      hdlr(cfg.kind, cfg.kind === 'vide' ? 'VideoHandler' : 'SoundHandler'),
      minf
    ]);

    return { box: box('trak', [tkhd, mdia]), durSec: durSec };
  }

  /* =========================================================
     MP4Muxer
     ========================================================= */
  function MP4Muxer(opts) {
    this.v = opts.video;       // {width,height,timescale,avcC,bitrate}
    this.a = opts.audio;       // {sampleRate,channels,asc,bitrate}
    this.vs = [];
    this.as = [];
  }

  MP4Muxer.prototype.addVideo = function (data, dur, isKey) {
    this.vs.push({ data: data, dur: dur, key: !!isKey });
  };

  MP4Muxer.prototype.addAudio = function (data, dur) {
    this.as.push({ data: data, dur: dur, key: true });
  };

  MP4Muxer.prototype.finalize = function () {
    var vs = this.vs, as = this.as;
    if (!vs.length) throw new Error('没有视频帧');

    var vBytes = 0, aBytes = 0, i;
    for (i = 0; i < vs.length; i++) vBytes += vs[i].data.length;
    for (i = 0; i < as.length; i++) aBytes += as[i].data.length;

    var brands = this.v.boxType === 'av01'
      ? [ascii('isom'), ascii('iso2'), ascii('av01'), ascii('mp41')]
      : [ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41')];
    var ftyp = box('ftyp', [ascii('isom'), be(0x200, 4)].concat(brands));

    // moov 长度与偏移无关（stco 固定 4 字节），先构建一次拿到长度
    var mk = function (vOff, aOff) {
      var vTrak = trak({
        id: 1, kind: 'vide', samples: vs, timescale: this.v.timescale,
        width: this.v.width, height: this.v.height,
        entry: this.v.boxType === 'av01'
          ? av01(this.v.width, this.v.height, this.v.avcC)
          : avc1(this.v.width, this.v.height, this.v.avcC),
        offset: vOff
      });
      var parts = [
        fullbox('mvhd', 0, 0, [
          be(0, 4), be(0, 4), be(1000, 4),
          be(Math.round(Math.max(vTrak.durSec, as.length ? this.aDurSec() : 0) * 1000), 4),
          be(0x00010000, 4), be(0x0100, 2), be(0, 2), zeros(8),
          MATRIX, zeros(24), be(3, 4)
        ]),
        vTrak.box
      ];
      if (as.length) {
        parts.push(trak({
          id: 2, kind: 'soun', samples: as, timescale: this.a.sampleRate,
          width: 0, height: 0,
          entry: mp4a(this.a.sampleRate, this.a.channels, this.a.asc, this.a.bitrate),
          offset: aOff
        }).box);
      }
      return box('moov', parts);
    }.bind(this);

    var probe = mk(0, 0);
    var mdatStart = ftyp.length + probe.length + 8;
    var vOff = mdatStart;
    var aOff = mdatStart + vBytes;
    var moov = mk(vOff, aOff);

    var mdat = box('mdat', [cat(vs.map(function (s) { return s.data; })), cat(as.map(function (s) { return s.data; }))]);

    return cat([ftyp, moov, mdat]);
  };

  MP4Muxer.prototype.aDurSec = function () {
    var d = 0;
    for (var i = 0; i < this.as.length; i++) d += Math.round(this.as[i].dur);
    return d / this.a.sampleRate;
  };

  global.MP4Mux = { MP4Muxer: MP4Muxer };
})(window);
