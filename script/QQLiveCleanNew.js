/*
 * QQLiveClean.js — 腾讯视频 iOS（v9.x / MVL 布局）去广告 + 个人中心与 Tab 精简
 * 运行环境: Loon Script (http-request / http-response)
 * 实现: 无损 protobuf 子树删除（wire-format 级，不解析业务 schema）
 */
// (function (global) {
  'use strict';

  /* ============ 可配置规则 ============ */
  var CFG = {
    // 底部 Tab 栏要删除的条目标题（f3 字段值）。默认去掉「短剧」「好物」两个运营 tab
    removeTabs: ['短剧', '好物'],
    // 个人中心 VIP 营销推广卡标题（user_info 卡组内）
    removeVipPromoTitles: ['特惠升级SVIP', '新人16元看比赛', 'JUMP卡上新', '年轻人专属会员', '优惠宽带送VIP'],
    // 更多功能/顶部功能里要移除的运营推广项（按标题或 key 匹配）
    removeOpTitles: ['游戏福利', 'GOODS商城', '免费看漫剧', '免费领会员', '摸鱼免费玩'],
    removeOpKeys: ['game', 'goods', 'operation_position', 'resource_icon', 'aibot'],
    // 个人中心整模块删除（广告位）
    removeModules: ['user_center_ad_middle'],
    // 请求体含以下方法名的 i.video.qq.com 请求 → 直接返回空帧（广告类接口）
    blockApiMethods: ['GetFloatActivity', 'GetFollowHeartRewardAdInfo', 'GetSDKInitData', 'AccessPromotion']
  };

  /* ============ 纯 JS 环境 Base64 编解码器（修复 Loon 缺少 atob/btoa 的致命 Bug） ============ */
  var b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64ToUint8(str) {
    var lookup = new Uint8Array(256);
    for (var idx = 0; idx < b64Chars.length; idx++) lookup[b64Chars.charCodeAt(idx)] = idx;
    var bufferLength = str.length * 0.75, len = str.length, i, p = 0, encoded1, encoded2, encoded3, encoded4;
    if (str[str.length - 1] === '=') { bufferLength--; if (str[str.length - 2] === '=') bufferLength--; }
    var bytes = new Uint8Array(bufferLength);
    for (i = 0; i < len; i += 4) {
      encoded1 = lookup[str.charCodeAt(i)]; encoded2 = lookup[str.charCodeAt(i + 1)];
      encoded3 = lookup[str.charCodeAt(i + 2)]; encoded4 = lookup[str.charCodeAt(i + 3)];
      bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
      if (p < bufferLength) bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
      if (p < bufferLength) bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }
    return bytes;
  }
  function uint8ToB64(bytes) {
    var len = bytes.length, base64 = '', i;
    for (i = 0; i < len; i += 3) {
      base64 += b64Chars[bytes[i] >> 2];
      base64 += b64Chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
      base64 += b64Chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
      base64 += b64Chars[bytes[i + 2] & 63];
    }
    if (len % 3 === 2) base64 = base64.substring(0, base64.length - 1) + '=';
    else if (len % 3 === 1) base64 = base64.substring(0, base64.length - 2) + '==';
    return base64;
  }

  /* ============ 字节工具 ============ */
  function utf8Bytes(str) {
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }
  function findBytes(hay, needle, from) {
    if (!hay || !needle || needle.length === 0) return -1;
    var i, j, n = hay.length, m = needle.length;
    from = from || 0;
    outer: for (i = from; i + m <= n; i++) {
      for (j = 0; j < m; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }
  function containsBytes(hay, needle) { return findBytes(hay, needle) >= 0; }
  function bytesToStr(bytes) {
    var out = [], i = 0, n = bytes.length, c1, c2, c3;
    while (i < n) {
      c1 = bytes[i];
      if (c1 < 0x80) { out.push(String.fromCharCode(c1)); i++; }
      else if ((c1 & 0xe0) === 0xc0 && i + 1 < n && (bytes[i + 1] & 0xc0) === 0x80) {
        out.push(String.fromCharCode(((c1 & 31) << 6) | (bytes[i + 1] & 63))); i += 2;
      } else if ((c1 & 0xf0) === 0xe0 && i + 2 < n && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) {
        c2 = bytes[i + 1]; c3 = bytes[i + 2];
        out.push(String.fromCharCode(((c1 & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63))); i += 3;
      } else return ''; 
    }
    return out.join('');
  }

  /* ============ protobuf wire 解析 ============ */
  function readVarint(buf, pos) {
    var v = 0, shift = 0, b;
    while (pos < buf.length) {
      b = buf[pos++];
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return { v: v >>> 0, pos: pos };
      shift += 7;
      if (shift > 35) return null;
    }
    return null;
  }
  function varintBytes(v) {
    var out = [];
    while (true) {
      var b = v & 0x7f; v >>>= 7;
      if (v) out.push(b | 0x80); else { out.push(b); break; }
    }
    return out;
  }

  function parseFields(buf, start, end) {
    var fields = [], pos = start, r, ln;
    while (pos < end) {
      r = readVarint(buf, pos);
      if (!r || r.pos > end) break;
      var tag = r.v, fs = pos;
      pos = r.pos;
      var fnum = tag >>> 3, wt = tag & 7;
      if (wt === 0) {
        r = readVarint(buf, pos);
        if (!r) break;
        fields.push({ f: fnum, wt: 0, val: r.v, start: fs, end: r.pos });
        pos = r.pos;
      } else if (wt === 2) {
        r = readVarint(buf, pos);
        if (!r) break;
        ln = r.v; pos = r.pos;
        if (pos + ln > end) break;
        fields.push({ f: fnum, wt: 2, data: buf.subarray(pos, pos + ln), start: fs, end: pos + ln });
        pos += ln;
      } else if (wt === 1) {
        if (pos + 8 > end) break;
        fields.push({ f: fnum, wt: 1, data: buf.subarray(pos, pos + 8), start: fs, end: pos + 8 });
        pos += 8;
      } else if (wt === 5) {
        if (pos + 4 > end) break;
        fields.push({ f: fnum, wt: 5, data: buf.subarray(pos, pos + 4), start: fs, end: pos + 4 });
        pos += 4;
      } else break;
    }
    return fields;
  }
  function parseFull(buf, start, end) {
    var fs = parseFields(buf, start, end);
    if (!fs.length) return null;
    var last = fs[fs.length - 1];
    if (last.end !== end) return null;
    return fs;
  }
  function fieldStr(bytes) {
    var s = bytesToStr(bytes);
    return s === '' ? null : s;
  }

  /* ============ 编辑核心（先判删后递归，字节无损） ============ */
  function concatParts(parts, total) {
    var out = new Uint8Array(total), p = 0, i;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
    return out;
  }
  function encodeField(f, payload, wt) {
    var tagV = varintBytes((f << 3) | (wt === undefined ? 2 : wt));
    var lenV = varintBytes(payload.length);
    var out = new Uint8Array(tagV.length + lenV.length + payload.length);
    var p = 0, i;
    for (i = 0; i < tagV.length; i++) out[p++] = tagV[i];
    for (i = 0; i < lenV.length; i++) out[p++] = lenV[i];
    out.set(payload, p);
    return out;
  }
  function rawSlice(buf, start, end) { return buf.subarray(start, end); }

  function editTree(seg, pred, depth, maxd) {
    var fs = parseFull(seg, 0, seg.length);
    if (!fs || depth > maxd) return null;
    var parts = [], total = 0, changed = false, i, x, sub, nd, raw;
    for (i = 0; i < fs.length; i++) {
      x = fs[i];
      if (x.wt === 2) {
        if (pred(x.data)) { changed = true; continue; }          
        sub = parseFull(x.data, 0, x.data.length);
        if (sub) {
          nd = editTree(x.data, pred, depth + 1, maxd);           
          if (nd) {
            raw = encodeField(x.f, nd, 2);
            parts.push(raw); total += raw.length; changed = true;
            continue;
          }
        }
        raw = rawSlice(seg, x.start, x.end);
        parts.push(raw); total += raw.length;
      } else if (x.wt === 0) {
        raw = rawSlice(seg, x.start, x.end);
        parts.push(raw); total += raw.length;
      } else {
        raw = rawSlice(seg, x.start, x.end);
        parts.push(raw); total += raw.length;
      }
    }
    if (!changed) return null;
    return concatParts(parts, total);
  }

  function topStrs(seg) {
    var fs = parseFull(seg, 0, seg.length), out = [], i, s;
    if (!fs) return out;
    for (i = 0; i < fs.length; i++) {
      if (fs[i].wt === 2) { s = fieldStr(fs[i].data); if (s !== null) out.push(s); }
    }
    return out;
  }
  function containsChinese(s) { return /[一-鿿]/.test(s); }
  function inList(s, list) { return list.indexOf(s) >= 0; }

  /* ============ 谓词 ============ */
  function isCardLike(seg) {
    var fs = parseFull(seg, 0, seg.length), i, hasStr = false, t;
    if (!fs || fs.length < 3) return false;
    for (i = 0; i < fs.length; i++) {
      if (fs[i].wt === 2) {
        t = fieldStr(fs[i].data);
        if (t !== null) { hasStr = true; break; }
      }
    }
    return hasStr;
  }
  function predVipPromo(seg) {
    if (!isCardLike(seg)) return false;
    var strs = topStrs(seg), i, j;
    for (i = 0; i < strs.length; i++) if (inList(strs[i], CFG.removeVipPromoTitles)) return true;
    for (i = 0; i < strs.length; i++) {
      if (strs[i] === 'ptag') {
        for (j = i + 1; j < Math.min(strs.length, i + 6); j++) {
          if (strs[j] !== null && strs[j].length > 3 && strs[j].substring(0, 3) === 'ad.') return true;
        }
      }
    }
    return false;
  }
  function predOpItem(seg) {
    if (!isCardLike(seg)) return false;
    var strs = topStrs(seg), i, hasCJK = false, gameUrl = false;
    for (i = 0; i < strs.length; i++) {
      if (inList(strs[i], CFG.removeOpTitles)) return true;
      if (containsChinese(strs[i])) hasCJK = true;
      if (strs[i].indexOf('iwan.qq.com/g/') >= 0) gameUrl = true;   
    }
    if (hasCJK) {
      for (i = 0; i < strs.length; i++) if (inList(strs[i], CFG.removeOpKeys)) return true;
      if (gameUrl) return true;
    }
    return false;
  }
  function predAdModule(seg) {
    var fs = parseFull(seg, 0, seg.length), i, t;
    if (!fs) return false;
    for (i = 0; i < fs.length; i++) {
      if (fs[i].wt === 2 && fs[i].f === 2) {
        t = fieldStr(fs[i].data);
        if (t !== null && inList(t, CFG.removeModules)) return true;
      }
    }
    return false;
  }
  var AD_TYPE_HITS = ['ad_insert_mix_block', 'ad_feed', 'feed_ad', 'adfeed', 'ad_focus', 'ad_ssp', 'ad_load'];
  function predAdCardId(seg) {
    if (!isCardLike(seg)) return false;
    var fs = parseFull(seg, 0, seg.length), i, t, low;
    if (!fs) return false;
    var mid = '', mtype = '';
    for (i = 0; i < fs.length; i++) {
      if (fs[i].wt === 2) {
        t = fieldStr(fs[i].data);
        if (t === null) continue;
        if (fs[i].f === 1) mid = t;
        else if (fs[i].f === 2) mtype = t;
      }
    }
    low = mid.toLowerCase();
    if (low.substring(0, 8) === 'ad_block_' || low.substring(0, 3) === 'ad_') return true;
    low = mtype.toLowerCase();
    if (low.substring(0, 3) === 'ad_' || low.substring(low.length - 3) === '_ad') return true;
    for (i = 0; i < AD_TYPE_HITS.length; i++) if (low.indexOf(AD_TYPE_HITS[i]) >= 0) return true;
    return false;
  }
  function predAdAnyField(seg) {
    var fs = parseFull(seg, 0, seg.length), i, t;
    if (!fs) return false;
    for (i = 0; i < fs.length; i++) {
      if (fs[i].wt === 2 && fs[i].f === 1) {
        t = fieldStr(fs[i].data);
        if (t !== null && t.indexOf('type.googleapis.com/') === 0 && predAdAny(seg)) return true;
      }
    }
    return false;
  }
  var MARKERS_AD = [utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdFeedInfo'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdFocusPoster'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdFeedVideoPoster'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdResponseInfo'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.LoadingConfig'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.InnerAdPromotionEventList'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.InnerAdPullRefreshEventList'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.InnerAdPullRefreshExtraDisplayInfo'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.InnerAdCommonPromotionEventActivityList'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdOpenWxProgramAction'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdOpenAppAction'),
    utf8Bytes('type.googleapis.com/com.tencent.qqlive.protocol.pb.AdJumpAction')];
  function predAdAny(seg) {
    var i;
    for (i = 0; i < MARKERS_AD.length; i++) if (containsBytes(seg, MARKERS_AD[i])) return true;
    return false;
  }
  function predTab(seg) {
    var fs = parseFull(seg, 0, seg.length), i, t;
    if (!fs) return false;
    for (i = 0; i < fs.length; i++) {
      if (fs[i].wt === 2 && fs[i].f === 3) {
        t = fieldStr(fs[i].data);
        if (t !== null && inList(t, CFG.removeTabs)) return true;
      }
    }
    return false;
  }

  /* ============ 页面级处理 ============ */
  var ANCHOR = utf8Bytes('qqlive_rsp_head');
  function bodyAnchor(buf) {
    var i = findBytes(buf, ANCHOR), back, q, r, r2;
    if (i < 0) return -1;
    for (back = 2; back <= 8; back++) {
      q = i - back;
      if (q < 0) break;
      r = readVarint(buf, q);
      if (!r) continue;
      if ((r.v >>> 3) === 8 && (r.v & 7) === 2 && r.pos <= i) {
        r2 = readVarint(buf, r.pos);
        if (r2 && r2.pos === i) return q;
      }
    }
    return i - 2;
  }
  function editPageExact(page, modulePreds, innerPreds) {
    var inner = parseFields(page, 0, page.length), parts = [], total = 0, i, x, raw;
    var listIndex = -1, j;
    for (i = 0; i < inner.length; i++) if (inner[i].wt === 2 && inner[i].f === 2) { listIndex = i; break; }
    for (i = 0; i < inner.length; i++) {
      x = inner[i];
      if (i === listIndex && x.wt === 2) {
        var mods = parseFields(x.data, 0, x.data.length);
        var keep = [], anyChange = false, k;
        for (j = 0; j < mods.length; j++) {
          var m = mods[j];
          if (m.wt === 2 && m.f === 1) {
            var drop = false;
            for (k = 0; k < modulePreds.length; k++) if (modulePreds[k](m.data)) { drop = true; break; }
            if (drop) { anyChange = true; continue; }
            var edited = null;
            for (k = 0; k < innerPreds.length; k++) {
              edited = editTree(m.data, innerPreds[k], 0, 14);
              if (edited) break;
            }
            if (edited) { keep.push(edited); anyChange = true; }
            else keep.push(m.data);
          } else keep.push(rawSlice(x.data, m.start, m.end));
        }
        if (!anyChange) { raw = rawSlice(page, x.start, x.end); parts.push(raw); total += raw.length; continue; }
        var lp, lparts = [], ltotal = 0;
        for (j = 0; j < keep.length; j++) {
          lp = encodeField(1, keep[j], 2);
          lparts.push(lp); ltotal += lp.length;
        }
        var listBytes = concatParts(lparts, ltotal);
        raw = encodeField(2, listBytes, 2);
        parts.push(raw); total += raw.length;
      } else {
        raw = rawSlice(page, x.start, x.end); parts.push(raw); total += raw.length;
      }
    }
    return concatParts(parts, total);
  }
  function processResponseBody(body) {
    if (!body || body.length < 30) return null;
    var anchor = bodyAnchor(body);
    if (anchor < 0) return null;
    var newBody = null;
    if (containsBytes(body, utf8Bytes('GetTabListRsp'))) {
      newBody = editPageExactAt(body, [], [predTab]);
    }
    if (!newBody && containsBytes(body, utf8Bytes('user_center_ad_middle'))) {
      newBody = editPageExactAt(body, [predAdModule], [predVipPromo, predOpItem]);
    }
    if (!newBody && containsBytes(body, utf8Bytes('user_center_more_function'))) {
      newBody = editPageExactAt(body, [predAdModule], [predVipPromo, predOpItem]);
    }
    if (!newBody && (containsBytes(body, utf8Bytes('ad_block_')) || containsBytes(body, utf8Bytes('AdFeed'))
        || containsBytes(body, utf8Bytes('AdResponseInfo')) || containsBytes(body, utf8Bytes('InnerAd'))
        || containsBytes(body, utf8Bytes('LoadingConfig')))) {
      newBody = editPageExactAt(body, [predAdCardId], [predAdCardId, predAdAnyField]);
    }
    return newBody;
  }
  function editPageExactAt(body, modulePreds, innerPreds) {
    var anchor = bodyAnchor(body);
    if (anchor < 0) return null;
    var fs = parseFields(body, anchor, body.length), parts = [], total = 0, i, x, raw, pageNew, edited, changed = false;
    for (i = 0; i < fs.length; i++) {
      x = fs[i];
      if (x.wt === 2 && x.f === 1) {
        pageNew = editPageExact(x.data, modulePreds, innerPreds);
        if (!pageNew) return null;
        raw = encodeField(1, pageNew, 2);
        if (pageNew.length !== x.data.length) changed = true;
        parts.push(raw); total += raw.length;
      } else if (x.wt === 2) {
        edited = null;
        var k;
        for (k = 0; k < innerPreds.length; k++) {
          edited = editTree(x.data, innerPreds[k], 0, 14);
          if (edited) break;
        }
        if (edited) { raw = encodeField(x.f, edited, 2); changed = true; }
        else raw = rawSlice(body, x.start, x.end);
        parts.push(raw); total += raw.length;
      } else {
        raw = rawSlice(body, x.start, x.end); parts.push(raw); total += raw.length;
      }
    }
    if (!changed) return null;
    var head = rawSlice(body, 0, anchor);
    var merged = concatParts(parts, total);
    var out = new Uint8Array(head.length + merged.length);
    out.set(head, 0); out.set(merged, head.length);
    return out;
  }

  /* ============ 请求拦截 ============ */
  var STATIC_EMPTY_FRAME = b64ToUint8('CTAAAAAAcNsAyjoCsZsBABjlAUJhCg1hY2Nlc3NfcmVwb3J0ElB7InNlcnZpY2VfbmFtZSI6InRycGMub3ZiX2dhbGF4eS5nYXRld2F5Lmh0dHBfdHJwYyIsInNldF9uYW1lIjoib3ZiLmdhbGF4eS5hcHAifUIoCg9xcWxpdmVfcnNwX2hlYWQSFUIAShEInQIYq7uk/Ic0IMi9pPyHNEIeCg51c2VyX2FyZWFfY29kZRIMMTU2MDMzMzMwMTAwQhgKB3VzZXJfaXASDTYwLjE5MC\.yNTMuNTg=');

  function shouldBlockRequest(reqBytes) {
    if (!reqBytes) return false;
    var i;
    for (i = 0; i < CFG.blockApiMethods.length; i++) {
      if (containsBytes(reqBytes, utf8Bytes(CFG.blockApiMethods[i]))) return true;
    }
    return false;
  }

  var api = {
    processResponseBody: processResponseBody,
    shouldBlockRequest: shouldBlockRequest,
    STATIC_EMPTY_FRAME: STATIC_EMPTY_FRAME,
    b64ToUint8: b64ToUint8,
    uint8ToB64: uint8ToB64
  };
  
  var root = typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : this);
  root.QQLiveClean = api;
// })(this);

/* ============ Loon 环境原生桥接层（自适应二进制转换，修复数据不匹配的逻辑 Bug） ============ */
// if (typeof $done !== 'undefined') {
//   try {
//     if (typeof $response !== 'undefined' && $response && $response.body) {
//       var rawBody = (typeof $response.body === 'string') ? QQLiveClean.b64ToUint8($response.body) : new Uint8Array($response.body);
//       var modifiedBody = QQLiveClean.processResponseBody(rawBody);
//       if (modifiedBody) { 
//         $response.body = (typeof $response.body === 'string') ? QQLiveClean.uint8ToB64(modifiedBody) : modifiedBody.buffer;
//         $done({ response: $response }); 
//       } else { 
//         $done({}); 
//       }
//     } else {
//       var rawReq = ($request && $request.body) ? ((typeof $request.body === 'string') ? QQLiveClean.b64ToUint8($request.body) : new Uint8Array($request.body)) : null;
//       var _blocked = QQLiveClean.shouldBlockRequest(rawReq);
//       if (_blocked) {
//         var mockBody = (typeof $request.body === 'string') ? QQLiveClean.uint8ToB64(QQLiveClean.STATIC_EMPTY_FRAME) : QQLiveClean.STATIC_EMPTY_FRAME.buffer;
//         $done({ response: { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: mockBody } });
//       } else { 
//         $done({}); 
//       }
//     }
//   } catch (e) { 
//     $done({}); 
//   }
// }


// ============================================================
// 腾讯视频净化 · Loon 脚本
// 原版：Quantumult X 重写规则 + 脚本（作者 TG@ZenMoFiShi）
// 移植：Loon（同一份脚本同时挂 http-request / http-response）
//
// 处理内容：
//   i.video.qq.com        protobuf(tRPC) 响应：开屏/前贴/中插/信息流/我的页广告、底部 Tab
//   i.video.qq.com        请求：拦截广告 RPC 调用
//   iacc.qq.com           JCE 二进制响应：播放提示、贴片广告、暂停广告、青少年弹窗
//   config.ab.qq.com      AB 配置：开启简洁模式、关闭 QUIC / 预解析
//   rdelivery.qq.com      SDK 灰度：关闭 tab_gray
// ============================================================

(() => {
  const TAB_DROP_KEYS = ["smallvideo_entrance", "goods_entrance"];
  const TAB_DROP_TITLES = ["短剧", "好物"];
  const TAB_CUT_WHITELIST = "0;2;4";
  const AD_ANY = ["AdResponseInfo", "InnerAdPromotionEventList", "InnerAdCommonPromotionEventActivityList", "LoadingConfig", "PreloadResourceInfo", "AdFeedInfo"];
  const DROP_MODULES = ["user_center_more_function"];
  const AD_MODULE_IDS = ["outerPaster"];
  const FEED_MODULE_TAGS = ["waterfall_feeds_module_mergeid"];
  const MARKERS = ["AdFeedInfo", "AdResponseInfo", "InnerAd", "LoadingConfig", "PreloadResourceInfo", "GetTabListRsp", "_ad", "teenager_popup_ctrl"].concat(DROP_MODULES);
  const BLOCK_FUNCS = [
    "/trpc.business_splash.ad_ssp_splash.splashService/GetSplashPreload",
    "/trpc.business_splash.ad_ssp_splash.splashService/GetSplashRealtimePoll",
    "/trpc.business_inside_video.ad_ssp_time_point.push_ad_point/GetPushAd",
    "/trpc.business_inside_video.ad_ssp_time_point.push_ad_point/GetPushAdPoint",
    "/trpc.business_inside_video.ad_ssp_widget.Widget/GetSpeedPanelAd",
    "/trpc.business_feeds.video_ad_ssp_feeds.ServerAdFeedsVideo/GetSlotAdData",
    "/trpc.business_feeds.video_ad_ssp_feeds.ServerAdFeedsVideo/GetSearchAdData",
    "/trpc.business_feeds.video_ad_ssp_feeds.ServerAdFeedsVideo/GetDownloadAdData",
    "/trpc.business_feeds.video_ad_ssp_feeds.Independent/GetAds",
    "/trpc.business_feeds.video_ad_ssp_feeds.Independent/GetUnifiedRefreshAds",
    "/trpc.vipcontent.promotional_slot.PromotionalSlot/InPlayTouchpoints",
    "/trpc.vip_ad_promotion.promotion.PromotionHub/GetPromotionHub",
    "/trpc.video_pay_ffgn.vipcenter.VCUpgradeDialogService/getUpgradeDialogData",
    "/trpc.activity.memberExperience.ActivityTcp/getHomeGrowPopupUrl",
    "/trpc.reward_ad_ssp.reward_judgment.pendant/GetRewardPendant",
    "/trpc.business_feeds.video_ad_ssp_feeds.ServerAdFeedsVideo/GetPersonalCenterAdData"
  ];
  const JCE_TEEN_CONFIG = 89738;
  const JCE_PLAY_TIPS = 126577;
  // 播放器贴片广告(前贴/中插)，body tag2 为广告单列表
  const JCE_ROLL_ADS = [129278, 130273];
  // 暂停广告，body tag1.tag1 为包着广告单列表的 simple list
  const JCE_PAUSE_AD = 129196;
  const DROP = {};

  function utf8(s) {
    const e = encodeURIComponent(s), a = [];
    for (let i = 0; i < e.length; i++) {
      if (e[i] === "%") { a.push(parseInt(e.substr(i + 1, 2), 16)); i += 2; }
      else a.push(e.charCodeAt(i));
    }
    return new Uint8Array(a);
  }
  function text(b, s, e) {
    let r = "";
    for (let i = s; i < e; i++) r += "%" + (b[i] < 16 ? "0" : "") + b[i].toString(16);
    try { return decodeURIComponent(r); } catch (x) { return null; }
  }
  function ascii(b, s, e) {
    let r = "";
    for (let i = s; i < e; i++) { if (b[i] < 32 || b[i] > 126) return null; r += String.fromCharCode(b[i]); }
    return r;
  }
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const o = new Uint8Array(n);
    let k = 0;
    for (const p of parts) { o.set(p, k); k += p.length; }
    return o;
  }
  function find(h, n, s, e) {
    const f = n[0], m = n.length;
    outer: for (let i = s; i <= e - m; i++) {
      if (h[i] !== f) continue;
      for (let j = 1; j < m; j++) if (h[i + j] !== n[j]) continue outer;
      return i;
    }
    return -1;
  }
  function u32(b, p) { return ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; }
  function put32(b, p, v) { b[p] = (v >>> 24) & 255; b[p + 1] = (v >>> 16) & 255; b[p + 2] = (v >>> 8) & 255; b[p + 3] = v & 255; }
  // Loon 的 bodyBytes 可能是 ArrayBuffer，也可能是 Uint8Array，这里统一成 Uint8Array
  function toU8(x) {
    if (!x) return null;
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    const tag = Object.prototype.toString.call(x);
    if (tag === "[object ArrayBuffer]") return new Uint8Array(x);
    if (typeof x === "object" && x.buffer && typeof x.byteLength === "number") {
      return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
    }
    return null;
  }
  // 回写给 Loon 时需要 ArrayBuffer，这里手工拷贝，避免跨 realm 的 slice 差异
  function toBuf(u) {
    const ab = new ArrayBuffer(u.length);
    new Uint8Array(ab).set(u);
    return ab;
  }

  const LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLO = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  function huff(len, n) {
    const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(n);
    for (let i = 0; i < n; i++) count[len[i]]++;
    count[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (let i = 0; i < n; i++) if (len[i]) sym[offs[len[i]]++] = i;
    return { count: count, sym: sym };
  }
  function inflate(src, start) {
    let ip = start, bb = 0, bc = 0, op = 0, out = new Uint8Array(src.length * 4 + 4096);
    function room(n) {
      if (op + n <= out.length) return;
      let l = out.length * 2;
      while (l < op + n) l *= 2;
      const o = new Uint8Array(l);
      o.set(out.subarray(0, op));
      out = o;
    }
    function bits(n) {
      while (bc < n) { if (ip >= src.length) throw new Error("inflate eof"); bb |= src[ip++] << bc; bc += 8; }
      const v = bb & ((1 << n) - 1);
      bb >>>= n; bc -= n;
      return v;
    }
    function dec(h) {
      let code = 0, first = 0, index = 0;
      for (let l = 1; l < 16; l++) {
        code |= bits(1);
        const c = h.count[l];
        if (code - c < first) return h.sym[index + (code - first)];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw new Error("inflate code");
    }
    let fl = null, fd = null;
    for (;;) {
      const last = bits(1), type = bits(2);
      if (type === 0) {
        bb = 0; bc = 0;
        const n = src[ip] | (src[ip + 1] << 8);
        ip += 4;
        if (ip + n > src.length) throw new Error("inflate stored");
        room(n); out.set(src.subarray(ip, ip + n), op); op += n; ip += n;
      } else if (type === 1 || type === 2) {
        let hl, hd;
        if (type === 1) {
          if (!fl) {
            const l = new Uint8Array(288);
            for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
            fl = huff(l, 288);
            const d = new Uint8Array(30).fill(5);
            fd = huff(d, 30);
          }
          hl = fl; hd = fd;
        } else {
          const nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4;
          const cl = new Uint8Array(19);
          for (let i = 0; i < nc; i++) cl[CLO[i]] = bits(3);
          const ch = huff(cl, 19), ls = new Uint8Array(nl + nd);
          for (let i = 0; i < nl + nd;) {
            const s = dec(ch);
            if (s < 16) ls[i++] = s;
            else {
              let r, v = 0;
              if (s === 16) { if (!i) throw new Error("inflate rep"); v = ls[i - 1]; r = 3 + bits(2); }
              else if (s === 17) r = 3 + bits(3);
              else r = 11 + bits(7);
              if (i + r > nl + nd) throw new Error("inflate rep");
              while (r--) ls[i++] = v;
            }
          }
          hl = huff(ls.subarray(0, nl), nl); hd = huff(ls.subarray(nl), nd);
        }
        for (;;) {
          let s = dec(hl);
          if (s < 256) { room(1); out[op++] = s; }
          else if (s === 256) break;
          else {
            s -= 257;
            if (s >= 29) throw new Error("inflate len");
            const len = LB[s] + bits(LE[s]), ds = dec(hd);
            if (ds >= 30) throw new Error("inflate dist");
            const dist = DB[ds] + bits(DE[ds]);
            if (dist > op) throw new Error("inflate back");
            room(len);
            for (let i = 0; i < len; i++, op++) out[op] = out[op - dist];
          }
        }
      } else throw new Error("inflate type");
      if (last) break;
    }
    return { data: out.subarray(0, op), end: ip };
  }
  function gunzip(b) {
    if (b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) throw new Error("not gzip");
    const f = b[3];
    let p = 10;
    if (f & 4) p += 2 + (b[p] | (b[p + 1] << 8));
    if (f & 8) { while (b[p]) p++; p++; }
    if (f & 16) { while (b[p]) p++; p++; }
    if (f & 2) p += 2;
    const r = inflate(b, p);
    if (r.end + 8 > b.length) throw new Error("gzip trailer");
    const isize = (b[r.end + 4] | (b[r.end + 5] << 8) | (b[r.end + 6] << 16) | (b[r.end + 7] << 24)) >>> 0;
    if (isize !== (r.data.length >>> 0)) throw new Error("gzip size");
    return r.data;
  }
  let CRC = null;
  function crc32(b) {
    if (!CRC) {
      CRC = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function gzip(d) {
    const blocks = Math.max(1, Math.ceil(d.length / 65535));
    const o = new Uint8Array(10 + blocks * 5 + d.length + 8);
    o.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
    let p = 10;
    for (let i = 0; i < blocks; i++) {
      const s = i * 65535, n = Math.min(65535, d.length - s);
      o[p++] = i === blocks - 1 ? 1 : 0;
      o[p++] = n & 255; o[p++] = n >> 8; o[p++] = ~n & 255; o[p++] = (~n >> 8) & 255;
      o.set(d.subarray(s, s + n), p); p += n;
    }
    const c = crc32(d), z = d.length >>> 0;
    o[p++] = c & 255; o[p++] = (c >>> 8) & 255; o[p++] = (c >>> 16) & 255; o[p++] = c >>> 24;
    o[p++] = z & 255; o[p++] = (z >>> 8) & 255; o[p++] = (z >>> 16) & 255; o[p++] = z >>> 24;
    return o;
  }

  let VP = 0;
  function rv(b, p, e) {
    let x = 0, m = 1, c;
    do {
      if (p >= e || m > 72057594037927936) return -1;
      c = b[p++];
      x += (c & 127) * m;
      m *= 128;
    } while (c & 128);
    VP = p;
    return x;
  }
  function ev(v) {
    const a = [];
    while (v >= 128) { a.push((v % 128) | 128); v = Math.floor(v / 128); }
    a.push(v);
    return new Uint8Array(a);
  }
  function lenField(f, d) { return concat([ev(f * 8 + 2), ev(d.length), d]); }
  function parse(b, s, e) {
    const out = [];
    let p = s;
    while (p < e) {
      const ts = p, k = rv(b, p, e);
      if (k < 8) return null;
      p = VP;
      const f = Math.floor(k / 8), w = k % 8;
      if (w === 0) {
        const v = rv(b, p, e);
        if (v < 0) return null;
        out.push({ f: f, w: w, s: ts, vs: p, e: VP, v: v });
        p = VP;
      } else if (w === 1 || w === 5) {
        const n = w === 1 ? 8 : 4;
        if (p + n > e) return null;
        out.push({ f: f, w: w, s: ts, vs: p, e: p + n });
        p += n;
      } else if (w === 2) {
        const l = rv(b, p, e);
        if (l < 0) return null;
        p = VP;
        if (p + l > e) return null;
        out.push({ f: f, w: w, s: ts, vs: p, e: p + l });
        p += l;
      } else return null;
    }
    return out;
  }
  function rebuild(b, s, e, fields, edits) {
    const parts = [];
    let last = s, changed = false;
    for (const x of fields) {
      if (!edits.has(x)) continue;
      const r = edits.get(x);
      parts.push(b.subarray(last, x.s));
      if (r !== DROP) parts.push(r);
      last = x.e;
      changed = true;
    }
    if (!changed) return null;
    parts.push(b.subarray(last, e));
    return concat(parts);
  }

  const TYPE = utf8("type.googleapis.com/");
  let ANYV = 0;
  function anyName(b, s, e) {
    if (b[s] !== 0x0a) return null;
    const l = rv(b, s + 1, e);
    if (l < 21 || VP + l > e) return null;
    const p = VP;
    if (find(b, TYPE, p, p + TYPE.length) !== p) return null;
    const t = ascii(b, p, p + l);
    if (!t) return null;
    ANYV = p + l;
    return t.slice(Math.max(t.lastIndexOf("."), t.lastIndexOf("/")) + 1);
  }

  let MARK = {}, ALL = [];
  function indexMarkers(b, s, e) {
    MARK = {}; ALL = [];
    for (const m of MARKERS) {
      const nb = utf8(m), arr = [];
      for (let p = s; (p = find(b, nb, p, e)) >= 0; p += nb.length) arr.push(p);
      MARK[m] = arr;
      ALL = ALL.concat(arr);
    }
    ALL.sort((x, y) => x - y);
  }
  function inRange(arr, s, e) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < s) lo = mid + 1; else hi = mid; }
    return lo < arr.length && arr[lo] < e;
  }
  function has(m, s, e) { return inRange(m ? MARK[m] || [] : ALL, s, e); }

  function kidsOf(b, recs, f) {
    const r = [];
    for (const x of recs) if (x.f === f && x.w === 2) { const k = parse(b, x.vs, x.e); if (k) r.push(k); }
    return r;
  }
  function blocksAt(b, kids) {
    let level = [kids];
    for (const f of [2, 5, 1]) {
      const next = [];
      for (const k of level) for (const c of kidsOf(b, k, f)) next.push(c);
      level = next;
      if (!level.length) break;
    }
    return level;
  }
  function adBlock(b, k) { return k.some(x => x.f === 4 && x.w === 2 && anyName(b, x.vs, x.e) === "AdFeedInfo"); }
  function adAtPath(b, kids) { return blocksAt(b, kids).some(k => adBlock(b, k)); }
  function adOnlyAtPath(b, kids) {
    const l = blocksAt(b, kids);
    return l.length > 0 && l.every(k => adBlock(b, k));
  }
  function wrapsAny(b, k) {
    if (anyName(b, k.vs, k.e)) return true;
    const w = parse(b, k.vs, k.e);
    return !!w && w.some(z => z.f === 2 && z.w === 2 && anyName(b, z.vs, z.e));
  }
  function isAdElement(b, x, kids) {
    for (const k of kids) {
      if (k.w !== 2 || (k.f !== 1 && k.f !== 2 && k.f !== 10)) continue;
      if (k.f === 10 && has("AdFeedInfo", k.vs, k.e) && wrapsAny(b, k)) return true;
      const t = anyName(b, k.vs, k.e);
      if (t && AD_ANY.indexOf(t) >= 0) return true;
    }
    const f1 = kids.find(k => k.f === 1 && k.w === 2), f2 = kids.find(k => k.f === 2 && k.w === 2);
    if (f1 && f2 && f2.e - f2.vs > 3 && f2.e - f2.vs < 64) {
      const t = ascii(b, f2.vs, f2.e), id = ascii(b, f1.vs, f1.e);
      if (t && id && DROP_MODULES.indexOf(t) >= 0 && /\.\d+\.\d+$/.test(id)) return true;
      if (t && id !== null && /^[a-z0-9_]+$/.test(t) && /(^ad_|_ad_|_ad$)/.test(t) && (id === "" || /\.\d+\.\d+$/.test(id))) return true;
    }
    if ((!f1 || f1.e === f1.vs || AD_MODULE_IDS.indexOf(ascii(b, f1.vs, f1.e)) >= 0) && has("AdFeedInfo", x.vs, x.e) && adAtPath(b, kids)) return true;
    const f6 = kids.find(k => k.f === 6 && k.w === 2);
    if (f6 && FEED_MODULE_TAGS.indexOf(ascii(b, f6.vs, f6.e)) >= 0 && has("AdFeedInfo", x.vs, x.e) && adOnlyAtPath(b, kids)) return true;
    return false;
  }
  function tabFix(b, x) {
    if (anyName(b, x.vs, x.e) !== "GetTabListRsp") return null;
    const rest = parse(b, ANYV, x.e);
    const v = rest && rest.find(r => r.f === 2 && r.w === 2);
    if (!v) return null;
    const vf = parse(b, v.vs, v.e);
    if (!vf) return null;
    const items = vf.filter(r => r.f === 1 && r.w === 2), drop = new Set();
    for (const it of items) {
      const ik = parse(b, it.vs, it.e);
      if (!ik) return null;
      let key = "", title = "";
      for (const r of ik) {
        if (r.f === 3 && r.w === 2) title = text(b, r.vs, r.e) || "";
        if (r.f === 22 && r.w === 2) {
          const rk = parse(b, r.vs, r.e), k1 = rk && rk.find(z => z.f === 1 && z.w === 2);
          if (k1) key = ascii(b, k1.vs, k1.e) || "";
        }
      }
      if (TAB_DROP_KEYS.indexOf(key) >= 0 || TAB_DROP_TITLES.indexOf(title) >= 0) drop.add(it);
    }
    if (!drop.size) return null;
    const edits = new Map();
    let idx = 0;
    for (const it of items) {
      if (drop.has(it)) { edits.set(it, DROP); continue; }
      const ik = parse(b, it.vs, it.e), parts = [];
      if (idx > 0) parts.push(ev(16), ev(idx));
      for (const r of ik) if (!(r.f === 2 && r.w === 0)) parts.push(b.subarray(r.s, r.e));
      edits.set(it, lenField(1, concat(parts)));
      idx++;
    }
    const nv = rebuild(b, v.vs, v.e, vf, edits);
    return lenField(x.f, concat([b.subarray(x.vs, v.s), lenField(2, nv), b.subarray(v.e, x.e)]));
  }
  function clean(b, s, e, depth) {
    if (depth > 48 || !has(null, s, e)) return null;
    const fs = parse(b, s, e);
    if (!fs) return null;
    const edits = new Map();
    for (const x of fs) {
      if (x.w !== 2 || x.e - x.vs < 2 || !has(null, x.vs, x.e)) continue;
      const kids = parse(b, x.vs, x.e);
      if (!kids || !kids.length) continue;
      if (isAdElement(b, x, kids)) { edits.set(x, DROP); continue; }
      if (has("GetTabListRsp", x.vs, x.e)) {
        const t = tabFix(b, x);
        if (t) { edits.set(x, t); continue; }
      }
      const r = clean(b, x.vs, x.e, depth + 1);
      if (r) edits.set(x, lenField(x.f, r));
    }
    return rebuild(b, s, e, fs, edits);
  }
  const PC_PAGE = utf8("personal_center_page"), AD_FEED = utf8("pb.AdFeed");
  function transform(b, s, e) {
    const top = parse(b, s, e);
    if (!top) return null;
    if (has("teenager_popup_ctrl", s, e)) {
      const isCtrl = top.some(x => {
        if (x.f !== 7 || x.w !== 2) return false;
        const k = parse(b, x.vs, x.e), v = k && k.find(z => z.f === 2 && z.w === 2);
        return !!v && ascii(b, v.vs, v.e) === "teenager_popup_ctrl";
      });
      if (isCtrl) {
        const edits = new Map();
        for (const x of top) if (x.f === 1) edits.set(x, DROP);
        return rebuild(b, s, e, top, edits);
      }
    }
    if (find(b, PC_PAGE, s, e) >= 0) {
      const f5 = top.find(x => x.f === 5 && x.w === 2 && find(b, PC_PAGE, x.vs, x.e) >= 0);
      if (f5) {
        const edits = new Map();
        for (const x of top) if (x.w === 2 && x !== f5 && find(b, AD_FEED, x.vs, x.e) >= 0) edits.set(x, DROP);
        if (edits.size) return rebuild(b, s, e, top, edits);
      }
    }
    return clean(b, s, e, 0);
  }
  function trpcFrame(u8) {
    if (u8.length < 16 || u8[0] !== 0x09 || u8[1] !== 0x30) return null;
    const total = u32(u8, 4), hl = (u8[8] << 8) | u8[9];
    if (total !== u8.length || 16 + hl > total) return null;
    return { hs: 16, he: 16 + hl };
  }
  function onTrpcResponse(raw) {
    let u8 = raw, gz = false;
    if (u8[0] === 0x1f && u8[1] === 0x8b) { u8 = gunzip(u8); gz = true; }
    const fr = trpcFrame(u8);
    if (!fr) return null;
    indexMarkers(u8, fr.he, u8.length);
    const body = transform(u8, fr.he, u8.length);
    if (!body) return null;
    const out = concat([u8.subarray(0, fr.he), body]);
    put32(out, 4, out.length);
    return gz ? gzip(out) : out;
  }
  function onTrpcRequest(raw) {
    let u8 = raw, gz = false;
    if (u8[0] === 0x1f && u8[1] === 0x8b) { u8 = gunzip(u8); gz = true; }
    const fr = trpcFrame(u8);
    if (!fr) return null;
    const hd = parse(u8, fr.hs, fr.he), fn = hd && hd.find(x => x.f === 7 && x.w === 2);
    const func = fn ? ascii(u8, fn.vs, fn.e) : null;
    if (!func || BLOCK_FUNCS.indexOf(func) < 0) return null;
    const nb = utf8(func.slice(func.lastIndexOf("/") + 1)), out = u8.slice();
    for (let p = fr.hs; (p = find(out, nb, p, fr.he)) >= 0; p += nb.length) out[p] = out[p] === 0x58 ? 0x59 : 0x58;
    return gz ? gzip(out) : out;
  }

  function jHead(b, p) {
    const c = b[p];
    let tag = c >> 4;
    const t = c & 15;
    p++;
    if (tag === 15) tag = b[p++];
    VP = p;
    return [tag, t];
  }
  function jInt(b, p) {
    const h = jHead(b, p);
    p = VP;
    let v;
    if (h[1] === 12) v = 0;
    else if (h[1] === 0) { v = (b[p] << 24) >> 24; p += 1; }
    else if (h[1] === 1) { v = ((b[p] << 24) >> 16) | b[p + 1]; p += 2; }
    else if (h[1] === 2) { v = u32(b, p) | 0; p += 4; }
    else if (h[1] === 3) { v = u32(b, p) * 4294967296 + u32(b, p + 4); p += 8; }
    else throw new Error("jce int");
    VP = p;
    return v;
  }
  function jSkip(b, p, t, e) {
    let q;
    switch (t) {
      case 0: q = p + 1; break;
      case 1: q = p + 2; break;
      case 2: case 4: q = p + 4; break;
      case 3: case 5: q = p + 8; break;
      case 6: q = p + 1 + b[p]; break;
      case 7: q = p + 4 + u32(b, p); break;
      case 8: case 9: {
        const n = jInt(b, p) * (t === 8 ? 2 : 1);
        q = VP;
        if (n < 0) throw new Error("jce count");
        for (let i = 0; i < n; i++) { const h = jHead(b, q); q = jSkip(b, VP, h[1], e); }
        break;
      }
      case 10: {
        q = p;
        for (;;) {
          const h = jHead(b, q);
          q = VP;
          if (h[1] === 11) break;
          q = jSkip(b, q, h[1], e);
        }
        break;
      }
      case 11: case 12: q = p; break;
      case 13: {
        jHead(b, p);
        const n = jInt(b, VP);
        q = VP + n;
        break;
      }
      default: throw new Error("jce type " + t);
    }
    if (q > e) throw new Error("jce overflow");
    return q;
  }
  function jFields(b, s, e) {
    const out = [];
    let p = s;
    while (p < e) {
      const h = jHead(b, p), vs = VP;
      if (h[1] === 11) throw new Error("jce end");
      const q = jSkip(b, vs, h[1], e);
      out.push({ tag: h[0], t: h[1], s: p, vs: vs, e: q });
      p = q;
    }
    if (p !== e) throw new Error("jce tail");
    return out;
  }
  function jHeadEnc(tag, t) { return tag < 15 ? [(tag << 4) | t] : [0xf0 | t, tag]; }
  function jIntEnc(tag, v) {
    if (v === 0) return new Uint8Array(jHeadEnc(tag, 12));
    if (v >= -128 && v <= 127) return new Uint8Array(jHeadEnc(tag, 0).concat([v & 255]));
    if (v >= -32768 && v <= 32767) return new Uint8Array(jHeadEnc(tag, 1).concat([(v >> 8) & 255, v & 255]));
    return new Uint8Array(jHeadEnc(tag, 2).concat([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]));
  }
  function jSimpleList(tag, d) { return concat([new Uint8Array(jHeadEnc(tag, 13).concat([0])), jIntEnc(0, d.length), d]); }
  function jStr(b, x) {
    if (x.t === 6) return ascii(b, x.vs + 1, x.e);
    if (x.t === 7) return ascii(b, x.vs + 4, x.e);
    return null;
  }
  function jRebuild(b, s, e, fields, edits) {
    const parts = [];
    let last = s, changed = false;
    for (const x of fields) {
      if (!edits.has(x)) continue;
      parts.push(b.subarray(last, x.s));
      const r = edits.get(x);
      if (r !== DROP) parts.push(r);
      last = x.e;
      changed = true;
    }
    if (!changed) return null;
    parts.push(b.subarray(last, e));
    return concat(parts);
  }
  function fixTeenConfig(b, s, e) {
    const fs = jFields(b, s, e);
    const code = fs.find(x => x.tag === 9);
    const sc = code ? jStr(b, code) : null;
    if (!sc || !/^[0-9A-F]{32,}$/.test(sc)) return null;
    const edits = new Map();
    for (const x of fs) {
      if (x.tag === 4 && x.t !== 12) edits.set(x, jIntEnc(4, 0));
      if ((x.tag === 6 || x.tag === 10) && x.t === 10) edits.set(x, DROP);
    }
    return jRebuild(b, s, e, fs, edits);
  }
  function fixPlayTips(b, s, e) {
    const fs = jFields(b, s, e), m = fs.find(x => x.tag === 1 && x.t === 8);
    if (!m) return null;
    const n = jInt(b, m.vs);
    let q = VP;
    const keep = [];
    let dropped = 0;
    for (let i = 0; i < n; i++) {
      const st = q;
      const hk = jHead(b, q), kvs = VP, ke = jSkip(b, kvs, hk[1], e);
      const key = jStr(b, { t: hk[1], vs: kvs, e: ke });
      const hv = jHead(b, ke), ve = jSkip(b, VP, hv[1], e);
      if (key === "4_operator_info") dropped++;
      else keep.push(b.subarray(st, ve));
      q = ve;
    }
    if (q !== m.e || !dropped) return null;
    const enc = concat([new Uint8Array(jHeadEnc(1, 8)), jIntEnc(0, keep.length)].concat(keep));
    const edits = new Map();
    edits.set(m, enc);
    return jRebuild(b, s, e, fs, edits);
  }
  function fixRollAds(b, s, e) {
    const fs = jFields(b, s, e), l = fs.find(x => x.tag === 2 && x.t === 9);
    if (!l || jInt(b, l.vs) <= 0 || find(b, utf8("livemsg"), l.vs, l.e) < 0) return null;
    const edits = new Map();
    edits.set(l, concat([new Uint8Array(jHeadEnc(2, 9)), jIntEnc(0, 0)]));
    return jRebuild(b, s, e, fs, edits);
  }
  function fixPauseAd(b, s, e) {
    const fs = jFields(b, s, e), w = fs.find(x => x.tag === 1 && x.t === 10);
    if (!w || b[w.e - 1] !== 0x0b) return null;
    const ws = jFields(b, w.vs, w.e - 1), l = ws.find(x => x.tag === 1 && x.t === 13);
    if (!l) return null;
    jHead(b, l.vs);
    const n = jInt(b, VP), ds = VP;
    if (ds + n !== l.e) return null;
    const inner = jFields(b, ds, l.e), list = inner.find(x => x.tag === 0 && x.t === 9);
    if (!list || jInt(b, list.vs) <= 0 || find(b, utf8("livemsg"), list.vs, list.e) < 0) return null;
    const le = new Map();
    le.set(l, jSimpleList(1, concat([new Uint8Array(jHeadEnc(0, 9)), jIntEnc(0, 0)])));
    const nw = concat([b.subarray(w.s, w.vs), jRebuild(b, w.vs, w.e - 1, ws, le), new Uint8Array([0x0b])]);
    const edits = new Map();
    edits.set(w, nw);
    return jRebuild(b, s, e, fs, edits);
  }
  function onJce(raw) {
    const b = raw, n = b.length;
    if (n < 100 || b[0] !== 0x13 || u32(b, 1) !== n || b[n - 1] !== 0x03) return null;
    const cmd = (b[8] << 16) | (b[9] << 8) | b[10];
    const fix = cmd === JCE_TEEN_CONFIG ? fixTeenConfig : cmd === JCE_PLAY_TIPS ? fixPlayTips : JCE_ROLL_ADS.indexOf(cmd) >= 0 ? fixRollAds : cmd === JCE_PAUSE_AD ? fixPauseAd : null;
    if (!fix) return null;
    const gz = find(b, new Uint8Array([0x1f, 0x8b, 0x08]), 60, Math.min(n, 140));
    if (gz < 4) return null;
    const inner = gunzip(b.subarray(gz, n - 1));
    const m = inner.length;
    if (u32(b, gz - 4) !== m || m < 18 || inner[0] !== 0x26 || u32(inner, 1) !== m || inner[m - 1] !== 0x28) return null;
    const top = jFields(inner, 16, m - 1), body = top.find(x => x.tag === 1 && x.t === 13);
    if (!body) return null;
    jHead(inner, body.vs);
    const bl = jInt(inner, VP), bs = VP;
    if (bs + bl !== body.e) return null;
    const nb = fix(inner, bs, bs + bl);
    if (!nb) return null;
    const ni = concat([inner.subarray(0, body.s), jSimpleList(1, nb), inner.subarray(body.e, m)]);
    put32(ni, 1, ni.length);
    const head = b.slice(0, gz);
    put32(head, gz - 4, ni.length);
    const out = concat([head, gzip(ni), new Uint8Array([0x03])]);
    put32(out, 1, out.length);
    return out;
  }

  const SIMPLE_KEY = "simple_mode_config";
  function patchSimpleMode(js) {
    let o;
    try { o = JSON.parse(js); } catch (x) { return null; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const fc = o.feature_config && typeof o.feature_config === "object" ? o.feature_config : {};
    if (o.enable === 1 && fc.enable === 1 && fc.tab_bar_cut_enable === 1 && fc.tab_bar_cut_whitelist === TAB_CUT_WHITELIST) return null;
    fc.enable = 1;
    fc.tab_bar_cut_enable = 1;
    fc.tab_bar_cut_whitelist = TAB_CUT_WHITELIST;
    o.enable = 1;
    o.feature_config = fc;
    return JSON.stringify(o);
  }

  function simpleModeJson() {
    return JSON.stringify({ enable: 1, launch_config: { enable: 1, delay_create_tab_enable: 1, delay_create_tab_whitelist: "" }, feature_config: { enable: 1, tab_bar_cut_enable: 1, tab_bar_cut_whitelist: TAB_CUT_WHITELIST } });
  }
  function simpleModeEntry() {
    const v = concat([lenField(1, utf8(simpleModeJson())), ev(16), ev(11276), lenField(4, utf8(SIMPLE_KEY))]);
    return concat([lenField(1, utf8(SIMPLE_KEY)), lenField(2, v)]);
  }
  function patchNoQuic(js) {
    let o;
    try { o = JSON.parse(js); } catch (x) { return null; }
    const q = o && o.quic;
    if (!q || typeof q !== "object" || (q.enabled === false && q.allPbReqEnabled === false && q.allJceReqEnabled === false)) return null;
    q.enabled = false;
    q.allPbReqEnabled = false;
    q.allJceReqEnabled = false;
    return JSON.stringify(o);
  }
  function patchNoPreResolve(js) {
    let o;
    try { o = JSON.parse(js); } catch (x) { return null; }
    if (!o || typeof o !== "object" || Array.isArray(o) || (o.enablePreResolve === false && o.enableNac === false && o.enableHdns === false)) return null;
    o.enablePreResolve = false;
    o.enableNac = false;
    o.enableHdns = false;
    return JSON.stringify(o);
  }
   const AB_PATCH = { simple_mode_config: patchSimpleMode, ios_nx_netframework_compatible: patchNoQuic, ios_nx_netframework_compatible_bbtf: patchNoQuic, network_resolve_config: patchNoPreResolve };
  const AB_NEEDLES = [utf8(SIMPLE_KEY), utf8("ios_nx_netframework_compatible"), utf8("network_resolve_config")];
  function onAbConfig(raw) {
    let u8 = raw, gz = false;
    if (u8[0] === 0x1f && u8[1] === 0x8b) { u8 = gunzip(u8); gz = true; }
    const top = parse(u8, 0, u8.length);
    if (!top) return null;
    const edits = new Map();
    let found = false;
    for (const x of top) {
      if (x.f !== 3 || x.w !== 2 || !AB_NEEDLES.some(kb => find(u8, kb, x.vs, x.e) >= 0)) continue;
      const ef = parse(u8, x.vs, x.e);
      const k = ef && ef.find(z => z.f === 1 && z.w === 2), v = ef && ef.find(z => z.f === 2 && z.w === 2);
      const key = k && v ? ascii(u8, k.vs, k.e) : null;
      if (!key || !Object.prototype.hasOwnProperty.call(AB_PATCH, key)) continue;
      const vf = parse(u8, v.vs, v.e), j = vf && vf.find(z => z.f === 1 && z.w === 2);
      if (!j) continue;
      if (key === SIMPLE_KEY) found = true;
      const js = text(u8, j.vs, j.e), nj = js ? AB_PATCH[key](js) : null;
      if (!nj) continue;
      const vm = new Map();
      vm.set(j, lenField(1, utf8(nj)));
      const nv = rebuild(u8, v.vs, v.e, vf, vm);
      const em = new Map();
      em.set(v, lenField(2, nv));
      edits.set(x, lenField(3, rebuild(u8, x.vs, x.e, ef, em)));
    }
    let out = rebuild(u8, 0, u8.length, top, edits);
    if (!out && !found && top.some(x => x.f === 1 && x.w === 0 && x.v === 100) && top.some(x => x.f === 3 && x.w === 2)) out = concat([u8, lenField(3, simpleModeEntry())]);
    if (!out) return null;
    return gz ? gzip(out) : out;
  }

  const MAX_BODY = 8 * 1024 * 1024;

  function main() {
    const url = $request.url || "", host = (url.split("/")[2] || "").split(":")[0];
    const isResp = typeof $response !== "undefined" && $response !== null;
    try {
      if (!isResp) {
        const b = host === "i.video.qq.com" ? toU8($request.bodyBytes) : null;
        if (b && b.length > MAX_BODY) { $done({}); return; }
        const r = b && b.length ? onTrpcRequest(b) : null;
        $done(r ? { bodyBytes: toBuf(r) } : {});
        return;
      }
      if (host === "rdelivery.qq.com") {
        const s = typeof $response.body === "string" ? $response.body : "";
        const o = /"tab_gray"\s*:\s*true/.test(s) ? s.replace(/("tab_gray"\s*:\s*)true/, "$1false") : null;
        $done(o ? { body: o } : {});
        return;
      }
      const b = toU8($response.bodyBytes);
      if (b && b.length > MAX_BODY) { $done({}); return; }
      let r = null;
      if (b && b.length) {
        if (host === "i.video.qq.com") r = onTrpcResponse(b);
        else if (host === "iacc.qq.com") r = onJce(b);
        else if (host === "config.ab.qq.com" && url.split("?")[0].endsWith("/tab/GetTabRemoteConfig")) r = onAbConfig(b);
      }
      $done(r ? { bodyBytes: toBuf(r) } : {});
    } catch (e) {
      try { if (typeof console !== "undefined" && console.log) console.log("txvideo-ad-clean: " + e); } catch (x) {}
      $done({});
    }
  }
  main();
})();
