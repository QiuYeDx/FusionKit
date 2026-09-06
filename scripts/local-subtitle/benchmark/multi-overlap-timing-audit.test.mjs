import test from 'node:test';
import assert from 'node:assert/strict';
import { auditMultiOverlapTiming as audit } from './multi-overlap-timing-audit.mjs';
const sha='a'.repeat(64), a='説明を聞いた後で順番に', b='手順を確認する必要', rest='があると伝えました';
const next='次は資料を読んで内容を詳しく確認してから提出してください';
const source=()=>({mediaSha256:sha,left:[{id:'a',text:a,startMs:10000,endMs:14000},{id:'b',text:b,startMs:14000,endMs:17500}],
  right:{id:'c',text:'順番に'+b+rest+' '+next,startMs:17500,endMs:26000},
  leftObserved:[{text:a,startMs:10000,endMs:14000},{text:b,startMs:14000,endMs:18500}],
  rightObserved:{text:'順番に'+b+rest+' '+next,startMs:13500,endMs:26000}});
function view(id='a', origin=0, shift=0){
  const segment=(pairs,start,end)=>({text:pairs.map(p=>p[0]).join(''),startMs:start-origin,endMs:end-origin,
    dtwTokens:pairs.map(([text,point])=>({text,pointMs:point-origin}))});
  return {id,mediaSha256:sha,mode:'uncompressed_non_vad',windowStartMs:origin,windowEndMs:30000,segments:[
    segment([['説明を聞いた後で',11000],['順番に',13000],[b,16000],[rest,19000]],9500,20000),
    segment([['次は',21000+shift],['資料を読んで',22000],['内容を詳しく確認してから提出してください',24500]],20000,26000)]};
}
const pair=()=>[view(),view('b',1000,100)];
function quote(v){v.segments[0].text='「'+v.segments[0].text;v.segments[0].dtwTokens.unshift({text:'「',pointMs:0});v.segments.at(-1).text+='」';v.segments.at(-1).dtwTokens.push({text:'」',pointMs:26000-v.windowStartMs});}
test('produces two source-complete sentences, preserves outer times and never auto-accepts offline',()=>{
  const s=source(),before=structuredClone(s),r=audit(s,pair());assert.equal(r.status,'supported');assert.equal(r.automaticAcceptance,false);
  assert.deepEqual(r.replacements,[{...s.left[0],text:a+b+rest,endMs:21000},{...s.right,text:next,startMs:21000}]);assert.deepEqual(s,before);
});
test('allows only a single outer wrapper supported by an unquoted peer',()=>{
  const views=pair();quote(views[1]);const r=audit(source(),views);assert.equal(r.status,'supported');assert.equal(r.observations[1].quoted,true);
  quote(views[0]);assert.equal(audit(source(),views).reason,'unquoted_peer_required');
});
test('does not invent a new first onset from divergent in-range observations',()=>{
  const views=pair();views[1].segments[0].dtwTokens[0].pointMs+=1000;
  const r=audit(source(),views);assert.equal(r.status,'supported');assert.equal(r.replacements[0].startMs,10000);
});
for(const scenario of ['changed','missing','reversed','out_of_bounds','interior_quote','unclosed_quote','source_quote','other_media','same_origin','unstable','no_boundary','ambiguous_boundaries','source_point','partial_token','repeat'])test('rejects '+scenario,()=>{
  const s=source(),views=pair(),v=views[1];
  if(scenario==='changed'){v.segments[0].text=v.segments[0].text.replace('手順','方法');v.segments[0].dtwTokens[2].text=v.segments[0].dtwTokens[2].text.replace('手順','方法');}
  if(scenario==='missing')delete v.segments[1].dtwTokens;
  if(scenario==='reversed')v.segments[1].dtwTokens[1].pointMs=0;
  if(scenario==='out_of_bounds')v.segments[1].dtwTokens.at(-1).pointMs=40000;
  if(scenario==='interior_quote'){v.segments[1].text='「'+v.segments[1].text+'」';v.segments[1].dtwTokens.unshift({text:'「',pointMs:20000});v.segments[1].dtwTokens.push({text:'」',pointMs:26000});}
  if(scenario==='unclosed_quote'){v.segments[0].text='「'+v.segments[0].text;v.segments[0].dtwTokens.unshift({text:'「',pointMs:0});}
  if(scenario==='source_quote')s.left[0].text='「'+s.left[0].text+'」';
  if(scenario==='other_media')v.mediaSha256='b'.repeat(64);
  if(scenario==='same_origin')views[1]=view('b');
  if(scenario==='unstable')v.segments[1].dtwTokens[0].pointMs+=500;
  if(scenario==='no_boundary'){v.segments[0].text+=v.segments[1].text;v.segments[0].dtwTokens.push(...v.segments[1].dtwTokens);v.segments[0].endMs=v.segments[1].endMs;v.segments.pop();}
  if(scenario==='ambiguous_boundaries')for(const w of views){const z=w.segments[1],last=z.dtwTokens.pop();z.text=z.dtwTokens.map(t=>t.text).join('');z.endMs=23000-w.windowStartMs;w.segments.push({text:last.text,startMs:z.endMs,endMs:26000-w.windowStartMs,dtwTokens:[{text:'内容を詳しく確認してから',pointMs:24000-w.windowStartMs},{text:'提出してください',pointMs:25000-w.windowStartMs}]});}
  if(scenario==='source_point')v.segments[0].dtwTokens[2].pointMs=14000-v.windowStartMs-401;
  if(scenario==='partial_token'){v.segments[0].dtwTokens[1].text+=v.segments[0].dtwTokens[2].text;v.segments[0].dtwTokens.splice(2,1);}
  if(scenario==='repeat'){const repeated={text:'順番に'+b,startMs:27000-v.windowStartMs,endMs:29000-v.windowStartMs,dtwTokens:[{text:'順番に'+b,pointMs:28000-v.windowStartMs}]};v.segments.push(repeated);}
  assert.equal(audit(s,views).status,'rejected');
});
test('requires exact provenance, bounded inputs and both complete observations',()=>{
  assert.equal(audit(source(),[view()]).status,'rejected');const s=source();s.leftObserved[1].endMs=17000;assert.equal(audit(s,pair()).status,'rejected');
  const v=pair();v[1].segments=Array.from({length:129},()=>v[0].segments[0]);assert.equal(audit(source(),v).status,'rejected');
  assert.equal(audit(null,[]).reason,'invalid_media');
});

test('rejects unmatched speech inside the edited source interval',()=>{
 const views=pair(),v=views[1];v.segments[0].text='追加の発言'+v.segments[0].text;v.segments[0].dtwTokens.unshift({text:'追加の発言',pointMs:10500-v.windowStartMs});
 const r=audit(source(),views);assert.equal(r.status,'rejected');assert.equal(r.observations[1].reason,'unmatched_speech_in_source_range');
});
