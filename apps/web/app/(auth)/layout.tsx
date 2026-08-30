import { APP_NAME } from "@/lib/constants";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-2 p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <div className="flex items-center gap-2.5">
            <div className="w-[26px] h-[26px] rounded-[7px] bg-ink text-bg grid place-items-center font-mono font-medium text-[13px] relative">
              FR
              <span className="absolute -right-[3px] -bottom-[3px] w-2 h-2 rounded-full bg-accent border-2 border-bg-2" />
            </div>
            <span className="font-semibold tracking-[-0.01em] text-[17px]">{APP_NAME}</span>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
