/*
 * Vvebo 用户主页修复 v2
 * 原理：Vvebo 使用的 /2/statuses/user_timeline 已失效，
 * 改写为微博轻享版使用的 /2/profile/statuses/tab，再把返回数据转成旧格式。
 */

const KEY_UID = "vvebo_fix_uid";
const KEY_NAME = "vvebo_fix_name_";
const KEY_SINCE = "vvebo_fix_since_";
const TAG = "_vvebo_fix";

function log(msg) {
  console.log("[VveboFix] " + msg);
}

function getParam(u, name) {
  const m = u.match(new RegExp("[?&]" + name + "=([^&#]*)"));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].replace(/\+/g, " "));
  } catch (e) {
    return m[1];
  }
}

function removeParam(u, name) {
  return u
    .replace(new RegExp("([?&])" + name + "=[^&#]*&?"), "$1")
    .replace(/[?&]$/, "");
}

function setParam(u, name, value) {
  u = removeParam(u, name);
  const sep = u.indexOf("?") === -1 ? "?" : "&";
  return u + sep + name + "=" + encodeURIComponent(value);
}

// 1. users/show：记录 uid 以及 昵称→uid 映射
function handleUserShow() {
  if (typeof $response !== "undefined") {
    try {
      const d = JSON.parse($response.body);
      const id = d.idstr || (d.id ? String(d.id) : "");
      if (id) {
        $persistentStore.write(id, KEY_UID);
        if (d.screen_name) $persistentStore.write(id, KEY_NAME + d.screen_name);
        log("users/show 记录 uid=" + id + " name=" + (d.screen_name || ""));
      } else {
        log("users/show 响应中没有 id，keys=" + Object.keys(d).join(","));
      }
    } catch (e) {
      log("users/show 解析失败: " + e);
    }
  } else {
    const uid = getParam($request.url, "uid");
    if (uid) $persistentStore.write(uid, KEY_UID);
    log("users/show 请求 uid=" + uid + " screen_name=" + getParam($request.url, "screen_name"));
  }
  $done({});
}

// 2. user_timeline 请求：改写为 profile/statuses/tab
function handleTimelineRequest() {
  const url = $request.url;
  let uid = getParam(url, "uid");
  let source = "uid参数";

  if (!uid) {
    const name = getParam(url, "screen_name");
    if (name) {
      uid = $persistentStore.read(KEY_NAME + name);
      source = "昵称映射(" + name + ")";
    }
  }
  if (!uid) {
    uid = $persistentStore.read(KEY_UID);
    source = "最近记录";
  }

  log("user_timeline 原始请求参数: uid=" + getParam(url, "uid") +
      " screen_name=" + getParam(url, "screen_name") +
      " max_id=" + getParam(url, "max_id") +
      " → 使用 uid=" + uid + "（来源：" + source + "）");

  if (!uid) {
    log("拿不到 uid，放行原请求");
    $done({});
    return;
  }

  let newUrl = url.replace("/2/statuses/user_timeline", "/2/profile/statuses/tab");
  const maxId = getParam(url, "max_id");
  newUrl = removeParam(newUrl, "max_id");
  newUrl = removeParam(newUrl, "since_id");
  newUrl = setParam(newUrl, "containerid", "230413" + uid + "_-_WEIBO_SECOND_PROFILE_WEIBO");

  if (maxId && maxId !== "0") {
    const since = $persistentStore.read(KEY_SINCE + uid);
    if (since) newUrl = setParam(newUrl, "since_id", since);
    log("翻页，since_id=" + since);
  }

  newUrl = setParam(newUrl, TAG, "1");
  $done({ url: newUrl });
}

// 3. profile/statuses/tab 响应：转换为旧格式
function handleTimelineResponse() {
  let data;
  try {
    data = JSON.parse($response.body);
  } catch (e) {
    log("响应不是 JSON，长度=" + ($response.body || "").length);
    $done({});
    return;
  }

  log("响应 keys=" + Object.keys(data).join(","));

  // 接口报错：把错误信息传给 Vvebo
  if (data.errno || data.error_code || data.errmsg) {
    log("接口报错: " + JSON.stringify(data).slice(0, 300));
    $done({
      body: JSON.stringify({
        error: data.errmsg || data.error || "请求失败",
        error_code: data.errno || data.error_code || -1,
      }),
    });
    return;
  }

  const containerid = getParam($request.url, "containerid") || "";
  const m = containerid.match(/^230413(\d+)/);
  const uid = m ? m[1] : null;

  const statuses = [];
  const seen = {};
  const types = [];

  const walk = (card) => {
    if (!card || typeof card !== "object") return;
    if (card.card_type !== undefined) types.push(card.card_type);
    if (card.mblog && typeof card.mblog === "object") {
      const s = card.mblog;
      const id = s.idstr || String(s.id);
      if (!seen[id]) {
        seen[id] = true;
        if (s.isTop || s.mblogtype == 2) s.label = "置顶";
        statuses.push(s);
      }
    }
    if (Array.isArray(card.card_group)) card.card_group.forEach(walk);
  };
  (data.cards || []).forEach(walk);

  const info = data.cardlistInfo || {};
  const sinceId = info.since_id ? String(info.since_id) : "";
  if (uid) $persistentStore.write(sinceId, KEY_SINCE + uid);

  log("uid=" + uid + " cards=" + (data.cards || []).length +
      " card_types=" + types.join(",") +
      " 解析出微博=" + statuses.length +
      " since_id=" + sinceId);

  $done({
    body: JSON.stringify({
      statuses: statuses,
      total_number: info.total || 1000,
      since_id: sinceId,
      next_cursor: sinceId ? 1 : 0,
    }),
  });
}

(function main() {
  const url = $request.url;
  if (/\/2\/users\/show\?/.test(url)) {
    handleUserShow();
  } else if (/\/2\/statuses\/user_timeline\?/.test(url)) {
    handleTimelineRequest();
  } else if (/\/2\/profile\/statuses\/tab\?/.test(url) && typeof $response !== "undefined") {
    handleTimelineResponse();
  } else {
    $done({});
  }
})();
