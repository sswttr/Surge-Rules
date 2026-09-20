/*
 * Vvebo 用户主页修复 v4
 * 原理：Vvebo 使用的 /2/statuses/user_timeline 已失效，
 * 改写为微博轻享版使用的 /2/profile/statuses/tab，再把返回数据转成旧格式。
 * v4：每页数量降为 20，避免响应过大导致脚本超时/内存不足
 */

const DEBUG = false; // 出问题需要排查时改为 true
const PAGE_SIZE = "20";

const KEY_UID = "vvebo_fix_uid";
const KEY_NAME = "vvebo_fix_name_";
const KEY_SINCE = "vvebo_fix_since_";
const TAG = "_vvebo_fix";

function log(msg) {
  console.log("[VveboFix] " + msg);
}

function notify(subtitle, body) {
  log(subtitle + " | " + body);
  if (DEBUG) $notification.post("Vvebo 修复", subtitle, body);
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

function saveUser(d) {
  const id = d && (d.idstr || (d.id ? String(d.id) : ""));
  if (!id) return null;
  if (d.screen_name) $persistentStore.write(id, KEY_NAME + d.screen_name);
  return id;
}

// 1. users/show：记录 uid 以及 昵称→uid 映射
function handleUserShow() {
  if (typeof $response !== "undefined") {
    try {
      const id = saveUser(JSON.parse($response.body));
      if (id) $persistentStore.write(id, KEY_UID);
    } catch (e) {}
  } else {
    const uid = getParam($request.url, "uid");
    if (uid) $persistentStore.write(uid, KEY_UID);
  }
  $done({});
}

// 用昵称实时查询 uid（沿用当前请求的登录参数）
function lookupUidByName(name, callback) {
  let u = $request.url.replace("/2/statuses/user_timeline", "/2/users/show");
  ["uid", "max_id", "since_id", "page", "count", "feature", "screen_name"].forEach((k) => {
    u = removeParam(u, k);
  });
  u = setParam(u, "screen_name", name);
  const headers = Object.assign({}, $request.headers);
  delete headers["Content-Length"];
  delete headers["content-length"];

  $httpClient.get({ url: u, headers: headers }, (err, resp, body) => {
    if (err) {
      callback(null, "查询失败: " + err);
      return;
    }
    try {
      const id = saveUser(JSON.parse(body));
      callback(id, id ? null : "查询结果无 uid: " + String(body).slice(0, 120));
    } catch (e) {
      callback(null, "查询结果解析失败");
    }
  });
}

// 2. user_timeline 请求：改写为 profile/statuses/tab
function rewriteTimeline(uid, source) {
  const url = $request.url;
  let newUrl = url.replace("/2/statuses/user_timeline", "/2/profile/statuses/tab");
  const maxId = getParam(url, "max_id");
  newUrl = removeParam(newUrl, "max_id");
  newUrl = removeParam(newUrl, "since_id");
  newUrl = setParam(newUrl, "count", PAGE_SIZE);
  newUrl = setParam(newUrl, "containerid", "230413" + uid + "_-_WEIBO_SECOND_PROFILE_WEIBO");

  if (maxId && maxId !== "0") {
    const since = $persistentStore.read(KEY_SINCE + uid);
    if (since) newUrl = setParam(newUrl, "since_id", since);
  }

  newUrl = setParam(newUrl, TAG, "1");
  newUrl = setParam(newUrl, "_vvebo_src", source);
  log("改写 uid=" + uid + " 来源=" + source);
  $done({ url: newUrl });
}

function handleTimelineRequest() {
  const url = $request.url;
  const uidParam = getParam(url, "uid");
  const name = getParam(url, "screen_name");

  if (uidParam) {
    rewriteTimeline(uidParam, "uid");
    return;
  }

  if (name) {
    const cached = $persistentStore.read(KEY_NAME + name);
    if (cached) {
      rewriteTimeline(cached, "name_cache");
      return;
    }
    lookupUidByName(name, (id, err) => {
      if (id) {
        rewriteTimeline(id, "name_lookup");
      } else {
        notify("无法获取 uid", "昵称：" + name + "\n" + err);
        $done({});
      }
    });
    return;
  }

  const last = $persistentStore.read(KEY_UID);
  if (last) {
    rewriteTimeline(last, "last");
  } else {
    notify("无法获取 uid", "请求中没有 uid 和 screen_name");
    $done({});
  }
}

// 3. profile/statuses/tab 响应：转换为旧格式
function handleTimelineResponse() {
  const reqUrl = $request.url;
  const containerid = getParam(reqUrl, "containerid") || "";
  const m = containerid.match(/^230413(\d+)/);
  const uid = m ? m[1] : null;
  const source = getParam(reqUrl, "_vvebo_src") || "?";
  const isFirstPage = !getParam(reqUrl, "since_id");
  const size = ($response.body || "").length;

  let data;
  try {
    data = JSON.parse($response.body);
  } catch (e) {
    notify("响应不是 JSON", "uid=" + uid + " 状态码=" + $response.status + " 大小=" + size);
    $done({});
    return;
  }

  if (data.errno || data.error_code || data.errmsg) {
    notify("接口报错", "uid=" + uid + "（" + source + "）\n" + JSON.stringify(data).slice(0, 200));
    $done({
      body: JSON.stringify({
        error: data.errmsg || data.error || "请求失败",
        error_code: data.errno || data.error_code || -1,
      }),
    });
    return;
  }

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
    ["card_group", "items", "cards"].forEach((k) => {
      if (Array.isArray(card[k])) card[k].forEach(walk);
    });
  };
  (data.cards || []).forEach(walk);

  const info = data.cardlistInfo || {};
  const sinceId = info.since_id ? String(info.since_id) : "";
  const total = info.total || 1000;
  if (uid) $persistentStore.write(sinceId, KEY_SINCE + uid);
  data = null; // 尽早释放内存

  if (statuses.length === 0 && isFirstPage) {
    notify(
      "首页解析出 0 条微博",
      "uid=" + uid + "（" + source + "）大小=" + size + "\ntypes=" + types.join(",")
    );
  }

  $done({
    body: JSON.stringify({
      statuses: statuses,
      total_number: total,
      since_id: sinceId,
      next_cursor: sinceId ? 1 : 0,
    }),
  });
}

(function main() {
  try {
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
  } catch (e) {
    notify("脚本异常", String(e));
    $done({});
  }
})();
