import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cn } from "../lib/format";

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-auto rounded-lg border border-line bg-panel", className)}>
      <table className="w-full border-collapse [&_tbody_tr:last-child>td]:border-0">{children}</table>
    </div>
  );
}

export function Th({ className, num, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return (
    <th className={cn("sticky top-0 z-1 h-[34px] border-b border-line bg-sidebar px-3 text-xs font-medium whitespace-nowrap text-muted select-none",
      num ? "text-right" : "text-left", rest.onClick && "cursor-pointer hover:text-ink", className)} {...rest} />
  );
}

export function Td({ className, num, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return (
    <td className={cn("h-[38px] max-w-[280px] overflow-hidden border-b border-line px-3 py-2 text-ellipsis whitespace-nowrap",
      num ? "text-right tabular-nums" : "text-left", className)} {...rest} />
  );
}

/** Row that highlights on hover; clickable when onClick is set. */
export function Tr({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return <tr onClick={onClick} className={cn(onClick && "cursor-pointer [&:hover>td]:bg-hover")}>{children}</tr>;
}
