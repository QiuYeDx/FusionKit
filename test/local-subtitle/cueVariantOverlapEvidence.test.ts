import {expect,it} from 'vitest';import {inspectVariantOverlapSource as sourceCheck,inspectVariantOverlapTiming as inspect} from '../../electron/main/local-subtitle/cue-variant-overlap-evidence';
const prefix='説明が終わって安心したわね',parts=['次の資料を読んだ','後で静かな部屋に','ミナミを呼んでから','詳しい話を聞いているわ'];
function fixture(){const left={id:'a',text:prefix+' 次の資料を読んで',startMs:143440,endMs:152500},right=parts.map((text,i)=>({id:'r'+i,text,startMs:[152500,155180,157480,161080][i],endMs:[155180,157480,161080,164820][i]}));const source={sourceIdentity:'pcm',left,right,leftObserved:{...left,endMs:155020},rightObserved:right.map((s,i)=>({...s,startMs:i?s.startMs:151840})),leftWindowEndMs:155000};const view=(id:string,origin:number,shift:number)=>({id,sourceIdentity:'pcm',mode:'uncompressed_non_vad' as const,windowStartMs:origin,windowEndMs:origin+30000,segments:[prefix,parts.join('')].map((text,i)=>({id:i,text,startMs:[140000,153180][i]-origin,endMs:[153180,169000][i]-origin,temperature:0,averageLogProbability:-.1,noSpeechProbability:.01,dtwTokens:Array.from(text).map((text,j)=>({text,pointMs:(i?153360+shift:144800)+j*(i?200:300)-origin}))}))});return {source,views:[view('a',140000,0),view('b',139000,20)]};}
it('selects the original complete right sentence with a shared onset',()=>{const f=fixture(),copy=structuredClone(f),r=inspect(f.source,f.views);expect(r.status).toBe('supported');if(r.status==='supported')expect(r.replacements.map(s=>[s.text,s.startMs,s.endMs])).toEqual([[prefix,143440,153360],[parts.join(''),153360,164820]]);expect(f).toEqual(copy);});
it.each(['same','internal','edge','owner','source_text','repeat','no_sentence_end','too_long','quote','skipped'])('rejects invalid source: %s',kind=>{const f=fixture(),s=f.source;
 if(kind==='same'){s.left.text=prefix+' '+parts[0];s.leftObserved.text=s.left.text;}
 if(kind==='internal'){s.right[0].text='次の書類を読んだ';s.rightObserved[0].text=s.right[0].text;}
 if(kind==='edge')s.leftWindowEndMs-=200;
 if(kind==='owner')s.right[0].startMs++;
 if(kind==='source_text')s.leftObserved.text+='よ';
 if(kind==='repeat'){s.left.text=parts[0]+s.left.text;s.leftObserved.text=s.left.text;}
 if(kind==='no_sentence_end'){s.right.at(-1)!.text='話の続きについて';s.rightObserved.at(-1)!.text=s.right.at(-1)!.text;}
 if(kind==='too_long'){s.right.at(-1)!.endMs=180000;s.rightObserved.at(-1)!.endMs=180000;}
 if(kind==='quote')s.left.text='「'+s.left.text+'」';
 if(kind==='skipped')(s as any).skipped={text:'別の発言だった',startMs:150000,endMs:151000};
 expect(sourceCheck(s).status).toBe('rejected');});
it.each(['missing','reverse','outside','drift','insert','repeat','old_variant','protected_edit','both_edit','large_edit','numeric_edit','no_boundary','unmatched','far_point','partial'])('rejects adverse observation: %s',kind=>{const f=fixture(),v=f.views[1],s=v.segments[1];
 const edit=(segment:typeof s,at:number,text:string)=>{segment.dtwTokens[at].text=text;segment.text=segment.dtwTokens.map(t=>t.text).join('');};
 if(kind==='missing')s.dtwTokens=[];
 if(kind==='reverse')s.dtwTokens[1].pointMs=1;
 if(kind==='outside')s.dtwTokens.at(-1)!.pointMs=99999;
 if(kind==='drift')s.dtwTokens.forEach(t=>t.pointMs+=500);
 if(kind==='insert'){s.text='あ'+s.text;s.dtwTokens.unshift({text:'あ',pointMs:s.dtwTokens[0].pointMs});}
 if(kind==='repeat'){s.text+=s.text;s.dtwTokens.push(...s.dtwTokens.map(t=>({...t,pointMs:s.dtwTokens.at(-1)!.pointMs})));}
 if(kind==='old_variant')edit(s,parts[0].length-1,'で');
 if(kind==='protected_edit')edit(s,3,'書');
 if(kind==='both_edit')for(const v of f.views)edit(v.segments[0],3,'始');
 if(kind==='large_edit')for(const at of [1,2,3])edit(v.segments[0],at,'別');
 if(kind==='numeric_edit')edit(v.segments[0],3,'9');
 if(kind==='no_boundary'){v.segments[0].text+=s.text;v.segments[0].dtwTokens.push(...s.dtwTokens);v.segments[0].endMs=s.endMs;v.segments.pop();}
 if(kind==='unmatched'){const p=v.segments[0];p.text='あ'+p.text;p.dtwTokens.unshift({text:'あ',pointMs:5500});}
 if(kind==='far_point')s.dtwTokens.at(-1)!.pointMs=27000;
 if(kind==='partial'){const p=v.segments[0],last=p.dtwTokens.pop()!,first=s.dtwTokens.shift()!;p.text=p.dtwTokens.map(t=>t.text).join('');s.dtwTokens.unshift({text:last.text+first.text,pointMs:first.pointMs});s.text=s.dtwTokens.map(t=>t.text).join('');}
 expect(inspect(f.source,f.views).status).toBe('rejected');});
it('records kana spelling and peer-supported edits but keeps the source text',()=>{const f=fixture();for(const v of f.views){const s=v.segments[1];s.dtwTokens.forEach(t=>{t.text=t.text.replace(/[ァ-ヶ]/gu,g=>String.fromCodePoint(g.codePointAt(0)!-0x60));});s.text=s.dtwTokens.map(t=>t.text).join('');}const s=f.views[0].segments[0];s.dtwTokens[3].text='始';s.text=s.dtwTokens.map(t=>t.text).join('');const r=inspect(f.source,f.views);expect(r.status).toBe('supported');if(r.status==='supported'){expect(r.replacements[0].text).toBe(prefix);expect(r.replacements[1].text).toContain('ミナミ');expect(r.observations[0].differences.some(d=>d.kanaOnly)).toBe(true);}});
it('rejects missing peers, duplicate origins and a different source identity',()=>{const f=fixture();expect(inspect(f.source,[f.views[0]]).status).toBe('rejected');f.views[1].sourceIdentity='other';expect(inspect(f.source,f.views).status).toBe('rejected');f.views[1]={...f.views[0],id:'other'};expect(inspect(f.source,f.views).status).toBe('rejected');});
