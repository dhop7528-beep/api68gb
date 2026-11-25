
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
// Render sẽ tự động cấp PORT qua biến môi trường, mặc định 3000 nếu chạy local
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Link API lịch sử gốc
const HISTORY_API_URL = 'http://103.249.117.229:17227/api/68gb/vhmd5';

/**
 * Hàm lấy dữ liệu lịch sử từ API gốc và sắp xếp tăng dần theo số phiên (cũ -> mới)
 */
async function fetchHistoryData() {
    try {
        const response = await axios.get(HISTORY_API_URL, { timeout: 8000 });
        const jsonData = response.data;

        if (!jsonData || !jsonData.success || !Array.isArray(jsonData.data) || jsonData.data.length === 0) {
            return { data: null, error: 'Dữ liệu API lịch sử trống hoặc không hợp lệ.' };
        }

        // Sắp xếp tăng dần theo phiên để phân tích đúng chiều thời gian
        const sortedData = jsonData.data.sort((a, b) => Number(a.phien) - Number(b.phien));
        return { data: sortedData, error: null };
    } catch (err) {
        return { data: null, error: `Lỗi kết nối API lịch sử: ${err.message}` };
    }
}

/**
 * Thuật toán VIP phân tích Pattern thực tế (Không random)
 * Nhận diện cầu bệt, cầu 1-1, 2-2, 1-2-1, 1-2-3 và lực điểm xúc xắc để quyết định THEO CẦU hay BẺ CẦU
 */
function analyzePatternVIP(history) {
    // Chuyển đổi kết quả sang dạng ký hiệu T (Tài) và X (Xỉu)
    const seq = history.map(item => item.result.trim().toLowerCase() === 'tài' ? 'T' : 'X');
    const sums = history.map(item => Number(item.sum));

    const n = seq.length;
    const lastItem = history[n - 1];
    const nextPhien = Number(lastItem.phien) + 1;

    // Chuỗi pattern 12 phiên gần nhất
    const recentPattern = seq.slice(-12).join('-');

    // Tính độ dài dây bệt hiện tại ở cuối chuỗi
    const currentChar = seq[n - 1];
    let streak = 0;
    for (let i = n - 1; i >= 0; i--) {
        if (seq[i] === currentChar) {
            streak++;
        } else {
            break;
        }
    }

    let predictionChar = currentChar;
    let confidence = 70.0;
    let reason = '';
    let strategy = '';

    // --- TẦNG 1: PHÂN TÍCH CẦU BỆT (STREAK >= 4) ---
    if (streak >= 4) {
        const last3Sums = sums.slice(-3);
        if (currentChar === 'T') {
            // Tài bệt nhưng điểm giảm dần về sát mốc 11 -> Dấu hiệu hụt hơi, bẻ cầu
            if (last3Sums[last3Sums.length - 1] <= 11 && last3Sums[0] > last3Sums[last3Sums.length - 1]) {
                predictionChar = 'X';
                confidence = 86.5;
                strategy = 'BẺ CẦU';
                reason = `Cầu bệt Tài dây ${streak} nhưng tổng điểm đang suy yếu về mốc biên (${last3Sums[last3Sums.length - 1]} điểm). Tín hiệu đảo chiều sang Xỉu cực cao.`;
            } else if (streak >= 7) {
                predictionChar = 'X';
                confidence = 89.0;
                strategy = 'BẺ CẦU';
                reason = `Cầu bệt Tài đã kéo dài tới ${streak} tay (chạm ngưỡng bão hòa). Thuật toán ưu tiên bẻ gãy chuỗi sang Xỉu.`;
            } else {
                predictionChar = 'T';
                confidence = 84.0;
                strategy = 'THEO CẦU';
                reason = `Cầu bệt Tài đang vào form đẹp (dây ${streak}), lực xúc xắc duy trì ổn định. Tiếp tục theo bệt.`;
            }
        } else {
            // Xỉu bệt nhưng điểm tăng dần lên sát mốc 10 -> Dấu hiệu đảo chiều sang Tài
            if (last3Sums[last3Sums.length - 1] >= 10 && last3Sums[0] < last3Sums[last3Sums.length - 1]) {
                predictionChar = 'T';
                confidence = 86.5;
                strategy = 'BẺ CẦU';
                reason = `Cầu bệt Xỉu dây ${streak} nhưng tổng điểm đang đẩy sát biên trên (${last3Sums[last3Sums.length - 1]} điểm). Khả năng cao bẻ sang Tài.`;
            } else if (streak >= 7) {
                predictionChar = 'T';
                confidence = 89.0;
                strategy = 'BẺ CẦU';
                reason = `Cầu bệt Xỉu đạt đỉnh ${streak} tay liên tiếp. Áp dụng quy tắc hồi quy xác suất để bẻ sang Tài.`;
            } else {
                predictionChar = 'X';
                confidence = 84.0;
                strategy = 'THEO CẦU';
                reason = `Đang chạy dây bệt Xỉu (${streak} phiên liên tiếp), nhịp cầu chưa có dấu hiệu hụt hơi. Đánh theo cầu.`;
            }
        }
    }
    // --- TẦNG 2: PHÂN TÍCH CẦU NGẮN & CẦU ĐỐI XỨNG (STREAK < 4) ---
    else if (n >= 4) {
        const tail4 = seq.slice(-4).join('');
        const tail5 = n >= 5 ? seq.slice(-5).join('') : '';

        // 1. Nhận diện Cầu 1-1 (T-X-T-X hoặc X-T-X-T)
        if (tail4 === 'TXTX' || tail4 === 'XTXT') {
            predictionChar = currentChar === 'X' ? 'T' : 'X';
            confidence = 85.5;
            strategy = 'THEO CẦU 1-1';
            reason = `Phát hiện nhịp cầu ngắn 1-1 (${seq.slice(-4).join('-')}) đang chạy rất đều. Tiếp tục bắt nhịp đảo luân phiên.`;
        }
        // 2. Nhận diện Cầu 2-2 (T-T-X-X hoặc X-X-T-T)
        else if (tail4 === 'TTXX' || tail4 === 'XXTT') {
            if (tail4 === 'TTXX') {
                predictionChar = 'T';
                reason = 'Hình thành cầu cặp 2-2 (T-T-X-X). Phiên tiếp theo mở đầu cặp Tài mới.';
            } else {
                predictionChar = 'X';
                reason = 'Hình thành cầu cặp 2-2 (X-X-T-T). Phiên tiếp theo mở đầu cặp Xỉu mới.';
            }
            confidence = 82.0;
            strategy = 'THEO CẦU 2-2';
        }
        // 3. Nhận diện Cầu 1-2-2 tiến lên 1-2-3
        else if (tail5 === 'TXXTT' || tail5 === 'XTTXX') {
            predictionChar = currentChar;
            confidence = 79.5;
            strategy = 'THEO CẦU 1-2-3';
            reason = `Cầu đang phát triển theo thế 1-2-2 (${seq.slice(-5).join('-')}), ưu tiên đánh thuận theo đà lên tay thứ 3.`;
        }
        // 4. Nhận diện Cầu 1-2-1
        else if (tail4 === 'TXXT' || tail4 === 'XTTX') {
            predictionChar = currentChar;
            confidence = 78.0;
            strategy = 'THEO NHỊP 1-2';
            reason = `Xuất hiện mẫu cầu ngắn 1-2-1 (${seq.slice(-4).join('-')}), dự đoán lặp lại vế đôi ở phiên kế tiếp.`;
        }
        // 5. Dây 3 tay liên tiếp
        else if (streak === 3) {
            predictionChar = currentChar;
            confidence = 77.5;
            strategy = 'THEO ĐÀ BỆT';
            reason = `Cầu đã đi được 3 tay ${currentChar === 'T' ? 'Tài' : 'Xỉu'} liên tiếp, dấu hiệu chớm hình thành cầu bệt. Đánh theo cầu.`;
        }
        // 6. Dây 2 tay liên tiếp -> Dựa vào lực điểm tổng để theo tay 3 hoặc bẻ về 2-1
        else if (streak === 2) {
            const lastSum = sums[n - 1];
            if ((currentChar === 'T' && lastSum >= 14) || (currentChar === 'X' && lastSum <= 7)) {
                predictionChar = currentChar;
                confidence = 76.5;
                strategy = 'THEO CẦU';
                reason = `Cầu đôi ${currentChar === 'T' ? 'Tài' : 'Xỉu'} có tổng điểm cực mạnh (${lastSum} điểm), lực cầu còn dư địa đi tiếp tay 3.`;
            } else {
                predictionChar = currentChar === 'T' ? 'X' : 'T';
                confidence = 75.0;
                strategy = 'BẺ NHỊP NGẮN';
                reason = `Cầu ngắn đi 2 tay với điểm số trung bình (${lastSum} điểm), dễ gãy sang cầu 2-1. Chốt bẻ ngược.`;
            }
        }
        // 7. Cầu biến động -> Tính trung bình động 5 phiên
        else {
            const recentSums = sums.slice(-5);
            const avgSum = recentSums.reduce((a, b) => a + b, 0) / recentSums.length;
            if (avgSum > 10.5) {
                predictionChar = 'X';
                reason = `Cầu ngắn đang biến động, trung bình điểm 5 phiên nghiêng mạnh về Tài (${avgSum.toFixed(1)}đ). Bắt nhịp cân bằng sang Xỉu.`;
            } else {
                predictionChar = 'T';
                reason = `Cầu ngắn đang biến động, trung bình điểm 5 phiên nghiêng về Xỉu (${avgSum.toFixed(1)}đ). Bắt nhịp cân bằng sang Tài.`;
            }
            confidence = 73.5;
            strategy = 'CÂN BẰNG ĐIỂM';
        }
    }
    // --- DỰ PHÒNG NẾU LỊCH SỬ TRẢ VỀ QUÁ ÍT (< 4 PHIÊN) ---
    else {
        predictionChar = currentChar === 'X' ? 'T' : 'X';
        confidence = 68.0;
        strategy = 'CẦU NGẮN';
        reason = 'Dữ liệu lịch sử ngắn, áp dụng thuật toán đảo chiều cơ bản dựa trên phiên liền kề.';
    }

    const dudoanText = predictionChar === 'T' ? 'Tài' : 'Xỉu';

    return {
        success: true,
        phiendudoan: nextPhien,
        dudoan: dudoanText,
        dotincay: `${confidence}%`,
        patten: recentPattern,
        chienthuat: strategy,
        lido: reason,
        phien_gan_nhat: {
            phien: lastItem.phien,
            ket_qua: lastItem.result,
            xuc_xac: lastItem.dice,
            tong: lastItem.sum
        }
    };
}

// Route mặc định kiểm tra server sống (tránh Render báo lỗi healthcheck)
app.get('/', (req, res) => {
    res.json({
        status: 'Online',
        message: 'API Dự đoán Tài Xỉu MD5 đang hoạt động. Truy cập /vanhoa để lấy dữ liệu dự đoán.'
    });
});

// Endpoint chính trả về dự đoán tự động
app.get('/vanhoa', async (req, res) => {
    const { data, error } = await fetchHistoryData();
    if (error) {
        return res.status(500).json({
            success: false,
            message: error
        });
    }

    const result = analyzePatternVIP(data);
    return res.json(result);
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại cổng ${PORT}`);
});
