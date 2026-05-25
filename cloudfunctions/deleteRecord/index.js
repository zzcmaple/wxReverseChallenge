const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const guardCollection = db.collection("userGuards");

async function checkGuard(openid, action, maxCount, windowMs, blockMs) {
  const now = Date.now();
  let guardData = null;

  try {
    const guardRes = await guardCollection.doc(openid).get();
    guardData = guardRes.data;
  } catch (error) {
    guardData = null;
  }

  if (guardData && guardData.blockedUntil && guardData.blockedUntil > now) {
    throw new Error("操作过于频繁，当前已被限制，请稍后再试");
  }

  const actions = guardData && guardData.actions ? guardData.actions : {};
  const current = actions[action] || {
    count: 0,
    windowStart: now
  };

  if (now - current.windowStart > windowMs) {
    current.count = 0;
    current.windowStart = now;
  }

  current.count += 1;
  actions[action] = current;

  let blockedUntil = guardData && guardData.blockedUntil ? guardData.blockedUntil : 0;
  let violationCount = guardData && guardData.violationCount ? guardData.violationCount : 0;

  if (current.count > maxCount) {
    blockedUntil = now + blockMs;
    violationCount += 1;
  }

  await guardCollection.doc(openid).set({
    data: {
      openid,
      blockedUntil,
      violationCount,
      actions,
      updatedAt: new Date().toISOString()
    }
  });

  if (blockedUntil > now) {
    throw new Error("操作过于频繁，当前已被限制，请稍后再试");
  }
}

exports.main = async (event) => {
  const { id } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  if (!id) {
    throw new Error("缺少记录编号");
  }

  await checkGuard(openid, "deleteRecord", 20, 10 * 60 * 1000, 60 * 60 * 1000);

  const record = await db.collection("records").doc(id).get();

  if (!record.data || record.data.openid !== openid) {
    throw new Error("无权删除这条记录");
  }

  const deleteTargets = [];

  if (record.data.originalFileID) {
    deleteTargets.push(record.data.originalFileID);
  }

  if (record.data.reversedFileID && record.data.reversedFileID !== record.data.originalFileID) {
    deleteTargets.push(record.data.reversedFileID);
  }

  if (deleteTargets.length) {
    await cloud.deleteFile({
      fileList: deleteTargets
    });
  }

  await db.collection("records").doc(id).remove();

  return {
    success: true
  };
};
