import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/format";

export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  /** Colored dot (CSS color), e.g. for select options. */
  dot?: string;
  /** Leading icon or glyph. */
  icon?: ReactNode;
  /** Muted text on the right. */
  hint?: string;
};

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={cn("flex-none text-muted transition-transform", open && "rotate-180")} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Custom dropdown: consistent in light/dark, dots and icons, keyboard support
 * (arrows, Enter, Esc, type-to-jump). The menu is portalled so modals don't clip it.
 */
export function Select<T extends string = string>({
  value, options, onChange, placeholder = "Select…", size = "md", width, ariaLabel, clearable, autoFocus, className, defaultOpen, onClose,
}: {
  value: T | "" | null | undefined;
  options: SelectOption<T>[];
  onChange: (v: T | "") => void;
  placeholder?: string;
  size?: "sm" | "md";
  width?: number | string;
  ariaLabel?: string;
  /** Label for an empty choice, e.g. "None". */
  clearable?: string;
  autoFocus?: boolean;
  className?: string;
  /** Open the menu on mount (inline editing). */
  defaultOpen?: boolean;
  /** Called when the menu closes, whether or not a value was picked. */
  onClose?: () => void;
}) {
  const [open, setOpenState] = useState(!!defaultOpen);
  const setOpen = (v: boolean | ((o: boolean) => boolean)) =>
    setOpenState((o) => {
      const next = typeof v === "function" ? v(o) : v;
      if (o && !next) setTimeout(() => onClose?.(), 0);
      return next;
    });
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const all: SelectOption<T | "">[] = clearable ? [{ value: "", label: clearable }, ...options] : options;
  const current = options.find((o) => o.value === value);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const height = Math.min(320, all.length * 32 + 12);
    const up = r.bottom + height + 8 > window.innerHeight && r.top > height + 8;
    setPos({ left: r.left, top: up ? r.top - height - 4 : r.bottom + 4, width: Math.max(r.width, 180) });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    setActive(Math.max(0, all.findIndex((o) => o.value === (value ?? ""))));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const reposition = () => place();
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (v: T | "") => {
    onChange(v);
    setOpen(false);
    btn.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, all.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (all[active]) choose(all[active].value); }
    else if (e.key === "Tab") setOpen(false);
    else if (e.key.length === 1) {
      const i = all.findIndex((o, j) => j > active && o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      const k = i >= 0 ? i : all.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (k >= 0) setActive(k);
    }
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
        style={width !== undefined ? { width } : undefined}
        className={cn(
          "select inline-flex items-center justify-between gap-2 rounded-ctl border bg-panel text-left text-ink outline-none transition-colors",
          size === "sm" ? "h-7 w-auto pr-1.5 pl-2 text-xs" : "h-8 w-full pr-2 pl-2.5",
          open ? "border-accent ring-3 ring-accent-soft" : "border-line-2 hover:border-[color-mix(in_srgb,var(--ink)_25%,var(--line-2))] focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent-soft",
          className,
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
          {current?.dot && <i className="size-2 flex-none rounded-full" style={{ background: current.dot }} />}
          {current?.icon && <span className="inline-flex min-w-4 items-center justify-center text-xs text-muted">{current.icon}</span>}
          {current ? current.label : <span className="text-faint">{clearable && value === "" ? clearable : placeholder}</span>}
        </span>
        <Chevron open={open} />
      </button>
      {open && pos && createPortal(
        <div ref={menu} role="listbox" onKeyDown={onKey}
          className="select-menu animate-menu fixed z-[100] max-h-80 overflow-y-auto rounded-lg border border-line bg-panel p-1 text-[13px] text-ink shadow-pop"
          style={{ left: pos.left, top: pos.top, minWidth: pos.width }}>
          {all.map((o, i) => {
            const selected = o.value === (value ?? "");
            return (
              <div key={o.value || "__none"} data-i={i} role="option" aria-selected={selected}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); choose(o.value); }}
                className={cn("flex h-8 cursor-pointer items-center gap-2 whitespace-nowrap rounded-[5px] px-2", i === active && "bg-hover")}>
                {o.dot && <i className="size-2 flex-none rounded-full" style={{ background: o.dot }} />}
                {o.icon && <span className="inline-flex min-w-4 items-center justify-center text-xs text-muted">{o.icon}</span>}
                <span className="flex-1 overflow-hidden text-ellipsis">{o.label}</span>
                {o.hint && <span className="text-xs text-faint">{o.hint}</span>}
                {selected && (
                  <svg className="flex-none text-accent" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.5 5.8 10 11 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
