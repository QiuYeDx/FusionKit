export function fixSrtSubtitles(subtitleText: string) {
  // 按照空行（即字幕块之间的分隔）将字幕文本拆分成多个块
  const subtitles = subtitleText.trim().split('\n\n');

  // 用来存储修正后的字幕内容
  let correctedSubtitles = '';

  // 遍历每个字幕块，重新分配正确的编号
  subtitles.forEach((subtitle: string, index: any) => {
    // 将每个字幕块分割成时间戳和字幕文本
    let parts = subtitle.split('\n');

    if (parts.length === 3) {
      // 获取时间戳部分（即字幕的开始和结束时间）
      const timestamp = parts[0];

      // 剩余部分是字幕文本，将其合并成一块
      const subtitleText = parts.slice(1).join('\n');

      // 将修正后的字幕加入到最终结果中，编号从1开始递增
      correctedSubtitles += `${index + 1}\n${timestamp}\n${subtitleText}\n\n`;
    } else if (parts.length === 4) {
      parts = parts.slice(1);
      // 获取时间戳部分（即字幕的开始和结束时间）
      const timestamp = parts[0];

      // 剩余部分是字幕文本，将其合并成一块
      const subtitleText = parts.slice(1).join('\n');

      // 将修正后的字幕加入到最终结果中，编号从1开始递增
      correctedSubtitles += `${index + 1}\n${timestamp}\n${subtitleText}\n\n`;
    }

  });

  // 删除最后一个多余的换行符并返回修正后的字幕文本
  return correctedSubtitles.trim();
}