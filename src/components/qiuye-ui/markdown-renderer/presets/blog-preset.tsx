"use client";

import React from "react";
import type { Components } from "react-markdown";
import { ImageViewer } from "@/components/qiuye-ui/image-viewer";
import {
  CodeBlock,
  CodeBlockPanel,
} from "@/components/qiuye-ui/code-block";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { parseCodeBlockMeta } from "@/lib/markdown/parse-code-block-meta";
import { MermaidBlock } from "../blocks/MermaidBlock";
import type {
  MarkdownPresetConfig,
  MarkdownPresetComponentContext,
} from "../markdown-types";
import { parseWidgetFence } from "@/lib/markdown/parse-widget-fence";
import { MarkdownWidgetRenderer } from "../MarkdownWidgetRenderer";

const LANGUAGE_CLASS_RE = /(?:^|\s)language-([^\s]+)/;

function createBlogComponents(ctx: MarkdownPresetComponentContext): Components {
  const {
    isDarkRef,
    getHeadingId,
    codeBlock,
    widgetRegistry,
    widgetContext,
  } = ctx;

  return {
    code: ({ className, children, ...props }) => {
      const match = LANGUAGE_CLASS_RE.exec(className || "");
      const isCodeBlock = match;

      if (!isCodeBlock) {
        return (
          <code className="inline-code" {...props}>
            {children}
          </code>
        );
      }

      const language = match[1];
      const meta = (props as Record<string, unknown>)["data-meta"] as
        | string
        | undefined;
      const { title, highlightLines } = parseCodeBlockMeta(meta);
      const rawCode = String(children);

      // Widget 代码块识别
      if (
        widgetRegistry &&
        (language === "qv-widget" || language?.startsWith("qv:"))
      ) {
        const invocation = parseWidgetFence(language, meta, rawCode);
        if (invocation) {
          return (
            <MarkdownWidgetRenderer
              invocation={invocation}
              registry={widgetRegistry}
              context={widgetContext ?? {}}
            />
          );
        }
      }

      if (language === "mermaid") {
        return (
          <MermaidBlock
            stickyLineNumbers={codeBlock.stickyLineNumbers}
            colorTheme={codeBlock.colorTheme}
            customTheme={codeBlock.customTheme}
          >
            {rawCode}
          </MermaidBlock>
        );
      }

      return (
        <CodeBlockPanel
          className="my-6 sm:my-8"
          filename={title}
          language={language}
          code={rawCode}
          isDark={isDarkRef.current}
          colorTheme={codeBlock.colorTheme}
        >
          <CodeBlock
            language={language}
            isDark={isDarkRef.current}
            colorTheme={codeBlock.colorTheme}
            customTheme={codeBlock.customTheme}
            displayMode={codeBlock.displayMode}
            maxLines={codeBlock.maxLines}
            maxHeight={codeBlock.maxHeight}
            stickyLineNumbers={codeBlock.stickyLineNumbers}
            highlightLines={highlightLines}
            noShadow
            showLineNumbers={12}
          >
            {rawCode}
          </CodeBlock>
        </CodeBlockPanel>
      );
    },

    pre: ({ children }) => <>{children}</>,

    h1: ({ node, children, ...props }) => {
      const text = String(children);
      const id = getHeadingId(text, node);
      return (
        <h1
          id={id}
          className="scroll-m-20 text-4xl font-bold tracking-tight mt-12 mb-6"
          {...props}
        >
          {children}
        </h1>
      );
    },
    h2: ({ node, children, ...props }) => {
      const text = String(children);
      const id = getHeadingId(text, node);
      return (
        <h2
          id={id}
          className="scroll-m-20 text-3xl font-semibold tracking-tight mt-10 mb-4 border-b pb-2"
          {...props}
        >
          {children}
        </h2>
      );
    },
    h3: ({ node, children, ...props }) => {
      const text = String(children);
      const id = getHeadingId(text, node);
      return (
        <h3
          id={id}
          className="scroll-m-20 text-2xl font-semibold tracking-tight mt-8 mb-4"
          {...props}
        >
          {children}
        </h3>
      );
    },
    h4: ({ node, children, ...props }) => {
      const text = String(children);
      const id = getHeadingId(text, node);
      return (
        <h4
          id={id}
          className="scroll-m-20 text-xl font-semibold tracking-tight mt-6 mb-3"
          {...props}
        >
          {children}
        </h4>
      );
    },

    p: ({ children, ...props }) => (
      <p className="leading-7 my-4 text-muted-foreground" {...props}>
        {children}
      </p>
    ),

    a: ({ children, href, ...props }) => (
      <a
        href={href}
        className="text-primary hover:underline font-medium"
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        {children}
      </a>
    ),

    img: ({ node, src, alt, ...props }) => {
      void node;
      return (
        <ImageViewer
          wrapperClassName="my-0"
          hoverScale={1.05}
          src={src}
          alt={alt}
          {...props}
        />
      );
    },

    ul: ({ children, ...props }) => (
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2" {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ...props }) => (
      <ol className="my-6 ml-6 list-decimal [&>li]:mt-2" {...props}>
        {children}
      </ol>
    ),
    li: ({ children, ...props }) => (
      <li className="leading-7" {...props}>
        {children}
      </li>
    ),

    blockquote: ({ children, ...props }) => (
      <blockquote
        className="mt-6 border-l-4 border-primary pl-6 italic text-muted-foreground"
        {...props}
      >
        {children}
      </blockquote>
    ),

    table: ({ children, ...props }) => (
      <div className="my-6 rounded-lg border border-border/60 overflow-hidden">
        <Table {...props}>{children}</Table>
      </div>
    ),
    thead: ({ children, ...props }) => (
      <TableHeader className="bg-muted/40" {...props}>
        {children}
      </TableHeader>
    ),
    tbody: ({ children, ...props }) => (
      <TableBody {...props}>{children}</TableBody>
    ),
    tr: ({ children, ...props }) => (
      <TableRow {...props}>{children}</TableRow>
    ),
    th: ({ children, ...props }) => (
      <TableHead
        className="h-11 px-4 font-semibold whitespace-normal"
        {...props}
      >
        {children}
      </TableHead>
    ),
    td: ({ children, ...props }) => (
      <TableCell className="px-4 py-3 whitespace-normal" {...props}>
        {children}
      </TableCell>
    ),

    hr: (props) => <hr className="my-8 border-border" {...props} />,

    strong: ({ children, ...props }) => (
      <strong className="font-bold" {...props}>
        {children}
      </strong>
    ),
    em: ({ children, ...props }) => (
      <em className="italic" {...props}>
        {children}
      </em>
    ),
  };
}

export const blogPreset: MarkdownPresetConfig = {
  mode: "blog",
  density: "article",
  securityProfile: "trusted",
  enableRawHtml: true,
  enableHeadingIds: true,
  codeBlock: {
    displayMode: undefined,
    maxLines: 15,
    stickyLineNumbers: true,
    colorTheme: "github",
  },
  createComponents: createBlogComponents,
};
