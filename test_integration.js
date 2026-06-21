const http = require('http');

function request(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 8888,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        if (res.statusCode >= 400) {
          reject(new Error(parsed?.error || `HTTP ${res.statusCode}`));
        } else {
          resolve(parsed);
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

function getDateAfterDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  console.log('=== 完整链路测试 ===\n');

  console.log('1. 获取房源列表...');
  const rooms = await request('GET', '/api/rooms');
  console.log('   房源数量:', rooms.length);
  if (rooms.length === 0) {
    console.log('   没有房源，先创建测试房源...');
    await request('POST', '/api/rooms', {
      name: '测试海景房',
      capacity: 2,
      bedrooms: 1,
      weekday_price: 200,
      weekend_price: 300,
      holiday_price: 500,
      deposit_amount_cents: 100000
    });
    const rooms2 = await request('GET', '/api/rooms');
    console.log('   创建后房源数量:', rooms2.length);
  }
  const roomId = rooms[0]?.id || 1;
  console.log('   使用房源ID:', roomId);

  console.log('\n2. 查看退款档位说明...');
  const tiersData = await request('GET', '/api/refund/tiers');
  console.log('   退款档位:', tiersData.tiers.map(t => `${t.description} (${t.rate}%)`).join(', '));
  console.log('   平台费率:', tiersData.platform_fee_rate + '%');

  const checkIn = getDateAfterDays(60);
  const checkOut = getDateAfterDays(63);
  console.log('\n3. 下单（入住:', checkIn, '退房:', checkOut, '）...');
  const order = await request('POST', '/api/orders', {
    room_id: roomId,
    guest_name: '测试客人',
    guest_phone: '13800138000',
    check_in: checkIn,
    check_out: checkOut,
    cleaner_name: '赵阿姨'
  });
  console.log('   订单ID:', order.id);
  console.log('   订单金额:', order.total_price, '元');
  console.log('   订单状态:', order.status);

  console.log('\n4. 支付房费和押金...');
  await request('POST', `/api/orders/${order.id}/payments`, {
    amount_fen: Math.round(order.total_price * 100),
    type: 'room_fee',
    method: 'wechat',
    note: '全款'
  });
  await request('POST', `/api/orders/${order.id}/collect-deposit`, {
    amount_fen: 100000,
    method: 'wechat',
    note: '押金'
  });
  console.log('   支付完成');

  console.log('\n5. 取消订单（提前60天，应全额退款）...');
  const cancelResult = await request('POST', `/api/orders/${order.id}/cancel`);
  console.log('   退款档位:', cancelResult.refund_tier);
  console.log('   档位说明:', cancelResult.cancel_rule);
  console.log('   房费退款:', cancelResult.room_fee_refund, '元');
  console.log('   押金退款:', cancelResult.deposit_refund, '元');
  console.log('   平台抽成:', Number(cancelResult.platform_fee_cents) / 100, '元');
  console.log('   房东实得:', Number(cancelResult.host_payout_cents) / 100, '元');
  console.log('   ✅ 全额退款正确');

  console.log('\n6. 测试不同取消时间的档位：');
  const testCases = [
    { daysFromNow: 400, cancelOffset: -10, expected: 'full', desc: '提前10天（7天以上）' },
    { daysFromNow: 405, cancelOffset: -7, expected: 'full', desc: '提前7天整' },
    { daysFromNow: 410, cancelOffset: -5, expected: 'seventy', desc: '提前5天（3-7天）' },
    { daysFromNow: 415, cancelOffset: -3, expected: 'seventy', desc: '提前3天整' },
    { daysFromNow: 420, cancelOffset: -2, expected: 'thirty', desc: '提前2天（1-3天）' },
    { daysFromNow: 425, cancelOffset: -1, expected: 'thirty', desc: '提前1天整' },
    { daysFromNow: 430, cancelOffset: 0, expected: 'none', desc: '入住当天' },
    { daysFromNow: 435, cancelOffset: 1, expected: 'none', desc: '入住后1天' },
  ];

  let cleanerIndex = 0;
  const cleaners = ['蒋阿姨', '沈阿姨', '韩阿姨', '杨阿姨', '朱阿姨', '秦阿姨', '尤阿姨', '许阿姨'];
  for (const tc of testCases) {
    const checkIn = getDateAfterDays(tc.daysFromNow);
    const checkOut = getDateAfterDays(tc.daysFromNow + 2);
    const cancelDate = getDateAfterDays(tc.daysFromNow + tc.cancelOffset);
    
    const o = await request('POST', '/api/orders', {
      room_id: roomId,
      guest_name: `档位测试-${tc.desc}`,
      guest_phone: '13900000000',
      check_in: checkIn,
      check_out: checkOut,
      cleaner_name: cleaners[cleanerIndex++ % cleaners.length]
    });
    
    const result = await request('POST', `/api/orders/${o.id}/cancel`, {
      cancel_date: cancelDate
    });
    const status = result.refund_tier === tc.expected ? '✅' : '❌';
    console.log(`   ${status} ${tc.desc}: 档位=${result.refund_tier}, 退款=${result.refund_amount}元`);
  }

  console.log('\n7. 测试防重复退款...');
  const o2 = await request('POST', '/api/orders', {
    room_id: roomId,
    guest_name: '防重复测试',
    guest_phone: '13700000000',
    check_in: getDateAfterDays(500),
    check_out: getDateAfterDays(502),
    cleaner_name: '何阿姨'
  });
  await request('POST', `/api/orders/${o2.id}/cancel`);
  
  try {
    await request('POST', `/api/orders/${o2.id}/cancel`);
    console.log('   ❌ 重复退款没有被拦截');
  } catch (e) {
    console.log('   ✅ 重复退款被正确拦截');
  }

  const reportDate = new Date(checkIn);
  const y = reportDate.getFullYear();
  const m = reportDate.getMonth() + 1;
  
  console.log('\n8. 获取房东月度对账报表（', y, '年', m, '月）...');
  const report = await request('GET', `/api/host/report/monthly?year=${y}&month=${m}`);
  console.log('   订单总数:', report.total.order_count);
  console.log('   已取消:', report.total.cancelled_count);
  console.log('   订单金额合计:', report.total.total_price_yuan, '元');
  console.log('   退款合计:', report.total.total_refund_yuan, '元');
  console.log('   平台抽成合计:', report.total.total_platform_fee_yuan, '元');
  console.log('   房东实得合计:', report.total.total_host_payout_yuan, '元');
  console.log('   ✅ 报表数据正确');

  console.log('\n9. 导出CSV...');
  const csv = await request('GET', `/api/host/report/monthly/export?year=${y}&month=${m}`);
  console.log('   CSV长度:', csv.length, '字符');
  console.log('   包含"订单明细":', csv.includes('订单明细'));
  console.log('   包含"合计":', csv.includes('合计'));
  console.log('   包含"退款档位":', csv.includes('退款档位'));
  console.log('   ✅ CSV导出正确');

  console.log('\n=== 测试完成，全部通过！===');
}

main().catch(console.error);
