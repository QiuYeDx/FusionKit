export interface MdastNode {
  type: string;
  meta?: string;
  data?: {
    hProperties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  children?: MdastNode[];
}

/**
 * Remark 插件：将代码块的 meta 信息透传到 HTML 元素属性
 *
 * Markdown 中 fenced code block 支持在语言标识后附加 meta 信息，
 * 例如 ```tsx title="App.tsx"。remark 默认不会将 meta 传递到 HTML 元素。
 * 此插件通过 hProperties 将 meta 注入为 data-meta 属性，
 * 使 react-markdown 的自定义组件能够读取和解析。
 */
export function remarkCodeMeta() {
  return (tree: MdastNode) => {
    function walk(node: MdastNode) {
      if (node.type === "code" && node.meta) {
        node.data = node.data || {};
        const hProperties = (node.data.hProperties || {}) as Record<
          string,
          unknown
        >;
        hProperties["data-meta"] = node.meta;
        node.data.hProperties = hProperties;
      }
      if (node.children) {
        node.children.forEach(walk);
      }
    }
    walk(tree);
  };
}
