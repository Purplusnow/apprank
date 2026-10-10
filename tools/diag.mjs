import gplay from 'google-play-scraper';
const g = gplay.default ?? gplay;
const cases = [
  ['kr','GAME_SPORTS','TOP_PAID'], ['tw','GAME_PUZZLE','TOP_PAID'],
  ['ru','GAME','TOP_PAID'], ['ru','GAME','GROSSING'], ['ru','GAME','TOP_FREE'],
  ['kr','GAME','TOP_PAID'], ['us','GAME_SPORTS','TOP_PAID'],
];
for (const [country,cat,coll] of cases){
  try{
    const r = await g.list({collection:g.collection[coll], category:g.category[cat], country, lang:'en', num:200});
    console.log(`✅ ${country}/${cat}/${coll} -> ${r.length}건  (1위: ${r[0]?.title ?? '-'})`);
  }catch(e){
    console.log(`❌ ${country}/${cat}/${coll} -> ${e.message.slice(0,55)}`);
  }
}
