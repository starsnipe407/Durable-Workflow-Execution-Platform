import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { QueryProvider } from '@/lib/query-client';
import { Navbar } from '@/components/layout/Navbar';

export const metadata: Metadata = {
  title: 'Durable Engine Dashboard',
  description: 'Observability dashboard for durable workflow execution',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased font-sans">
        <QueryProvider>
          <Navbar />
          <main className="container mx-auto px-4 py-6 max-w-7xl">{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}
