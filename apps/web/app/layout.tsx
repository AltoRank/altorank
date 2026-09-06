import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/constants";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: `${APP_NAME} — AI SEO content engine`,
    template: `%s | ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${jetbrainsMono.variable} h-full antialiased`}
      // The theme script below stamps `data-theme` on this element before
      // React hydrates, so the server's <html> and the browser's differ by
      // exactly that attribute, on purpose.
      suppressHydrationWarning
    >
      <head>
        {/* Runs before first paint: picks light or dark from the stored
            choice or the system setting, so the page never flashes light and
            then snaps dark. The string is a constant from lib/theme.ts, tested
            in lib/__tests__/theme.test.ts; nothing user-supplied reaches it. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
