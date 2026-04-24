/**
 * 字幕翻译模块 - 工具函数
 */

/**
 * 修复 SRT 字幕的序号。
 * LLM 翻译后可能丢失或打乱 SRT 块的序号，此函数按出现顺序重新编号。
 *
 * SRT 块结构（标准 4 行）：
 *   1          <- 序号（可能缺失或错误）
 *   00:00:01,000 --> 00:00:02,000  <- 时间轴
 *   字幕文本第一行
 *   字幕文本第二行（可选）
 *
 * 函数兼容两种情况：
 *   - 3 行块（序号缺失，仅有时间轴+文本）
 *   - 4 行块（标准格式，丢弃旧序号后重新编号）
 */
export function fixSrtSubtitles(subtitleText: string) {
  const subtitles = subtitleText.trim().split('\n\n');
  let correctedSubtitles = '';

  subtitles.forEach((subtitle: string, index: any) => {
    let parts = subtitle.split('\n');

    if (parts.length === 3) {
      const timestamp = parts[0];
      const subtitleText = parts.slice(1).join('\n');
      correctedSubtitles += `${index + 1}\n${timestamp}\n${subtitleText}\n\n`;
    } else if (parts.length === 4) {
      // 4 行块：第一行是旧序号，跳过后取时间轴和文本
      parts = parts.slice(1);
      const timestamp = parts[0];
      const subtitleText = parts.slice(1).join('\n');
      correctedSubtitles += `${index + 1}\n${timestamp}\n${subtitleText}\n\n`;
    }
  });

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