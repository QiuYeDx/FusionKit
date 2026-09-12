import {expect,it} from 'vitest';
import {inspectShortOnsetActivity,inspectShortOnsetConsensus as consensus,inspectShortOnsetSource,inspectShortOnsetView as inspect} from '../../../electron/main/subtitle-studio/transcription/native/cue-short-onset-evidence';
function fixture(){
 const samples=new Int16Array(12000*16);
 for(const [start,end] of [[2100,2400],[2500,2800],[3200,3450],[5000,5800],[7000,8500],[9000,10500]])for(let i=start*16;i<end*16;i++)samples[i]=Math.round(3000*Math.sin(i/8));
 const cue={id:'c',text:'こちらから案内します 僕だ',startMs:2000,endMs:7000};
 const following=[{id:'d',text:'次の説明を始めます',startMs:7000,endMs:9000},{id:'e',text:'静かに聞いてください',startMs:9000,endMs:11000}];
 const texts=['案内をします ','ん ','ん ','僕','だ','。',following[0].text,'。',following[1].text];
 const make=(id:string,originMs:number)=>({id,sourceIdentity:'pcm',originMs,durationMs:12000-originMs,segments:[{startMs:0,endMs:12000-originMs,text:texts.join(''),dtwTokens:texts.map((text,i)=>({text,pointMs:[2200,2550,3300,5100,5500,5600,7200,8400,9500][i]-originMs}))}]});
 return{source:{sourceIdentity:'pcm',cue,following},audio:{sourceIdentity:'pcm',originMs:0,samples},views:[make('a',0),make('b',1000)]};
}
it('preserves source words and separates a short phrase after prior audible events',()=>{const f=fixture(),copy=structuredClone(f),r=consensus(f.source,f.audio,f.views);expect(r.status).toBe('supported');if(r.status==='supported'){expect(r.replacements.map(c=>[c.text,c.startMs,c.endMs])).toEqual([['こちらから案内します',2000,5100],['僕だ',5100,7000]]);expect(r.observations[0].status).toBe('short_onset_supported');}expect(f).toEqual(copy);});
it('keeps low-amplitude matching evidence without declaring speech presence',()=>{const f=fixture();f.audio.samples=f.audio.samples.map(x=>Math.round(x/8));expect(consensus(f.source,f.audio,f.views).status).toBe('supported');});
for(const kind of ['silence','constant_background','first_in_gap','tail_in_other_event','no_preceding_gap','very_long_event','late_first','missing_tokens','backward','outside','changed_forward','repeat_target','partial_target','partial_context','quote','wrong_audio','wrong_view','missing_peer','duplicate','drift'])it(`refuses unsafe timing evidence: ${kind}`,()=>{
 const f=fixture(),v=f.views[1],segment=v.segments[0];
 if(kind==='silence')f.audio.samples.fill(0);if(kind==='constant_background')f.audio.samples.fill(3000);
 if(kind==='first_in_gap')segment.dtwTokens[3].pointMs=4000-v.originMs;
 if(kind==='tail_in_other_event')segment.dtwTokens[3].pointMs=3300-v.originMs;
 if(kind==='no_preceding_gap')for(let i=3500*16;i<5100*16;i++)f.audio.samples[i]=Math.round(3000*Math.sin(i/8));
 if(kind==='very_long_event')for(let i=1000*16;i<6100*16;i++)f.audio.samples[i]=Math.round(3000*Math.sin(i/8));
 if(kind==='late_first'){segment.dtwTokens[3].pointMs=5550-v.originMs;segment.dtwTokens[4].pointMs=5600-v.originMs;}
 if(kind==='missing_tokens')segment.dtwTokens=[];if(kind==='backward')segment.dtwTokens[4].pointMs=1;if(kind==='outside')segment.dtwTokens.at(-1)!.pointMs=99999;
 if(kind==='changed_forward'){segment.dtwTokens[6].text='違う内容を説明します';segment.text=segment.dtwTokens.map(t=>t.text).join('');}
 if(kind==='repeat_target'){segment.dtwTokens.push({text:'僕だ',pointMs:11000-v.originMs});segment.text+='僕だ';}
 if(kind==='partial_target'){segment.dtwTokens[2].text+=segment.dtwTokens[3].text;segment.dtwTokens.splice(3,1);}
 if(kind==='partial_context'){segment.dtwTokens.at(-1)!.text+='追加';segment.text+='追加';}
 if(kind==='quote'){segment.text='「'+segment.text+'」';}
 if(kind==='wrong_audio')f.audio.sourceIdentity='other';if(kind==='wrong_view')v.sourceIdentity='other';
 if(kind==='missing_peer')f.views.pop();if(kind==='duplicate')f.views[1]={...f.views[0]};
 if(kind==='drift')for(let i=3;i<5;i++)segment.dtwTokens[i].pointMs+=350;
 expect(consensus(f.source,f.audio,f.views).status).toBe('rejected');
});
for(const kind of ['no_space','dependent','long_target','short_context','gap','repeat','quote','time','identity'])it(`requires a complete source relationship: ${kind}`,()=>{const f=fixture();if(kind==='no_space')f.source.cue.text=f.source.cue.text.replace(' ','');if(kind==='dependent')f.source.cue.text='こちらから案内 です';if(kind==='long_target')f.source.cue.text='こちらから案内 '+ '説明'.repeat(9);if(kind==='short_context')f.source.following=[{...f.source.following[0],text:'はい'}];if(kind==='gap')f.source.following[0].startMs++;if(kind==='repeat')f.source.cue.text='僕だと説明しました 僕だ';if(kind==='quote')f.source.cue.text='「'+f.source.cue.text+'」';if(kind==='time')f.source.cue.endMs=NaN;if(kind==='identity')(f.source as any).sourceIdentity=1;expect(inspectShortOnsetSource(f.source).status).toBe('rejected');});
it('records the activity mismatch instead of silently dropping an adverse observation',()=>{const f=fixture(),bad=structuredClone(f.views[1]);bad.id='bad';bad.originMs=2000;bad.durationMs=10000;bad.segments[0].startMs=0;bad.segments[0].endMs=10000;bad.segments[0].dtwTokens.forEach(t=>t.pointMs-=1000);bad.segments[0].dtwTokens[3].pointMs=2000;const result=inspect(f.source,f.audio,bad);expect(result).toMatchObject({status:'rejected',reason:'target_points_not_in_one_activity'});expect(consensus(f.source,f.audio,[...f.views,bad]).status).toBe('rejected');});
it('bounds PCM work and rejects malformed audio identities',()=>{const f=fixture();expect(inspectShortOnsetActivity({...f.audio,samples:new Int16Array(480001)}).status).toBe('rejected');expect(inspectShortOnsetActivity({...f.audio,sourceIdentity:1 as any}).status).toBe('rejected');expect(inspectShortOnsetActivity({...f.audio,originMs:Number.MAX_SAFE_INTEGER}).status).toBe('rejected');});
