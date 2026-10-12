import { describe, expect, it } from 'vitest';
import { groupByName } from './StudioMaterialsFields';

const named = (...names: string[]) => names.map(name => ({ name }));
const shape = (groups: ReturnType<typeof groupByName<{ name: string }>>) => groups.map(group => [group.name, group.items.map(item => item.label)]);

describe('materials picker groups', () => {
  it('groups "Group · Topic" names, treating a trailing number on the group as ordering only', () => {
    const groups = groupByName(named('共通 01 · 字幕基本要求', '共通 02 · 耳部护理与陪伴术语', 'R18 01 · 忠实与语境判断', 'R18 02 · 身体词汇',
      '绝区零 · 人物与阵营', '绝区零 · 战斗系统', '单独的资料集', '作品 · RJ01005157 · 圣诞陪伴'));
    expect(shape(groups)).toEqual([
      ['共通', ['字幕基本要求', '耳部护理与陪伴术语']],
      ['R18', ['忠实与语境判断', '身体词汇']],
      ['绝区零', ['人物与阵营', '战斗系统']],
      ['作品', ['RJ01005157 · 圣诞陪伴']],
      // Names without a prefix come last, without a heading.
      ['', ['单独的资料集']],
    ]);
  });

  it('keeps a short or unprefixed list flat', () => {
    expect(shape(groupByName(named('A · x', 'A · y', 'B · z')))).toEqual([['', ['A · x', 'A · y', 'B · z']]]);
    expect(shape(groupByName(named('一', '二', '三', '四', '五', '六', '七')))).toEqual([['', ['一', '二', '三', '四', '五', '六', '七']]]);
    // A trailing separator is not a group.
    expect(groupByName(named('a · ', 'b', 'c', 'd', 'e', 'f', 'g'))[0].name).toBe('');
  });
});
