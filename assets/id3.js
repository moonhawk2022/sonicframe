/* =========================================================
   id3.js — 全格式音频标签解析（零依赖）
   从 MP3 / WAV / FLAC / M4A 头部读出：标题 / 歌手 / 专辑 /
   内嵌封面 / 内嵌歌词（USLT 无时间戳、SYLT 带时间戳）
   · MP3        ：ID3v2.3 / v2.4（文件头 "ID3"）
   · WAV (RIFF) ：扫描 'id3 ' 块（很多工具会把 ID3 写进 WAV）
   · FLAC       ：VORBIS_COMMENT 的 LYRICS/UNSYNCEDLYRICS + PICTURE
   · M4A (MP4)  ：ilst 原子里的 ©lyr / ©nam / ©ART / covr
   找不到标签时也能从文件名猜「歌手 - 歌名」。
   ========================================================= */
(function (global) {
  'use strict';

  /* ---------- 文本解码 ---------- */
  function decodeText(bytes, encoding) {
    if (!bytes || !bytes.length) return '';

    // 去掉尾部填充 0
    var end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    var view = bytes.subarray(0, end);
    if (!view.length) return '';

    try {
      if (encoding === 1) {
        // UTF-16 带 BOM
        if (view[0] === 0xff && view[1] === 0xfe) {
          return new TextDecoder('utf-16le').decode(view.subarray(2));
        }
        if (view[0] === 0xfe && view[1] === 0xff) {
          return new TextDecoder('utf-16be').decode(view.subarray(2));
        }
        return new TextDecoder('utf-16le').decode(view);
      }
      if (encoding === 2) return new TextDecoder('utf-16be').decode(view);
      if (encoding === 3) return new TextDecoder('utf-8').decode(view);
      // encoding 0：规范是 ISO-8859-1，但中文 MP3 经常是 GBK，优先按 GBK 解
      try {
        return new TextDecoder('gbk').decode(view);
      } catch (e) {
        return new TextDecoder('iso-8859-1').decode(view);
      }
    } catch (e) {
      return '';
    }
  }

  /* ---------- 同步安全整数（syncsafe）---------- */
  function syncsafe(b, o) {
    return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
  }

  function readUint32(b, o) {
    return ((b[o] & 0xff) << 24) | ((b[o + 1] & 0xff) << 16) | ((b[o + 2] & 0xff) << 8) | (b[o + 3] & 0xff);
  }

  function readUint32LE(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  /* ---------- 帧 ID 校验 ---------- */
  function isFrameId(b, o) {
    for (var i = 0; i < 4; i++) {
      var c = b[o + i];
      if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) return false;
    }
    return true;
  }

  /* ---------- 按编码找字符串终止符，返回 {end, next} ---------- */
  function findTerm(b, start, end, enc) {
    if (enc === 1 || enc === 2) {
      var i = start;
      while (i + 1 < end) {
        if (b[i] === 0 && b[i + 1] === 0) return { end: i, next: i + 2 };
        i += 2;
      }
      return { end: end, next: end };
    }
    var j = start;
    while (j < end && b[j] !== 0) j++;
    return { end: j, next: Math.min(end, j + 1) };
  }

  /* ---------- 解析 APIC（封面）---------- */
  function parseAPIC(data) {
    if (!data.length) return null;
    var enc = data[0];
    var i = 1;
    // MIME，ASCII，以 0 结尾
    var mimeStart = i;
    while (i < data.length && data[i] !== 0) i++;
    var mime = '';
    for (var k = mimeStart; k < i; k++) mime += String.fromCharCode(data[k]);
    i++; // 跳过 0
    i++; // 图片类型
    // 描述，按编码宽度决定终止符
    var d = findTerm(data, i, data.length, enc);
    i = d.next;
    if (i >= data.length) return null;
    return { mime: mime || 'image/jpeg', bytes: data.subarray(i) };
  }

  /* ---------- 解析 USLT（无时间戳歌词）---------- */
  function parseUSLT(data) {
    if (data.length < 5) return '';
    var enc = data[0];
    var d = findTerm(data, 4, data.length, enc);   // 跳过语言(3)，找描述符终止符
    var text = decodeText(data.subarray(d.next), enc);
    return text.trim();
  }

  /* ---------- 解析 SYLT（带时间戳歌词）→ 转成 LRC 文本 ---------- */
  function parseSYLT(data) {
    if (data.length < 7) return '';
    var enc = data[0];
    var timeFormat = data[4];   // 1=MPEG帧 2=毫秒
    var d = findTerm(data, 6, data.length, enc);   // 跳过内容描述符
    var pos = d.next;
    var rows = [];

    while (pos + 4 <= data.length) {
      var t = findTerm(data, pos, data.length, enc);
      var text = decodeText(data.subarray(pos, t.end), enc);
      pos = t.next;
      if (pos + 4 > data.length) break;
      var stamp = readUint32(data, pos);
      pos += 4;
      if (!text.trim()) continue;
      var ms = timeFormat === 2 ? stamp : -1;
      if (ms < 0) continue;   // MPEG 帧格式无法换算，放弃同步
      var cs = Math.floor((ms % 1000) / 10);
      var sec = Math.floor(ms / 1000);
      var mm = Math.floor(sec / 60);
      var ss = ('0' + (sec % 60)).slice(-2);
      rows.push({ t: ms / 1000, line: '[' + mm + ':' + ss + '.' + ('0' + cs).slice(-2) + ']' + text });
    }

    if (rows.length < 2) return '';
    rows.sort(function (a, b) { return a.t - b.t; });
    return rows.map(function (r) { return r.line; }).join('\n');
  }

  /* ---------- 解析一个 ID3v2 块 ---------- */
  function parseID3Block(arrayBuffer, startOffset) {
    var out = { title: '', artist: '', album: '', picture: null, lyrics: '', synced: false };
    var base = startOffset || 0;
    var head = new Uint8Array(arrayBuffer, base, Math.min(arrayBuffer.byteLength - base, 24));
    if (head.length < 10) return out;
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out; // "ID3"

    var major = head[3];
    var tagSize = syncsafe(head, 6);
    var total = Math.min(arrayBuffer.byteLength - base, 10 + tagSize);
    var bytes = new Uint8Array(arrayBuffer, base, total);
    var pos = 10;

    while (pos + 10 <= total) {
      if (bytes[pos] === 0) break; // 进入 padding
      if (!isFrameId(bytes, pos)) break;

      var id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      var size = major === 4 ? syncsafe(bytes, pos + 4) : readUint32(bytes, pos + 4);
      if (size <= 0 || pos + 10 + size > total) break;

      var body = bytes.subarray(pos + 10, pos + 10 + size);

      if (id === 'TIT2' || id === 'TT2') out.title = decodeText(body.subarray(1), body[0]).trim();
      else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(body.subarray(1), body[0]).trim();
      else if (id === 'TALB' || id === 'TAL') out.album = decodeText(body.subarray(1), body[0]).trim();
      else if (id === 'APIC' || id === 'PIC') out.picture = parseAPIC(body);
      else if (id === 'USLT' || id === 'ULT') {
        var t = parseUSLT(body);
        if (t) out.lyrics = t;
      } else if (id === 'SYLT' || id === 'SLT') {
        var s = parseSYLT(body);
        if (s) { out.lyrics = s; out.synced = true; }
      }

      pos += 10 + size;
    }

    return out;
  }

  /* ---------- FLAC：VORBIS_COMMENT + PICTURE ---------- */
  function parseFLAC(ab) {
    var out = { title: '', artist: '', album: '', picture: null, lyrics: '', synced: false };
    var b = new Uint8Array(ab);
    if (b.length < 8) return out;

    var pos = 4; // 跳过 "fLaC"
    while (pos + 4 <= b.length) {
      var head = b[pos];
      var last = head & 0x80;
      var type = head & 0x7f;
      var size = (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
      var body = pos + 4;
      if (body + size > b.length) break;

      if (type === 4) {
        // VORBIS_COMMENT：全是小端
        var p = body + readUint32LE(b, body) + 4;   // 跳过 vendor
        var count = readUint32LE(b, p);
        p += 4;
        for (var i = 0; i < count && p + 4 <= body + size; i++) {
          var len = readUint32LE(b, p);
          p += 4;
          if (p + len > body + size) break;
          var kv = '';
          try { kv = new TextDecoder('utf-8').decode(b.subarray(p, p + len)); } catch (e) { /* skip */ }
          p += len;
          var eq = kv.indexOf('=');
          if (eq < 0) continue;
          var key = kv.slice(0, eq).toUpperCase();
          var val = kv.slice(eq + 1).trim();
          if (!val) continue;
          if (key === 'TITLE') out.title = out.title || val;
          else if (key === 'ARTIST') out.artist = out.artist || val;
          else if (key === 'ALBUM') out.album = out.album || val;
          else if (key === 'LYRICS' || key === 'UNSYNCEDLYRICS' || key === 'UNSYNCED LYRICS' || key === 'LYRICS-XXX') {
            out.lyrics = out.lyrics || val;
          } else if (key === 'SYNCEDLYRICS' || key === 'SYNCED LYRICS') {
            out.lyrics = out.lyrics || val;
            out.synced = true;
          }
        }
      } else if (type === 6 && !out.picture) {
        // PICTURE: type(4) mimeLen(4) mime descLen(4) desc w/h/depth/colors(16) dataLen(4) data
        var q = body + 4;
        var mimeLen = readUint32(b, q);
        q += 4;
        var mime = '';
        for (var m = 0; m < mimeLen && q + m < b.length; m++) mime += String.fromCharCode(b[q + m]);
        q += mimeLen;
        var descLen = readUint32(b, q);
        q += 4 + descLen + 16;
        var dataLen = readUint32(b, q);
        q += 4;
        if (q + dataLen <= b.length && dataLen > 100) {
          out.picture = { mime: mime || 'image/jpeg', bytes: b.subarray(q, q + dataLen) };
        }
      }

      pos = body + size;
      if (last) break;
    }
    return out;
  }

  /* ---------- M4A / MP4：ilst 原子 ---------- */
  function parseM4A(ab) {
    var out = { title: '', artist: '', album: '', picture: null, lyrics: '', synced: false };
    var b = new Uint8Array(ab);
    if (b.length < 12) return out;

    var CODE_LYR = [0xa9, 0x6c, 0x79, 0x72];   // ©lyr
    var CODE_NAM = [0xa9, 0x6e, 0x61, 0x6d];   // ©nam
    var CODE_ART = [0xa9, 0x41, 0x52, 0x54];   // ©ART
    var CODE_ALB = [0xa9, 0x61, 0x6c, 0x62];   // ©alb
    var CODE_COV = [0x63, 0x6f, 0x76, 0x72];   // covr

    function eq4(o, code) {
      return b[o] === code[0] && b[o + 1] === code[1] && b[o + 2] === code[2] && b[o + 3] === code[3];
    }

    // 在 [start,end) 里遍历原子，找到 ilst 后解析其子项
    function walk(start, end, depth) {
      if (depth > 8) return;
      var off = start;
      while (off + 8 <= end) {
        var size = readUint32(b, off);
        var hs = 8;
        if (size === 1) {
          // 64 位长度：只取低 32 位（音频标签远不会超过 4GB）
          size = readUint32(b, off + 12);
          hs = 16;
        }
        if (size === 0) size = end - off;
        if (size < hs || off + size > end) break;

        if (eq4(off + hs - 4, [0x6d, 0x65, 0x74, 0x61])) {
          // meta 原子有 4 字节 version/flags，子原子从 +4 开始
          walk(off + hs + 4, off + size, depth + 1);
        } else if (eq4(off + hs - 4, [0x69, 0x6c, 0x73, 0x74])) {
          readIlst(off + hs, off + size);
        } else {
          walk(off + hs, off + size, depth + 1);
        }
        off += size;
      }
    }

    function readIlst(start, end) {
      var off = start;
      while (off + 8 <= end) {
        var size = readUint32(b, off);
        if (size < 8 || off + size > end) break;
        var dataOff = -1;

        if (eq4(off + 4, CODE_LYR) || eq4(off + 4, CODE_NAM) || eq4(off + 4, CODE_ART) || eq4(off + 4, CODE_ALB)) {
          // 子原子：data
          var sub = off + 8;
          while (sub + 8 <= off + size) {
            var ssize = readUint32(b, sub);
            if (ssize < 8 || sub + ssize > off + size) break;
            if (b[sub + 4] === 0x64 && b[sub + 5] === 0x61 && b[sub + 6] === 0x74 && b[sub + 7] === 0x61) {
              dataOff = sub + 16;   // data 头：size(4)+type(4)+ver/flags(4)+locale(4)
              break;
            }
            sub += ssize;
          }
          if (dataOff > 0) {
            var text = decodeText(b.subarray(dataOff, off + size), 3);
            if (eq4(off + 4, CODE_NAM)) out.title = out.title || text.trim();
            else if (eq4(off + 4, CODE_ART)) out.artist = out.artist || text.trim();
            else if (eq4(off + 4, CODE_ALB)) out.album = out.album || text.trim();
            else if (eq4(off + 4, CODE_LYR) && text.trim()) out.lyrics = out.lyrics || text.trim();
          }
        } else if (eq4(off + 4, CODE_COV) && !out.picture) {
          var sub2 = off + 8;
          while (sub2 + 8 <= off + size) {
            var ssize2 = readUint32(b, sub2);
            if (ssize2 < 8 || sub2 + ssize2 > off + size) break;
            if (b[sub2 + 4] === 0x64 && b[sub2 + 5] === 0x61 && b[sub2 + 6] === 0x74 && b[sub2 + 7] === 0x61) {
              var dlen = ssize2 - 16;
              if (dlen > 100) {
                var flags = readUint32(b, sub2 + 8) & 0xffffff;
                out.picture = { mime: flags === 14 ? 'image/png' : 'image/jpeg', bytes: b.subarray(sub2 + 16, sub2 + ssize2) };
              }
              break;
            }
            sub2 += ssize2;
          }
        }
        off += size;
      }
    }

    walk(0, b.length, 0);
    return out;
  }

  /* ---------- WAV (RIFF)：找 id3 块 ---------- */
  function parseWAV(ab) {
    var b = new Uint8Array(ab);
    if (b.length < 12) return { title: '', artist: '', album: '', picture: null, lyrics: '', synced: false };

    var pos = 12;   // 跳过 "RIFF" + size + "WAVE"
    while (pos + 8 <= b.length) {
      var size = readUint32LE(b, pos + 4);
      var id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
      if (id === 'id3 ' || id === 'ID3 ' || id === 'id3\x00' || id === 'apEt') {
        // 块内是一个完整 ID3v2
        return parseID3Block(ab, pos + 8);
      }
      pos += 8 + size + (size & 1);   // RIFF 块按字对齐
    }
    return { title: '', artist: '', album: '', picture: null, lyrics: '', synced: false };
  }

  /* ---------- 主入口：自动识别容器 ---------- */
  function parse(arrayBuffer) {
    var b = new Uint8Array(arrayBuffer);
    var empty = { title: '', artist: '', album: '', picture: null, lyrics: '', synced: false };
    if (b.length < 16) return empty;

    // 1) 文件头直接是 ID3（MP3，或带 ID3 头的 WAV）
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return parseID3Block(arrayBuffer, 0);

    // 2) 容器嗅探
    var four = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (four === 'RIFF') return parseWAV(arrayBuffer);
    if (four === 'fLaC') return parseFLAC(arrayBuffer);
    var brand = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (brand === 'ftyp') return parseM4A(arrayBuffer);

    return empty;
  }

  /* ---------- 从文件名猜歌名 ---------- */
  function guessFromName(filename) {
    var name = filename.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim();
    var m = name.match(/^(.{2,40}?)\s*[-—–]\s*(.{1,30})$/);
    if (m) {
      // “歌手 - 歌名” 或 “歌名 - 歌手”，两者都可能，默认按 歌手-歌名
      return { artist: m[1].trim(), title: m[2].trim() };
    }
    return { artist: '', title: name || '未命名歌曲' };
  }

  global.ID3 = { parse: parse, guessFromName: guessFromName };
})(window);
