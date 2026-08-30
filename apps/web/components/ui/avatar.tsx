import { cn } from "@/lib/utils";

type AvatarProps = {
  initials: string;
  color: string;
  size?: "sm" | "md" | "lg";
  round?: boolean;
  className?: string;
};

const sizeClasses = {
  sm: "w-5 h-5 text-[9px] rounded-[5px]",
  md: "w-[26px] h-[26px] text-[11px] rounded-[6px]",
  lg: "w-[34px] h-[34px] text-[13px] rounded-[8px]",
};

export function Avatar({ initials, color, size = "md", round, className }: AvatarProps) {
  return (
    <span
      className={cn(
        "inline-grid place-items-center text-white font-semibold font-mono shrink-0",
        sizeClasses[size],
        round && "rounded-full",
        color,
        className
      )}
    >
      {initials}
    </span>
  );
}
