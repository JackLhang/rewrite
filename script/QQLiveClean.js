/*
 * QQLiveClean.js — 腾讯视频 iOS（v9.x / MVL 布局）去广告 + 个人中心与 Tab 精简
 * 运行环境: Loon Script (http-request / http-response)
 * 实现: 无损 protobuf 子树删除（wire-format 级，不解析业务 schema）
 * date:2026-09-14 17:17:31
 */
// ============================================================
// 腾讯视频去广告 / 界面精简  (适配 iOS 9.04.46.25021)
// 适用：Surge / Loon / Stash（响应脚本需 opens binary-body-mode）
// 功能：
//   1) vv.video.qq.com / vv6.video.qq.com getvinfo/batchvinfo
//      请求参数改写（sppreviewtype/spsrt -> 0，去贴片/试看广告）
//   2) i.video.qq.com / iwan.video.qq.com 广告类 TRPC 请求拦截
//      （个人中心广告 / 激励广告 / 浮窗活动 / VIP推广 / 游戏预加载）
//   3) i.video.qq.com 响应 protobuf 手术：
//      · 顶部频道导航 + 底部 Tabs：去除 短剧 / 好物 / 好片
//      · 「我的」页：去除运营推广项与 VIP 营销卡（黑名单见下）
// ============================================================


// ============================================================
// 腾讯视频去广告 / 界面精简  (适配 iOS 9.04.46.25021)
// 适用：Surge / Loon / Stash（响应脚本需开启 binary-body-mode）
// 功能：
//   1) vv.video.qq.com / vv6.video.qq.com getvinfo/batchvinfo
//      请求参数改写（sppreviewtype/spsrt -> 0，去贴片/试看广告）
//   2) i.video.qq.com / iwan.video.qq.com 广告类 TRPC 请求拦截
//      （个人中心广告 / 激励广告 / 浮窗活动 / VIP推广 / 游戏预加载）
//   3) i.video.qq.com 响应 protobuf 手术：
//      · 顶部频道导航 + 底部 Tabs：去除 短剧 / 好物 / 好片
//      · 「我的」页：去除运营推广项、VIP 营销卡与左上角游戏中心
//   说明：开屏广告由模块 [Rule] 拦截，不在此脚本处理
// ============================================================

// ============================================================
// 腾讯视频去广告 / 界面精简  (适配 iOS 9.04.46.25021)
// 适用：Surge / Loon / Stash（响应脚本需开启 binary-body-mode）
// 功能：
//   1) vv.video.qq.com / vv6.video.qq.com getvinfo/batchvinfo
//      请求参数改写（sppreviewtype/spsrt -> 0，去贴片/试看广告）
//   2) i.video.qq.com / iwan.video.qq.com 广告类 TRPC 请求拦截
//      （个人中心广告 / 激励广告 / 浮窗活动 / VIP推广 / 游戏预加载；
//       方法名在 URL 或 body 均可命中）
//   3) i.video.qq.com 响应 protobuf 手术：
//      · 顶部频道导航 + 底部 Tabs：去除 短剧 / 好物 / 好片
//      · 「我的」页：去除运营推广项、VIP 营销卡与左上角游戏中心
//      · 首页 feed / 各 MVL 页面：删除广告卡（iPhone 类素材卡、咨询类广告、
//        GDT 广告 SDK 卡，特征 ad_pos_id/ad_ecpm/广告标签 等）
//   说明：开屏广告由模块 [Rule] 拦截，不在此脚本处理
// ============================================================
(function () {
  'use strict';

  // ---------------- 目标清单 ----------------
  var NAV_TABS = ['短剧', '好物', '好片']; // 顶部频道 + 底部 tab
  var MY_ITEMS = [ // 「我的」页：运营推广项 + VIP 营销卡标题 + 顶部游戏中心
    '特惠升级SVIP', '新人16元看比赛', 'JUMP卡上新', '年轻人专属会员', '优惠宽带送VIP',
    '游戏福利', 'GOODS商城', '免费看漫剧', '免费领会员', '摸鱼免费玩',
    '我的游戏', '爱玩游戏', '免流量领会员', '领权益送会员',
    '游戏' // 「我的」页左上角游戏中心入口（sp_mycntr_ceiling）
  ];
  var AD_METHODS = [ // 广告类 TRPC 方法名片段（命中断言 URL 或请求体）
    'GetPersonalCenterAdData',   // 个人中心广告数据
    'reward_ad_ssp',             // 激励广告（入口/挂件/关注礼）
    'GetFloatActivity',          // 浮窗活动
    'AccessPromotion',           // VIP 广告推广
    'GetPromotionGlobalConfig',  // 推广全局配置
    'GetSDKInitData',            // 移动(CMCC)推广 SDK
    'GetPreloadGames'            // 游戏预加载（我的游戏/爱玩游戏）
  ];
  // 广告卡特征（统一按字节匹配，兼容二进制混排字段）
  var AD_EXACT = ['广告']; // 精确等值（广告标签）
  var AD_FEATS = ['ad_pos_id', 'rerank_ad_info', 'ad_ecpm', 'advertiser', 'ad_orderid', 'is_locked_ad', 'ad_block_']; // 广告 SDK 字段/参数
  var AD_TEXTS = ['专属咨询顾问', '打开微信客服获取更多内容']; // 咨询类广告卡文案
  var AD_URLS = ['pgdt.gtimg.cn', 'review.gdtimg.com', 'c.l.qq.com/click', 'gdtimg']; // 广告素材/跳转域
  var AD_URLPARAMS = ['ad_playmode=', 'ad_is_fail=', 'ad_loca=', 'ad_idx=', 'ad_trans_native=', 'ad_schedule_ability=', 'ad_fixed_pctr=', 'ad_product_id=']; // 广告跳转链参数
  var FEAT_NAV = 'EditChannelListActivity';  // 顶部频道导航响应特征
  var FEAT_BOTTOM = 'GetTabListRsp';         // 底部 tab 响应特征
  var FEAT_MY1 = 'user_center_top_function'; // 我的页特征
  var FEAT_MY2 = 'user_center_more_function';
  var FEAT_MY3 = 'sp_mycntr_ceiling';        // 我的页顶部功能区特征

  // ---------------- 工具函数 ----------------
  function log(m) {
    try { console.log('[qqvideo-clean] ' + m); } catch (e) {}
  }
  function toU8(b) {
    if (b instanceof Uint8Array) return b;
    if (typeof ArrayBuffer !== 'undefined') {
      if (b instanceof ArrayBuffer) return new Uint8Array(b);
      if (ArrayBuffer.isView && ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    }
    if (typeof b === 'string') {
      var arr = new Uint8Array(b.length);
      for (var i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i) & 0xff;
      return arr;
    }
    return null;
  }
  function strToU8(s) {
    var arr = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i) & 0xff;
    return arr;
  }
  function toStr(b) {
    if (typeof b === 'string') return b;
    if (b instanceof Uint8Array) {
      var s = '';
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return s;
    }
    return '';
  }
  function utf8Of(bytes, start, end) {
    var out = '', i = start;
    while (i < end) {
      var b0 = bytes[i];
      if (b0 < 0x80) { out += String.fromCharCode(b0); i++; }
      else if ((b0 & 0xE0) === 0xC0) {
        if (i + 1 >= end || (bytes[i + 1] & 0xC0) !== 0x80) return null;
        out += String.fromCharCode(((b0 & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2;
      } else if ((b0 & 0xF0) === 0xE0) {
        if (i + 2 >= end || (bytes[i + 1] & 0xC0) !== 0x80 || (bytes[i + 2] & 0xC0) !== 0x80) return null;
        out += String.fromCharCode(((b0 & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3;
      } else if ((b0 & 0xF8) === 0xF0) {
        if (i + 3 >= end) return null;
        var cp = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
        cp -= 0x10000;
        if (cp < 0) return null;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); i += 4;
      } else return null;
    }
    return out;
  }
  // UTF-8 字符串 -> latin1 字节串（用于特征字节级匹配）
  function latinOf(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0x800) out += String.fromCharCode(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c <= 0xDBFF) {
        var c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          i++;
          var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          out += String.fromCharCode(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        } else out += String.fromCharCode(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else out += String.fromCharCode(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return out;
  }
  var AD_EXACT_L = [];
  for (var _ei = 0; _ei < AD_EXACT.length; _ei++) AD_EXACT_L.push(latinOf(AD_EXACT[_ei]));
  var AD_NEEDLES = [];
  (function () {
    var all = AD_FEATS.concat(AD_TEXTS, AD_URLS, AD_URLPARAMS);
    for (var i = 0; i < all.length; i++) AD_NEEDLES.push(latinOf(all[i]));
  })();

  function readVarint(bytes, pos) {
    var result = 0, shift = 0;
    while (true) {
      if (pos >= bytes.length) return null;
      var b = bytes[pos++];
      result += (b & 0x7F) * Math.pow(2, shift);
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 35) return null;
    }
    return { value: result, pos: pos };
  }
  function varintBytes(v) {
    var out = [];
    do {
      var b = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) b |= 0x80;
      out.push(b);
    } while (v > 0);
    return new Uint8Array(out);
  }

  // ---------------- protobuf 解析 ----------------
  function parseMessage(bytes, start, end) {
    var fields = [], pos = start;
    while (pos < end) {
      var s = pos;
      var tr = readVarint(bytes, pos);
      if (!tr) return null;
      pos = tr.pos;
      var tag = tr.value, fno = Math.floor(tag / 8), wire = tag % 8;
      if (fno === 0) return null;
      var fl = { f: fno, w: wire, start: s, end: s, vStart: pos, vEnd: pos, len: 0, msg: null };
      if (wire === 0) {
        var vr = readVarint(bytes, pos);
        if (!vr) return null;
        pos = vr.pos; fl.end = pos;
      } else if (wire === 1) {
        if (pos + 8 > end) return null;
        pos += 8; fl.end = pos;
      } else if (wire === 2) {
        var lr = readVarint(bytes, pos);
        if (!lr) return null;
        var len = lr.value; pos = lr.pos;
        if (pos + len > end) return null;
        fl.len = len; fl.vStart = pos; fl.vEnd = pos + len;
        pos += len; fl.end = pos;
      } else if (wire === 5) {
        if (pos + 4 > end) return null;
        pos += 4; fl.end = pos;
      } else return null;
      fields.push(fl);
    }
    if (pos !== end) return null;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.w === 2 && f.len >= 2) {
        var sub = parseMessage(bytes, f.vStart, f.vEnd);
        if (sub !== null) f.msg = sub;
      }
    }
    return fields;
  }

  function collectMatches(bytes, msg, chain, targets, matches) {
    if (!msg) return;
    for (var i = 0; i < msg.length; i++) {
      var fl = msg[i];
      if (fl.w !== 2) continue;
      if (fl.len >= 1 && fl.len <= 64) {
        var s = utf8Of(bytes, fl.vStart, fl.vEnd);
        if (s !== null && targets.indexOf(s) >= 0) {
          matches.push({ chain: chain, field: fl });
        }
      }
      var sub = parseMessage(bytes, fl.vStart, fl.vEnd);
      if (sub !== null) {
        fl.msg = sub;
        var nc = chain.concat([fl]);
        collectMatches(bytes, sub, nc, targets, matches);
      }
    }
  }

  // 收集广告特征字段（字节级匹配：精确"广告"标签 / 广告 SDK 字段 / 咨询文案 / 广告素材 URL / 广告跳转链参数）
  function collectAdMatches(bytes, msg, chain, matches) {
    if (!msg) return;
    for (var i = 0; i < msg.length; i++) {
      var fl = msg[i];
      if (fl.w !== 2) continue;
      if (fl.len >= 6 && fl.len <= 4096) {
        var latin = toStr(bytes.subarray(fl.vStart, fl.vEnd));
        var hit = false;
        for (var e = 0; e < AD_EXACT_L.length; e++) {
          if (latin === AD_EXACT_L[e]) { hit = true; break; }
        }
        if (!hit) {
          for (var n = 0; n < AD_NEEDLES.length; n++) {
            if (latin.indexOf(AD_NEEDLES[n]) >= 0) { hit = true; break; }
          }
        }
        if (hit) matches.push({ chain: chain, field: fl });
      }
      var sub = parseMessage(bytes, fl.vStart, fl.vEnd);
      if (sub !== null) {
        fl.msg = sub;
        collectAdMatches(bytes, sub, chain.concat([fl]), matches);
      }
    }
  }

  // 卡片级判定：
  //  · 含直接的 http/https/txvideo URL 字符串字段，或
  //  · 字段数 >= 6 且含 varint 字段（导航项/底部 tab 等结构特征）
  //  URL 检测支持子消息内嵌一层（部分 URL 被包在子消息中）
  function isCard(bytes, msg) {
    if (!msg || msg.length < 3) return false;
    var hasVarint = false, hasUrl = false;
    for (var i = 0; i < msg.length; i++) {
      var fl = msg[i];
      if (fl.w === 0 || fl.w === 1 || fl.w === 5) hasVarint = true;
      if (fl.w !== 2) continue;
      if (fl.len >= 8) {
        var s = utf8Of(bytes, fl.vStart, fl.vEnd);
        if (s !== null && (s.indexOf('http://') === 0 || s.indexOf('https://') === 0 || s.indexOf('txvideo://') === 0)) hasUrl = true;
        if (!hasUrl && fl.msg) {
          for (var j = 0; j < fl.msg.length; j++) {
            var c = fl.msg[j];
            if (c.w === 2 && c.len >= 8) {
              var cs = utf8Of(bytes, c.vStart, c.vEnd);
              if (cs !== null && (cs.indexOf('http://') === 0 || cs.indexOf('https://') === 0 || cs.indexOf('txvideo://') === 0)) { hasUrl = true; break; }
            }
          }
        }
      }
    }
    if (hasUrl) return true;
    if (msg.length >= 6 && hasVarint) return true;
    return false;
  }

  function cardFieldFor(bytes, match) {
    var chain = match.chain;
    for (var i = chain.length - 1; i >= 0; i--) {
      var f = chain[i];
      if (f.msg && isCard(bytes, f.msg)) return f;
    }
    return null;
  }

  // ---------------- 重建 ----------------
  function subtreeHasRemoval(msg, removed) {
    for (var i = 0; i < msg.length; i++) {
      if (removed[msg[i].start]) return true;
      if (msg[i].msg && subtreeHasRemoval(msg[i].msg, removed)) return true;
    }
    return false;
  }
  function rebuildField(bytes, fl, removed) {
    if (fl.w !== 2) {
      return bytes.subarray(fl.start, fl.end);
    }
    if (fl.msg && subtreeHasRemoval(fl.msg, removed)) {
      var inner = rebuildMessage(bytes, fl.msg, removed);
      var tagBytes = varintBytes(fl.f * 8 + 2);
      var lenBytes = varintBytes(inner.length);
      return concatBytes(tagBytes, lenBytes, inner);
    }
    return bytes.subarray(fl.start, fl.end);
  }
  function rebuildMessage(bytes, msg, removed) {
    var parts = [];
    for (var i = 0; i < msg.length; i++) {
      var fl = msg[i];
      if (removed[fl.start]) continue;
      parts.push(rebuildField(bytes, fl, removed));
    }
    return concatBytes.apply(null, parts);
  }
  function concatBytes() {
    var total = 0, i;
    for (i = 0; i < arguments.length; i++) total += arguments[i].length;
    var out = new Uint8Array(total), pos = 0;
    for (i = 0; i < arguments.length; i++) {
      out.set(arguments[i], pos);
      pos += arguments[i].length;
    }
    return out;
  }


  // ---------------- gzip 自适应（纯 JS，ES5 无依赖） ----------------
  var CRC_TABLE = null;
  function crc32(u8) {
  if (!CRC_TABLE) {
  CRC_TABLE = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
  var c = n;
  for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
  }
  }
  var crc = -1, i;
  for (i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ u8[i]) & 0xff];
  return (crc ^ -1) >>> 0;
  }
  function gzipStored(u8) {
  var parts = [], blocks = Math.max(1, Math.ceil(u8.length / 65535)), i, pos = 0, len, j, crc, isize;
  // gzip 头：magic(2) CM=8(1) FLG=0(1) MTIME(4) XFL=0(1) OS=255(1)
  parts.push(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]));
  for (i = 0; i < blocks; i++) {
  len = Math.min(65535, u8.length - pos);
  var last = (i === blocks - 1) ? 1 : 0;
  var head = new Uint8Array(5);
  head[0] = last;                    // BFINAL + BTYPE=00(stored)
  head[1] = len & 0xff;              // LEN 小端
  head[2] = (len >> 8) & 0xff;
  head[3] = (~len) & 0xff;           // NLEN = ~LEN 小端
  head[4] = ((~len) >> 8) & 0xff;
  parts.push(head);
  parts.push(u8.subarray(pos, pos + len));
  pos += len;
  }
  crc = crc32(u8);
  isize = u8.length >>> 0;
  var tail = new Uint8Array(8);
  tail[0] = crc & 0xff; tail[1] = (crc >> 8) & 0xff; tail[2] = (crc >> 16) & 0xff; tail[3] = (crc >>> 24) & 0xff;
  tail[4] = isize & 0xff; tail[5] = (isize >> 8) & 0xff; tail[6] = (isize >> 16) & 0xff; tail[7] = (isize >>> 24) & 0xff;
  parts.push(tail);
  var total = 0;
  for (i = 0; i < parts.length; i++) total += parts[i].length;
  var out = new Uint8Array(total), p = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
  return out;
  }

  /* 纯 JS gzip inflate（RFC1950/1951），ES5 无依赖。返回 Uint8Array 或 null */
  function inflateGzip(src) {
  if (!src || src.length < 18 || src[0] !== 0x1f || src[1] !== 0x8b || src[2] !== 8) return null;
  var p = 10, flg = src[3], xlen, i;
  if (flg & 4) { xlen = src[p] | (src[p + 1] << 8); p += 2 + xlen; }
  if (flg & 8) { while (src[p] !== 0) p++; p++; }
  if (flg & 16) { while (src[p] !== 0) p++; p++; }
  if (flg & 2) p += 2;
  if (p >= src.length) return null;

  var inPos = p;
  var out = [];

  var bitPos = 0;
  function getBits(n) {
  var v = 0, i;
  for (i = 0; i < n; i++) {
  v |= ((src[inPos] >> bitPos) & 1) << i;
  if (++bitPos === 8) { bitPos = 0; inPos++; }
  }
  return v;
  }

  function buildTable(lens, n) {
  var maxLen = 0, i;
  for (i = 0; i < n; i++) if (lens[i] > maxLen) maxLen = lens[i];
  if (maxLen === 0) return null;
  var count = new Array(maxLen + 1), code = new Array(maxLen + 1), j;
  for (i = 0; i <= maxLen; i++) count[i] = 0;
  for (i = 0; i < n; i++) count[lens[i]]++;
  count[0] = 0;
  code[0] = 0;
  for (i = 1; i <= maxLen; i++) code[i] = (code[i - 1] + count[i - 1]) << 1;
  var t = new Int16Array(1 << maxLen);
  for (i = 0; i < t.length; i++) t[i] = -1;
  for (i = 0; i < n; i++) {
  var len = lens[i];
  if (len === 0) continue;
  var c = code[len]++;
  var start = c << (maxLen - len), span = 1 << (maxLen - len);
  for (j = start; j < start + span; j++) t[j] = i;
  }
  t.maxBits = maxLen;
  t.lens = lens;
  return t;
  }

  function readSym(t) {
  var idx = 0, i, k;
  for (i = 0; i < t.maxBits; i++) idx = (idx << 1) | getBits(1);
  var s = t[idx];
  if (s < 0) return -1;
  k = t.maxBits - t.lens[s];
  while (k-- > 0) { bitPos--; if (bitPos < 0) { bitPos = 7; inPos--; } }
  return s;
  }

  /* fixed huffman 表：lit/dist 码长（RFC1951 3.2.6） */
  var FIXED_LIT_LENS = new Array(288), FIXED_DIST_LENS = new Array(30), z;
  for (z = 0; z < 144; z++) FIXED_LIT_LENS[z] = 8;
  for (; z < 256; z++) FIXED_LIT_LENS[z] = 9;
  for (; z < 280; z++) FIXED_LIT_LENS[z] = 7;
  for (; z < 288; z++) FIXED_LIT_LENS[z] = 8;
  for (z = 0; z < 30; z++) FIXED_DIST_LENS[z] = 5;
  var FIXED_LIT = buildTable(FIXED_LIT_LENS, 288);
  var FIXED_DIST = buildTable(FIXED_DIST_LENS, 30);
  var ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  var LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  var LEN_EXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  var DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  var DIST_EXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

  var finished = false, guard = 0, MAX_OUT = 2000000;
  while (!finished) {
  if (guard++ > 500000) return null;
  var bfinal = getBits(1), btype = getBits(2);
  if (btype === 0) {
  if (bitPos !== 0) { inPos++; bitPos = 0; } /* 字节对齐：丢弃当前字节剩余位 */
  if (inPos + 4 > src.length) return null;
  var llen = src[inPos] | (src[inPos + 1] << 8);
  var nlen = src[inPos + 2] | (src[inPos + 3] << 8);
  inPos += 4;
  if ((llen ^ 0xffff) !== nlen) return null;
  if (inPos + llen > src.length || out.length + llen > MAX_OUT) return null;
  for (var si = 0; si < llen; si++) out.push(src[inPos + si]);
  inPos += llen;
  } else {
  var litT, distT;
  if (btype === 1) { litT = FIXED_LIT; distT = FIXED_DIST; }
  else if (btype === 2) {
  var hlit = getBits(5) + 257, hdist = getBits(5) + 1, hclen = getBits(4) + 4;
  if (hlit > 286 || hdist > 30) return null;
  var clLens = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  for (var ci = 0; ci < hclen; ci++) clLens[ORDER[ci]] = getBits(3);
  var clT = buildTable(clLens, 19);
  if (!clT) return null;
  var allLens = [], lc = 0, total = hlit + hdist;
  while (lc < total) {
  var s = readSym(clT);
  if (s < 0) return null;
  if (s < 16) { allLens[lc++] = s; }
  else if (s === 16) { var rep = getBits(2) + 3, prev = lc > 0 ? allLens[lc - 1] : 0; while (rep--) allLens[lc++] = prev; }
  else if (s === 17) { var rep2 = getBits(3) + 3; while (rep2--) allLens[lc++] = 0; }
  else { var rep3 = getBits(7) + 11; while (rep3--) allLens[lc++] = 0; }
  if (lc > total) return null;
  }
  var litLens = allLens.slice(0, hlit), distLens = allLens.slice(hlit, hlit + hdist);
  litT = buildTable(litLens, hlit);
  distT = buildTable(distLens, hdist);
  if (!litT || !distT) return null;
  } else return null;
  for (;;) {
  if (out.length > MAX_OUT) return null;
  var sym = readSym(litT);
  if (sym < 0) return null;
  if (sym === 256) break;
  if (sym < 256) out.push(sym);
  else {
  var li = sym - 257;
  var l = LEN_BASE[li] + getBits(LEN_EXT[li]);
  var ds = readSym(distT);
  if (ds < 0 || ds > 29) return null;
  var d = DIST_BASE[ds] + getBits(DIST_EXT[ds]);
  if (d > out.length) return null;
  for (var m = 0; m < l; m++) out.push(out[out.length - d]);
  }
  }
  }
  finished = bfinal === 1;
  }
  return new Uint8Array(out);
  }

  // ---------------- 响应手术 ----------------
  function processResponse(body) {
    // 帧头校验：09 30 00 00 00 + 3字节大端总长 + 8字节，protobuf 自偏移16开始
    if (body.length < 32) return null;
    if (body[0] !== 0x09 || body[1] !== 0x30) {
      if (body[0] === 0x1F && body[1] === 0x8B) {
        log('响应体为 gzip 压缩：脚本未收到解压后数据（请确认插件 binary-body-mode=true 且 Loon 自动解压）');
      }
      return null;
    }
    var total = (body[5] << 16) | (body[6] << 8) | body[7];
    if (total !== body.length) return null;

    var text = toStr(body);
    var targets = null;
    if (text.indexOf(FEAT_MY1) >= 0 || text.indexOf(FEAT_MY2) >= 0 || text.indexOf(FEAT_MY3) >= 0) {
      targets = MY_ITEMS;
    } else if (text.indexOf(FEAT_NAV) >= 0 || text.indexOf(FEAT_BOTTOM) >= 0) {
      targets = NAV_TABS;
    }

    var msg = parseMessage(body, 16, body.length);
    if (!msg) return null;

    var removed = {}, i, c;

    // 1) 常规黑名单手术（tab / 顶部导航 / 我的页）
    if (targets) {
      var matches = [];
      collectMatches(body, msg, [], targets, matches);
      for (i = 0; i < matches.length; i++) {
        c = cardFieldFor(body, matches[i]);
        if (c) removed[c.start] = true;
      }
    }

    // 2) 广告卡手术（首页 feed 等 MVL 响应）
    var adMatches = [];
    collectAdMatches(body, msg, [], adMatches);
    for (i = 0; i < adMatches.length; i++) {
      c = cardFieldFor(body, adMatches[i]);
      if (c) {
        removed[c.start] = true;
      } else {
        // 提升失败（广告数据层字段，非 UI 卡）：直接删除小特征字段本身，
        // 清理 ad_report_params / ad_pos_id 等上报统计残留（大字段不删，防误伤容器）
        var f = adMatches[i].field;
        if (f.len >= 6 && f.len <= 2048) removed[f.start] = true;
      }
    }

    var keys = Object.keys(removed);
    if (!keys.length) return null;

    var newMsg = rebuildMessage(body, msg, removed);
    var newBody = concatBytes(body.subarray(0, 16), newMsg);
    var nt = newBody.length;
    newBody[5] = (nt >> 16) & 0xFF;
    newBody[6] = (nt >> 8) & 0xFF;
    newBody[7] = nt & 0xFF;
    log('removed ' + keys.length + ' item(s)');
    return newBody;
  }


  // ---------------- 响应入口（gzip 自适应：解压→处理→按响应头重新打包） ----------------
  function headerGet(headers, name) {
    if (!headers) return '';
    var lower = name.toLowerCase();
    for (var k in headers) {
      if (k.toLowerCase() === lower) return String(headers[k] == null ? '' : headers[k]);
    }
    return '';
  }
  function handleResponse(reqUrl, response) {
    var rb = toU8(response.body);
    if (!rb || rb.length <= 2) return null;
    var ce = headerGet(response.headers, 'content-encoding').toLowerCase();
    var wantsGzip = ce.indexOf('gzip') >= 0;
    var bodyIsGzip = rb[0] === 0x1F && rb[1] === 0x8B;
    var raw = rb;
    if (bodyIsGzip) {
      var inf = inflateGzip(rb);
      if (!inf) { log('gzip 解压失败，跳过 len=' + rb.length); return null; }
      raw = inf;
    }
    if (raw.length <= 32) return null;
    var out = processResponse(raw);
    if (!out || out.length === raw.length) return null;
    // 输出策略：始终返回明文 body，并移除 content-encoding/content-length 头，
    // 让客户端按明文解析（Loon 会自行重算 content-length）。
    // 注意：不要在这里自行 gzip 打包——实测 Loon 3.5 会对脚本输出做二次编码处理，gzip 打包会导致客户端解码失败。
    var headersOut = {};
    for (var hk in (response.headers || {})) {
      var lk = hk.toLowerCase();
      if (lk === 'content-encoding' || lk === 'content-length') continue;
      headersOut[hk] = response.headers[hk];
    }
    log('精简 ' + reqUrl + '：' + raw.length + ' -> ' + out.length + ' 字节（明文返回' + (ce.indexOf('gzip') >= 0 ? '，已移除 gzip 头' : '') + '）');
    try {
      if (typeof $persistentStore !== 'undefined' && typeof $notification !== 'undefined') {
        if (!$persistentStore.read('qqvc_notified')) {
          $persistentStore.write('1', 'qqvc_notified');
          $notification.post('腾讯视频去广告', '净化已生效 ✓', '示例：' + raw.length + ' -> ' + out.length + ' 字节');
        }
      }
    } catch (e) {}
    return { body: out, headers: headersOut };
  }

  // ---------------- 入口 ----------------
  var finished = false;
  function finish(obj) {
    if (finished) return;
    finished = true;
    $done(obj || {});
  }

  try {
    if (typeof $response !== 'undefined' && $response) {
      var reqUrl = ($request && $request.url) || '';
      if (reqUrl.indexOf('i.video.qq.com') >= 0) {
        var respObj = handleResponse(reqUrl, $response);
        if (respObj) {
          finish({ body: respObj.body, headers: respObj.headers });
          return;
        }
      }
      finish({});
      return;
    }

    if (typeof $request !== 'undefined' && $request) {
      var url = $request.url || '';
      var rawBody = $request.body || '';
      var reqStr = '';
      if (typeof rawBody === 'string') reqStr = rawBody;
      else { var reqU8 = toU8(rawBody); if (reqU8) reqStr = toStr(reqU8); }

      // 0) vmind 兼容：返回空 JSON（Loon 无 [Map Local]，改由脚本实现；旧链路广告视频接口）
      if ((url.indexOf('vv.video.qq.com') >= 0 || url.indexOf('vv6.video.qq.com') >= 0) &&
          url.indexOf('vmind') >= 0) {
        log('vmind 空响应: ' + url);
        finish({ response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' } });
        return;
      }

      // 1) 播放接口参数改写（去贴片/试看广告）——URL 与 body 双通道
      if ((url.indexOf('vv.video.qq.com') >= 0 || url.indexOf('vv6.video.qq.com') >= 0) &&
          (url.indexOf('getvinfo') >= 0 || url.indexOf('batchvinfo') >= 0)) {
        var nu = url
          .replace(/sppreviewtype=\d+/g, 'sppreviewtype=0')
          .replace(/spsrt=\d+/g, 'spsrt=0');
        var nb = reqStr
          .replace(/sppreviewtype=\d+/g, 'sppreviewtype=0')
          .replace(/spsrt=\d+/g, 'spsrt=0');
        if (nu !== url || nb !== reqStr) {
          log('改写播放参数: ' + url);
          finish({ url: nu, body: (typeof rawBody === 'string') ? nb : strToU8(nb) });
        } else {
          finish({});
        }
        return;
      }

      // 2) 广告类 TRPC 请求拦截（方法名在 URL path 或 body 均可命中）
      if (url.indexOf('i.video.qq.com') >= 0 || url.indexOf('iwan.video.qq.com') >= 0) {
        var hay = url + '\n' + reqStr;
        var blocked = false;
        for (var k = 0; k < AD_METHODS.length; k++) {
          if (hay.indexOf(AD_METHODS[k]) >= 0) { blocked = true; break; }
        }
        if (blocked) {
          log('拦截广告接口: ' + url);
          finish({ response: { status: 204, headers: {}, body: '' } });
        } else {
          finish({});
        }
        return;
      }

      finish({});
      return;
    }

    finish({});
  } catch (e) {
    log('脚本异常: ' + e);
    finish({});
  }
})();




// (function () {
//   'use strict';

//   // ---------------- 目标清单 ----------------
//   var NAV_TABS = ['短剧', '好物', '好片']; // 顶部频道 + 底部 tab
//   var MY_ITEMS = [ // 「我的」页：运营推广项 + VIP 营销卡标题 + 顶部游戏中心
//     '特惠升级SVIP', '新人16元看比赛', 'JUMP卡上新', '年轻人专属会员', '优惠宽带送VIP',
//     '游戏福利', 'GOODS商城', '免费看漫剧', '免费领会员', '摸鱼免费玩',
//     '我的游戏', '爱玩游戏', '免流量领会员', '领权益送会员',
//     '游戏' // 「我的」页左上角游戏中心入口（sp_mycntr_ceiling）
//   ];
//   var AD_METHODS = [ // 请求体中出现的广告类 TRPC 方法名片段
//     'GetPersonalCenterAdData',   // 个人中心广告数据
//     'reward_ad_ssp',             // 激励广告（入口/挂件/关注礼）
//     'GetFloatActivity',          // 浮窗活动
//     'AccessPromotion',           // VIP 广告推广
//     'GetPromotionGlobalConfig',  // 推广全局配置
//     'GetSDKInitData',            // 移动(CMCC)推广 SDK
//     'GetPreloadGames'            // 游戏预加载（我的游戏/爱玩游戏）
//   ];
//   var FEAT_NAV = 'EditChannelListActivity';  // 顶部频道导航响应特征
//   var FEAT_BOTTOM = 'GetTabListRsp';         // 底部 tab 响应特征
//   var FEAT_MY1 = 'user_center_top_function'; // 我的页特征
//   var FEAT_MY2 = 'user_center_more_function';
//   var FEAT_MY3 = 'sp_mycntr_ceiling';        // 我的页顶部功能区特征

//   // ---------------- 工具函数 ----------------
//   function log(m) {
//     try { console.log('[qqvideo-clean] ' + m); } catch (e) {}
//   }
//   function toU8(b) {
//     if (b instanceof Uint8Array) return b;
//     if (typeof ArrayBuffer !== 'undefined') {
//       if (b instanceof ArrayBuffer) return new Uint8Array(b);
//       if (ArrayBuffer.isView && ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
//     }
//     if (typeof b === 'string') {
//       var arr = new Uint8Array(b.length);
//       for (var i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i) & 0xff;
//       return arr;
//     }
//     return null;
//   }
//   function strToU8(s) {
//     var arr = new Uint8Array(s.length);
//     for (var i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i) & 0xff;
//     return arr;
//   }
//   function toStr(b) {
//     if (typeof b === 'string') return b;
//     if (b instanceof Uint8Array) {
//       var s = '';
//       for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
//       return s;
//     }
//     return '';
//   }
//   function utf8Of(bytes, start, end) {
//     var out = '', i = start;
//     while (i < end) {
//       var b0 = bytes[i];
//       if (b0 < 0x80) { out += String.fromCharCode(b0); i++; }
//       else if ((b0 & 0xE0) === 0xC0) {
//         if (i + 1 >= end || (bytes[i + 1] & 0xC0) !== 0x80) return null;
//         out += String.fromCharCode(((b0 & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2;
//       } else if ((b0 & 0xF0) === 0xE0) {
//         if (i + 2 >= end || (bytes[i + 1] & 0xC0) !== 0x80 || (bytes[i + 2] & 0xC0) !== 0x80) return null;
//         out += String.fromCharCode(((b0 & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3;
//       } else if ((b0 & 0xF8) === 0xF0) {
//         if (i + 3 >= end) return null;
//         var cp = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
//         cp -= 0x10000;
//         if (cp < 0) return null;
//         out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); i += 4;
//       } else return null;
//     }
//     return out;
//   }
//   function readVarint(bytes, pos) {
//     var result = 0, shift = 0;
//     while (true) {
//       if (pos >= bytes.length) return null;
//       var b = bytes[pos++];
//       result += (b & 0x7F) * Math.pow(2, shift);
//       if (!(b & 0x80)) break;
//       shift += 7;
//       if (shift > 35) return null;
//     }
//     return { value: result, pos: pos };
//   }
//   function varintBytes(v) {
//     var out = [];
//     do {
//       var b = v % 128;
//       v = Math.floor(v / 128);
//       if (v > 0) b |= 0x80;
//       out.push(b);
//     } while (v > 0);
//     return new Uint8Array(out);
//   }

//   // ---------------- protobuf 解析 ----------------
//   function parseMessage(bytes, start, end) {
//     var fields = [], pos = start;
//     while (pos < end) {
//       var s = pos;
//       var tr = readVarint(bytes, pos);
//       if (!tr) return null;
//       pos = tr.pos;
//       var tag = tr.value, fno = Math.floor(tag / 8), wire = tag % 8;
//       if (fno === 0) return null;
//       var fl = { f: fno, w: wire, start: s, end: s, vStart: pos, vEnd: pos, len: 0, msg: null };
//       if (wire === 0) {
//         var vr = readVarint(bytes, pos);
//         if (!vr) return null;
//         pos = vr.pos; fl.end = pos;
//       } else if (wire === 1) {
//         if (pos + 8 > end) return null;
//         pos += 8; fl.end = pos;
//       } else if (wire === 2) {
//         var lr = readVarint(bytes, pos);
//         if (!lr) return null;
//         var len = lr.value; pos = lr.pos;
//         if (pos + len > end) return null;
//         fl.len = len; fl.vStart = pos; fl.vEnd = pos + len;
//         pos += len; fl.end = pos;
//       } else if (wire === 5) {
//         if (pos + 4 > end) return null;
//         pos += 4; fl.end = pos;
//       } else return null;
//       fields.push(fl);
//     }
//     if (pos !== end) return null;
//     for (var i = 0; i < fields.length; i++) {
//       var f = fields[i];
//       if (f.w === 2 && f.len >= 2) {
//         var sub = parseMessage(bytes, f.vStart, f.vEnd);
//         if (sub !== null) f.msg = sub;
//       }
//     }
//     return fields;
//   }

//   function collectMatches(bytes, msg, chain, targets, matches) {
//     if (!msg) return;
//     for (var i = 0; i < msg.length; i++) {
//       var fl = msg[i];
//       if (fl.w !== 2) continue;
//       if (fl.len >= 1 && fl.len <= 64) {
//         var s = utf8Of(bytes, fl.vStart, fl.vEnd);
//         if (s !== null && targets.indexOf(s) >= 0) {
//           matches.push({ chain: chain, field: fl });
//         }
//       }
//       // 实时解析子消息继续深入（不依赖预构建，防断链）
//       var sub = parseMessage(bytes, fl.vStart, fl.vEnd);
//       if (sub !== null) {
//         fl.msg = sub;
//         var nc = chain.concat([fl]);
//         collectMatches(bytes, sub, nc, targets, matches);
//       }
//     }
//   }

//   // 卡片级判定：
//   //  · 含直接的 http/https/txvideo URL 字符串字段，或
//   //  · 字段数 >= 6 且含 varint 字段（导航项/底部 tab 等结构特征）
//   //  URL 检测支持子消息内嵌一层（部分 URL 被包在子消息中）
//   function isCard(bytes, msg) {
//     if (!msg || msg.length < 3) return false;
//     var hasVarint = false, hasUrl = false;
//     for (var i = 0; i < msg.length; i++) {
//       var fl = msg[i];
//       if (fl.w === 0 || fl.w === 1 || fl.w === 5) hasVarint = true;
//       if (fl.w !== 2) continue;
//       if (fl.len >= 8) {
//         var s = utf8Of(bytes, fl.vStart, fl.vEnd);
//         if (s !== null && (s.indexOf('http://') === 0 || s.indexOf('https://') === 0 || s.indexOf('txvideo://') === 0)) hasUrl = true;
//         if (!hasUrl && fl.msg) {
//           // 子消息内嵌 URL（一层）
//           for (var j = 0; j < fl.msg.length; j++) {
//             var c = fl.msg[j];
//             if (c.w === 2 && c.len >= 8) {
//               var cs = utf8Of(bytes, c.vStart, c.vEnd);
//               if (cs !== null && (cs.indexOf('http://') === 0 || cs.indexOf('https://') === 0 || cs.indexOf('txvideo://') === 0)) { hasUrl = true; break; }
//             }
//           }
//         }
//       }
//     }
//     if (hasUrl) return true;
//     if (msg.length >= 6 && hasVarint) return true;
//     return false;
//   }

//   function cardFieldFor(bytes, match) {
//     var chain = match.chain;
//     for (var i = chain.length - 1; i >= 0; i--) {
//       var f = chain[i];
//       if (f.msg && isCard(bytes, f.msg)) return f;
//     }
//     return null;
//   }

//   // ---------------- 重建 ----------------
//   function subtreeHasRemoval(msg, removed) {
//     for (var i = 0; i < msg.length; i++) {
//       if (removed[msg[i].start]) return true;
//       if (msg[i].msg && subtreeHasRemoval(msg[i].msg, removed)) return true;
//     }
//     return false;
//   }
//   function rebuildField(bytes, fl, removed) {
//     if (fl.w !== 2) {
//       return bytes.subarray(fl.start, fl.end);
//     }
//     if (fl.msg && subtreeHasRemoval(fl.msg, removed)) {
//       var inner = rebuildMessage(bytes, fl.msg, removed);
//       var tagBytes = varintBytes(fl.f * 8 + 2);
//       var lenBytes = varintBytes(inner.length);
//       return concatBytes(tagBytes, lenBytes, inner);
//     }
//     return bytes.subarray(fl.start, fl.end);
//   }
//   function rebuildMessage(bytes, msg, removed) {
//     var parts = [];
//     for (var i = 0; i < msg.length; i++) {
//       var fl = msg[i];
//       if (removed[fl.start]) continue;
//       parts.push(rebuildField(bytes, fl, removed));
//     }
//     return concatBytes.apply(null, parts);
//   }
//   function concatBytes() {
//     var total = 0, i;
//     for (i = 0; i < arguments.length; i++) total += arguments[i].length;
//     var out = new Uint8Array(total), pos = 0;
//     for (i = 0; i < arguments.length; i++) {
//       out.set(arguments[i], pos);
//       pos += arguments[i].length;
//     }
//     return out;
//   }

//   // ---------------- 响应手术 ----------------
//   function processResponse(body) {
//     // 帧头校验：09 30 00 00 00 + 3字节大端总长 + 8字节，protobuf 自偏移16开始
//     if (body.length < 32) return null;
//     if (body[0] !== 0x09 || body[1] !== 0x30) return null;
//     var total = (body[5] << 16) | (body[6] << 8) | body[7];
//     if (total !== body.length) return null;

//     var text = toStr(body);
//     var targets = null;
//     if (text.indexOf(FEAT_MY1) >= 0 || text.indexOf(FEAT_MY2) >= 0 || text.indexOf(FEAT_MY3) >= 0) {
//       targets = MY_ITEMS;
//     } else if (text.indexOf(FEAT_NAV) >= 0 || text.indexOf(FEAT_BOTTOM) >= 0) {
//       targets = NAV_TABS;
//     }
//     if (!targets) return null;

//     var msg = parseMessage(body, 16, body.length);
//     if (!msg) return null;

//     var matches = [];
//     collectMatches(body, msg, [], targets, matches);
//     if (!matches.length) return null;

//     var removed = {}, i, c;
//     for (i = 0; i < matches.length; i++) {
//       c = cardFieldFor(body, matches[i]);
//       if (c) removed[c.start] = true;
//     }
//     var keys = Object.keys(removed);
//     if (!keys.length) return null;

//     var newMsg = rebuildMessage(body, msg, removed);
//     var newBody = concatBytes(body.subarray(0, 16), newMsg);
//     var nt = newBody.length;
//     newBody[5] = (nt >> 16) & 0xFF;
//     newBody[6] = (nt >> 8) & 0xFF;
//     newBody[7] = nt & 0xFF;
//     log('removed ' + keys.length + ' item(s)');
//     return newBody;
//   }

//   // ---------------- 入口 ----------------
//   var finished = false;
//   function finish(obj) {
//     if (finished) return;
//     finished = true;
//     $done(obj || {});
//   }

//   try {
//     if (typeof $response !== 'undefined' && $response) {
//       var reqUrl = ($request && $request.url) || '';
//       if (reqUrl.indexOf('i.video.qq.com') >= 0) {
//         var rb = toU8($response.body);
//         if (rb && rb.length > 32) {
//           var out = processResponse(rb);
//           if (out && out.length !== rb.length) {
//             log('精简 ' + reqUrl + '：' + rb.length + ' -> ' + out.length + ' 字节');
//             finish({ body: out });
//             return;
//           }
//         }
//       }
//       finish({});
//       return;
//     }

//     if (typeof $request !== 'undefined' && $request) {
//       var url = $request.url || '';
//       var rawBody = $request.body || '';
//       var reqStr = '';
//       if (typeof rawBody === 'string') reqStr = rawBody;
//       else { var reqU8 = toU8(rawBody); if (reqU8) reqStr = toStr(reqU8); }

//       // 1) 播放接口参数改写（去贴片/试看广告）——URL 与 body 双通道
//       if ((url.indexOf('vv.video.qq.com') >= 0 || url.indexOf('vv6.video.qq.com') >= 0) &&
//           (url.indexOf('getvinfo') >= 0 || url.indexOf('batchvinfo') >= 0)) {
//         var nu = url
//           .replace(/sppreviewtype=\d+/g, 'sppreviewtype=0')
//           .replace(/spsrt=\d+/g, 'spsrt=0');
//         var nb = reqStr
//           .replace(/sppreviewtype=\d+/g, 'sppreviewtype=0')
//           .replace(/spsrt=\d+/g, 'spsrt=0');
//         if (nu !== url || nb !== reqStr) {
//           log('改写播放参数: ' + url);
//           finish({ url: nu, body: (typeof rawBody === 'string') ? nb : strToU8(nb) });
//         } else {
//           finish({});
//         }
//         return;
//       }

//       // 2) 广告类 TRPC 请求拦截
//       if (url.indexOf('i.video.qq.com') >= 0 || url.indexOf('iwan.video.qq.com') >= 0) {
//         var blocked = false;
//         for (var k = 0; k < AD_METHODS.length; k++) {
//           if (reqStr.indexOf(AD_METHODS[k]) >= 0) { blocked = true; break; }
//         }
//         if (blocked) {
//           log('拦截广告接口: ' + url);
//           finish({ response: { status: 204, headers: {}, body: '' } });
//         } else {
//           finish({});
//         }
//         return;
//       }

//       finish({});
//       return;
//     }

//     finish({});
//   } catch (e) {
//     log('脚本异常: ' + e);
//     finish({});
//   }
// })();





// (function () {
//   'use strict';

//   // ---------------- 目标清单 ----------------
//   var NAV_TABS = ['短剧', '好物', '好片']; // 顶部频道 + 底部 tab
//   var MY_ITEMS = [ // 「我的」页：运营推广项 + VIP 营销卡标题
//     '特惠升级SVIP', '新人16元看比赛', 'JUMP卡上新', '年轻人专属会员', '优惠宽带送VIP',
//     '游戏福利', 'GOODS商城', '免费看漫剧', '免费领会员', '摸鱼免费玩',
//     '我的游戏', '爱玩游戏', '免流量领会员', '领权益送会员'
//   ];
//   var AD_METHODS = [ // 请求体中出现的广告类 TRPC 方法名片段
//     'GetPersonalCenterAdData',   // 个人中心广告数据
//     'reward_ad_ssp',             // 激励广告（入口/挂件/关注礼）
//     'GetFloatActivity',          // 浮窗活动
//     'AccessPromotion',           // VIP 广告推广
//     'GetPromotionGlobalConfig',  // 推广全局配置
//     'GetSDKInitData',            // 移动(CMCC)推广 SDK
//     'GetPreloadGames'            // 游戏预加载（我的游戏/爱玩游戏）
//   ];
//   var FEAT_NAV = 'EditChannelListActivity';  // 顶部频道导航响应特征
//   var FEAT_BOTTOM = 'GetTabListRsp';         // 底部 tab 响应特征
//   var FEAT_MY1 = 'user_center_top_function'; // 我的页特征
//   var FEAT_MY2 = 'user_center_more_function';

//   // ---------------- 工具函数 ----------------
//   function toU8(b) {
//     if (b instanceof Uint8Array) return b;
//     if (typeof b === 'string') {
//       var arr = new Uint8Array(b.length);
//       for (var i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i) & 0xff;
//       return arr;
//     }
//     return null;
//   }
//   function toStr(b) {
//     if (typeof b === 'string') return b;
//     if (b instanceof Uint8Array) {
//       var s = '';
//       for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
//       return s;
//     }
//     return '';
//   }
//   function utf8Of(bytes, start, end) {
//     var out = '', i = start;
//     while (i < end) {
//       var b0 = bytes[i];
//       if (b0 < 0x80) { out += String.fromCharCode(b0); i++; }
//       else if ((b0 & 0xE0) === 0xC0) {
//         if (i + 1 >= end || (bytes[i + 1] & 0xC0) !== 0x80) return null;
//         out += String.fromCharCode(((b0 & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2;
//       } else if ((b0 & 0xF0) === 0xE0) {
//         if (i + 2 >= end || (bytes[i + 1] & 0xC0) !== 0x80 || (bytes[i + 2] & 0xC0) !== 0x80) return null;
//         out += String.fromCharCode(((b0 & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3;
//       } else if ((b0 & 0xF8) === 0xF0) {
//         if (i + 3 >= end) return null;
//         var cp = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
//         cp -= 0x10000;
//         if (cp < 0) return null;
//         out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); i += 4;
//       } else return null;
//     }
//     return out;
//   }
//   function readVarint(bytes, pos) {
//     var result = 0, shift = 0;
//     while (true) {
//       if (pos >= bytes.length) return null;
//       var b = bytes[pos++];
//       result += (b & 0x7F) * Math.pow(2, shift);
//       if (!(b & 0x80)) break;
//       shift += 7;
//       if (shift > 35) return null;
//     }
//     return { value: result, pos: pos };
//   }
//   function varintBytes(v) {
//     var out = [];
//     do {
//       var b = v % 128;
//       v = Math.floor(v / 128);
//       if (v > 0) b |= 0x80;
//       out.push(b);
//     } while (v > 0);
//     return new Uint8Array(out);
//   }

//   // ---------------- protobuf 解析 ----------------
//   function parseMessage(bytes, start, end) {
//     var fields = [], pos = start;
//     while (pos < end) {
//       var s = pos;
//       var tr = readVarint(bytes, pos);
//       if (!tr) return null;
//       pos = tr.pos;
//       var tag = tr.value, fno = Math.floor(tag / 8), wire = tag % 8;
//       if (fno === 0) return null;
//       var fl = { f: fno, w: wire, start: s, end: s, vStart: pos, vEnd: pos, len: 0, msg: null };
//       if (wire === 0) {
//         var vr = readVarint(bytes, pos);
//         if (!vr) return null;
//         pos = vr.pos; fl.end = pos;
//       } else if (wire === 1) {
//         if (pos + 8 > end) return null;
//         pos += 8; fl.end = pos;
//       } else if (wire === 2) {
//         var lr = readVarint(bytes, pos);
//         if (!lr) return null;
//         var len = lr.value; pos = lr.pos;
//         if (pos + len > end) return null;
//         fl.len = len; fl.vStart = pos; fl.vEnd = pos + len;
//         pos += len; fl.end = pos;
//       } else if (wire === 5) {
//         if (pos + 4 > end) return null;
//         pos += 4; fl.end = pos;
//       } else return null;
//       fields.push(fl);
//     }
//     if (pos !== end) return null;
//     for (var i = 0; i < fields.length; i++) {
//       var f = fields[i];
//       if (f.w === 2 && f.len >= 2) {
//         var sub = parseMessage(bytes, f.vStart, f.vEnd);
//         if (sub !== null) f.msg = sub;
//       }
//     }
//     return fields;
//   }

//   function collectMatches(bytes, msg, chain, targets, matches) {
//     if (!msg) return;
//     for (var i = 0; i < msg.length; i++) {
//       var fl = msg[i];
//       if (fl.w !== 2) continue;
//       if (fl.len >= 1 && fl.len <= 64) {
//         var s = utf8Of(bytes, fl.vStart, fl.vEnd);
//         if (s !== null && targets.indexOf(s) >= 0) {
//           matches.push({ chain: chain, field: fl });
//         }
//       }
//       // 实时解析子消息继续深入（不依赖预构建，防断链）
//       var sub = parseMessage(bytes, fl.vStart, fl.vEnd);
//       if (sub !== null) {
//         fl.msg = sub;
//         var nc = chain.concat([fl]);
//         collectMatches(bytes, sub, nc, targets, matches);
//       }
//     }
//   }

//   // 卡片级判定：
//   //  · 含直接的 http/https/txvideo URL 字符串字段，或
//   //  · 字段数 >= 6 且含 varint 字段（导航项/底部 tab 等结构特征）
//   //  URL 检测支持子消息内嵌一层（部分 URL 被包在子消息中）
//   function isCard(bytes, msg) {
//     if (!msg || msg.length < 3) return false;
//     var hasVarint = false, hasUrl = false;
//     for (var i = 0; i < msg.length; i++) {
//       var fl = msg[i];
//       if (fl.w === 0 || fl.w === 1 || fl.w === 5) hasVarint = true;
//       if (fl.w !== 2) continue;
//       if (fl.len >= 8) {
//         var s = utf8Of(bytes, fl.vStart, fl.vEnd);
//         if (s !== null && (s.indexOf('http://') === 0 || s.indexOf('https://') === 0 || s.indexOf('txvideo://') === 0)) hasUrl = true;
//         if (!hasUrl && fl.msg) {
//           // 子消息内嵌 URL（一层）
//           for (var j = 0; j < fl.msg.length; j++) {
//             var c = fl.msg[j];
//             if (c.w === 2 && c.len >= 8) {
//               var cs = utf8Of(bytes, c.vStart, c.vEnd);
//               if (cs !== null && (cs.indexOf('http://') === 0 || cs.indexOf('https://') === 0 || cs.indexOf('txvideo://') === 0)) { hasUrl = true; break; }
//             }
//           }
//         }
//       }
//     }
//     if (hasUrl) return true;
//     if (msg.length >= 6 && hasVarint) return true;
//     return false;
//   }

//   function cardFieldFor(bytes, match) {
//     var chain = match.chain;
//     for (var i = chain.length - 1; i >= 0; i--) {
//       var f = chain[i];
//       if (f.msg && isCard(bytes, f.msg)) return f;
//     }
//     return null;
//   }

//   // ---------------- 重建 ----------------
//   function subtreeHasRemoval(msg, removed) {
//     for (var i = 0; i < msg.length; i++) {
//       if (removed[msg[i].start]) return true;
//       if (msg[i].msg && subtreeHasRemoval(msg[i].msg, removed)) return true;
//     }
//     return false;
//   }
//   function rebuildField(bytes, fl, removed) {
//     if (fl.w !== 2) {
//       return bytes.subarray(fl.start, fl.end);
//     }
//     if (fl.msg && subtreeHasRemoval(fl.msg, removed)) {
//       var inner = rebuildMessage(bytes, fl.msg, removed);
//       var tagBytes = varintBytes(fl.f * 8 + 2);
//       var lenBytes = varintBytes(inner.length);
//       return concatBytes(tagBytes, lenBytes, inner);
//     }
//     return bytes.subarray(fl.start, fl.end);
//   }
//   function rebuildMessage(bytes, msg, removed) {
//     var parts = [];
//     for (var i = 0; i < msg.length; i++) {
//       var fl = msg[i];
//       if (removed[fl.start]) continue;
//       parts.push(rebuildField(bytes, fl, removed));
//     }
//     return concatBytes.apply(null, parts);
//   }
//   function concatBytes() {
//     var total = 0, i;
//     for (i = 0; i < arguments.length; i++) total += arguments[i].length;
//     var out = new Uint8Array(total), pos = 0;
//     for (i = 0; i < arguments.length; i++) {
//       out.set(arguments[i], pos);
//       pos += arguments[i].length;
//     }
//     return out;
//   }

//   // ---------------- 响应手术 ----------------
//   function processResponse(body) {
//     // 帧头校验：09 30 00 00 00 + 3字节大端总长 + 8字节，protobuf 自偏移16开始
//     if (body.length < 32) return null;
//     if (body[0] !== 0x09 || body[1] !== 0x30) return null;
//     var total = (body[5] << 16) | (body[6] << 8) | body[7];
//     if (total !== body.length) return null;

//     var text = toStr(body);
//     var targets = null;
//     if (text.indexOf(FEAT_MY1) >= 0 || text.indexOf(FEAT_MY2) >= 0) {
//       targets = MY_ITEMS;
//     } else if (text.indexOf(FEAT_NAV) >= 0 || text.indexOf(FEAT_BOTTOM) >= 0) {
//       targets = NAV_TABS;
//     }
//     if (!targets) return null;

//     var msg = parseMessage(body, 16, body.length);
//     if (!msg) return null;

//     var matches = [];
//     collectMatches(body, msg, [], targets, matches);
//     if (!matches.length) return null;

//     var removed = {}, i, c;
//     for (i = 0; i < matches.length; i++) {
//       c = cardFieldFor(body, matches[i]);
//       if (c) removed[c.start] = true;
//     }
//     var keys = Object.keys(removed);
//     if (!keys.length) return null;

//     var newMsg = rebuildMessage(body, msg, removed);
//     var newBody = concatBytes(body.subarray(0, 16), newMsg);
//     var nt = newBody.length;
//     newBody[5] = (nt >> 16) & 0xFF;
//     newBody[6] = (nt >> 8) & 0xFF;
//     newBody[7] = nt & 0xFF;
//     return newBody;
//   }

//   // ---------------- 入口 ----------------
//   if (typeof $response !== 'undefined' && $response) {
//     var reqUrl = ($request && $request.url) || '';
//     if (reqUrl.indexOf('i.video.qq.com') >= 0) {
//       var rb = toU8($response.body);
//       if (rb && rb.length > 32) {
//         var out = processResponse(rb);
//         if (out && out.length !== rb.length) {
//           $done({ body: out });
//           return;
//         }
//       }
//     }
//     $done({});
//     return;
//   }

//   if (typeof $request !== 'undefined' && $request) {
//     var url = $request.url || '';
//     var rawBody = $request.body || '';
//     var wasU8 = rawBody instanceof Uint8Array;
//     var reqStr = toStr(rawBody);

//     // 1) 播放接口参数改写（去贴片/试看广告）
//     if ((url.indexOf('vv.video.qq.com') >= 0 || url.indexOf('vv6.video.qq.com') >= 0) &&
//         (url.indexOf('getvinfo') >= 0 || url.indexOf('batchvinfo') >= 0)) {
//       var nb = reqStr
//         .replace(/sppreviewtype=\d+/g, 'sppreviewtype=0')
//         .replace(/spsrt=\d+/g, 'spsrt=0');
//       if (nb !== reqStr) {
//         if (wasU8) {
//           var arr = new Uint8Array(nb.length);
//           for (var z = 0; z < nb.length; z++) arr[z] = nb.charCodeAt(z) & 0xff;
//           $done({ body: arr });
//         } else {
//           $done({ body: nb });
//         }
//         return;
//       }
//       $done({});
//       return;
//     }

//     // 2) 广告类 TRPC 请求拦截
//     if (url.indexOf('i.video.qq.com') >= 0 || url.indexOf('iwan.video.qq.com') >= 0) {
//       for (var k = 0; k < AD_METHODS.length; k++) {
//         if (reqStr.indexOf(AD_METHODS[k]) >= 0) {
//           $done({ response: { status: 204, headers: {}, body: '' } });
//           return;
//         }
//       }
//     }
//     $done({});
//     return;
//   }

//   $done({});
// })();

// (function (global) {
//   'use strict';

//   /* ============ 可配置规则 ============ */
//   var CFG = {
//     DIAG_NOTIFY: true,          // 诊断期：处理动作弹系统通知（验证完可改 false）
//     NOTIFY_INTERVAL_MS: 20000,  // 动作通知限频（毫秒）
//     DIAG_NOTIFY_INTERVAL_MS: 10000, // 诊断通知限频（毫秒）
//     // 底部 Tab 栏要删除的条目标题（f3 字段值）。默认去掉「短剧」「好物/好片」两个运营 tab
//     removeTabs: ['短剧', '好物', '好片'],
//     // 个人中心 VIP 营销推广卡标题（user_info 卡组内）
//     removeVipPromoTitles: ['特惠升级SVIP', '新人16元看比赛', 'JUMP卡上新', '年轻人专属会员', '优惠宽带送VIP'],
//     // 更多功能/顶部功能里要移除的运营推广项（按标题或 key 匹配）
//     removeOpTitles: ['游戏福利', 'GOODS商城', '免费看漫剧', '免费领会员', '摸鱼免费玩', '我的游戏', '爱玩游戏', '免流量领会员', '领权益送会员'],
//     removeOpKeys: ['game', 'goods', 'operation_position', 'resource_icon', 'aibot'],
//     // 运营配置接口（纯 protobuf 配置响应）中要删除的 JSON 菜单键（键名即个人中心入口文案）
//     configRemoveKeys: ['我的游戏', '爱玩游戏', '免流量领会员', '领权益送会员'],
//     // 个人中心整模块删除（广告位）
//     removeModules: ['user_center_ad_middle'],
//     // 请求体含以下方法名的 i.video.qq.com 请求 → 直接返回空帧（广告类接口）
//     blockApiMethods: ['GetFloatActivity', 'GetFollowHeartRewardAdInfo', 'GetSDKInitData', 'AccessPromotion']
//   };

//   /* ============ 字节工具 ============ */
//   function utf8Bytes(str) {
//     var out = [], i, c;
//     for (i = 0; i < str.length; i++) {
//       c = str.charCodeAt(i);
//       if (c < 0x80) out.push(c);
//       else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
//       else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
//     }
//     return out;
//   }
//   function findBytes(hay, needle, from) {
//     if (!hay || !needle || needle.length === 0) return -1;
//     var i, j, n = hay.length, m = needle.length;
//     from = from || 0;
//     outer: for (i = from; i + m <= n; i++) {
//       for (j = 0; j < m; j++) if (hay[i + j] !== needle[j]) continue outer;
//       return i;
//     }
//     return -1;
//   }
//   function containsBytes(hay, needle) { return findBytes(hay, needle) >= 0; }
//   function bytesToStr(bytes) {
//     // UTF-8 -> JS string, invalid sequences become '' (treated as binary)
//     var out = [], i = 0, n = bytes.length, c1, c2, c3;
//     while (i < n) {
//       c1 = bytes[i];
//       if (c1 < 0x80) { out.push(String.fromCharCode(c1)); i++; }
//       else if ((c1 & 0xe0) === 0xc0 && i + 1 < n && (bytes[i + 1] & 0xc0) === 0x80) {
//         out.push(String.fromCharCode(((c1 & 31) << 6) | (bytes[i + 1] & 63))); i += 2;
//       } else if ((c1 & 0xf0) === 0xe0 && i + 2 < n && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) {
//         c2 = bytes[i + 1]; c3 = bytes[i + 2];
//         out.push(String.fromCharCode(((c1 & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63))); i += 3;
//       } else return ''; // binary
//     }
//     return out.join('');
//   }
//   /* ============ protobuf wire 解析 ============ */
//   function readVarint(buf, pos) {
//     var v = 0, shift = 0, b;
//     while (pos < buf.length) {
//       b = buf[pos++];
//       v |= (b & 0x7f) << shift;
//       if (!(b & 0x80)) return { v: v >>> 0, pos: pos };
//       shift += 7;
//       if (shift > 35) return null;
//     }
//     return null;
//   }
//   function varintBytes(v) {
//     var out = [];
//     while (true) {
//       var b = v & 0x7f; v >>>= 7;
//       if (v) out.push(b | 0x80); else { out.push(b); break; }
//     }
//     return out;
//   }

//   // Parse protobuf region [start,end). Fields: {f, wt, val, data(Uint8Array|null), start, end}
//   function parseFields(buf, start, end) {
//     var fields = [], pos = start, r, ln;
//     while (pos < end) {
//       r = readVarint(buf, pos);
//       if (!r || r.pos > end) break;
//       var tag = r.v, fs = pos;
//       pos = r.pos;
//       var fnum = tag >>> 3, wt = tag & 7;
//       if (wt === 0) {
//         r = readVarint(buf, pos);
//         if (!r) break;
//         fields.push({ f: fnum, wt: 0, val: r.v, start: fs, end: r.pos });
//         pos = r.pos;
//       } else if (wt === 2) {
//         r = readVarint(buf, pos);
//         if (!r) break;
//         ln = r.v; pos = r.pos;
//         if (pos + ln > end) break;
//         fields.push({ f: fnum, wt: 2, data: buf.subarray(pos, pos + ln), start: fs, end: pos + ln });
//         pos += ln;
//       } else if (wt === 1) {
//         if (pos + 8 > end) break;
//         fields.push({ f: fnum, wt: 1, data: buf.subarray(pos, pos + 8), start: fs, end: pos + 8 });
//         pos += 8;
//       } else if (wt === 5) {
//         if (pos + 4 > end) break;
//         fields.push({ f: fnum, wt: 5, data: buf.subarray(pos, pos + 4), start: fs, end: pos + 4 });
//         pos += 4;
//       } else break;
//     }
//     return fields;
//   }
//   function parseFull(buf, start, end) {
//     var fs = parseFields(buf, start, end);
//     if (!fs.length) return null;
//     var last = fs[fs.length - 1];
//     if (last.end !== end) return null;
//     return fs;
//   }
//   function fieldStr(bytes) {
//     var s = bytesToStr(bytes);
//     return s === '' ? null : s;
//   }
//   /* ============ 编辑核心（先判删后递归，字节无损） ============ */
//   function concatParts(parts, total) {
//     var out = new Uint8Array(total), p = 0, i;
//     for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
//     return out;
//   }
//   function encodeField(f, payload, wt) {
//     var tagV = varintBytes((f << 3) | (wt === undefined ? 2 : wt));
//     var lenV = varintBytes(payload.length);
//     var out = new Uint8Array(tagV.length + lenV.length + payload.length);
//     var p = 0, i;
//     for (i = 0; i < tagV.length; i++) out[p++] = tagV[i];
//     for (i = 0; i < lenV.length; i++) out[p++] = lenV[i];
//     out.set(payload, p);
//     return out;
//   }
//   function rawSlice(buf, start, end) { return buf.subarray(start, end); }

//   // editTree(seg) -> Uint8Array|null (null = no change); pred(fieldPayload) -> bool drop
//   function editTree(seg, pred, depth, maxd) {
//     var fs = parseFull(seg, 0, seg.length);
//     if (!fs || depth > maxd) return null;
//     var parts = [], total = 0, changed = false, i, x, sub, nd, raw;
//     for (i = 0; i < fs.length; i++) {
//       x = fs[i];
//       if (x.wt === 2) {
//         if (pred(x.data)) { changed = true; continue; }          // 整字段删除
//         sub = parseFull(x.data, 0, x.data.length);
//         if (sub) {
//           nd = editTree(x.data, pred, depth + 1, maxd);           // 递归清理内部
//           if (nd) {
//             raw = encodeField(x.f, nd, 2);
//             parts.push(raw); total += raw.length; changed = true;
//             continue;
//           }
//         }
//         raw = rawSlice(seg, x.start, x.end);
//         parts.push(raw); total += raw.length;
//       } else if (x.wt === 0) {
//         raw = rawSlice(seg, x.start, x.end);
//         parts.push(raw); total += raw.length;
//       } else {
//         raw = rawSlice(seg, x.start, x.end);
//         parts.push(raw); total += raw.length;
//       }
//     }
//     if (!changed) return null;
//     return concatParts(parts, total);
//   }

//   // 顶层字段字符串列表（用于标题/黑名单判断，避免误伤子层）
//   function topStrs(seg) {
//     var fs = parseFull(seg, 0, seg.length), out = [], i, s;
//     if (!fs) return out;
//     for (i = 0; i < fs.length; i++) {
//       if (fs[i].wt === 2) { s = fieldStr(fs[i].data); if (s !== null) out.push(s); }
//     }
//     return out;
//   }
//   function containsChinese(s) { return /[\u4e00-\u9fff]/.test(s); }
//   function inList(s, list) { return list.indexOf(s) >= 0; }

//   /* ============ 谓词（与 Python 原型同语义） ============ */
//   function isCardLike(seg) {
//     // 卡级 msg：顶层至少 1 个字符串字段，且总字段数 >= 3（排除单字段 str / 双字段 kv）
//     var fs = parseFull(seg, 0, seg.length), i, hasStr = false, t;
//     if (!fs || fs.length < 3) return false;
//     for (i = 0; i < fs.length; i++) {
//       if (fs[i].wt === 2) {
//         t = fieldStr(fs[i].data);
//         if (t !== null) { hasStr = true; break; }
//       }
//     }
//     return hasStr;
//   }
//   function predVipPromo(seg) {
//     if (!isCardLike(seg)) return false;
//     var strs = topStrs(seg), i, j;
//     for (i = 0; i < strs.length; i++) if (inList(strs[i], CFG.removeVipPromoTitles)) return true;
//     for (i = 0; i < strs.length; i++) {
//       if (strs[i] === 'ptag') {
//         for (j = i + 1; j < Math.min(strs.length, i + 6); j++) {
//           if (strs[j] !== null && strs[j].length > 3 && strs[j].substring(0, 3) === 'ad.') return true;
//         }
//       }
//     }
//     return false;
//   }
//   function predOpItem(seg) {
//     if (!isCardLike(seg)) return false;
//     var strs = topStrs(seg), i, j, hasCJK = false, gameUrl = false, magicUrl = false;
//     for (i = 0; i < strs.length; i++) {
//       if (inList(strs[i], CFG.removeOpTitles)) return true;
//       if (containsChinese(strs[i])) hasCJK = true;
//       if (strs[i].indexOf('iwan.qq.com/g/') >= 0) gameUrl = true;   // 游戏中心入口
//       if (strs[i].indexOf('magic-act') >= 0) magicUrl = true;       // 营销活动 H5（免流量领会员/领权益送会员）
//     }
//     if (hasCJK) {
//       for (i = 0; i < strs.length; i++) if (inList(strs[i], CFG.removeOpKeys)) return true;
//       if (gameUrl || magicUrl) return true;
//     }
//     return false;
//   }
//   function predAdModule(seg) {
//     var fs = parseFull(seg, 0, seg.length), i, t;
//     if (!fs) return false;
//     for (i = 0; i < fs.length; i++) {
//       if (fs[i].wt === 2 && fs[i].f === 2) {
//         t = fieldStr(fs[i].data);
//         if (t !== null && inList(t, CFG.removeModules)) return true;
//       }
//     }
//     return false;
//   }
//   var AD_TYPE_HITS = ['ad_insert_mix_block', 'ad_feed', 'feed_ad', 'adfeed', 'ad_focus', 'ad_ssp', 'ad_load'];
//   function predAdCardId(seg) {
//     // 卡级判定：id 为 ad 前缀 或 type 为广告容器类型（不做内容检查，可安全用于模块级）
//     if (!isCardLike(seg)) return false;
//     var fs = parseFull(seg, 0, seg.length), i, t, low;
//     if (!fs) return false;
//     var mid = '', mtype = '';
//     for (i = 0; i < fs.length; i++) {
//       if (fs[i].wt === 2) {
//         t = fieldStr(fs[i].data);
//         if (t === null) continue;
//         if (fs[i].f === 1) mid = t;
//         else if (fs[i].f === 2) mtype = t;
//       }
//     }
//     low = mid.toLowerCase();
//     if (low.substring(0, 8) === 'ad_block_' || low.substring(0, 3) === 'ad_') return true;
//     low = mtype.toLowerCase();
//     if (low.substring(0, 3) === 'ad_' || low.substring(low.length - 3) === '_ad') return true;
//     for (i = 0; i < AD_TYPE_HITS.length; i++) if (low.indexOf(AD_TYPE_HITS[i]) >= 0) return true;
//     return false;
//   }
//   function predAdAnyField(seg) {
//     // 字段级：payload 本身是 Any 消息且 type_url 命中广告类型（删除广告数据字段，不伤兄弟字段/正常卡）
//     var fs = parseFull(seg, 0, seg.length), i, t;
//     if (!fs) return false;
//     for (i = 0; i < fs.length; i++) {
//       if (fs[i].wt === 2 && fs[i].f === 1) {
//         t = fieldStr(fs[i].data);
//         if (t !== null && t.indexOf('type.googleapis.com/') === 0 && predAdAny(seg)) return true;
//       }
//     }
//     return false;
//   }
//   var MARKERS_AD = [utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdFeedInfo'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdFocusPoster'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdFeedVideoPoster'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdResponseInfo'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.LoadingConfig'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.InnerAdPromotionEventList'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.InnerAdPullRefreshEventList'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.InnerAdPullRefreshExtraDisplayInfo'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.InnerAdCommonPromotionEventActivityList'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdOpenWxProgramAction'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdOpenAppAction'),
//     utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdJumpAction')];
//   function predAdAny(seg) {
//     var i;
//     for (i = 0; i < MARKERS_AD.length; i++) if (containsBytes(seg, MARKERS_AD[i])) return true;
//     return false;
//   }
//   function predTab(seg) {
//     // tab 条目 msg: f3 = 标题
//     var fs = parseFull(seg, 0, seg.length), i, t;
//     if (!fs) return false;
//     for (i = 0; i < fs.length; i++) {
//       if (fs[i].wt === 2 && fs[i].f === 3) {
//         t = fieldStr(fs[i].data);
//         if (t !== null && inList(t, CFG.removeTabs)) return true;
//       }
//     }
//     return false;
//   }

//   /* ============ 页面级处理 ============ */
//   // 找到锚点：qqlive_rsp_head 所在的 f8 字段起点
//   var ANCHOR = utf8Bytes('\x0a\x0fqqlive_rsp_head');
//   function bodyAnchor(buf) {
//     var i = findBytes(buf, ANCHOR), back, q, r, r2;
//     if (i < 0) return -1;
//     for (back = 2; back <= 8; back++) {
//       q = i - back;
//       if (q < 0) break;
//       r = readVarint(buf, q);
//       if (!r) continue;
//       if ((r.v >>> 3) === 8 && (r.v & 7) === 2 && r.pos <= i) {
//         r2 = readVarint(buf, r.pos);
//         if (r2 && r2.pos === i) return q;
//       }
//     }
//     return i - 2;
//   }
//   function editPageExact(page, modulePreds, innerPreds) {
//     // 严谨实现：定位 f2 列表字段 → 过滤 f1 模块（其余字段原样保留）→ 每个保留模块递归 editTree
//     var inner = parseFields(page, 0, page.length), parts = [], total = 0, i, x, raw;
//     var listIndex = -1, j;
//     for (i = 0; i < inner.length; i++) if (inner[i].wt === 2 && inner[i].f === 2) { listIndex = i; break; }
//     for (i = 0; i < inner.length; i++) {
//       x = inner[i];
//       if (i === listIndex && x.wt === 2) {
//         var mods = parseFields(x.data, 0, x.data.length);
//         var keep = [], anyChange = false, k;
//         for (j = 0; j < mods.length; j++) {
//           var m = mods[j];
//           if (m.wt === 2 && m.f === 1) {
//             var drop = false;
//             for (k = 0; k < modulePreds.length; k++) if (modulePreds[k](m.data)) { drop = true; break; }
//             if (drop) { anyChange = true; continue; }
//             var edited = null;
//             for (k = 0; k < innerPreds.length; k++) {
//               edited = editTree(m.data, innerPreds[k], 0, 14);
//               if (edited) break;
//             }
//             if (edited) { keep.push(edited); anyChange = true; }
//             else keep.push(m.data);
//           } else keep.push(rawSlice(x.data, m.start, m.end));
//         }
//         if (!anyChange) { raw = rawSlice(page, x.start, x.end); parts.push(raw); total += raw.length; continue; }
//         var lp, lparts = [], ltotal = 0;
//         for (j = 0; j < keep.length; j++) {
//           lp = encodeField(1, keep[j], 2);
//           lparts.push(lp); ltotal += lp.length;
//         }
//         var listBytes = concatParts(lparts, ltotal);
//         raw = encodeField(2, listBytes, 2);
//         parts.push(raw); total += raw.length;
//       } else {
//         raw = rawSlice(page, x.start, x.end); parts.push(raw); total += raw.length;
//       }
//     }
//     return concatParts(parts, total);
//   }
//   /* ============ 运营配置响应（纯 protobuf 无 tRPC 帧）JSON 菜单键删除 ============ */
//   function bytesToLatin1(u8) {
//     var s = '', i, chunk = 8192, seg;
//     for (i = 0; i < u8.length; i += chunk) {
//       seg = u8.subarray ? u8.subarray(i, Math.min(i + chunk, u8.length)) : u8.slice(i, Math.min(i + chunk, u8.length));
//       s += String.fromCharCode.apply(null, seg);
//     }
//     return s;
//   }
//   function latin1ToBytes(s) {
//     var out = new Uint8Array(s.length), i;
//     for (i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
//     return out;
//   }
//   function stripJsonKeys(latin) {
//     // latin: JSON 对象字符串（latin1/UTF-8 字节视图）。删除 CFG.configRemoveKeys 中的键值对
//     if (!latin || latin.charAt(0) !== '{') return null;
//     var out = latin, i, keyLat, re, prev;
//     for (i = 0; i < CFG.configRemoveKeys.length; i++) {
//       keyLat = bytesToLatin1(utf8Bytes(CFG.configRemoveKeys[i]));
//       re = new RegExp('"' + keyLat + '"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*",?', 'g');
//       out = out.replace(re, '');
//     }
//     if (out === latin) return null;
//     // 清理残留逗号（",}" → "}" 等）
//     out = out.replace(/,\s*([}\]])/g, '$1');
//     out = out.replace(/^\s*,/, '');
//     return out;
//   }
//   function editAnyFieldJson(seg, depth) {
//     if (depth > 8 || seg.length > 3000000) return null;
//     var fs = parseFull(seg, 0, seg.length);
//     if (!fs) return null;
//     var parts = [], total = 0, changed = false, i, x, raw, s, ns, sub;
//     for (i = 0; i < fs.length; i++) {
//       x = fs[i];
//       if (x.wt === 2) {
//         if (x.data.length > 0 && x.data[0] === 0x7b) {  // '{'
//           s = bytesToLatin1(x.data);
//           ns = stripJsonKeys(s);
//           if (ns !== null) {
//             raw = encodeField(x.f, latin1ToBytes(ns), 2);
//             parts.push(raw); total += raw.length; changed = true;
//             continue;
//           }
//         }
//         sub = editAnyFieldJson(x.data, depth + 1);
//         if (sub) {
//           raw = encodeField(x.f, sub, 2);
//           parts.push(raw); total += raw.length; changed = true;
//           continue;
//         }
//         raw = rawSlice(seg, x.start, x.end);
//         parts.push(raw); total += raw.length;
//       } else {
//         raw = rawSlice(seg, x.start, x.end);
//         parts.push(raw); total += raw.length;
//       }
//     }
//     if (!changed) return null;
//     return concatParts(parts, total);
//   }
//   function editConfigJson(body) {
//     var hit = false, i;
//     for (i = 0; i < CFG.configRemoveKeys.length; i++) {
//       if (containsBytes(body, utf8Bytes(CFG.configRemoveKeys[i]))) { hit = true; break; }
//     }
//     if (!hit) return null;
//     return editAnyFieldJson(body, 0);
//   }

//   function processResponseBody(body) {
//     if (!body || body.length < 30) return null;
//     if (isGzip(body)) {
//       var plain = inflateGzip(body);
//       if (!plain) return null;
//       body = plain;
//     }
//     var anchor = bodyAnchor(body);
//     if (anchor < 0) {
//       // 无 tRPC 帧：可能是运营配置接口（纯 protobuf，菜单以 JSON 键值下发）
//       return editConfigJson(body);
//     }
//     var newBody = null;
//     if (containsBytes(body, utf8Bytes('GetTabListRsp'))) {
//       // tab 栏精简
//       newBody = editPageExactAt(body, [], [predTab]);
//     }
//     if (!newBody && containsBytes(body, utf8Bytes('user_center_ad_middle'))) {
//       newBody = editPageExactAt(body, [predAdModule], [predVipPromo, predOpItem]);
//     }
//     if (!newBody && containsBytes(body, utf8Bytes('user_center_more_function'))) {
//       newBody = editPageExactAt(body, [predAdModule], [predVipPromo, predOpItem]);
//     }
//     var pageish = containsBytes(body, utf8Bytes('user_center_')) || containsBytes(body, utf8Bytes('GetTabListRsp'))
//       || containsBytes(body, utf8Bytes('ad_block_')) || containsBytes(body, utf8Bytes('AdFeedInfo'));
//     var standaloneAd = (containsBytes(body, utf8Bytes('InnerAdCommon')) || containsBytes(body, utf8Bytes('LoadingConfig'))
//       || containsBytes(body, utf8Bytes('AdFeedVideoPoster'))) && !pageish;
//     if (standaloneAd) {
//       // 独立广告接口（GetFloatActivity / AccessPromotion / GetPersonalCenterAdData）：
//       // 整体替换为空响应帧模板（客户端解析为“无广告数据”）
//       newBody = b64decodeBytes(EMPTY_FRAME_B64);
//     } else if (!newBody && (containsBytes(body, utf8Bytes('ad_block_')) || containsBytes(body, utf8Bytes('AdFeed'))
//         || containsBytes(body, utf8Bytes('AdResponseInfo')) || containsBytes(body, utf8Bytes('InnerAd'))
//         || containsBytes(body, utf8Bytes('LoadingConfig')))) {
//       newBody = editPageExactAt(body, [predAdCardId], [predAdCardId, predAdAnyField]);
//     }
//     return newBody;
//   }
//   function editPageExactAt(body, modulePreds, innerPreds) {
//     var anchor = bodyAnchor(body);
//     if (anchor < 0) return null;
//     var fs = parseFields(body, anchor, body.length), parts = [], total = 0, i, x, raw, pageNew, edited, changed = false;
//     for (i = 0; i < fs.length; i++) {
//       x = fs[i];
//       if (x.wt === 2 && x.f === 1) {
//         pageNew = editPageExact(x.data, modulePreds, innerPreds);
//         if (!pageNew) return null;
//         raw = encodeField(1, pageNew, 2);
//         if (pageNew.length !== x.data.length) changed = true;
//         parts.push(raw); total += raw.length;
//       } else if (x.wt === 2) {
//         // 页面外的顶层字段（如尾部广告/扩展数据 msg）也做内层清理
//         edited = null;
//         var k;
//         for (k = 0; k < innerPreds.length; k++) {
//           edited = editTree(x.data, innerPreds[k], 0, 14);
//           if (edited) break;
//         }
//         if (edited) { raw = encodeField(x.f, edited, 2); changed = true; }
//         else raw = rawSlice(body, x.start, x.end);
//         parts.push(raw); total += raw.length;
//       } else {
//         raw = rawSlice(body, x.start, x.end); parts.push(raw); total += raw.length;
//       }
//     }
//     if (!changed) return null;
//     var head = rawSlice(body, 0, anchor);
//     var merged = concatParts(parts, total);
//     var out = new Uint8Array(head.length + merged.length);
//     out.set(head, 0); out.set(merged, head.length);
//     return out;
//   }

// /* 纯 JS gzip(stored 块) 打包：输出合法 gzip 但内容未压缩（RFC1950/1951 stored blocks）。
//    用途：Loon 转发「脚本编辑后的响应」时可能保留原始 content-encoding: gzip 头，
//    若直接给明文客户端会解压失败 → 网络错误。输出 stored-gzip 与 gzip 头自洽，
//    客户端可正常解压出 protobuf。 */
// var CRC_TABLE = null;
// function crc32(u8) {
//   if (!CRC_TABLE) {
//     CRC_TABLE = new Int32Array(256);
//     for (var n = 0; n < 256; n++) {
//       var c = n;
//       for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
//       CRC_TABLE[n] = c;
//     }
//   }
//   var crc = -1, i;
//   for (i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ u8[i]) & 0xff];
//   return (crc ^ -1) >>> 0;
// }
// function gzipStored(u8) {
//   var parts = [], blocks = Math.max(1, Math.ceil(u8.length / 65535)), i, pos = 0, len, j, crc, isize;
//   // gzip 头：magic(2) CM=8(1) FLG=0(1) MTIME(4) XFL=0(1) OS=255(1)
//   parts.push(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]));
//   for (i = 0; i < blocks; i++) {
//     len = Math.min(65535, u8.length - pos);
//     var last = (i === blocks - 1) ? 1 : 0;
//     var head = new Uint8Array(5);
//     head[0] = last;                    // BFINAL + BTYPE=00(stored)
//     head[1] = len & 0xff;              // LEN 小端
//     head[2] = (len >> 8) & 0xff;
//     head[3] = (~len) & 0xff;           // NLEN = ~LEN 小端
//     head[4] = ((~len) >> 8) & 0xff;
//     parts.push(head);
//     parts.push(u8.subarray(pos, pos + len));
//     pos += len;
//   }
//   crc = crc32(u8);
//   isize = u8.length >>> 0;
//   var tail = new Uint8Array(8);
//   tail[0] = crc & 0xff; tail[1] = (crc >> 8) & 0xff; tail[2] = (crc >> 16) & 0xff; tail[3] = (crc >>> 24) & 0xff;
//   tail[4] = isize & 0xff; tail[5] = (isize >> 8) & 0xff; tail[6] = (isize >> 16) & 0xff; tail[7] = (isize >>> 24) & 0xff;
//   parts.push(tail);
//   var total = 0;
//   for (i = 0; i < parts.length; i++) total += parts[i].length;
//   var out = new Uint8Array(total), p = 0;
//   for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
//   return out;
// }

// /* 纯 JS gzip inflate（RFC1950/1951），ES5 无依赖。返回 Uint8Array 或 null */
// function inflateGzip(src) {
//   if (!src || src.length < 18 || src[0] !== 0x1f || src[1] !== 0x8b || src[2] !== 8) return null;
//   var p = 10, flg = src[3], xlen, i;
//   if (flg & 4) { xlen = src[p] | (src[p + 1] << 8); p += 2 + xlen; }
//   if (flg & 8) { while (src[p] !== 0) p++; p++; }
//   if (flg & 16) { while (src[p] !== 0) p++; p++; }
//   if (flg & 2) p += 2;
//   if (p >= src.length) return null;

//   var inPos = p;
//   var out = [];

//   var bitPos = 0;
//   function getBits(n) {
//     var v = 0, i;
//     for (i = 0; i < n; i++) {
//       v |= ((src[inPos] >> bitPos) & 1) << i;
//       if (++bitPos === 8) { bitPos = 0; inPos++; }
//     }
//     return v;
//   }

//   function buildTable(lens, n) {
//     var maxLen = 0, i;
//     for (i = 0; i < n; i++) if (lens[i] > maxLen) maxLen = lens[i];
//     if (maxLen === 0) return null;
//     var count = new Array(maxLen + 1), code = new Array(maxLen + 1), j;
//     for (i = 0; i <= maxLen; i++) count[i] = 0;
//     for (i = 0; i < n; i++) count[lens[i]]++;
//     count[0] = 0;
//     code[0] = 0;
//     for (i = 1; i <= maxLen; i++) code[i] = (code[i - 1] + count[i - 1]) << 1;
//     var t = new Int16Array(1 << maxLen);
//     for (i = 0; i < t.length; i++) t[i] = -1;
//     for (i = 0; i < n; i++) {
//       var len = lens[i];
//       if (len === 0) continue;
//       var c = code[len]++;
//       var start = c << (maxLen - len), span = 1 << (maxLen - len);
//       for (j = start; j < start + span; j++) t[j] = i;
//     }
//     t.maxBits = maxLen;
//     t.lens = lens;
//     return t;
//   }

//   function readSym(t) {
//     var idx = 0, i, k;
//     for (i = 0; i < t.maxBits; i++) idx = (idx << 1) | getBits(1);
//     var s = t[idx];
//     if (s < 0) return -1;
//     k = t.maxBits - t.lens[s];
//     while (k-- > 0) { bitPos--; if (bitPos < 0) { bitPos = 7; inPos--; } }
//     return s;
//   }

//   /* fixed huffman 表：lit/dist 码长（RFC1951 3.2.6） */
//   var FIXED_LIT_LENS = new Array(288), FIXED_DIST_LENS = new Array(30), z;
//   for (z = 0; z < 144; z++) FIXED_LIT_LENS[z] = 8;
//   for (; z < 256; z++) FIXED_LIT_LENS[z] = 9;
//   for (; z < 280; z++) FIXED_LIT_LENS[z] = 7;
//   for (; z < 288; z++) FIXED_LIT_LENS[z] = 8;
//   for (z = 0; z < 30; z++) FIXED_DIST_LENS[z] = 5;
//   var FIXED_LIT = buildTable(FIXED_LIT_LENS, 288);
//   var FIXED_DIST = buildTable(FIXED_DIST_LENS, 30);
//   var ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
//   var LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
//   var LEN_EXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
//   var DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
//   var DIST_EXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

//   var finished = false, guard = 0, MAX_OUT = 2000000;
//   while (!finished) {
//     if (guard++ > 500000) return null;
//     var bfinal = getBits(1), btype = getBits(2);
//     if (btype === 0) {
//       if (bitPos !== 0) { inPos++; bitPos = 0; } /* 字节对齐：丢弃当前字节剩余位 */
//       if (inPos + 4 > src.length) return null;
//       var llen = src[inPos] | (src[inPos + 1] << 8);
//       var nlen = src[inPos + 2] | (src[inPos + 3] << 8);
//       inPos += 4;
//       if ((llen ^ 0xffff) !== nlen) return null;
//       if (inPos + llen > src.length || out.length + llen > MAX_OUT) return null;
//       for (var si = 0; si < llen; si++) out.push(src[inPos + si]);
//       inPos += llen;
//     } else {
//       var litT, distT;
//       if (btype === 1) { litT = FIXED_LIT; distT = FIXED_DIST; }
//       else if (btype === 2) {
//         var hlit = getBits(5) + 257, hdist = getBits(5) + 1, hclen = getBits(4) + 4;
//         if (hlit > 286 || hdist > 30) return null;
//         var clLens = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
//         for (var ci = 0; ci < hclen; ci++) clLens[ORDER[ci]] = getBits(3);
//         var clT = buildTable(clLens, 19);
//         if (!clT) return null;
//         var allLens = [], lc = 0, total = hlit + hdist;
//         while (lc < total) {
//           var s = readSym(clT);
//           if (s < 0) return null;
//           if (s < 16) { allLens[lc++] = s; }
//           else if (s === 16) { var rep = getBits(2) + 3, prev = lc > 0 ? allLens[lc - 1] : 0; while (rep--) allLens[lc++] = prev; }
//           else if (s === 17) { var rep2 = getBits(3) + 3; while (rep2--) allLens[lc++] = 0; }
//           else { var rep3 = getBits(7) + 11; while (rep3--) allLens[lc++] = 0; }
//           if (lc > total) return null;
//         }
//         var litLens = allLens.slice(0, hlit), distLens = allLens.slice(hlit, hlit + hdist);
//         litT = buildTable(litLens, hlit);
//         distT = buildTable(distLens, hdist);
//         if (!litT || !distT) return null;
//       } else return null;
//       for (;;) {
//         if (out.length > MAX_OUT) return null;
//         var sym = readSym(litT);
//         if (sym < 0) return null;
//         if (sym === 256) break;
//         if (sym < 256) out.push(sym);
//         else {
//           var li = sym - 257;
//           var l = LEN_BASE[li] + getBits(LEN_EXT[li]);
//           var ds = readSym(distT);
//           if (ds < 0 || ds > 29) return null;
//           var d = DIST_BASE[ds] + getBits(DIST_EXT[ds]);
//           if (d > out.length) return null;
//           for (var m = 0; m < l; m++) out.push(out[out.length - d]);
//         }
//       }
//     }
//     finished = bfinal === 1;
//   }
//   return new Uint8Array(out);
// }

//   /* ============ 请求拦截（广告 API mock 空帧） ============ */
//   function b64decodeBytes(s) {
//     var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
//     var out = [], buf = 0, bits = 0, i, c, idx;
//     for (i = 0; i < s.length; i++) {
//       c = s.charAt(i);
//       if (c === '=') break;
//       idx = chars.indexOf(c);
//       if (idx < 0) continue;
//       buf = (buf << 6) | idx; bits += 6;
//       if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
//     }
//     return new Uint8Array(out);
//   }
//   var EMPTY_FRAME_B64 = 'CTAAAAAAcNsAyjoCsZsBABjlAUJhCg1hY2Nlc3NfcmVwb3J0ElB7InNlcnZpY2VfbmFtZSI6InRycGMub3ZiX2dhbGF4eS5nYXRld2F5Lmh0dHBfdHJwYyIsInNldF9uYW1lIjoib3ZiLmdhbGF4eS5hcHAifUIoCg9xcWxpdmVfcnNwX2hlYWQSFUIAShEInQIYq7uk/Ic0IMi9pPyHNEIeCg51c2VyX2FyZWFfY29kZRIMMTU2MDMzMzMwMTAwQhgKB3VzZXJfaXASDTYwLjE5MC4yNTMuNTg=';
//   function shouldBlockRequest(reqBytes) {
//     if (!reqBytes) return false;
//     var i;
//     for (i = 0; i < CFG.blockApiMethods.length; i++) {
//       if (containsBytes(reqBytes, utf8Bytes(CFG.blockApiMethods[i]))) return true;
//     }
//     return false;
//   }

//   // expose for Loon & node testing
//   var api = {
//     processResponseBody: processResponseBody,
//     shouldBlockRequest: shouldBlockRequest,
//     EMPTY_FRAME_B64: EMPTY_FRAME_B64,
//     inflateGzip: function (u8) { return inflateGzip(u8); },
//     gzipStored: function (u8) { return gzipStored(u8); },
//     crc32: function (u8) { return crc32(u8); },
//     _b64decode: function (s) {
//       // 纯 JS base64 解码（兼容任意 Loon 版本，不依赖 atob/$utils）
//       return b64decodeBytes(s);
//     },
//     _b64encode: function (u8) {
//       // 纯 JS base64 编码
//       var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
//       var out = '', i, b0, b1, b2;
//       for (i = 0; i < u8.length; i += 3) {
//         b0 = u8[i]; b1 = i + 1 < u8.length ? u8[i + 1] : 0; b2 = i + 2 < u8.length ? u8[i + 2] : 0;
//         out += chars[b0 >> 2] + chars[((b0 & 3) << 4) | (b1 >> 4)];
//         out += i + 1 < u8.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
//         out += i + 2 < u8.length ? chars[b2 & 63] : '=';
//       }
//       return out;
//     },
//     processResponse: function (bodyB64) {
//       var raw = api._b64decode(bodyB64);
//       var out = api.processResponseBody(raw);
//       return out ? api._b64encode(out) : null;
//     },
//     processRequest: function (bodyB64) {
//       if (!bodyB64) return false;
//       var raw = api._b64decode(bodyB64);
//       return api.shouldBlockRequest(raw);
//     }
//   };
//   global.QQLiveClean = api;

//   /* ============ 诊断日志（Loon 控制台日志中搜 QQLiveClean） ============ */
//   function log(msg) {
//     try { if (typeof console !== 'undefined' && console.log) console.log('[QQLiveClean] ' + msg); } catch (e) {}
//   }
//   var SCRIPT_VERSION = '1.3';
//   /* 系统通知（带外验证通道）：Loon 主日志可能不显示脚本 console.log，
//      通知横幅可 100% 确认脚本是否运行 / 加载的是哪个版本 */
//   var _notifyTs = {};
//   function notify(kind, title, msg, intervalMs) {
//     try {
//       if (!CFG.DIAG_NOTIFY) return;
//       var now = Date.now ? Date.now() : 0;
//       var last = _notifyTs[kind] || 0;
//       var iv = intervalMs || CFG.NOTIFY_INTERVAL_MS;
//       if (now - last < iv) return;
//       _notifyTs[kind] = now;
//       var t = '[QQLive' + SCRIPT_VERSION + '] ' + title;
//       if (typeof $notification !== 'undefined' && $notification && $notification.post) {
//         $notification.post(t, '', msg);
//       }
//     } catch (e) {}
//   }
//   function notifyOnce(key, title, msg) {
//     /* persistentStore 去重：跨执行只通知一次（用于“脚本已加载 vX”提示） */
//     try {
//       if (typeof $persistentStore !== 'undefined' && $persistentStore) {
//         var v = $persistentStore.read('QQLiveNotifyVersion');
//         if (v === key) return;
//         if ($persistentStore.write) $persistentStore.write(key, 'QQLiveNotifyVersion');
//         notify('version', title, msg);
//       } else {
//         notify('version', title, msg);
//       }
//     } catch (e) {}
//   }
//   function hexHead(u8, n) {
//     var out = '', i;
//     for (i = 0; i < n && i < u8.length; i++) {
//       var h = u8[i].toString(16);
//       if (h.length < 2) h = '0' + h;
//       out += h;
//     }
//     return out;
//   }
//   var DIAG_HITS = ['qqlive_rsp_head', 'user_center_ad_middle', 'GetTabListRsp', 'ad_block_', 'AdFeed', 'AdResponseInfo', 'InnerAdCommon', 'LoadingConfig'];
//   function detectHits(u8) {
//     var out = [], i;
//     for (i = 0; i < DIAG_HITS.length; i++) if (containsBytes(u8, utf8Bytes(DIAG_HITS[i]))) out.push(DIAG_HITS[i]);
//     return out.join(',');
//   }
//   function isGzip(u8) { return u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b; }

//   /* ============ Loon 桥接（IIFE 内，不依赖全局变量暴露） ============ */
//   if (typeof $done !== 'undefined') {
//     try {
//       try { notifyOnce('1.3', 'QQLiveClean v1.3 已加载', '脚本已生效（若您未看到此通知，说明安装的是旧版脚本）'); } catch (e) {}
//       var _u = (typeof $request !== 'undefined' && $request && $request.url) ? $request.url : '';
//       var _reqBody = (typeof $request !== 'undefined' && $request && $request.body) ? $request.body : null;
//       if (typeof $response !== 'undefined' && $response && $response.body) {
//         var _t0 = Date.now ? Date.now() : 0;
//         var _rbody = api._b64decode($response.body);
//         if (!_rbody || _rbody.length === 0) notify('empty', '响应 body 为空(Loon 未传 body)', _u);
//         var _gzipIn = isGzip(_rbody);
//         log('resp len=' + _rbody.length + ' head=' + hexHead(_rbody, 12) + ' gzip=' + _gzipIn + ' hits=[' + detectHits(_rbody) + '] ' + _u);
//         var _out = api.processResponse($response.body);
//         notify('diag', 'RESP len=' + _rbody.length + ' gzip=' + (_gzipIn ? 1 : 0), 'hits=[' + detectHits(_rbody) + '] ' + ((_out && _out !== $response.body) ? 'EDITED' : 'pass'), CFG.DIAG_NOTIFY_INTERVAL_MS);
//         if (_out && _out !== $response.body) {
//           try {
//             var _ce = null, _hdrs = $response.headers || {};
//             if (_hdrs['content-encoding']) _ce = _hdrs['content-encoding'];
//             else if (_hdrs['Content-Encoding']) _ce = _hdrs['Content-Encoding'];
//             var _edited = api._b64decode(_out);
//             if (_ce && String(_ce).toLowerCase().indexOf('gzip') >= 0) {
//               // 响应头保留 content-encoding: gzip：输出合法 gzip（stored 块），客户端解压后即 protobuf
//               $response.body = api._b64encode(gzipStored(_edited));
//             } else {
//               // 原始响应未压缩：直接输出明文
//               $response.body = _out;
//             }
//             $response.headers['X-QQLive-Clean'] = '1';
//           } catch (e3) {
//             $response.body = _out;
//           }
//           log('response EDITED ' + (_t0 ? (Date.now() - _t0) + 'ms ' : '') + (_gzipIn ? '(decompressed+edited) ' : '') + _u);
//           notify('resp', '已精简 ' + Math.round($response.body.length / 1024) + 'KB', _u);
//           $done({ response: $response });
//         } else {
//           $done({});
//         }
//       } else {
//         var _reqRaw = _reqBody ? api._b64decode(_reqBody) : null;
//         if (_reqBody && (!_reqRaw || _reqRaw.length === 0)) notify('empty', '请求 body 为空(Loon 未传 body)', _u);
//         var _reqGzip = _reqRaw ? isGzip(_reqRaw) : false;
//         if (_reqGzip) { _reqRaw = inflateGzip(_reqRaw); log('req gzip decompressed ' + (_reqRaw ? _reqRaw.length : 0) + 'B'); }
//         log('req len=' + (_reqRaw ? _reqRaw.length : 0) + ' head=' + (_reqRaw ? hexHead(_reqRaw, 12) : '-') + ' gzip=' + _reqGzip + ' ' + _u);
//         var _blocked = _reqRaw ? api.shouldBlockRequest(_reqRaw) : false;
//         notify('diag', 'REQ len=' + (_reqRaw ? _reqRaw.length : 0) + ' gzip=' + (_reqGzip ? 1 : 0), (_blocked ? 'BLOCK' : 'pass'), CFG.DIAG_NOTIFY_INTERVAL_MS);
//         if (_blocked) {
//           log('request BLOCKED (ad api) ' + _u);
//           notify('req', '广告接口已拦截', _u);
//           $done({ response: { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: api.EMPTY_FRAME_B64 } });
//         } else {
//           $done({});
//         }
//       }
//     } catch (e) {
//       try { log('error: ' + (e && e.message ? e.message : e)); } catch (e2) {}
//       try { $done({}); } catch (e3) {}
//     }
//   }
// })(typeof globalThis !== 'undefined' ? globalThis
//     : (typeof self !== 'undefined' ? self
//     : (typeof window !== 'undefined' ? window : {})));
