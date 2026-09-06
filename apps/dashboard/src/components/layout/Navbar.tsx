'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity } from 'lucide-react';
import { SystemHealthBadge } from '../dashboard/SystemHealthBadge';

export function Navbar() {
  const pathname = usePathname();

  const isOverviewActive = pathname === '/' || pathname.startsWith('/dashboard');
  const isWorkflowsActive = pathname.startsWith('/workflows');
  const isRunsActive = pathname.startsWith('/runs');

  return (
    <header className="sticky top-0 z-50 w-full border-b border-neutral-200 bg-white/95 backdrop-blur-sm">
      <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 font-semibold text-neutral-900 tracking-tight text-lg"
          >
            <Activity className="h-5 w-5 text-indigo-600" />
            <span>Durable Engine</span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link
              href="/dashboard"
              className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                isOverviewActive
                  ? 'bg-neutral-100 text-neutral-900 font-semibold'
                  : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-50'
              }`}
            >
              Overview
            </Link>
            <Link
              href="/workflows"
              className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                isWorkflowsActive
                  ? 'bg-neutral-100 text-neutral-900 font-semibold'
                  : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-50'
              }`}
            >
              Workflows
            </Link>
            <Link
              href="/runs"
              className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                isRunsActive
                  ? 'bg-neutral-100 text-neutral-900 font-semibold'
                  : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-50'
              }`}
            >
              Runs
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <SystemHealthBadge />
        </div>
      </div>
    </header>
  );
}
