const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_API = "http://103.249.117.229:17227/api/68gb/md5";
const CACHE_TTL_MS = 1200;
const HISTORY_FILE = path.join(__dirname, "history_68gb_md5.json");

let cache = {
  data: null,
  expiresAt: 0,
};

// Lưu lịch sử tích lũy: { phien, sum, sign, dice }
let historyStore = loadHistory();

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      if (Array.isArray(parsed)) return parsed.slice(-300);
    }
  } catch (_) {}
  return [];
}

function saveHistory() {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(historyStore.slice(-300), null, 2),
      "utf8"
    );
  } catch (_) {}
}

function toTX(item) {
  if (typeof item.result === "string") {
    const r = item.result.trim().toLowerCase();
    if (r === "tài" || r === "tai" || r === "t") return "T";
    if (r === "xỉu" || r === "xiu" || r === "x") return "X";
  }
  if (typeof item.sum === "number") {
    return item.sum >= 11 ? "T" : "X";
  }
  return "X";
}

function mergeHistory(incomingList) {
  if (!Array.isArray(incomingList) || incomingList.length === 0) {
    throw new Error("Danh sách phiên trống");
  }

  const map = new Map();
  for (const item of historyStore) {
    if (item && item.phien !== undefined) {
      map.set(Number(item.phien), item);
    }
  }

  for (const raw of incomingList) {
    if (raw && raw.phien !== undefined) {
      const phienNum = Number(raw.phien);
      map.set(phienNum, {
        phien: phienNum,
        sum: typeof raw.sum === "number" ? raw.sum : null,
        dice: raw.dice ?? null,
        sign: toTX(raw),
      });
    }
  }

  historyStore = [...map.values()]
    .sort((a, b) => a.phien - b.phien)
    .slice(-300);

  saveHistory();
  return historyStore;
}

function detectStreakAndCadence(seqArr) {
  // Đếm độ dài chuỗi bệt liên tiếp ở cuối (ví dụ: TTT -> 3)
  const lastChar = seqArr[seqArr.length - 1];
  let streakLen = 1;
  for (let i = seqArr.length - 2; i >= 0; i--) {
    if (seqArr[i] === lastChar) streakLen++;
    else break;
  }

  // Kiểm tra nhịp xen kẽ 1-1 ở 4 phiên cuối (ví dụ: TXTX hoặc XTXT)
  let alternating11 = false;
  if (seqArr.length >= 4) {
    const w4 = seqArr.slice(-4);
    alternating11 =
      w4[0] !== w4[1] && w4[1] !== w4[2] && w4[2] !== w4[3];
  }

  return { lastChar, streakLen, alternating11 };
}

function analyzeBridge(list) {
  const ordered = mergeHistory(list);
  const latest = ordered[ordered.length - 1];
  const predictedSession = Number(latest.phien) + 1;

  const seqArr = ordered.map((x) => x.sign);
  const currentPattern = seqArr.join("");
  const recent12 = seqArr.slice(-12).join("");

  const { lastChar, streakLen, alternating11 } = detectStreakAndCadence(seqArr);

  // 1. Khớp mẫu n-gram trong lịch sử trước phiên cuối (ưu tiên 5 -> 4 -> 3 -> 2)
  const historyBeforeLatest = seqArr.slice(0, -1).join("");
  let nGramScoreT = 0.5;
  let nGramScoreX = 0.5;
  let nGramSummary = "chưa đủ mẫu lặp dài";

  for (const len of [5, 4, 3, 2]) {
    if (seqArr.length <= len) continue;
    const suffix = seqArr.slice(-len).join("");
    let cT = 0;
    let cX = 0;

    for (let i = 0; i <= historyBeforeLatest.length - len - 1; i++) {
      if (historyBeforeLatest.slice(i, i + len) === suffix) {
        const nxt = historyBeforeLatest[i + len];
        if (nxt === "T") cT++;
        else if (nxt === "X") cX++;
      }
    }

    if (cT + cX > 0) {
      nGramScoreT = cT / (cT + cX);
      nGramScoreX = cX / (cT + cX);
      nGramSummary = `mẫu ${suffix} xuất hiện ${cT + cX} lần trước đó (sau đó ra ${cT}T/${cX}X)`;
      break;
    }
  }

  // 2. Phân tích cấu trúc cầu hiện tại (bệt / nhịp 1-1 / tỷ lệ gần nhất)
  let bridgeScoreT = 0.5;
  let bridgeScoreX = 0.5;
  let bridgeSummary = "";

  if (alternating11) {
    // Đang đi nhịp 1-1 -> xu hướng đảo chiều sang mặt đối lập
    const nextOpp = lastChar === "T" ? "X" : "T";
    bridgeScoreT = nextOpp === "T" ? 0.65 : 0.35;
    bridgeScoreX = nextOpp === "X" ? 0.65 : 0.35;
    bridgeSummary = `cầu nhịp 1-1 ở đuôi ${seqArr.slice(-4).join("")}, thiên về đảo sang ${nextOpp}`;
  } else if (streakLen >= 3) {
    // Đang bệt >= 3 -> cân nhắc theo bệt hoặc bẻ cầu nhẹ tùy độ dài bệt
    const followStreak = streakLen <= 4;
    const target = followStreak ? lastChar : lastChar === "T" ? "X" : "T";
    bridgeScoreT = target === "T" ? 0.62 : 0.38;
    bridgeScoreX = target === "X" ? 0.62 : 0.38;
    bridgeSummary = followStreak
      ? `cầu bệt ${lastChar} đang dài ${streakLen} phiên, thiên về bám bệt ${target}`
      : `bệt ${lastChar} đã kéo ${streakLen} phiên, thiên về bẻ sang ${target}`;
  } else {
    const tCount = seqArr.slice(-12).filter((c) => c === "T").length;
    const xCount = seqArr.slice(-12).length - tCount;
    const totalW = Math.max(tCount + xCount, 1);
    bridgeScoreT = tCount / totalW;
    bridgeScoreX = xCount / totalW;
    bridgeSummary = `cầu biến thiên (${tCount}T/${xCount}X trong ${Math.min(
      12,
      seqArr.length
    )} phiên gần nhất)`;
  }

  // Tổng hợp điểm (50% khớp mẫu lịch sử + 50% cấu trúc cầu hiện tại)
  const finalT = nGramScoreT * 0.5 + bridgeScoreT * 0.5;
  const finalX = nGramScoreX * 0.5 + bridgeScoreX * 0.5;

  const prediction = finalT >= finalX ? "T" : "X";
  const top = Math.max(finalT, finalX);
  const sumScore = Math.max(finalT + finalX, 0.0001);

  const confidence = Number(
    Math.min(89, Math.max(51, (top / sumScore) * 100)).toFixed(1)
  );

  const reason = `Kiểm tra ${seqArr.length} phiên (chuỗi gần nhất: ${recent12}): ${nGramSummary}; ${bridgeSummary}.`;

  return {
    phien_du_doan: predictedSession,
    du_doan: prediction,
    do_tin_cay: `${confidence}%`,
    patten: currentPattern,
    ly_do: reason,
  };
}

async function fetchAndPredict() {
  const now = Date.now();
  if (cache.data && cache.expiresAt > now) {
    return cache.data;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(SOURCE_API, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) {
      throw new Error(`API gốc trả về status ${res.status}`);
    }
    const json = await res.json();
    const list = Array.isArray(json) ? json : json.data ?? json.list;
    const result = analyzeBridge(list);

    cache = {
      data: result,
      expiresAt: now + CACHE_TTL_MS,
    };
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/vanhoa", async (req, res) => {
  try {
    const data = await fetchAndPredict();
    res.json(data);
  } catch (err) {
    res.status(502).json({
      error: "Không thể lấy hoặc phân tích dữ liệu từ API gốc",
      detail: err.message,
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    endpoint: "/vanhoa",
    stored_sessions: historyStore.length,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
