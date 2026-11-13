import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/** Markdown is always sanitized; raw HTML is never rendered (plan §8). */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("prose-morrow", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        components={{
          // Tailwind preflight removes list markers; utilities put them back.
          ul: ({ children: listChildren }) => (
            <ul className="my-2 list-disc space-y-1 pl-5">{listChildren}</ul>
          ),
          ol: ({ children: listChildren }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5">{listChildren}</ol>
          ),
          li: ({ children: itemChildren }) => (
            <li className="pl-0.5">{itemChildren}</li>
          ),
          a: ({ href, children: linkChildren }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent underline underline-offset-2"
            >
              {linkChildren}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
