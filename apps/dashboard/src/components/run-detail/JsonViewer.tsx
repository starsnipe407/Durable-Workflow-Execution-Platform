'use client';

import React, { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, Code } from 'lucide-react';

export interface JsonViewerProps {
  title: string;
  data: unknown;
  defaultExpanded?: boolean;
}

export function JsonViewer({ title, data, defaultExpanded = true }: JsonViewerProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const hasData = data !== null && data !== undefined;
  const jsonString = hasData ? JSON.stringify(data, null, 2) : '';

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasData) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(jsonString);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  return (
    <div className="rounded-lg border border-neutral-200 bg-white shadow-xs overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-3 bg-neutral-50/75 border-b border-neutral-200 cursor-pointer select-none"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="toggle-collapse"
            className="p-0.5 text-neutral-500 hover:text-neutral-800 rounded focus:outline-none"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0" />
            )}
          </button>
          <Code className="h-4 w-4 text-neutral-400 shrink-0" />
          <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
        </div>

        {hasData && (
          <button
            type="button"
            aria-label="copy-json"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 bg-white border border-neutral-200 rounded hover:bg-neutral-50 focus:outline-none transition-colors"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-600" />
                <span className="text-emerald-700">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3 text-neutral-400" />
                <span>Copy</span>
              </>
            )}
          </button>
        )}
      </div>

      {isExpanded && (
        <div className="p-4 bg-neutral-950 text-neutral-100 text-xs font-mono overflow-x-auto max-h-96">
          {hasData ? (
            <pre className="whitespace-pre-wrap break-words">{jsonString}</pre>
          ) : (
            <p className="text-neutral-500 italic">No data</p>
          )}
        </div>
      )}
    </div>
  );
}
