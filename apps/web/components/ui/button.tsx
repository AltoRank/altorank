import { cn } from "@/lib/utils";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "accent" | "ghost";
  size?: "sm" | "md" | "lg";
};

const variantClasses = {
  default: "border-line bg-bg text-ink hover:bg-panel-2",
  primary: "bg-ink text-bg border-ink hover:bg-[oklch(0.25_0.008_80)]",
  accent: "bg-accent text-white border-accent hover:bg-accent-2 hover:border-accent-2",
  ghost: "bg-transparent border-transparent text-ink-2 hover:bg-panel-2 hover:text-ink",
};

const sizeClasses = {
  sm: "px-[9px] py-[5px] text-[12.5px]",
  md: "px-3 py-[7px] text-[13px]",
  lg: "px-4 py-2.5 text-sm",
};

export function Button({
  variant = "default",
  size = "md",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center gap-[7px] rounded-[7px] font-medium border whitespace-nowrap transition-[background,border-color] duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function IconButton({
  ghost,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { ghost?: boolean }) {
  return (
    <button
      className={cn(
        "w-[30px] h-[30px] rounded-[7px] inline-grid place-items-center text-ink-2 cursor-pointer transition-colors disabled:opacity-40 disabled:pointer-events-none",
        ghost
          ? "border-transparent bg-transparent hover:bg-panel-2 hover:border-line hover:text-ink"
          : "border border-line bg-bg hover:bg-panel-2 hover:text-ink",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
