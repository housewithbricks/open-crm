import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn, dot, fmtDate, initials, objColor, tint } from "../lib/format";
import { useObject } from "../lib/schema";

/* --------------------------------- controls --------------------------------- */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger"; size?: "md" | "sm" };

export const btnClass = (variant: BtnProps["variant"] = "default", size: BtnProps["size"] = "md") =>
  cn(
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border font-medium transition-colors disabled:opacity-45 disabled:cursor-default",
    size === "sm" ? "h-[26px] px-2.5 text-xs" : "h-[30px] px-3",
    variant === "primary" && "border-accent bg-accent text-accent-ink hover:brightness-110",
    variant === "default" && "border-line-2 bg-panel text-ink hover:bg-hover",
    variant === "ghost" && "border-transparent bg-transparent text-muted hover:bg-hover hover:text-ink",
    variant === "danger" && "border-line-2 bg-panel text-danger hover:bg-danger-soft",
  );

export function Button({ variant, size, className, type = "button", ...rest }: BtnProps) {
  return <button type={type} className={cn(btnClass(variant, size), className)} {...rest} />;
}

export const inputClass =
  "h-8 w-full rounded-ctl border border-line-2 bg-panel px-2.5 text-ink outline-none placeholder:text-faint focus:border-accent focus:ring-3 focus:ring-accent-soft";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputClass, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputClass, "h-auto min-h-[72px] resize-y py-2 leading-normal", className)} {...rest} />;
}

/** A form label. Pass htmlFor (the control's id), or an id for a group to point aria-labelledby at. */
export function Label({ children, className, htmlFor, id }: { children: ReactNode; className?: string; htmlFor?: string; id?: string }) {
  return <label htmlFor={htmlFor} id={id} className={cn("mt-3.5 mb-1.5 block text-xs font-medium text-ink-2", className)}>{children}</label>;
}

export const Hint = ({ children }: { children: ReactNode }) => <p className="mt-1 text-xs text-muted">{children}</p>;

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="my-2.5 rounded-ctl bg-danger-soft px-2.5 py-2 text-danger">{error instanceof Error ? error.message : String(error)}</div>;
}

/** Segmented control. */
export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn("inline-flex gap-0.5 rounded-[7px] bg-hover p-0.5", className)}>
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cn("h-[26px] rounded-[5px] px-2.5 font-medium transition-colors",
            value === o.value ? "bg-panel text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted hover:text-ink")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={(e) => { e.preventDefault(); onChange(!checked); }}
      className={cn("relative h-5 w-[34px] flex-none rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent", checked ? "bg-accent" : "bg-line-2")}>
      <span className={cn("absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform", checked && "translate-x-3.5")} />
    </button>
  );
}

/** A labelled on/off row with an explanation. */
export function SwitchRow({ title, hint, checked, onChange }: { title: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 border-b border-line py-2.5 last:border-0">
      <span className="flex flex-col"><b className="font-medium">{title}</b>{hint && <small className="text-xs text-muted">{hint}</small>}</span>
      <Switch checked={checked} onChange={onChange} label={title} />
    </label>
  );
}

/* --------------------------------- surfaces --------------------------------- */

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-w-0 rounded-[10px] border border-line bg-panel p-4", className)}>{children}</div>;
}

export function CardHead({ title, action, children }: { title: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2.5">
      <h3 className="m-0 inline-flex items-center gap-2 text-[13px]">{title}</h3>
      {children ?? (action && <span className="text-xs">{action}</span>)}
    </div>
  );
}

/** Bordered list of rows (tasks, approvals, activity…). */
export function List({ children, flat, className }: { children: ReactNode; flat?: boolean; className?: string }) {
  return (
    <div className={cn(flat ? "" : "rounded-lg border border-line bg-panel",
      "[&>*]:flex [&>*]:min-h-10 [&>*]:items-center [&>*]:gap-2.5 [&>*]:border-b [&>*]:border-line [&>*]:py-2 [&>*:last-child]:border-0",
      flat ? "[&>*]:px-0" : "[&>*]:px-3.5", className)}>
      {children}
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="justify-center text-muted">{children}</div>;

export function PageHead({ title, children, desc }: { title: ReactNode; children?: ReactNode; desc?: ReactNode }) {
  return (
    <>
      <div className="mb-4 flex min-h-8 flex-wrap items-center gap-2.5">
        <h1 className="m-0 mr-2 inline-flex items-center gap-2.5 text-lg">{title}</h1>
        <div className="flex-1" />
        {children}
      </div>
      {desc && <p className="-mt-2 mb-5 max-w-[680px] text-muted">{desc}</p>}
    </>
  );
}

export const Pill = ({ children }: { children: ReactNode }) => (
  <span className="ml-1.5 inline-block rounded border border-line-2 px-1.5 text-[11px] leading-[17px] text-muted">{children}</span>
);

export function Link2({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) {
  return <span role="link" tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === "Enter" && onClick?.()} className={cn("cursor-pointer text-accent hover:underline", className)}>{children}</span>;
}

/** Quiet underlined reference to a record or URL. */
export const refClass = "cursor-pointer underline decoration-line-2 underline-offset-[3px] hover:decoration-current";

/* ---------------------------------- modal ----------------------------------- */

export function Modal({ title, onClose, children, wide, bare }: { title?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; bare?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div data-modal className="fixed inset-0 z-40 grid place-items-start justify-center bg-black/30 pt-[12vh]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()}
        className={cn("max-h-[76vh] overflow-y-auto rounded-[10px] border border-line bg-panel shadow-pop",
          wide ? "w-[min(640px,calc(100vw-32px))]" : "w-[min(480px,calc(100vw-32px))]", bare ? "p-0" : "p-5")}>
        {title && <h2 className="m-0 mb-1 text-[15px]">{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export const ModalActions = ({ children }: { children: ReactNode }) => <div className="mt-5 flex justify-end gap-2">{children}</div>;

/* ------------------------------ identity & color ----------------------------- */

/** Small tinted square with the object's initial. */
export function ObjIcon({ slug, size = 18 }: { slug: string; size?: number }) {
  const obj = useObject(slug);
  const c = dot(objColor(obj, slug));
  return (
    <span aria-hidden="true" className="inline-grid flex-none place-items-center rounded-[5px] font-semibold leading-none"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.58), color: c, background: tint(c) }}>
      {(obj?.label ?? slug).slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Avatar({ type, name }: { type: string; name: string }) {
  const label = name === "You" || name === "system" ? "Y" : initials(name).slice(0, 1);
  const agent = type === "agent";
  return (
    <span title={agent ? `${name} (agent)` : name}
      className={cn("grid size-[22px] flex-none place-items-center rounded-full text-[11px] font-semibold",
        agent ? "bg-agent/15 text-agent" : "bg-accent/15 text-accent")}>
      {label}
    </span>
  );
}

/** Name of whoever made a change; agents are teal. */
export function Who({ type, name }: { type?: string; name: string }) {
  const agent = type ? type === "agent" : !(name === "You" || name === "system" || name.startsWith("You "));
  return <span className={agent ? "text-agent" : undefined}>{name === "system" ? "Open CRM" : name}</span>;
}

/** A select/multi-select value: neutral pill with a colored dot. */
export function Tag({ label, color, className }: { label: ReactNode; color?: string; className?: string }) {
  return (
    <span className={cn("mr-1 my-px inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-line-2 bg-panel px-2 text-xs text-ink-2", className)}>
      <i className="size-[7px] flex-none rounded-full" style={{ background: dot(color) }} />
      {label}
    </span>
  );
}

/** Due date with urgency: overdue (red), today (amber), within a week (accent). */
export function DueDate({ due, done }: { due: string; done?: boolean }) {
  const day = due.slice(0, 10);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const now = new Date();
  const t = iso(now);
  const week = iso(new Date(now.getTime() + 7 * 864e5));
  const state = done ? "" : day < t ? "overdue" : day === t ? "today" : day <= week ? "soon" : "";
  const text = !done && day === t ? "Today" : !done && day < t ? `${fmtDate(due)} · overdue` : fmtDate(due);
  return (
    <span className={cn("inline-flex h-[22px] items-center whitespace-nowrap rounded-full px-2 text-xs tabular-nums",
      state === "overdue" && "bg-danger/12 text-danger",
      state === "today" && "bg-[color-mix(in_srgb,var(--d-amber)_16%,transparent)] text-[color-mix(in_srgb,var(--d-amber)_75%,var(--ink))]",
      state === "soon" && "bg-accent/11 text-accent",
      !state && "text-muted")}>
      {text}
    </span>
  );
}

export const COLOR_NAMES = ["gray", "blue", "violet", "green", "amber", "orange", "red", "teal", "pink"] as const;

/** Row of palette dots plus a custom-color swatch; the selected one gets a ring. */
export function ColorSwatches({ value, onChange, size = 18 }: { value?: string; onChange: (c: string) => void; size?: number }) {
  const custom = !!value && value.startsWith("#");
  const [draft, setDraft] = useState(custom ? value! : "#0ea5e9");
  useEffect(() => { if (custom) setDraft(value!); }, [value]);
  const ring = "ring-2 ring-ink ring-offset-2 ring-offset-bg";
  return (
    <div role="radiogroup" className="inline-flex flex-wrap items-center gap-1.5">
      {COLOR_NAMES.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} title={c} onClick={() => onChange(c)}
          className={cn("rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,.08)] transition-transform hover:scale-110", value === c && ring)}
          style={{ width: size, height: size, background: `var(--d-${c})` }} />
      ))}
      <label title={custom ? `Custom ${value}` : "Custom color"}
        className={cn("relative cursor-pointer overflow-hidden rounded-full transition-transform hover:scale-110", custom && ring)}
        style={{ width: size, height: size, background: custom ? value : "conic-gradient(#ef4444,#f59e0b,#22c55e,#14b8a6,#3b82f6,#8b5cf6,#ec4899,#ef4444)" }}>
        {/* React's onChange fires while dragging (preview); the native "change" fires once when the picker closes (save). */}
        <input type="color" value={draft} aria-label="Custom color" className="absolute -inset-1 size-[calc(100%+8px)] cursor-pointer opacity-0"
          onChange={(e) => setDraft(e.target.value)}
          ref={(el) => { if (el) el.onchange = () => onChange(el.value); }} />
      </label>
    </div>
  );
}

/** The Handshake mark: human chevron (indigo), agent chevron (teal), shared record. Theme-aware. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M11.5 7.5 L4.5 16 L11.5 24.5" fill="none" stroke="var(--mark-a)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20.5 7.5 L27.5 16 L20.5 24.5" fill="none" stroke="var(--mark-b)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="3.3" fill="var(--mark-c)" />
    </svg>
  );
}

/** Copyable code block. */
export function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      <pre className="pr-20">{text}</pre>
      <Button size="sm" className="absolute top-1.5 right-1.5"
        onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}>
        {done ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
