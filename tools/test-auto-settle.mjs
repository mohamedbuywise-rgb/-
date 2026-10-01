// اختبار منطق التصفية التلقائية بـ Supabase وهمي. التشغيل: node tools/test-auto-settle.mjs
import fs from 'fs';
const src = fs.readFileSync(new URL('../lib/debts.js', import.meta.url), 'utf8');
const fn = src.match(/export async function autoSettleIfBalanced[\s\S]*?\n}\n/)[0].replace('export ','');
function makeSupabase(db){
  return { from(table){
    const q={ table, filters:[], _insert:null };
    const b={
      select(){return b;}, eq(c,v){q.filters.push([c,v]);return b;}, ilike(c,v){q.filters.push(['ilike:'+c,v]);return b;},
      insert(row){ db.inserted.push({table,row}); return Promise.resolve({error:null}); },
      then(res){ const rows=(db[table]||[]).filter(r=>q.filters.every(([c,v])=>c.startsWith('ilike:')?String(r[c.slice(6)]).toLowerCase()===String(v).toLowerCase():r[c]===v)); return Promise.resolve({data:rows,error:null}).then(res); },
    }; return b; } };
}
async function run(db, person){ const supabase=makeSupabase(db); const f=new Function('supabase','console',fn+';return autoSettleIfBalanced;')(supabase,console); return f(1,person); }
const mk=(o)=>({telegram_user_id:1,commitment_type:'debt',currency_code:'EGP',...o});
let fail=0; const check=(n,c)=>{console.log((c?'PASS':'FAIL'),n); if(!c) fail++;};
// 1) أخدت 500 ورجّعت 500 => تصفية
let db={inserted:[],debts:[mk({person_name:'علي',amount:500,direction:'borrowed',created_at:'2026-09-01T10:00:00Z'}),mk({person_name:'علي',amount:500,direction:'borrowed',is_repayment:true,created_at:'2026-09-02T10:00:00Z'})],debt_settlements:[]};
// الاتنين borrowed هنا بيدّوا -1000؛ نعدّلهم: سلفة 500 ثم سداد = lent 500 بعد الاقتراض
db.debts[1].direction='lent';
check('رصيد صفر => تصفية', await run(db,'علي')===true && db.inserted.length===1 && db.inserted[0].table==='debt_settlements');
// 2) رصيد مش صفر => لا
db={inserted:[],debts:[mk({person_name:'علي',amount:500,direction:'borrowed',created_at:'2026-09-01T10:00:00Z'}),mk({person_name:'علي',amount:200,direction:'lent',created_at:'2026-09-02T10:00:00Z'})],debt_settlements:[]};
check('رصيد 300 => مفيش تصفية', await run(db,'علي')===false && db.inserted.length===0);
// 3) تصفية سابقة بعد آخر عملية => مفيش تكرار
db={inserted:[],debts:[mk({person_name:'علي',amount:500,direction:'borrowed',created_at:'2026-09-01T10:00:00Z'}),mk({person_name:'علي',amount:500,direction:'lent',created_at:'2026-09-02T10:00:00Z'})],debt_settlements:[{telegram_user_id:1,person_name:'علي',settled_at:'2026-09-03T00:00:00Z'}]};
check('متسجلش تصفية مكررة', await run(db,'علي')===false && db.inserted.length===0);
// 4) عملتين: EGP صفر و USD مش صفر => لا
db={inserted:[],debts:[mk({person_name:'علي',amount:500,direction:'borrowed',created_at:'2026-09-01T10:00:00Z'}),mk({person_name:'علي',amount:500,direction:'lent',created_at:'2026-09-02T10:00:00Z'}),mk({person_name:'علي',amount:50,currency_code:'USD',direction:'lent',created_at:'2026-09-02T11:00:00Z'})],debt_settlements:[]};
check('عملة تانية لسه عليها رصيد => لا', await run(db,'علي')===false);
process.exit(fail?1:0);
