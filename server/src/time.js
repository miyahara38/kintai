'use strict';
// 日時はすべて日本時間(Asia/Tokyo)で扱う。サーバーPCの設定に左右されないよう Intl を使う。
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function parts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
const jstDate = ms => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const jstTime = ms => { const p = parts(ms); return `${p.hour}:${p.minute}`; };
const jstDateTime = ms => { const p = parts(ms); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };
const jstMinutes = ms => { const p = parts(ms); return Number(p.hour) * 60 + Number(p.minute); };

module.exports = { jstDate, jstTime, jstDateTime, jstMinutes };
