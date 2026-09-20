const url = $request.url;

function getParam(url, name) {
  const match = url.match(new RegExp("[?&]" + name + "=([^&]+)"));
  return match ? decodeURIComponent(match[1]) : null;
}

// 1. VVebo 请求用户资料时，记录目标 UID
if (url.includes("/2/users/show")) {
  const uid = getParam(url, "uid");

  if (uid) {
    $persistentStore.write(uid, "vvebo_target_uid");
    console.log("[VVebo Fix] 保存目标 UID: " + uid);
  }

  $done({});
}

// 2. VVebo 请求用户微博，但缺少 uid 时，自动补上
else if (url.includes("/2/statuses/user_timeline")) {

  const existingUid = getParam(url, "uid");

  // 本身已有 UID 就不处理
  if (existingUid) {
    console.log("[VVebo Fix] user_timeline 已有 UID: " + existingUid);
    $done({});
  } else {
    const uid = $persistentStore.read("vvebo_target_uid");

    if (uid) {
      const separator = url.includes("?") ? "&" : "?";
      const newUrl = url + separator + "uid=" + encodeURIComponent(uid);

      console.log("[VVebo Fix] user_timeline 补 UID: " + uid);
      console.log("[VVebo Fix] 新 URL: " + newUrl);

      $done({
        url: newUrl
      });
    } else {
      console.log("[VVebo Fix] 没有找到已保存的 UID");
      $done({});
    }
  }
}

else {
  $done({});
}
