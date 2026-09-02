import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownReader({
  source,
  className = "",
}: {
  source: string;
  className?: string;
}) {
  return (
    <div className={`markdown-reader ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <pre className="md-pre">{children}</pre>,
          code: ({ className: cn, children, ...props }) => {
            const isBlock = Boolean(cn);
            if (isBlock) {
              return (
                <code className={cn} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="md-inline-code" {...props}>
                {children}
              </code>
            );
          },
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
