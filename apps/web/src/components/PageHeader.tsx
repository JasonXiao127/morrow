import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
  bordered = true,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  bordered?: boolean;
}) {
  return (
    <header className={bordered ? "border-b border-hairline pb-5 md:pb-6" : "pb-4 md:pb-5"}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="mb-1.5 text-13 text-muted">{eyebrow}</div>
          ) : null}
          <h1 className="serif text-28 text-ink md:text-[2rem] md:leading-[2.25rem]">
            {title}
          </h1>
          {description ? (
            <div className="mt-2 max-w-xl text-13 text-muted">{description}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children}
    </header>
  );
}
