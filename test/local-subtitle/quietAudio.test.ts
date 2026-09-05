import { describe, it, expect } from 'vitest';
import { conditionQuietPcm16 } from '../../electron/main/local-subtitle/quiet-audio';

function tone(amplitude: number, frames=16000) {
  const pcm=Buffer.alloc(frames*2);
  for(let i=0;i<frames;i++)pcm.writeInt16LE(Math.round(amplitude*Math.sin(2*Math.PI*i/40)),i*2);
  return pcm;
}
function peak(pcm:Buffer) {
  let value=0;for(let i=0;i<pcm.length;i+=2)value=Math.max(value,Math.abs(pcm.readInt16LE(i)));return value;
}
describe('bounded quiet PCM conditioning',()=>{
  it('leaves silence, digital noise and normal speech byte-identical',()=>{
    for(const input of [Buffer.alloc(32000),tone(2),tone(6000)]) {
      const result=conditionQuietPcm16(input);
      expect(result.pcm).toBe(input);expect(result.gainDb).toBe(0);
    }
  });
  it('boosts quiet input without shifting samples, filling pauses or modifying the source',()=>{
    const input=tone(700);input.fill(0,8000,16000);const before=Buffer.from(input);
    const result=conditionQuietPcm16(input);
    expect(result.gainDb).toBe(12);expect(result.pcm.length).toBe(input.length);
    expect(input.equals(before)).toBe(true);
    expect(result.pcm.subarray(8000,16000).every(value=>value===0)).toBe(true);
    for(let i=0;i<input.length;i+=2) expect(result.pcm.readInt16LE(i)).toBe(Math.round(input.readInt16LE(i)*10**.6));
  });
  it('softens isolated transients below the ceiling and refuses sustained limiting',()=>{
    const limited=tone(250);limited.writeInt16LE(12000,0);
    const result=conditionQuietPcm16(limited);
    expect(result.gainDb).toBe(12);
    expect(peak(result.pcm)).toBeLessThanOrEqual(Math.ceil(32768*10**(-1/20)));
    const transient=tone(250);for(let i=0;i<40;i++)transient.writeInt16LE(-10000,i*2);
    expect(conditionQuietPcm16(transient).gainDb).toBe(0);
  });
  it('rejects unbounded or malformed PCM',()=>{
    for(const input of [Buffer.alloc(0),Buffer.alloc(1),Buffer.alloc(960002)])expect(()=>conditionQuietPcm16(input)).toThrow();
  });
});
