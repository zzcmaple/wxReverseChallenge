const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const collection = db.collection("records");
const guardCollection = db.collection("userGuards");

function findDataChunk(buffer) {
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === "data") {
      return {
        dataOffset: offset + 8,
        dataSize: chunkSize
      };
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  throw new Error("未找到 WAV data 区块");
}

function reverseWavBuffer(buffer) {
  const riff = buffer.toString("ascii", 0, 4);
  const wave = buffer.toString("ascii", 8, 12);

  if (riff !== "RIFF" || wave !== "WAVE") {
    const hexHead = buffer.subarray(0, 16).toString("hex");
    throw new Error(`当前音频不是合法的 WAV 文件，文件头：${hexHead}`);
  }

  const audioFormat = buffer.readUInt16LE(20);
  const channelCount = buffer.readUInt16LE(22);
  const bitsPerSample = buffer.readUInt16LE(34);
  const blockAlign = buffer.readUInt16LE(32);

  if (audioFormat !== 1) {
    throw new Error("当前仅支持 PCM 编码的 WAV 录音");
  }

  if (!blockAlign || !channelCount || !bitsPerSample) {
    throw new Error("WAV 头信息不完整");
  }

  const { dataOffset, dataSize } = findDataChunk(buffer);
  const header = buffer.subarray(0, dataOffset);
  const audioData = buffer.subarray(dataOffset, dataOffset + dataSize);

  if (audioData.length % blockAlign !== 0) {
    throw new Error("WAV 音频帧长度异常");
  }

  const frameCount = audioData.length / blockAlign;
  const reversedData = Buffer.alloc(audioData.length);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const sourceStart = frameIndex * blockAlign;
    const targetStart = (frameCount - 1 - frameIndex) * blockAlign;
    audioData.copy(reversedData, targetStart, sourceStart, sourceStart + blockAlign);
  }

  return Buffer.concat([header, reversedData]);
}

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
  const {
    originalFileID,
    duration = 0,
    parentRecordId = "",
    sourceType = "primary"
  } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  if (!originalFileID) {
    throw new Error("缺少原始音频文件");
  }

  await checkGuard(openid, "processAudio", 6, 5 * 60 * 1000, 30 * 60 * 1000);

  const now = new Date().toISOString();
  const titlePrefix = sourceType === "mimic" ? "玩家B模仿" : "挑战录音";
  const title = `${titlePrefix} ${now.slice(5, 16).replace("T", " ")}`;

  const addRes = await collection.add({
    data: {
      title,
      openid,
      parentRecordId,
      sourceType,
      originalFileID,
      reversedFileID: "",
      originalTempUrl: "",
      reversedTempUrl: "",
      duration,
      status: "processing",
      createdAt: now,
      updatedAt: now,
      errorMessage: ""
    }
  });

  try {
    const downloadRes = await cloud.downloadFile({
      fileID: originalFileID
    });

    if (!downloadRes.fileContent) {
      throw new Error("下载原始音频失败");
    }

    const originalBuffer = Buffer.isBuffer(downloadRes.fileContent)
      ? downloadRes.fileContent
      : Buffer.from(downloadRes.fileContent);
    const reversedBuffer = reverseWavBuffer(originalBuffer);
    const reversedCloudPath = `audio/reversed/${Date.now()}-${Math.random().toString(36).slice(2)}.wav`;

    const uploadRes = await cloud.uploadFile({
      cloudPath: reversedCloudPath,
      fileContent: reversedBuffer
    });

    await collection.doc(addRes._id).update({
      data: {
        reversedFileID: uploadRes.fileID,
        status: "done",
        updatedAt: new Date().toISOString()
      }
    });

    return {
      success: true,
      recordId: addRes._id
    };
  } catch (error) {
    await collection.doc(addRes._id).update({
      data: {
        status: "failed",
        errorMessage: error.message || "音频处理失败",
        updatedAt: new Date().toISOString()
      }
    });

    throw error;
  }
};
