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

/**
 * 清理大模型返回结果中的思考标签
 * 支持删除 <think></think> 标签及其内容，适配深度思考类型的大模型API
 * @param content 大模型返回的原始内容
 * @returns 清理后的内容
 */
export function removeThinkTags(content: string): string {
  if (!content) {
    return content;
  }

  // 移除 <think></think> 标签及其内容
  // 使用正则表达式匹配，支持多行内容和嵌套结构
  const thinkTagRegex = /<think>[\s\S]*?<\/think>/gi;
  
  // 先移除所有的think标签
  let cleanedContent = content.replace(thinkTagRegex, '');
  
  // 清理多余的空行（连续超过2个换行符的情况）
  cleanedContent = cleanedContent.replace(/\n{3,}/g, '\n\n');
  
  // 去除开头和结尾的空白字符
  cleanedContent = cleanedContent.trim();
  
  return cleanedContent;
}

/**
 * 检测内容是否包含think标签
 * @param content 要检测的内容
 * @returns 是否包含think标签
 */
export function hasThinkTags(content: string): boolean {
  if (!content) {
    return false;
  }
  
  const thinkTagRegex = /<think>[\s\S]*?<\/think>/gi;
  return thinkTagRegex.test(content);
}

/**
 * 测试removeThinkTags函数的功能
 * 用于验证think标签的清理是否正常工作
 */
export function testRemoveThinkTags() {
  console.log("开始测试 removeThinkTags 功能...");
  
  // 测试用例1：包含单个think标签
  const test1 = `<think>
这是我的思考过程，需要被移除
用户不应该看到这部分内容
</think>

这是实际的翻译结果，应该保留`;
  
  const result1 = removeThinkTags(test1);
  console.log("测试1 - 原始内容：", test1);
  console.log("测试1 - 清理后：", result1);
  console.log("测试1 - 验证：", result1 === "这是实际的翻译结果，应该保留");
  
  // 测试用例2：包含多个think标签
  const test2 = `首先翻译这部分

<think>
思考1：这部分需要移除
</think>

中间的翻译内容

<think>
思考2：这部分也需要移除
</think>

最后的翻译内容`;
  
  const result2 = removeThinkTags(test2);
  console.log("测试2 - 原始内容：", test2);
  console.log("测试2 - 清理后：", result2);
  
  // 测试用例3：没有think标签的内容
  const test3 = "这是正常的翻译内容，没有think标签";
  const result3 = removeThinkTags(test3);
  console.log("测试3 - 验证：", result3 === test3);
  
  // 测试用例4：空内容
  const test4 = "";
  const result4 = removeThinkTags(test4);
  console.log("测试4 - 验证：", result4 === "");
  
  console.log("removeThinkTags 功能测试完成");
}