"use client";

import React from "react";
import type { Components } from "react-markdown";
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
import { parseWidgetFence } from "@/lib/markdown/parse-widget-fence";
import { sanitizeUrl } from "@/lib/markdown/sanitize-url";
import { isUrlAllowed, getSafeLinkProps } from "@/lib/markdown/link-policy";
import { MarkdownWidgetRenderer } from "../MarkdownWidgetRenderer";
import type {
  MarkdownPresetConfig,
  MarkdownPresetComponentContext,
} from "../markdown-types";

const LANGUAGE_CLASS_RE = /(?:^|\s)language-([^\s]+)/;

function createChatComponents(ctx: MarkdownPresetComponentContext): Components {
  const {
    isDarkRef,
    getHeadingId,
    codeBlock,
    widgetRegistry,
    widgetContext,
    securityProfile,
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
          <CodeBlockPanel
            className="my-3"
            filename="mermaid"
            language="mermaid"
            code={rawCode}
            isDark={isDarkRef.current}
            colorTheme={codeBlock.colorTheme}
          >
            <CodeBlock
              language="mermaid"
              isDark={isDarkRef.current}
              colorTheme={codeBlock.colorTheme}
              customTheme={codeBlock.customTheme}
              displayMode="scroll"
              maxHeight="200px"
              stickyLineNumbers={false}
              noShadow
            >
              {rawCode}
            </CodeBlock>
          </CodeBlockPanel>
        );
      }

      return (
        <CodeBlockPanel
          className="my-3"
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
            displayMode={codeBlock.displayMode ?? "scroll"}
            maxLines={codeBlock.maxLines}
            maxHeight={codeBlock.maxHeight ?? "240px"}
            stickyLineNumbers={codeBlock.stickyLineNumbers ?? false}
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
          className="scroll-m-16 text-lg font-bold tracking-tight mt-4 mb-2"
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
          className="scroll-m-16 text-base font-semibold tracking-tight mt-3 mb-1.5"
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
          className="scroll-m-16 text-sm font-semibold tracking-tight mt-3 mb-1"
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
          className="scroll-m-16 text-sm font-semibold mt-2 mb-1"
          {...props}
        >
          {children}
        </h4>
      );
    },

    p: ({ children, ...props }) => (
      <p className="leading-6 my-2 text-foreground" {...props}>
        {children}
      </p>
    ),

    a: ({ children, href, ...props }) => {
      const safeHref = sanitizeUrl(href);
      if (!isUrlAllowed(safeHref, securityProfile)) {
        return <span {...props}>{children}</span>;
      }

      const linkProps = getSafeLinkProps(safeHref, securityProfile);
      return (
        <a
          href={safeHref}
          className="text-primary hover:underline font-medium"
          {...linkProps}
          {...props}
        >
          {children}
        </a>
      );
    },

    img: ({ node, src, alt, ...props }) => {
      void node;
      const safeSrc = sanitizeUrl(src);
      if (!safeSrc) return null;

      return (
        // eslint-disable-next-line @next/next/no-img-element -- Chat markdown images can come from arbitrary safe URLs.
        <img
          src={safeSrc}
          alt={alt || ""}
          className="max-w-full h-auto rounded-md my-2"
          loading="lazy"
          {...props}
        />
      );
    },

    ul: ({ children, ...props }) => (
      <ul className="my-2 ml-4 list-disc [&>li]:mt-1" {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ...props }) => (
      <ol className="my-2 ml-4 list-decimal [&>li]:mt-1" {...props}>
        {children}
      </ol>
    ),
    li: ({ children, ...props }) => (
      <li className="leading-6 text-sm" {...props}>
        {children}
      </li>
    ),

    blockquote: ({ children, ...props }) => (
      <blockquote
        className="my-2 border-l-2 border-muted-foreground/30 pl-3 italic text-muted-foreground text-sm"
        {...props}
      >
        {children}
      </blockquote>
    ),

    table: ({ children, ...props }) => (
      <div className="my-3 rounded-lg border border-border/60 overflow-x-auto">
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
        className="h-9 px-3 text-xs font-semibold whitespace-normal"
        {...props}
      >
        {children}
      </TableHead>
    ),
    td: ({ children, ...props }) => (
      <TableCell className="px-3 py-2 text-sm whitespace-normal" {...props}>
        {children}
      </TableCell>
    ),

    hr: (props) => <hr className="my-4 border-border/40" {...props} />,

    strong: ({ children, ...props }) => (
      <strong className="font-semibold" {...props}>
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

export const chatPreset: MarkdownPresetConfig = {
  mode: "chat",
  density: "compact",
  securityProfile: "untrusted",
  enableRawHtml: false,
  enableHeadingIds: false,
  codeBlock: {
    displayMode: "scroll",
    maxLines: 10,
    maxHeight: "240px",
    stickyLineNumbers: false,
    colorTheme: "github",
  },
  createComponents: createChatComponents,
};
