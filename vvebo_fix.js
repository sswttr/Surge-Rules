/*
 * Vvebo 用户主页修复
 * 原理：Vvebo 使用的 /2/statuses/user_timeline 已失效，
 * 改写为微博轻享版使用的 /2/profile/statuses/tab，再把返回数据转成旧格式。
 */

const KEY_UID = "vvebo_fix_uid";
const KEY_SINCE = "vvebo_fix_since_";
const TAG = "_vvebo_fix";

function getParam(u, name) {
  const m = u.match(new RegExp("[?&]" + name + "=([^&#]*)"));
  return m ? decodeURIComponent(m[1]) : null;
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

// 1. users/show：记录 uid
function handleUserShow() {
  if (typeof $response !== "undefined") {
    try {
      const d = JSON.parse($response.body);
      const id = d.idstr || (d.id ? String(d.id) : "");
      if (id) $persistentStore.write(id, KEY_UID);
    } catch (e) {}
  } else {
    const uid = getParam($request.url, "uid");
    if (uid) $persistentStore.write(uid, KEY_UID);
  }
  $done({});
}

// 2. user_timeline 请求：改写为 profile/statuses/tab
function handleTimelineRequest() {
  const url = $request.url;
  const uid = getParam(url, "uid") || $persistentStore.read(KEY_UID);
  if (!uid) {
    $done({});
    return;
  }

  let newUrl = url.replace("/2/statuses/user_timeline", "/2/profile/statuses/tab");
  const maxId = getParam(url, "max_id");
  newUrl = removeParam(newUrl, "max_id");
  newUrl = removeParam(newUrl, "since_id");
  newUrl = setParam(newUrl, "containerid", "230413" + uid + "_-_WEIBO_SECOND_PROFILE_WEIBO");

  // 翻页：旧接口用 max_id，新接口用上一页返回的 since_id
  if (maxId && maxId !== "0") {
    const since = $persistentStore.read(KEY_SINCE + uid);
    if (since) newUrl = setParam(newUrl, "since_id", since);
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
    $done({});
    return;
  }

  const containerid = getParam($request.url, "containerid") || "";
  const m = containerid.match(/^230413(\d+)/);
  const uid = m ? m[1] : null;

  const statuses = [];
  const seen = {};
  const pushCard = (card) => {
    if (!card) return;
    if (Array.isArray(card.card_group)) {
      card.card_group.forEach(pushCard);
      return;
    }
    if (card.card_type === 9 && card.mblog) {
      const s = card.mblog;
      const id = s.idstr || String(s.id);
      if (seen[id]) return;
      seen[id] = true;
      if (s.isTop || s.mblogtype === 2) s.label = "置顶";
      statuses.push(s);
    }
  };
  (data.cards || []).forEach(pushCard);

  const info = data.cardlistInfo || {};
  const sinceId = info.since_id ? String(info.since_id) : "";
  if (uid) $persistentStore.write(sinceId, KEY_SINCE + uid);

  const body = {
    statuses: statuses,
    total_number: info.total || 1000,
    since_id: sinceId,
    next_cursor: sinceId ? 1 : 0,
  };
  $done({ body: JSON.stringify(body) });
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
