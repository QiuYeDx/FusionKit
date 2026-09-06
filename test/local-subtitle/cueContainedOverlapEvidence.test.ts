import { expect, it } from 'vitest';
import { inspectContainedOverlapSource as sourceCheck, inspectContainedOverlapTiming as inspect } from '../../electron/main/local-subtitle/cue-contained-overlap-evidence';
const prefix='こちらの図書館にいるけど',middle='その人は資料を持っていて',following='静かな場所で本を読んでいるよ';
function fixture(){
 const cues=[{id:'a',text:prefix+middle+'明日は',startMs:96170,endMs:102500},{id:'b',text:middle,startMs:102500,endMs:104150},{id:'c',text:following,startMs:104150,endMs:109930}] as const;
 const source={sourceIdentity:'normalized',cues:[...cues] as [typeof cues[0],typeof cues[1],typeof cues[2]],observed:[{...cues[0],endMs:105020},{...cues[1],startMs:100770},{...cues[2]}] as const,leftWindowEndMs:105000};
 const view=(id:string,origin:number,delta:number)=>({id,sourceIdentity:'normalized',mode:'uncompressed_non_vad' as const,windowStartMs:origin,windowEndMs:origin+20000,segments:[prefix,middle,following].map((text,i)=>({id:i,text,startMs:[95000,99000,104000][i]-origin,endMs:[99000,104000,111000][i]-origin,temperature:0,averageLogProbability:-.1,noSpeechProbability:.01,dtwTokens:Array.from(text).map((text,j)=>({text,pointMs:[96500,100860+delta,104740+delta][i]+j*150-origin}))}))});
 return {source,views:[view('a',95000,0),view('b',94000,40)]};
}
it('qualifies complete correspondence without any manual label',()=>{const f=fixture(),before=structuredClone(f),r=inspect(f.source,f.views);expect(r.status).toBe('supported');if(r.status==='supported')expect(r.replacements.map(s=>[s.text,s.startMs,s.endMs])).toEqual([[prefix,96170,100860],[middle,100860,104740],[following,104740,109930]]);expect(f).toEqual(before);});
it.each(['tail','edge','owner','source_text','duplicate','quote','short_prefix'])('rejects unsupported source: %s',scenario=>{const f=fixture(),s=f.source;
 if(scenario==='tail'){s.cues[0].text+='あいうえお';s.observed[0].text=s.cues[0].text;}
 if(scenario==='edge')s.leftWindowEndMs+=200;
 if(scenario==='owner')s.cues[0].endMs--;
 if(scenario==='source_text')s.observed[0].text+='違う';
 if(scenario==='duplicate'){s.cues[0].text=prefix+middle+middle+'明日は';s.observed[0].text=s.cues[0].text;}
 if(scenario==='quote'){s.cues[0].text='「'+s.cues[0].text;s.observed[0].text=s.cues[0].text;}
 if(scenario==='short_prefix'){s.cues[0].text='けど'+middle+'明日は';s.observed[0].text=s.cues[0].text;}
 expect(sourceCheck(s).status).toBe('rejected');});
it.each(['missing','reverse','outside','drift','insert','repeat','extra','following_edit','both_middle_edit','prefix_disagreement','no_sentence','unmatched_speech','far_source'])('rejects adverse observation: %s',scenario=>{const f=fixture(),v=f.views[1],s=v.segments[1];
 if(scenario==='missing')s.dtwTokens=[];
 if(scenario==='reverse')s.dtwTokens[1].pointMs=1;
 if(scenario==='outside')v.segments[2].dtwTokens.at(-1)!.pointMs=99999;
 if(scenario==='drift')s.dtwTokens.forEach(t=>t.pointMs+=400);
 if(scenario==='insert'){s.text='あ'+s.text;s.dtwTokens.unshift({text:'あ',pointMs:s.dtwTokens[0].pointMs});}
 if(scenario==='repeat'){s.text+=s.text;s.dtwTokens.push(...s.dtwTokens.map(t=>({...t,pointMs:s.dtwTokens.at(-1)!.pointMs})));}
 if(scenario==='extra'){const last=v.segments[2];last.text+='明日は';last.dtwTokens.push({text:'明日は',pointMs:16000});}
 if(scenario==='following_edit'){v.segments[2].text='騒'+following.slice(1);v.segments[2].dtwTokens[0].text='騒';}
 if(scenario==='both_middle_edit')for(const v of f.views){v.segments[1].dtwTokens[7].text='図';v.segments[1].text=v.segments[1].dtwTokens.map(t=>t.text).join('');}
 if(scenario==='prefix_disagreement'){v.segments[0].dtwTokens[0].text='あ';v.segments[0].text=v.segments[0].dtwTokens.map(t=>t.text).join('');}
 if(scenario==='no_sentence'){v.segments[0].text+=s.text;v.segments[0].dtwTokens.push(...s.dtwTokens);v.segments[0].endMs=s.endMs;v.segments.splice(1,1);}
 if(scenario==='unmatched_speech'){const first=v.segments[0];first.text='あ'+first.text;first.dtwTokens.unshift({text:'あ',pointMs:2200});}
 if(scenario==='far_source')v.segments[2].dtwTokens.forEach(t=>t.pointMs+=2000);
 expect(inspect(f.source,f.views).status).toBe('rejected');});
it('retains limited lexical variants in evidence and keeps original output',()=>{const f=fixture();for(const v of f.views){v.segments[0].dtwTokens[0].text='あ';v.segments[0].text=v.segments[0].dtwTokens.map(t=>t.text).join('');}const s=f.views[1].segments[1];s.dtwTokens[7].text='図';s.text=s.dtwTokens.map(t=>t.text).join('');const r=inspect(f.source,f.views);expect(r.status).toBe('supported');if(r.status==='supported'){expect(r.replacements[0].text).toBe(prefix);expect(r.replacements[1].text).toBe(middle);expect(r.observations[1].differences).toHaveLength(2);}});
it('requires two distinct origins and exact identity',()=>{const f=fixture();expect(inspect(f.source,[f.views[0]]).status).toBe('rejected');f.views[1].sourceIdentity='different';expect(inspect(f.source,f.views).status).toBe('rejected');f.views[1]=structuredClone(f.views[0]);f.views[1].id='different';expect(inspect(f.source,f.views).status).toBe('rejected');});
