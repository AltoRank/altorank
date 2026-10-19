import type { Metadata } from "next";
import { headers } from "next/headers";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/constants";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { NONCE_HEADER } from "@/lib/security/csp";
import { RouteMemory } from "@/components/route-memory";

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The request's CSP nonce (middleware.ts). Reading it renders every page per
  // request, which a nonce needs: a page built ahead of time would carry
  // scripts with no nonce, and the policy would refuse them.
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
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
            in lib/__tests__/theme.test.ts; nothing user-supplied reaches it.
            It carries the request's nonce, the only way an inline script
            runs under the CSP. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        {children}
        {/* The path before this one, for where an article was opened from. */}
        <RouteMemory />
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
