// ============================================================
// 腾讯视频净化 · Loon 脚本
// 原版：Quantumult X 重写规则 + 脚本（作者 TG@ZenMoFiShi）
// 移植：Loon（同一份脚本同时挂 http-request / http-response）
// 说明：Loon 只提供 $request.body / $response.body（String 或 Uint8Array），
//       没有 bodyBytes；插件需配 binary-body-mode=true，脚本回写用 $done({body})。
//       同一份脚本在 Quantumult X 下仍走 bodyBytes，行为不变。
//
// 处理内容：
//   i.video.qq.com        protobuf(tRPC) 响应：开屏/前贴/中插/信息流/我的页广告、底部 Tab
//   i.video.qq.com        我的页入口：左上角游戏手柄图标、领VIP会员+流量
//   i.video.qq.com        请求：拦截广告 RPC 调用
//   iacc.qq.com           JCE 二进制响应：播放提示、贴片广告、暂停广告、青少年弹窗
//
// v1.0.4（2026-11-12）修复「底部 Tab 删不掉」：
//   1) 根因是延迟，不是删除逻辑：抓包里脚本已经把 GetTabListRsp 从 5 项改成 3 项，
//      但这笔 getNaviPage 是请求发出 14.4s 后才回写（请求侧排队 8.8s + 响应侧 5.3s），
//      而客户端 3s 就放弃了这笔请求（日志里 23125 那条 3.1s 后直接 dealloc），
//      于是 App 一直用本地默认的 5 个 Tab，改好的响应被丢掉。
//      延迟来源：脚本每次求值都要重新下载（gh-proxy 的 cache-control 只有 60s），
//      冷启动一轮 ~150 次求值串行排队；实测 Start evaluate → 脚本首行 中位数 3.3s、最长 12.8s。
//      → 脚本地址换成自带 7 天缓存的 jsdelivr，超时 60s→8s，删掉两条无用规则。
//   2) 版本号（f4）改成持久化递增：原来每次只 +1，客户端缓存里已经是 +1 后的值，
//      下次再收到同样的值就判定「没更新」，永远沿用旧 Tab。
//   3) 删掉 config.ab.qq.com / rdelivery.qq.com 两条规则：9.04.80 的
//      GetTabRemoteConfig 返回的是打点 AB 采样配置（带 check_sum），里面没有
//      simple_mode_config，塞条目删不掉 Tab，还有弄坏打点配置的风险。
// ============================================================

(() => {
  // 底部 Tab 删除：两套方案，插件页 [Argument] 的 tabvip 开关切换
  //   a（tabvip=关，默认）= 删「短剧/短视频」「好物」，留 首页 / 会员专区 / 我的
  //   b（tabvip=开）       = 删「会员专区/VIP会员」「好物」，留 首页 / 短视频 / 我的
  // 判断方式：既看 f22 的埋点 key（*_entrance），也看 f3 标题，任一命中就删。
  const TAB_PLANS = {
    a: { desc: "删短剧+好物", keys: ["smallvideo_entrance", "goods_entrance"], titles: ["短剧", "短视频", "好物"] },
    b: { desc: "删VIP会员+好物", keys: ["vip_entrance", "goods_entrance"], titles: ["会员专区", "VIP会员", "好物"] }
  };
  const AD_ANY = ["AdResponseInfo", "InnerAdPromotionEventList", "InnerAdCommonPromotionEventActivityList", "LoadingConfig", "PreloadResourceInfo", "AdFeedInfo"];
  const DROP_MODULES = ["user_center_more_function"];
  const AD_MODULE_IDS = ["outerPaster"];
  const FEED_MODULE_TAGS = ["waterfall_feeds_module_mergeid"];
  const MARKERS = ["AdFeedInfo", "AdResponseInfo", "InnerAd", "LoadingConfig", "PreloadResourceInfo", "GetTabListRsp", "_ad", "teenager_popup_ctrl", "SplashAd", "splash_ad"].concat(DROP_MODULES);
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
  // 广告 SDK 配置（gzip 内是整份广告配置 JSON，含 splashConfig.splashAdClose 等开关）
  const JCE_AD_SDK_CONFIG = 129513;
  // 在配置 JSON 里做同长度替换：false→true+空格 / true→false+空格，长度不变，JSON 依然合法
  const SDK_PATCHES = [
    ['"splashAdClose":false', '"splashAdClose":true '],                       // 开屏广告总开关
    ['"enableHotLaunchSplashAd":true', '"enableHotLaunchSplashAd":false  ']    // 热启动（切回前台）开屏
  ];
  // 开屏广告的 RPC 方法名每个版本都可能变（GetSplashPreload / GetSplashRealtimePoll / 以后别的名字），
  // 所以除了精确名单，再用关键词兜底：方法名里带 splash 的一律拦（splash 只用于开屏广告）。
  const BLOCK_RE = /(^|[._/])splash/i;
  function normFunc(f) { return String(f == null ? "" : f).replace(/^\/+/, ""); }
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
      if (t && /Splash/i.test(t)) return true;   // 开屏类 Any（如 SplashAdInfo / SplashInfo）一律整块删
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
  // ── 底部 Tab ────────────────────────────────────────────────
  // 客户端这笔请求是 MVLNavigationService/getNaviPage(page_id=bottom)，
  // 响应体里 type=...GetTabListRsp 的 f1 列表就是底部导航每一项：
  //   f1 = tab id（0 首页 / 1 短视频 / 2 会员专区 / 21 好物 / 4 个人中心）
  //   f2 = 顺序号，f3 = 标题，f22 = 埋点 key（*_entrance）
  // 做法：删掉不需要的项，把留下的顺序号原地改连续，其余字段（图标/角标/埋点）原样保留。
  function tabFix(b, x) {
    if (anyName(b, x.vs, x.e) !== "GetTabListRsp") return null;
    if (!TAB_ON) { L("Tab", "开关已关闭，导航响应一字节不改"); return null; }
    const rest = parse(b, ANYV, x.e);
    const v = rest && rest.find(r => r.f === 2 && r.w === 2);
    if (!v) return null;
    const vf = parse(b, v.vs, v.e);
    if (!vf) return null;
    const items = vf.filter(r => r.f === 1 && r.w === 2), drop = new Set(), names = [];
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
      names.push(title || key || "?");
      if (TAB_PLAN.keys.indexOf(key) >= 0 || TAB_PLAN.titles.indexOf(title) >= 0) drop.add(it);
    }
    if (!drop.size) { L("Tab", "没匹配到要删的项，当前是：" + names.join(" / ")); return null; }
    const edits = new Map(), kept = [];
    let idx = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (drop.has(it)) { edits.set(it, DROP); continue; }
      kept.push(names[i]);
      const ik = parse(b, it.vs, it.e), ie = new Map();
      let hasIdx = false;
      for (const r of ik) {
        // 顺序号原地替换：字段顺序和原始字节布局保持一致，少一种被客户端判错的写法
        if (r.f === 2 && r.w === 0) { hasIdx = true; ie.set(r, concat([ev(16), ev(idx)])); }
      }
      // 首项的顺序号 0 在原包里本来就不写，这里也不额外补，尽量少改动字节
      const body2 = hasIdx ? rebuild(b, it.vs, it.e, ik, ie)
        : (idx > 0 ? concat([ev(16), ev(idx), b.subarray(it.vs, it.e)]) : b.subarray(it.vs, it.e));
      edits.set(it, lenField(1, body2));
      idx++;
    }
    // 版本号（f4，20 位十进制）：一定要严格变大，客户端才会丢掉本地缓存重新应用
    const ver = vf.find(r => r.f === 4 && r.w === 2 && /^[0-9]{1,20}$/.test(ascii(b, r.vs, r.e) || ""));
    let verTxt = "", newVer = "";
    if (ver) {
      verTxt = ascii(b, ver.vs, ver.e) || "";
      newVer = nextVer(verTxt);
      edits.set(ver, lenField(4, utf8(newVer)));
    }
    const nv = rebuild(b, v.vs, v.e, vf, edits);
    L("Tab", "方案 " + TAB_PLAN.desc + "：删 " + drop.size + " 个，留 " + kept.join(" / ") + (verTxt ? "，版本 " + verTxt + "→" + newVer : ""));
    return lenField(x.f, concat([b.subarray(x.vs, v.s), lenField(2, nv), b.subarray(v.e, x.e)]));
  }
  // ── 导航数据版本号 ─────────────────────────────────────────
  // 老写法是每次 +1。但服务端每次下发的原值是固定的，客户端却把 +1 之后的值
  // 存进了本地缓存，于是下一次再收到同样的 +1 就判成「没更新」，永远用旧 Tab。
  // 这里改成持久化计数器：无论服务端给什么，永远给出比上次更大的值。
  const VER_TAG = "txvideo_tabver";
  function bigAdd(s, n) {
    const a = s.split("");
    let i = a.length - 1, carry = n;
    while (i >= 0 && carry > 0) {
      const v = (a[i].charCodeAt(0) - 48) + carry;
      a[i] = String.fromCharCode(48 + (v % 10));
      carry = Math.floor(v / 10);
      i--;
    }
    return ((carry > 0 ? String(carry) : "") + a.join("")).replace(/^0+(?=.)/, "");
  }
  function bigCmp(x, y) {
    if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    return x === y ? 0 : (x < y ? -1 : 1);
  }
  function kvGet(k) {
    try { if (typeof $persistentStore !== "undefined" && $persistentStore.read) return $persistentStore.read(k); } catch (e) {}
    try { if (typeof $prefs !== "undefined" && $prefs.valueForKey) return $prefs.valueForKey(k); } catch (e) {}
    return null;
  }
  function kvSet(k, v) {
    try { if (typeof $persistentStore !== "undefined" && $persistentStore.write) { $persistentStore.write(v, k); return; } } catch (e) {}
    try { if (typeof $prefs !== "undefined" && $prefs.setValueForKey) { $prefs.setValueForKey(v, k); return; } } catch (e) {}
  }
  function nextVer(orig) {
    let nv = bigAdd(orig, 1);
    const last = kvGet(VER_TAG);
    if (last && /^[0-9]{1,20}$/.test(last) && bigCmp(nv, last) <= 0) nv = bigAdd(last, 1);
    if (nv.length > 20) nv = nv.slice(-20);
    kvSet(VER_TAG, nv);
    return nv;
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
  // 「我的」页是 MVL 布局：一条 item 通常是「图标/标题 + 跳转链接 + eid/mod_id 元数据」。
  // 想删掉某个入口，就整块删掉承载它的那条 item：节点里出现特征串 + 节点直接带跳转链接。
  const UI_TOP = utf8("user_center_top_function");
  const UI_KEYS = [
    // { 特征串, 是否只在「我的」页顶部功能区出现时才生效 }
    [utf8("iwan.qq.com/g/honor-center"), 1],   // 左上角游戏手柄图标（首页「爱玩」频道也有同域名，须限定）
    [utf8("userCenter_weishiVIP0606_entry"), 0], // 领VIP会员+流量（任务入口）
    [utf8("领VIP会员+流量"), 0]                   // 同名兜底（入口改 key 但标题没变时）
  ];
  function hasUiKey(b, s, e, top) {
    for (let i = 0; i < UI_KEYS.length; i++) {
      if (UI_KEYS[i][1] && !top) continue;
      if (find(b, UI_KEYS[i][0], s, e) >= 0) return true;
    }
    return false;
  }
  function hasUrlChild(b, s, e) {
    const fs = parse(b, s, e);
    if (!fs) return false;
    for (const x of fs) {
      if (x.w !== 2 || x.e - x.vs < 10 || x.e - x.vs > 600) continue;
      const v = x.vs;
      if (b[v] === 0x68 && b[v + 1] === 0x74 && b[v + 2] === 0x74 && b[v + 3] === 0x70) return true; // http
      if (b[v] === 0x74 && b[v + 1] === 0x78 && b[v + 2] === 0x76) return true;                      // txv
    }
    return false;
  }
  function dropUi(b, s, e, depth, top) {
    if (depth > 16 || e - s < 120 || e - s > 262144 || !hasUiKey(b, s, e, top)) return null;
    const fs = parse(b, s, e);
    if (!fs) return null;
    const edits = new Map();
    for (const x of fs) {
      if (x.w !== 2 || x.e - x.vs < 120) continue;
      if (!hasUiKey(b, x.vs, x.e, top)) continue;
      if (x.e - x.vs <= 1600 && hasUrlChild(b, x.vs, x.e)) { edits.set(x, DROP); L("我的页", "删除入口 " + (x.e - x.vs) + "B"); continue; }
      const sub = dropUi(b, x.vs, x.e, depth + 1, top);
      if (sub) edits.set(x, lenField(x.f, sub));
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
    const ui = dropUi(b, s, e, 0, find(b, UI_TOP, s, e) >= 0);
    if (ui) {
      indexMarkers(ui, 0, ui.length);
      const c = clean(ui, 0, ui.length, 0);
      L("我的页", "入口已删除 " + (e - s) + "→" + (c ? c.length : ui.length) + "B");
      return c || ui;
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
    if (gzMagic(u8)) { u8 = gunzip(u8); gz = true; L("gunzip", "响应体解压后 " + btype(u8)); if (!u8) return null; }
    const fr = trpcFrame(u8);
    if (!fr) { L("i.video", "不是 tRPC 帧（首字节 0x" + ((u8 && u8[0]) || 0).toString(16) + "），放行"); return null; }
    indexMarkers(u8, fr.he, u8.length);
    L("i.video", "tRPC 帧 OK：头 " + fr.he + "B / 体 " + (u8.length - fr.he) + "B");
    const body = transform(u8, fr.he, u8.length);
    if (!body) {
      L("i.video", has(null, fr.he, u8.length) ? "包内有广告标记但没命中删除规则（可能是未覆盖的新结构）" : "解析完成，未命中广告元素，放行");
      return null;
    }
    const out = concat([u8.subarray(0, fr.he), body]);
    put32(out, 4, out.length);
    L("i.video", "清洗生效：" + u8.length + "→" + out.length + "B");
    return gz ? gzip(out) : out;
  }
  function onTrpcRequest(raw) {
    let u8 = raw, gz = false;
    if (gzMagic(u8)) { u8 = gunzip(u8); gz = true; L("gunzip", "请求体解压后 " + btype(u8)); if (!u8) return null; }
    const fr = trpcFrame(u8);
    if (!fr) { L("请求", "不是 tRPC 帧（首字节 0x" + ((u8 && u8[0]) || 0).toString(16) + "），放行"); return null; }
    const hd = parse(u8, fr.hs, fr.he), fn = hd && hd.find(x => x.f === 7 && x.w === 2);
    const func = fn ? ascii(u8, fn.vs, fn.e) : null;
    if (!func) { L("请求", "tRPC 帧里没有 func 字段，放行"); return null; }
    const nf = normFunc(func);
    const hitList = BLOCK_FUNCS.some(x => normFunc(x) === nf);
    const hitRe = BLOCK_RE.test(nf);
    if (!hitList && !hitRe) { L("请求", "RPC=" + nf + " 不在拦截名单"); return null; }
    L("请求", "RPC=" + nf + " 命中（" + (hitList ? "精确名单" : "splash 关键词") + "），改写方法名");
    const nb = utf8(nf.slice(nf.lastIndexOf("/") + 1)), out = u8.slice();
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
  // 广告 SDK 配置：gzip 内是整份广告配置 JSON（splashConfig.splashAdClose 等开关）。
  // JSON 前面紧挨着一个 4 字节大端长度；改完内容要同步这个长度，
  // 外层 JCE 的长度由 onJce 统一重算，所以这里只管这一段。
  function fixAdSdkConfig(b, s, e) {
    const js = find(b, utf8('{"appConfig"'), s, e);
    if (js < 4) { L("iacc", "广告 SDK 配置：没找到配置 JSON"); return null; }
    const oldLen = u32(b, js - 4);
    if (oldLen <= 0 || js + oldLen > e) { L("iacc", "广告 SDK 配置：JSON 长度不符（" + oldLen + "）"); return null; }
    const json = b.subarray(js, js + oldLen);
    const jobs = [];
    for (const [from, to] of SDK_PATCHES) {
      const f = utf8(from);
      let i = 0;
      while (i < json.length) {
        const p = find(json, f, i, json.length);
        if (p < 0) break;
        jobs.push([p, f.length, utf8(to)]);
        i = p + f.length;
      }
    }
    if (!jobs.length) { L("iacc", "广告 SDK 配置：开关已是关闭状态"); return null; }
    jobs.sort((a, c) => a[0] - c[0]);
    const parts = [];
    let cur = 0;
    for (const [p, fl, t] of jobs) { parts.push(json.subarray(cur, p), t); cur = p + fl; }
    parts.push(json.subarray(cur));
    const nj = concat(parts);
    const lb = new Uint8Array(4);
    put32(lb, 0, nj.length);
    L("iacc", "广告 SDK 配置：关闭开屏开关 " + jobs.length + " 处，JSON " + oldLen + "→" + nj.length + "B");
    return concat([b.subarray(s, js - 4), lb, nj, b.subarray(js + oldLen, e)]);
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
    if (n < 100 || b[0] !== 0x13 || u32(b, 1) !== n || b[n - 1] !== 0x03) {
      L("iacc", "不是 JCE 包（len=" + n + " 首字节 0x" + ((b[0] || 0).toString(16)) + "），放行");
      return null;
    }
    const cmd = (b[8] << 16) | (b[9] << 8) | b[10];
    L("iacc", "JCE cmd=" + cmd + " len=" + n);
    const fix = cmd === JCE_TEEN_CONFIG ? fixTeenConfig : cmd === JCE_PLAY_TIPS ? fixPlayTips : cmd === JCE_AD_SDK_CONFIG ? fixAdSdkConfig : JCE_ROLL_ADS.indexOf(cmd) >= 0 ? fixRollAds : cmd === JCE_PAUSE_AD ? fixPauseAd : null;
    if (!fix) { L("iacc", "cmd=" + cmd + " 不在处理列表"); return null; }
    const gz = find(b, new Uint8Array([0x1f, 0x8b, 0x08]), 60, Math.min(n, 140));
    if (gz < 4) { L("iacc", "cmd=" + cmd + " 找不到内层 gzip 流"); return null; }
    const inner = gunzip(b.subarray(gz, n - 1));
    const m = inner.length;
    if (u32(b, gz - 4) !== m || m < 18 || inner[0] !== 0x26 || u32(inner, 1) !== m || inner[m - 1] !== 0x28) {
      L("iacc", "cmd=" + cmd + " 内层结构校验失败（m=" + m + "）");
      return null;
    }
    const top = jFields(inner, 16, m - 1), body = top.find(x => x.tag === 1 && x.t === 13);
    if (!body) { L("iacc", "cmd=" + cmd + " 内层没有 tag1 列表"); return null; }
    jHead(inner, body.vs);
    const bl = jInt(inner, VP), bs = VP;
    if (bs + bl !== body.e) { L("iacc", "cmd=" + cmd + " 内层列表长度不符"); return null; }
    const nb = fix(inner, bs, bs + bl);
    if (!nb) { L("iacc", "cmd=" + cmd + " 修补函数返回空（该包本身无可删项）"); return null; }
    const ni = concat([inner.subarray(0, body.s), jSimpleList(1, nb), inner.subarray(body.e, m)]);
    put32(ni, 1, ni.length);
    const head = b.slice(0, gz);
    put32(head, gz - 4, ni.length);
    const out = concat([head, gzip(ni), new Uint8Array([0x03])]);
    put32(out, 1, out.length);
    L("iacc", "cmd=" + cmd + " 已修补，输出 " + out.length + "B");
    return out;
  }

  const IS_QX = typeof $task !== "undefined"; // Quantumult X 提供 $task，Loon 没有
  const MAX_BODY = 8 * 1024 * 1024;

  // ── 诊断日志 ────────────────────────────────────────────────
  // 每次脚本执行给一个短 ID，按阶段打点：出问题时能看出停在哪一步。
  // 开关优先级：插件 [Argument] 里的 diag 开关 > 下面的 DBG_DEFAULT。
  //   · 新版语法：script("...", {${diag}}) → $argument = {diag:true/false}
  //   · 旧版语法：argument="diag=true"      → $argument 是字符串
  //   · 都没有：用 DBG_DEFAULT
  // ── 插件 [Argument] 通用读取 ────────────────────────────────
  // 新版语法 script("x.js",{${a},${b}}) → $argument 是对象；旧版 argument="a=true&b=x" → 字符串
  function argRaw(a, names) {
    if (a === undefined || a === null) return null;
    if (typeof a === "object") {
      for (let i = 0; i < names.length; i++)
        if (typeof a[names[i]] !== "undefined") return a[names[i]];
      return null;
    }
    if (typeof a === "string") {
      const re = new RegExp("(?:^|[&\\s,{;])(?:" + names.join("|") + ")\\s*[=:]\\s*([^&\\s,;}]+)", "i");
      const m = a.match(re);
      return m ? m[1].trim() : null;
    }
    return null;
  }
  function argBool(a, names, def) {
    let v = argRaw(a, names);
    if (v === null) return def;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    v = String(v).trim();
    if (/^(1|true|on|yes|y)$/i.test(v)) return true;
    if (/^(0|false|off|no|n)$/i.test(v)) return false;
    return def;
  }
  const DBG_DEFAULT = true;
  function argFlag(a) {
    if (a === undefined || a === null) return null;
    if (typeof a === "boolean") return a;
    if (typeof a === "number") return a !== 0;
    if (typeof a === "object") {
      const keys = ["diag", "debug", "log", "logging"];
      for (let i = 0; i < keys.length; i++) {
        if (typeof a[keys[i]] !== "undefined") return argFlag(a[keys[i]]);
      }
      return null;
    }
    if (typeof a === "string") {
      const m = a.match(/(?:^|[&\s,])(?:diag|debug|log)\s*[=:]\s*([^&\s,}]+)/i);
      if (m) return /^(1|true|on|yes)$/i.test(m[1].trim());
      const s = a.trim();
      if (/^(true|1|on|yes)$/i.test(s)) return true;
      if (/^(false|0|off|no)$/i.test(s)) return false;
    }
    return null;
  }
  let DBG = (function () {
    let a = null;
    try { if (typeof $argument !== "undefined") a = $argument; } catch (e) { a = null; }
    const v = argFlag(a);
    return v === null ? DBG_DEFAULT : v;
  })();
  // ── 底部 Tab 删除开关（插件页可改，不用动代码）──────────────
  //   tabs=true/false       是否删除底部多余 Tab（false = 导航响应一字节不改）
  //   tabmode=a/b           删哪一组：a=删短剧+好物，b=删VIP会员+好物
  let TAB_ON = true, TAB_PLAN = TAB_PLANS.a;
  (function () {
    let a = null;
    try { if (typeof $argument !== "undefined") a = $argument; } catch (e) { a = null; }
    TAB_ON = argBool(a, ["tabs", "tab", "tabcut", "tabclean"], true);
    let m = argRaw(a, ["tabmode", "tabplan", "tabset"]);
    m = m === null ? "" : String(m).trim().toLowerCase();
    if (m === "b" || m === "vip" || m === "2") TAB_PLAN = TAB_PLANS.b;
    else if (m === "a" || m === "short" || m === "smallvideo" || m === "1") TAB_PLAN = TAB_PLANS.a;
    else if (m) L("参数", "tabmode=" + m + " 无法识别，改看 tabvip 开关");
    else if (argBool(a, ["tabvip", "tabb"], false)) TAB_PLAN = TAB_PLANS.b;
  })();
  let RID = "?", STAGE = "初始化";
  function L(stage, msg) {
    if (!DBG && stage !== "错误") return;
    try {
      if (typeof console !== "undefined" && console.log)
        console.log("txvideo-ad-clean #" + RID + " [" + stage + "] " + msg);
    } catch (e) {}
  }
  function btype(x) {
    if (x === undefined) return "undefined";
    if (x === null) return "null";
    if (typeof x === "string") return "String(" + x.length + ")";
    const tag = Object.prototype.toString.call(x).slice(8, -1);
    return tag + "(" + (x && typeof x.length === "number" ? x.length : "?") + "B)";
  }
  function gzMagic(u8) { return !!u8 && u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b; }
  function hexHead(u8, n) {
    if (!u8 || !u8.length) return "-";
    const k = Math.min(u8.length, n || 8), a = [];
    for (let i = 0; i < k; i++) a.push((u8[i] < 16 ? "0" : "") + u8[i].toString(16));
    return a.join(" ");
  }

  // Loon：$request.body / $response.body 是 String 或 Uint8Array（binary-body-mode=true 时是 Uint8Array）
  // Quantumult X：只有 bodyBytes，没有 ArrayBuffer 形态的 body 之外的入口
  function readBody(o) {
    if (!o) { L("body", "没有 body 对象"); return null; }
    try {
      if (o.bodyBytes) {
        const u = toU8(o.bodyBytes);
        L("body", "取到 bodyBytes " + btype(u) + (gzMagic(u) ? " gzip" : ""));
        return u;
      }
    } catch (e) {
      L("body", "读 bodyBytes 抛错: " + e);
    }
    let b;
    try {
      b = o.body;
    } catch (e) {
      // 插件规则漏了 binary-body-mode=true 时，Loon 会把二进制 body 当 UTF-8 解码，
      // 解码失败就在这里抛 "Convert body string error"，整段清洗逻辑会被跳过。
      L("错误", "读 body 抛错: " + e + " —— 多半是脚本规则缺 binary-body-mode=true");
      return null;
    }
    if (typeof b === "string") {
      if (!b.length) { L("body", "取到空 String"); return null; }
      let latin1 = true;
      for (let i = 0; i < b.length; i++) { if (b.charCodeAt(i) > 0xff) { latin1 = false; break; } }
      if (latin1) {
        // 没开 binary-body-mode 时，Loon 交给脚本的是“每字符一字节”的字符串，
        // 这里按 latin1 原样还原成字节，仍有机会正常清洗（首字节会打在日志里）。
        const u = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i) & 0xff;
        L("body", "取到 String(" + b.length + ") 未走二进制模式 → latin1 还原 " + u.length + "B，首字节 " + hexHead(u));
        return u;
      }
      L("body", "取到 String(" + b.length + ") 含多字节字符（二进制体已被 UTF-8 解码破坏），首 8 字符 " + hexHead(utf8(b)));
      return utf8(b);
    }
    const u = b ? toU8(b) : null;
    L("body", u ? "取到 " + btype(u) + (gzMagic(u) ? " gzip" : "") + "，首字节 " + hexHead(u) : "body 类型无法识别: " + btype(b));
    return u;
  }

  // 回写：Loon 用 body(Uint8Array)，QX 用 bodyBytes(ArrayBuffer)
  function finish(u8) {
    if (!u8) { L("回写", "放行原响应/请求（$done({})）"); $done({}); return; }
    if (IS_QX) { L("回写", "bodyBytes " + u8.length + "B"); $done({ bodyBytes: toBuf(u8) }); }
    else { L("回写", "body " + u8.length + "B"); $done({ body: u8 }); }
  }

  function main() {
    const url = $request.url || "", host = (url.split("/")[2] || "").split(":")[0];
    const isResp = typeof $response !== "undefined" && $response !== null;
    RID = Date.now().toString(36).slice(-4) + (isResp ? "R" : "Q");
    STAGE = "入口";
    L("入口", (IS_QX ? "QX" : "Loon") + " " + (isResp ? "响应" : "请求") + " host=" + host + " diag=" + (DBG ? "on" : "off") + " url=" + (url.length > 80 ? url.slice(0, 80) + "…" : url));
    try {
      if (!isResp) {
        STAGE = "读取请求体";
        const b = host === "i.video.qq.com" ? readBody($request) : null;
        if (!b) { L("跳过", "无请求体或读不到，放行"); $done({}); return; }
        if (b.length > MAX_BODY) { L("跳过", "请求体 " + b.length + "B 超过上限，放行"); $done({}); return; }
        STAGE = "请求清洗";
        const out = onTrpcRequest(b);
        L("完成", out ? "请求已改写 " + b.length + "→" + out.length + "B" : "请求无需改写 " + b.length + "B");
        finish(out);
        return;
      }
      STAGE = "读取响应体";
      const b = readBody($response);
      if (!b) { L("跳过", "无响应体，放行"); $done({}); return; }
      if (b.length > MAX_BODY) { L("跳过", "响应体 " + b.length + "B 超过上限，放行"); $done({}); return; }
      let r = null;
      if (host === "i.video.qq.com") { STAGE = "i.video 清洗"; r = onTrpcResponse(b); }
      else if (host === "iacc.qq.com") { STAGE = "iacc JCE"; r = onJce(b); }
      else { L("跳过", "host=" + host + " 不处理，放行"); }
      L("完成", r ? "已修改 " + b.length + "→" + r.length + "B" : "无变化，放行 " + b.length + "B");
      finish(r);
    } catch (e) {
      const st = e && e.stack ? String(e.stack).split("\n")[1] : "";
      L("错误", "在【" + STAGE + "】抛出: " + (e && e.message ? e.message : e) + (st ? " @" + st.trim() : ""));
      $done({});
    }
  }
  main();
})();
