import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sentinel | Monitoramento de segurança",
  description:
    "Monitoramento e investigação de eventos de segurança para aplicações web. Projeto em desenvolvimento.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
