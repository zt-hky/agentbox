import type { Metadata } from "next";
import { headers } from "next/headers";
import { JetBrains_Mono, Schibsted_Grotesk } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const grotesk = Schibsted_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-grotesk" });
const jbmono = JetBrains_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-jbmono" });

export const metadata: Metadata = {
  title: { default: "AgentBox", template: "%s | AgentBox" },
  description: "Persistent coding-agent workspaces",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request nonce also opts every page into dynamic rendering, which Next requires
  // for nonce-based CSP.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={`${grotesk.variable} ${jbmono.variable}`} suppressHydrationWarning>
      <body className="min-h-svh antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          nonce={nonce}
        >
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
