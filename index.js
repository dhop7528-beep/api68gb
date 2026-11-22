// ============================================================
//  TÀI XỈU REALTIME - Cloudflare Workers + Durable Objects
// ============================================================

const WSS_URL = 'https://koay56bcni5e0mk.cq.qnwxdhwica.com/';
const MAX_HISTORY = 50;

const SUPERVISOR_INTERVAL_MS   = 15000;
const STALE_OPEN_TIMEOUT_MS    = 60000;
const WATCHDOG_TIMEOUT_MS      = 3 * 60 * 1000;
const RELOGIN_INTERVAL_MS      = 45 * 60 * 1000;
const RECONNECT_MIN_MS         = 5000;
const RECONNECT_MAX_MS         = 120000;
const STABLE_CONNECTION_MS     = 30000;
const MAX_CONSECUTIVE_FAILURES = 10;
const FAILURE_COOLDOWN_MS      = 5 * 60 * 1000;

const HANDSHAKE_HEX   = "010000727b22737973223a7b22706c6174666f726d223a226a732d776562736f636b6574222c22636c69656e744275696c644e756d626572223a22302e302e31222c22636c69656e7456657273696f6e223a223061323134383164373436663932663834323865316236646565623736666561227d7d";
const LOGIN_HEX       = "0400004d01040001080210ca011a40373537626233613938353539346563356133303764333537343666366565626138356432373862336536373634343061626265393239383531316535393537624200";
const JOIN_ROOM_HEX   = "040000250005226d6e6d6473622e6d6e6d64736268616e646c65722e656e74657267616d65726f6f6d";
const JOIN_TX_HEX     = "0400002b0006286d6e7368616962616f2e6d6e7368616962616f68616e646c65722e656e74657267616d65726f6f6d";

const HANDSHAKE_BUF = hexToBytes(HANDSHAKE_HEX);
const HANDSHAKE_ACK_BUF = new Uint8Array([0x02, 0x00, 0x00, 0x00]);
const LOGIN_BUF     = hexToBytes(LOGIN_HEX);
const JOIN_ROOM_BUF = hexToBytes(JOIN_ROOM_HEX);
const JOIN_TX_BUF   = hexToBytes(JOIN_TX_HEX);
const HEARTBEAT_BUF = new Uint8Array([0x03, 0x00, 0x00, 0x00]);

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function calcStats(list, n = 20) {
  const recent = list.slice(0, n);
  let tai = 0, xiu = 0;
  for (const s of recent) {
    if (s.result === 'TÀI') tai++;
    else if (s.result === 'XỈU') xiu++;
  }
  return {
    sampleSize: recent.length, tai, xiu,
    taiPercent: recent.length ? +(tai / recent.length * 100).toFixed(1) : 0,
    xiuPercent: recent.length ? +(xiu / recent.length * 100).toFixed(1) : 0
  };
}
function formatSession(s) {
  const d = (s.dice || '0-0-0').split('-');
  return {
    matchId: Number(s.matchId) || 0,
    dice: s.dice, d1: +d[0], d2: +d[1], d3: +d[2],
    sum: s.sum, result: s.result, md5: s.md5 || null, time: s.time
  };
}

function decodeRawProtobuf(buffer) {
  let offset = 0;
  const result = {};
  function readVarint() {
    let value = 0n, shift = 0n;
    while (offset < buffer.length) {
      const b = buffer[offset++];
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return value;
  }
  while (offset < buffer.length) {
    try {
      const tag = readVarint();
      const wireType = Number(tag & 7n);
      const fieldNumber = Number(tag >> 3n);
      if (wireType === 0) {
        const val = readVarint().toString();
        result[fieldNumber] = result[fieldNumber] ? result[fieldNumber] + ',' + val : val;
      } else if (wireType === 1) {
        offset += 8; result[fieldNumber] = "(64-bit)";
      } else if (wireType === 2) {
        const length = Number(readVarint());
        const data = buffer.slice(offset, offset + length);
        offset += length;
        let text = '';
        for (let i = 0; i < data.length; i++) {
          text += (data[i] >= 32 && data[i] <= 126) ? String.fromCharCode(data[i]) : '.';
        }
        result[fieldNumber] = result[fieldNumber] ? result[fieldNumber] + ' | ' + text : text;
        result[fieldNumber + '_hex'] = bytesToHex(data);
      } else if (wireType === 5) {
        offset += 4; result[fieldNumber] = "(32-bit)";
      } else break;
    } catch { break; }
  }
  return result;
}

function md5Fallback(s) {
  function cmn(q, a, b, x, s, t) {
    a = (((a + q) | 0) + ((x + t) | 0)) | 0;
    return (((a << s) | (a >>> (32 - s))) + b) | 0;
  }
  function ff(a,b,c,d,x,s,t){return cmn((b&c)|((~b)&d),a,b,x,s,t);}
  function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&(~d)),a,b,x,s,t);}
  function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
  function ii(a,b,c,d,x,s,t){return cmn(c^(b|(~d)),a,b,x,s,t);}
  function hex(n){let s='',j;for(j=0;j<=3;j++)s+=((n>>>(j*8+4))&0x0F).toString(16)+((n>>>(j*8))&0x0F).toString(16);return s;}
  function str2blks(str){
    let nblk=((str.length+8)>>6)+1, blks=new Array(nblk*16), i;
    for(i=0;i<nblk*16;i++)blks[i]=0;
    for(i=0;i<str.length;i++)blks[i>>2]|=str.charCodeAt(i)<<((i%4)*8);
    blks[i>>2]|=0x80<<((i%4)*8);
    blks[nblk*16-2]=str.length*8;
    return blks;
  }
  const x=str2blks(unescape(encodeURIComponent(s)));
  let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
  for(let i=0;i<x.length;i+=16){
    const oa=a,ob=b,oc=c,od=d;
    a=ff(a,b,c,d,x[i+0],7,-680876936);d=ff(d,a,b,c,x[i+1],12,-389564586);
    c=ff(c,d,a,b,x[i+2],17,606105819);b=ff(b,c,d,a,x[i+3],22,-1044525330);
    a=ff(a,b,c,d,x[i+4],7,-176418897);d=ff(d,a,b,c,x[i+5],12,1200080426);
    c=ff(c,d,a,b,x[i+6],17,-1473231341);b=ff(b,c,d,a,x[i+7],22,-45705983);
    a=ff(a,b,c,d,x[i+8],7,1770035416);d=ff(d,a,b,c,x[i+9],12,-1958414417);
    c=ff(c,d,a,b,x[i+10],17,-42063);b=ff(b,c,d,a,x[i+11],22,-1990404162);
    a=ff(a,b,c,d,x[i+12],7,1804603682);d=ff(d,a,b,c,x[i+13],12,-40341101);
    c=ff(c,d,a,b,x[i+14],17,-1502002290);b=ff(b,c,d,a,x[i+15],22,1236535329);
    a=gg(a,b,c,d,x[i+1],5,-165796510);d=gg(d,a,b,c,x[i+6],9,-1069501632);
    c=gg(c,d,a,b,x[i+11],14,643717713);b=gg(b,c,d,a,x[i+0],20,-373897302);
    a=gg(a,b,c,d,x[i+5],5,-701558691);d=gg(d,a,b,c,x[i+10],9,38016083);
    c=gg(c,d,a,b,x[i+15],14,-660478335);b=gg(b,c,d,a,x[i+4],20,-405537848);
    a=gg(a,b,c,d,x[i+9],5,568446438);d=gg(d,a,b,c,x[i+14],9,-1019803690);
    c=gg(c,d,a,b,x[i+3],14,-187363961);b=gg(b,c,d,a,x[i+8],20,1163531501);
    a=gg(a,b,c,d,x[i+13],5,-1444681467);d=gg(d,a,b,c,x[i+2],9,-51403784);
    c=gg(c,d,a,b,x[i+7],14,1735328473);b=gg(b,c,d,a,x[i+12],20,-1926607734);
    a=hh(a,b,c,d,x[i+5],4,-378558);d=hh(d,a,b,c,x[i+8],11,-2022574463);
    c=hh(c,d,a,b,x[i+11],16,1839030562);b=hh(b,c,d,a,x[i+14],23,-35309556);
    a=hh(a,b,c,d,x[i+1],4,-1530992060);d=hh(d,a,b,c,x[i+4],11,1272893353);
    c=hh(c,d,a,b,x[i+7],16,-155497632);b=hh(b,c,d,a,x[i+10],23,-1094730640);
    a=hh(a,b,c,d,x[i+13],4,681279174);d=hh(d,a,b,c,x[i+0],11,-358537222);
    c=hh(c,d,a,b,x[i+3],16,-722521979);b=hh(b,c,d,a,x[i+6],23,76029189);
    a=hh(a,b,c,d,x[i+9],4,-640364487);d=hh(d,a,b,c,x[i+12],11,-421815835);
    c=hh(c,d,a,b,x[i+15],16,530742520);b=hh(b,c,d,a,x[i+2],23,-995338651);
    a=ii(a,b,c,d,x[i+0],6,-198630844);d=ii(d,a,b,c,x[i+7],10,1126891415);
    c=ii(c,d,a,b,x[i+14],15,-1416354905);b=ii(b,c,d,a,x[i+5],21,-57434055);
    a=ii(a,b,c,d,x[i+12],6,1700485571);d=ii(d,a,b,c,x[i+3],10,-1894986606);
    c=ii(c,d,a,b,x[i+10],15,-1051523);b=ii(b,c,d,a,x[i+1],21,-2054922799);
    a=ii(a,b,c,d,x[i+8],6,1873313359);d=ii(d,a,b,c,x[i+15],10,-30611744);
    c=ii(c,d,a,b,x[i+6],15,-1560198380);b=ii(b,c,d,a,x[i+13],21,1309151649);
    a=ii(a,b,c,d,x[i+4],6,-145523070);d=ii(d,a,b,c,x[i+11],10,-1120210379);
    c=ii(c,d,a,b,x[i+2],15,718787259);b=ii(b,c,d,a,x[i+9],21,-343485551);
    a=(a+oa)|0;b=(b+ob)|0;c=(c+oc)|0;d=(d+od)|0;
  }
  return hex(a)+hex(b)+hex(c)+hex(d);
}

// Đã nén HTML thành JSON string để chống lỗi font trên điện thoại
const HTML_PAGE = "<!DOCTYPE html>\n<html lang=\"vi\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Tài Xỉu Realtime</title>\n<style>\n  * { box-sizing: border-box; }\n  body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif;\n    background: #0f172a; color: #e2e8f0; padding: 12px; }\n  h1 { text-align: center; font-size: 18px; margin: 0 0 8px; color: #38bdf8; }\n  .api-links { text-align: center; margin-bottom: 12px; font-size: 13px; }\n  .api-links a { color: #38bdf8; text-decoration: none; margin: 0 4px;\n    padding: 4px 10px; border: 1px solid #38bdf8; border-radius: 4px; display: inline-block; margin-bottom: 4px; }\n  .api-links a:hover { background: #38bdf8; color: #0f172a; }\n  .toolbar { text-align: center; margin-bottom: 12px; }\n  .toolbar input { background: #1e293b; border: 1px solid #334155; color: #e2e8f0;\n    padding: 8px 12px; border-radius: 6px; width: 180px; font-size: 14px; }\n  .toolbar button { background: #ef4444; color: white; border: none; padding: 8px 14px;\n    border-radius: 6px; cursor: pointer; margin-left: 6px; font-size: 14px; }\n  .status { text-align: center; margin-bottom: 12px; font-size: 12px; color: #94a3b8; }\n  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;\n    background: #22c55e; margin-right: 6px; animation: pulse 1.5s infinite; }\n  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }\n  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-width: 1400px; margin: 0 auto; }\n  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }\n  .panel { background: #1e293b; border-radius: 10px; overflow: hidden; border: 1px solid #334155; }\n  .panel h2 { margin: 0; padding: 10px; font-size: 14px; text-align: center; color: white; letter-spacing: 1px; }\n  .panel.md5 h2 { background: #8b5cf6; }\n  .panel.tx h2 { background: #f59e0b; }\n  .stats { display: flex; gap: 8px; padding: 8px 10px; background: #0f172a; font-size: 12px; }\n  .stats .item { flex: 1; text-align: center; padding: 4px; border-radius: 4px; background: #1e293b; }\n  .stats .item b { display: block; font-size: 14px; margin-top: 2px; }\n  .stats .tai b { color: #22c55e; }\n  .stats .xiu b { color: #ef4444; }\n  table { width: 100%; border-collapse: collapse; font-size: 13px; }\n  td { padding: 8px; border-top: 1px solid #334155; }\n  tr.start td { color: #94a3b8; font-style: italic; }\n  tr.end.tai td { background: rgba(34,197,94,.10); }\n  tr.end.xiu td { background: rgba(239,68,68,.10); }\n  .tai { color: #22c55e; font-weight: bold; }\n  .xiu { color: #ef4444; font-weight: bold; }\n  .md5hash { font-family: monospace; font-size: 11px; color: #94a3b8; word-break: break-all; }\n  .dice { display: inline-block; background: #334155; border-radius: 4px; padding: 2px 6px;\n    font-family: monospace; font-weight: bold; margin-right: 2px; }\n  .empty { text-align: center; padding: 30px; color: #64748b; font-style: italic; }\n</style>\n</head>\n<body>\n  <h1>🎲 TÀI XỈU REALTIME (Cloudflare)</h1>\n  <div class=\"api-links\">\n    <a href=\"/api/md5\" target=\"_blank\">/api/md5</a>\n    <a href=\"/api/tx\" target=\"_blank\">/api/tx</a>\n    <a href=\"/api/all\" target=\"_blank\">/api/all</a>\n    <a href=\"/api/signal\" target=\"_blank\">/api/signal</a>\n    <a href=\"/api/status\" target=\"_blank\">/api/status</a>\n  </div>\n  <div class=\"toolbar\">\n    <input id=\"search\" placeholder=\"Tìm mã phiên...\">\n    <button onclick=\"clearAll()\">🗑 Clear</button>\n  </div>\n  <div class=\"status\"><span class=\"dot\"></span><span id=\"conn\">Đang kết nối...</span>\n    | MD5: <b id=\"countMd5\">0</b> | Thường: <b id=\"countTx\">0</b></div>\n\n  <div class=\"grid\">\n    <div class=\"panel md5\">\n      <h2>🔮 TÀI XỈU MD5</h2>\n      <div class=\"stats\" id=\"statsMd5\">\n        <div class=\"item tai\">TÀI<b>-</b></div>\n        <div class=\"item xiu\">XỈU<b>-</b></div>\n        <div class=\"item\">Tỷ lệ<b>-</b></div>\n      </div>\n      <div style=\"max-height: 70vh; overflow-y: auto;\">\n        <table><tbody id=\"bodyMd5\"><tr><td class=\"empty\">Chưa có dữ liệu...</td></tr></tbody></table>\n      </div>\n    </div>\n    <div class=\"panel tx\">\n      <h2>💰 TÀI XỈU THƯỜNG</h2>\n      <div class=\"stats\" id=\"statsTx\">\n        <div class=\"item tai\">TÀI<b>-</b></div>\n        <div class=\"item xiu\">XỈU<b>-</b></div>\n        <div class=\"item\">Tỷ lệ<b>-</b></div>\n      </div>\n      <div style=\"max-height: 70vh; overflow-y: auto;\">\n        <table><tbody id=\"bodyTx\"><tr><td class=\"empty\">Chưa có dữ liệu...</td></tr></tbody></table>\n      </div>\n    </div>\n  </div>\n\n<script>\n  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';\n  let ws;\n  const rows = { md5: [], tx: [] };\n\n  function connectWs() {\n    ws = new WebSocket(proto + '//' + location.host + '/ws');\n    ws.onopen = () => document.getElementById('conn').textContent = 'Đang nhận realtime';\n    ws.onclose = () => {\n      document.getElementById('conn').textContent = 'Mất kết nối, thử lại...';\n      setTimeout(connectWs, 3000);\n    };\n    ws.onmessage = (ev) => {\n      const msg = JSON.parse(ev.data);\n      if (msg.event === 'init') {\n        rows.md5 = msg.md5 || [];\n        rows.tx = msg.tx || [];\n        render('md5'); render('tx');\n        updateStats('md5'); updateStats('tx');\n      } else if (msg.event === 'result') {\n        const type = msg.type;\n        rows[type].unshift(msg.data);\n        if (rows[type].length > 50) rows[type].pop();\n        render(type);\n        updateStats(type);\n      }\n    };\n  }\n  connectWs();\n\n  function updateStats(type) {\n    const done = rows[type].filter(r => r.result).slice(0, 20);\n    let tai = 0, xiu = 0;\n    for (const s of done) {\n      if (s.result === 'TÀI') tai++;\n      else if (s.result === 'XỈU') xiu++;\n    }\n    const total = done.length;\n    const el = document.getElementById(type === 'md5' ? 'statsMd5' : 'statsTx');\n    el.querySelector('.tai b').textContent = tai;\n    el.querySelector('.xiu b').textContent = xiu;\n    el.querySelectorAll('.item b')[2].textContent =\n      total ? tai + '/' + xiu + ' (' + (tai/total*100).toFixed(0) + '% T)' : '-';\n  }\n\n  function render(type) {\n    const tbody = document.getElementById(type === 'md5' ? 'bodyMd5' : 'bodyTx');\n    const filter = document.getElementById('search').value.trim();\n    const list = filter ? rows[type].filter(r => String(r.matchId).includes(filter)) : rows[type];\n    document.getElementById(type === 'md5' ? 'countMd5' : 'countTx').textContent = rows[type].length;\n    if (list.length === 0) {\n      tbody.innerHTML = '<tr><td class=\"empty\">Chưa có dữ liệu...</td></tr>';\n      return;\n    }\n    tbody.innerHTML = list.map(r => {\n      if (!r.result) {\n        return '<tr class=\"start\"><td>#' + r.matchId + '</td><td>BẮT ĐẦU</td>' +\n          '<td colspan=\"3\">' + (r.md5 ? 'MD5: ' + r.md5.substring(0,20) + '...' : 'Đang chờ kết quả...') + '</td></tr>';\n      }\n      const cls = r.result === 'TÀI' ? 'tai' : 'xiu';\n      const d = (r.dice || '0-0-0').split('-');\n      return '<tr class=\"end ' + cls + '\">' +\n        '<td><b>#' + r.matchId + '</b></td>' +\n        '<td><span class=\"dice\">' + d[0] + '</span><span class=\"dice\">' + d[1] + '</span><span class=\"dice\">' + d[2] + '</span></td>' +\n        '<td>' + r.sum + '</td>' +\n        '<td class=\"' + cls + '\">' + r.result + '</td>' +\n        '<td class=\"md5hash\">' + (r.md5 ? r.md5.substring(0,16) + '...' : '') + '</td></tr>';\n    }).join('');\n  }\n\n  document.getElementById('search').addEventListener('input', () => { render('md5'); render('tx'); });\n  function clearAll() { rows.md5 = []; rows.tx = []; render('md5'); render('tx'); }\n</script>\n</body>\n</html>";

export default {
  async fetch(request, env) {
    const id = env.TAIXIU.idFromName('singleton');
    const stub = env.TAIXIU.get(id);
    return stub.fetch(request);
  }
};

export class TaiXiuDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = { md5: [], tx: [] };
    this.pending  = { md5: null, tx: null };
    this.clients = new Set();
    this.gameWs  = null;
    this.sessionSeq = 0;
    this.lastMessageAt = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastLoginAt = null;
    this.lastHeartbeatAt = null;
    this.reconnectAttempts = 0;
    this.consecutiveFailures = 0;
    this.totalReconnects = 0;
    this.cooldownUntil = 0;
    this.currentMd5MatchId = '???';
    this.currentTxMatchId  = '???';
    this.currentReqId = 6;
    this.startedAt = Date.now();

    this.state.blockConcurrencyWhile(async () => {
      this.sessions.md5 = (await this.state.storage.get('md5')) || [];
      this.sessions.tx  = (await this.state.storage.get('tx'))  || [];
      this.pending.md5  = (await this.state.storage.get('pending_md5')) || null;
      this.pending.tx   = (await this.state.storage.get('pending_tx'))  || null;
      this.currentMd5MatchId = (await this.state.storage.get('cur_md5')) || '???';
      this.currentTxMatchId  = (await this.state.storage.get('cur_tx'))  || '???';

      await this.connectGame();
      await this.state.storage.setAlarm(Date.now() + SUPERVISOR_INTERVAL_MS);
    });
  }

  async alarm() {
    const now = Date.now();
    try {
      if (!this.gameWs) {
        await this.scheduleReconnect(0);
        return;
      }
      if (this.lastMessageAt && now - this.lastMessageAt > STALE_OPEN_TIMEOUT_MS) {
        this.forceCloseGame();
        await this.scheduleReconnect(0);
        return;
      }
      if (this.lastMessageAt && now - this.lastMessageAt > WATCHDOG_TIMEOUT_MS) {
        this.forceCloseGame();
        await this.scheduleReconnect(0);
        return;
      }
      if (this.lastLoginAt && now - this.lastLoginAt > RELOGIN_INTERVAL_MS) {
        this.sendToGame(LOGIN_BUF);
        this.lastLoginAt = now;
      }
      if (this.lastHeartbeatAt === null || now - this.lastHeartbeatAt >= 10000) {
        this.sendToGame(HEARTBEAT_BUF);
        this.lastHeartbeatAt = now;
      }
    } catch (e) {
      console.error('alarm error:', e.message);
    } finally {
      await this.state.storage.setAlarm(Date.now() + SUPERVISOR_INTERVAL_MS);
    }
  }

  async connectGame() {
    this.sessionSeq++;
    const seq = this.sessionSeq;
    this.lastConnectedAt = Date.now();
    this.lastMessageAt = Date.now();

    try {
      const res = await fetch(WSS_URL, { headers: { 'Upgrade': 'websocket' } });
      const ws = res.webSocket;
      if (!ws) throw new Error('No webSocket');
      ws.accept();

      this.gameWs = ws;

      ws.addEventListener('message', (ev) => {
        if (seq !== this.sessionSeq) return;
        this.lastMessageAt = Date.now();
        try { this.handleGameMessage(ev.data, seq); } catch (e) {}
      });

      ws.addEventListener('close', () => {
        if (seq !== this.sessionSeq) return;
        const lived = Date.now() - this.lastConnectedAt;
        this.lastDisconnectedAt = Date.now();
        this.gameWs = null;
        this.lastHeartbeatAt = null;
        if (lived > STABLE_CONNECTION_MS) {
          this.reconnectAttempts = 0;
          this.consecutiveFailures = 0;
        } else {
          this.consecutiveFailures++;
        }
        this.scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        try { ws.close(); } catch {}
      });

      this.sendToGame(HANDSHAKE_BUF);
    } catch (e) {
      this.gameWs = null;
      this.consecutiveFailures++;
      this.scheduleReconnect();
    }
  }

  sendToGame(buf) {
    if (!this.gameWs) return false;
    try { this.gameWs.send(buf); return true; } catch (e) { return false; }
  }

  forceCloseGame() {
    if (this.gameWs) {
      try { this.gameWs.close(); } catch {}
      this.gameWs = null;
    }
  }

  async scheduleReconnect(minDelay = null) {
    const now = Date.now();
    if (this.cooldownUntil > now) {
      await this.state.storage.setAlarm(this.cooldownUntil);
      return;
    }
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.cooldownUntil = now + FAILURE_COOLDOWN_MS;
      this.consecutiveFailures = 0;
      await this.state.storage.setAlarm(this.cooldownUntil);
      return;
    }
    const base = Math.min(RECONNECT_MIN_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
    const jitter = Math.floor(Math.random() * 3000);
    const delay = minDelay !== null ? minDelay : base + jitter;
    this.reconnectAttempts++;
    this.totalReconnects++;
    await this.state.storage.setAlarm(Date.now() + delay);
  }

  async handleGameMessage(raw, seq) {
    if (seq !== this.sessionSeq) return;
    let data;
    if (raw instanceof ArrayBuffer) data = new Uint8Array(raw);
    else if (raw instanceof Uint8Array) data = raw;
    else return;
    if (data.length === 0) return;

    const type = data[0];
    if (type === 1) {
      this.sendToGame(HANDSHAKE_ACK_BUF);
      this.sendToGame(LOGIN_BUF);
      this.lastLoginAt = Date.now();
      setTimeout(() => this.sendToGame(JOIN_ROOM_BUF), 1500);
      setTimeout(() => this.sendToGame(JOIN_TX_BUF), 3000);
      return;
    }
    if (type !== 4) return;

    const payload = data.slice(4);
    if (payload.length === 0) return;

    let offset = 0;
    const flag = payload[offset++];
    const msgType = (flag >> 1) & 0x07;
    const compressRoute = flag & 0x01;

    if (msgType === 0 || msgType === 2) {
      let m = 0;
      do { m = payload[offset++]; } while (m >= 128);
    }

    let route = '';
    if (msgType === 0 || msgType === 1 || msgType === 3) {
      if (compressRoute) {
        route = 'RouteCode_' + ((payload[offset] << 8) | payload[offset + 1]);
        offset += 2;
      } else {
        const routeLen = payload[offset++];
        route = new TextDecoder().decode(payload.slice(offset, offset + routeLen));
        offset += routeLen;
      }
    }

    if (!route || route === 'broadhallmessage' || route === 'mnsbuserbet' || route === 'mnmdsbuserbet') return;

    const protobufData = payload.slice(offset);
    const decoded = decodeRawProtobuf(protobufData);

    for (const key in decoded) {
      const value = decoded[key];

      if (route === 'mnmdsbgamestart' && key === '2') {
        this.currentMd5MatchId = decoded[1] ? (Number(decoded[1]) / 2) : '???';
        await this.savePending('md5', { matchId: this.currentMd5MatchId, md5: value, time: Date.now() });
        await this.state.storage.put('cur_md5', this.currentMd5MatchId);
        continue;
      }

      if (route.includes('mnmdsb') && typeof value === 'string' && value.includes('{') && value.includes('}')) {
        const matchId = this.currentMd5MatchId;
        const md5hash = md5Fallback(value);
        const m = value.match(/\{(\d+-\d+-\d+)\}/);
        if (m) {
          const dice = m[1].split('-');
          const sum = parseInt(dice[0]) + parseInt(dice[1]) + parseInt(dice[2]);
          const tx = sum >= 11 ? 'TÀI' : 'XỈU';
          await this.saveEnd('md5', { matchId, dice: m[1], sum, result: tx, md5: md5hash, time: Date.now() });
        }
      }

      if (route === 'mnsbgamestart') {
        const nextId = this.currentTxMatchId !== '???' ? Number(this.currentTxMatchId) + 1 : '???';
        await this.savePending('tx', { matchId: nextId, time: Date.now() });
        break;
      }

      if (route === 'mnsbgameend' && key === '1_hex') {
        if (value.length === 6) {
          const matchId = decoded[5] || '???';
          this.currentTxMatchId = matchId;
          const d1 = parseInt(value.substring(0, 2), 16) / 2;
          const d2 = parseInt(value.substring(2, 4), 16) / 2;
          const d3 = parseInt(value.substring(4, 6), 16) / 2;
          const sum = d1 + d2 + d3;
          const tx = sum >= 11 ? 'TÀI' : 'XỈU';
          await this.saveEnd('tx', { matchId, dice: `${d1}-${d2}-${d3}`, sum, result: tx, md5: null, time: Date.now() });
          await this.state.storage.put('cur_tx', matchId);
        }
      }
    }

    if (route.endsWith('gameend')) {
      setTimeout(() => {
        if (seq !== this.sessionSeq) return;
        this.currentReqId++;
        if (this.currentReqId > 127) this.currentReqId = 5;
        if (route.includes('mnmdsb')) {
          JOIN_ROOM_BUF[5] = this.currentReqId;
          this.sendToGame(JOIN_ROOM_BUF);
        } else {
          JOIN_TX_BUF[5] = this.currentReqId;
          this.sendToGame(JOIN_TX_BUF);
        }
      }, 2000);
    }
  }

  async savePending(type, data) {
    this.pending[type] = data;
    await this.state.storage.put(`pending_${type}`, data);
    this.broadcast({ event: 'result', type, data: { status: 'START', ...data } });
  }

  async saveEnd(type, data) {
    this.sessions[type].unshift(data);
    if (this.sessions[type].length > MAX_HISTORY) this.sessions[type].pop();
    this.pending[type] = null;
    await this.state.storage.put(type, this.sessions[type]);
    await this.state.storage.put(`pending_${type}`, null);
    this.broadcast({ event: 'result', type, data: { status: 'END', ...data } });
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const c of this.clients) {
      try { c.send(msg); } catch {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.clients.add(server);

      server.addEventListener('close', () => this.clients.delete(server));
      server.addEventListener('error', () => this.clients.delete(server));

      server.send(JSON.stringify({
        event: 'init',
        md5: this.sessions.md5.slice(0, MAX_HISTORY),
        tx:  this.sessions.tx.slice(0, MAX_HISTORY)
      }));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    }

    if (url.pathname === '/api/status') {
      const now = Date.now();
      return Response.json({
        ok: true,
        wsState: this.gameWs ? 1 : 0,
        wsStateText: this.gameWs ? 'OPEN' : 'CLOSED',
        totalReconnects: this.totalReconnects,
        lastMessageAgoSec: this.lastMessageAt ? Math.floor((now - this.lastMessageAt) / 1000) : null,
        clients: this.clients.size,
        stats: { md5: this.sessions.md5.length, tx: this.sessions.tx.length }
      });
    }

    if (url.pathname === '/api/md5' || url.pathname === '/api/tx') {
      const type = url.pathname === '/api/md5' ? 'md5' : 'tx';
      return Response.json({
        ok: true, table: type,
        pending: this.pending[type],
        latest: this.sessions[type][0] ? formatSession(this.sessions[type][0]) : null,
        stats: calcStats(this.sessions[type], 20),
        data: this.sessions[type].slice(0, MAX_HISTORY).map(formatSession)
      });
    }

    return new Response('Not found', { status: 404 });
  }
                                        
