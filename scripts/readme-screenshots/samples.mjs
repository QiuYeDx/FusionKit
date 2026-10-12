// Original sample subtitles for the README screenshots. Written for this project; not taken from any work.

const ms = (value) => {
  const date = new Date(value);
  return `${date.toISOString().slice(11, 19)},${String(date.getUTCMilliseconds()).padStart(3, '0')}`;
};

/** Builds an SRT file from [start, end, ...lines] tuples (seconds). */
export function srt(cues) {
  return cues.map(([start, end, ...lines], index) => `${index + 1}\n${ms(start * 1000)} --> ${ms(end * 1000)}\n${lines.join('\n')}\n`).join('\n');
}

/** Episode 1: Japanese original with a Chinese line under each cue, imported as a bilingual document. */
export const lighthouseBilingual = srt([
  [1.2, 3.8, '灯台の光、今夜も届くかな。', '灯塔的光，今晚也能照到吗？'],
  [4.1, 6.6, '届くよ。毎晩ちゃんと回ってるから。', '能照到的。它每天晚上都在好好地转着。'],
  [7.0, 9.4, 'おじいちゃん、ずっと一人で守ってたんだね。', '爷爷一直是一个人守着这里的吧。'],
  [9.8, 12.9, 'うん。嵐の夜も、一度も消したことがないって。', '嗯。他说就算是暴风雨的夜里，也从没让它熄灭过。'],
  [13.4, 15.2, 'それって、すごいことだよ。', '那可真了不起。'],
  [15.9, 18.7, '今度は私たちの番だね。', '这次轮到我们了。'],
  [19.2, 21.5, 'ねえ、あの船、こっちに来てない？', '喂，那艘船是不是朝这边来了？'],
  [21.9, 24.3, '霧が濃くなってきた。急ごう。', '雾越来越浓了，快走吧。'],
  [24.8, 27.6, 'ランプの予備、どこにしまったっけ？', '备用的灯泡放到哪里去了来着？'],
  [28.0, 30.2, '階段の下の、青い箱の中。', '在楼梯下面那个蓝色箱子里。'],
  [30.9, 33.4, '見つけた！これで朝まで大丈夫。', '找到了！这样就能撑到天亮了。'],
  [34.0, 36.8, '光が届いたら、きっと汽笛を鳴らしてくれる。', '光照到的话，他们一定会鸣笛回应的。'],
  [37.5, 39.0, '……聞こえた？', '……听到了吗？'],
  [39.4, 42.2, '聞こえた。ちゃんと届いたんだ。', '听到了。真的照到了。'],
]);

/** Episode 2: Japanese only, still waiting for a translation. */
export const lighthouseJapanese = srt([
  [0.8, 3.1, '朝の港は、思ったより静かだった。'],
  [3.6, 6.0, '昨日の船、無事に着いたって。'],
  [6.5, 8.9, '手紙が届いてるよ。差出人は……船長さん？'],
  [9.3, 12.0, '「灯台の二人へ。ありがとう」だって。'],
  [12.6, 14.8, 'なんだか、少し照れるね。'],
  [15.3, 17.9, 'お返事、書こうか。'],
]);

/** A short English interview clip. */
export const interviewEnglish = srt([
  [0.5, 3.2, 'So how long have you been keeping the light?'],
  [3.6, 6.9, 'Almost forty years now. My grandfather did it before me.'],
  [7.4, 10.1, 'Do you ever get tired of the stairs?'],
  [10.5, 13.4, 'Every single night. But the view is worth it.'],
]);
