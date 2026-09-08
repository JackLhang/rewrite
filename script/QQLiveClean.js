/*
 * QQLiveClean.js — 腾讯视频 iOS（v9.x / MVL 布局）去广告 + 个人中心与 Tab 精简
 * 运行环境: Loon Script (http-request / http-response)
 * 实现: 无损 protobuf 子树删除（wire-format 级，不解析业务 schema）
 */
(function (global) {
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
    // UTF-8 -> JS string, invalid sequences become '' (treated as binary)
    var out = [], i = 0, n = bytes.length, c1, c2, c3;
    while (i < n) {
      c1 = bytes[i];
      if (c1 < 0x80) { out.push(String.fromCharCode(c1)); i++; }
      else if ((c1 & 0xe0) === 0xc0 && i + 1 < n && (bytes[i + 1] & 0xc0) === 0x80) {
        out.push(String.fromCharCode(((c1 & 31) << 6) | (bytes[i + 1] & 63))); i += 2;
      } else if ((c1 & 0xf0) === 0xe0 && i + 2 < n && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) {
        c2 = bytes[i + 1]; c3 = bytes[i + 2];
        out.push(String.fromCharCode(((c1 & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63))); i += 3;
      } else return ''; // binary
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

  // Parse protobuf region [start,end). Fields: {f, wt, val, data(Uint8Array|null), start, end}
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

  // editTree(seg) -> Uint8Array|null (null = no change); pred(fieldPayload) -> bool drop
  function editTree(seg, pred, depth, maxd) {
    var fs = parseFull(seg, 0, seg.length);
    if (!fs || depth > maxd) return null;
    var parts = [], total = 0, changed = false, i, x, sub, nd, raw;
    for (i = 0; i < fs.length; i++) {
      x = fs[i];
      if (x.wt === 2) {
        if (pred(x.data)) { changed = true; continue; }          // 整字段删除
        sub = parseFull(x.data, 0, x.data.length);
        if (sub) {
          nd = editTree(x.data, pred, depth + 1, maxd);           // 递归清理内部
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

  // 顶层字段字符串列表（用于标题/黑名单判断，避免误伤子层）
  function topStrs(seg) {
    var fs = parseFull(seg, 0, seg.length), out = [], i, s;
    if (!fs) return out;
    for (i = 0; i < fs.length; i++) {
      if (fs[i].wt === 2) { s = fieldStr(fs[i].data); if (s !== null) out.push(s); }
    }
    return out;
  }
  function containsChinese(s) { return /[\u4e00-\u9fff]/.test(s); }
  function inList(s, list) { return list.indexOf(s) >= 0; }

  /* ============ 谓词（与 Python 原型同语义） ============ */
  function isCardLike(seg) {
    // 卡级 msg：顶层至少 1 个字符串字段，且总字段数 >= 3（排除单字段 str / 双字段 kv）
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
      if (strs[i].indexOf('iwan.qq.com/g/') >= 0) gameUrl = true;   // 游戏中心入口
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
    // 卡级判定：id 为 ad 前缀 或 type 为广告容器类型（不做内容检查，可安全用于模块级）
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
    // 字段级：payload 本身是 Any 消息且 type_url 命中广告类型（删除广告数据字段，不伤兄弟字段/正常卡）
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
    // tab 条目 msg: f3 = 标题
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
  // 找到锚点：qqlive_rsp_head 所在的 f8 字段起点
  var ANCHOR = utf8Bytes('\x0a\x0fqqlive_rsp_head');
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
    // 严谨实现：定位 f2 列表字段 → 过滤 f1 模块（其余字段原样保留）→ 每个保留模块递归 editTree
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
      // tab 栏精简
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
        // 页面外的顶层字段（如尾部广告/扩展数据 msg）也做内层清理
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

  /* ============ 请求拦截（广告 API mock 空帧） ============ */
  var EMPTY_FRAME_B64 = 'CTAAAAAAcNsAyjoCsZsBABjlAUJhCg1hY2Nlc3NfcmVwb3J0ElB7InNlcnZpY2VfbmFtZSI6InRycGMub3ZiX2dhbGF4eS5nYXRld2F5Lmh0dHBfdHJwYyIsInNldF9uYW1lIjoib3ZiLmdhbGF4eS5hcHAifUIoCg9xcWxpdmVfcnNwX2hlYWQSFUIAShEInQIYq7uk/Ic0IMi9pPyHNEIeCg51c2VyX2FyZWFfY29kZRIMMTU2MDMzMzMwMTAwQhgKB3VzZXJfaXASDTYwLjE5MC4yNTMuNTg=';
  function shouldBlockRequest(reqBytes) {
    if (!reqBytes) return false;
    var i;
    for (i = 0; i < CFG.blockApiMethods.length; i++) {
      if (containsBytes(reqBytes, utf8Bytes(CFG.blockApiMethods[i]))) return true;
    }
    return false;
  }

  // expose for Loon & node testing
  var api = {
    processResponseBody: processResponseBody,
    shouldBlockRequest: shouldBlockRequest,
    EMPTY_FRAME_B64: EMPTY_FRAME_B64,
    _b64decode: function (s) {
      var bin = atob(s), out = new Uint8Array(bin.length), i;
      for (i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
    _b64encode: function (u8) {
      var bin = '', i;
      for (i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      return btoa(bin);
    },
    processResponse: function (bodyB64) {
      var raw = api._b64decode(bodyB64);
      var out = api.processResponseBody(raw);
      return out ? api._b64encode(out) : null;
    },
    processRequest: function (bodyB64) {
      if (!bodyB64) return false;
      var raw = api._b64decode(bodyB64);
      return api.shouldBlockRequest(raw);
    }
  };
  global.QQLiveClean = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ============ Loon 桥接 ============ */
if (typeof $done !== 'undefined') {
  try {
    if (typeof $response !== 'undefined' && $response && $response.body) {
      var _out = QQLiveClean.processResponse($response.body);
      if (_out) { $response.body = _out; $done({ response: $response }); }
      else { $done({}); }
    } else {
      var _blocked = $request && $request.body ? QQLiveClean.processRequest($request.body) : false;
      if (_blocked) {
        $done({ response: { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: QQLiveClean.EMPTY_FRAME_B64 } });
      } else { $done({}); }
    }
  } catch (e) { $done({}); }
}
