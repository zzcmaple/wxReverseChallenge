const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const guardCollection = db.collection("userGuards");
const _ = db.command;

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

  await checkGuard(openid, "getRecordDetail", 120, 5 * 60 * 1000, 30 * 60 * 1000);

  const res = await db.collection("records").doc(id).get();

  if (!res.data || res.data.openid !== openid) {
    throw new Error("无权访问这条记录");
  }

  const mimicRes = await db.collection("records")
    .where({
      parentRecordId: _.eq(id),
      sourceType: _.eq("mimic"),
      openid: _.eq(openid)
    })
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  const fileList = [];

  if (res.data.originalFileID) {
    fileList.push(res.data.originalFileID);
  }

  if (res.data.reversedFileID && res.data.reversedFileID !== res.data.originalFileID) {
    fileList.push(res.data.reversedFileID);
  }

  const mimicRecord = mimicRes.data && mimicRes.data.length ? mimicRes.data[0] : null;

  if (mimicRecord && mimicRecord.originalFileID) {
    fileList.push(mimicRecord.originalFileID);
  }

  if (mimicRecord && mimicRecord.reversedFileID && mimicRecord.reversedFileID !== mimicRecord.originalFileID) {
    fileList.push(mimicRecord.reversedFileID);
  }

  const tempUrlMap = {};

  if (fileList.length) {
    const tempRes = await cloud.getTempFileURL({
      fileList
    });

    tempRes.fileList.forEach((item) => {
      tempUrlMap[item.fileID] = item.tempFileURL;
    });
  }

  return {
    record: {
      _id: res.data._id,
      title: res.data.title,
      originalFileID: res.data.originalFileID || "",
      reversedFileID: res.data.reversedFileID || "",
      originalTempUrl: tempUrlMap[res.data.originalFileID] || "",
      reversedTempUrl: tempUrlMap[res.data.reversedFileID] || "",
      duration: res.data.duration || 0,
      status: res.data.status || "processing",
      createdAt: res.data.createdAt || "",
      errorMessage: res.data.errorMessage || ""
    },
    mimicRecord: mimicRecord ? {
      _id: mimicRecord._id,
      title: mimicRecord.title,
      originalFileID: mimicRecord.originalFileID || "",
      reversedFileID: mimicRecord.reversedFileID || "",
      originalTempUrl: tempUrlMap[mimicRecord.originalFileID] || "",
      reversedTempUrl: tempUrlMap[mimicRecord.reversedFileID] || "",
      duration: mimicRecord.duration || 0,
      status: mimicRecord.status || "processing",
      createdAt: mimicRecord.createdAt || "",
      errorMessage: mimicRecord.errorMessage || ""
    } : null
  };
};
