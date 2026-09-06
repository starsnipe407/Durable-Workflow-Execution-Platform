import type { ReactNode } from 'react';

export interface MetricCardProps {
  title: string;
  value: string | number;
  icon?: ReactNode;
  tone?: 'default' | 'green' | 'red' | 'blue' | 'amber';
}

const toneStyles: Record<
  NonNullable<MetricCardProps['tone']>,
  { container: string; value: string; icon: string }
> = {
  default: {
    container: 'border-neutral-200 bg-white',
    value: 'text-neutral-900',
    icon: 'text-neutral-500 bg-neutral-100',
  },
  green: {
    container: 'border-emerald-200 bg-emerald-50/40',
    value: 'text-emerald-950',
    icon: 'text-emerald-600 bg-emerald-100',
  },
  red: {
    container: 'border-rose-200 bg-rose-50/40',
    value: 'text-rose-950',
    icon: 'text-rose-600 bg-rose-100',
  },
  blue: {
    container: 'border-blue-200 bg-blue-50/40',
    value: 'text-blue-950',
    icon: 'text-blue-600 bg-blue-100',
  },
  amber: {
    container: 'border-amber-200 bg-amber-50/40',
    value: 'text-amber-950',
    icon: 'text-amber-600 bg-amber-100',
  },
};

export function MetricCard({ title, value, icon, tone = 'default' }: MetricCardProps) {
  const styles = toneStyles[tone];

  return (
    <div
      className={`relative overflow-hidden rounded-xl border p-5 shadow-xs transition-shadow hover:shadow-sm ${styles.container}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-neutral-600">{title}</span>
        {icon && (
          <span className={`inline-flex p-2 rounded-lg ${styles.icon}`}>
            {icon}
          </span>
        )}
      </div>
      <div className="mt-3 flex items-baseline">
        <span className={`text-3xl font-bold tracking-tight ${styles.value}`}>
          {value}
        </span>
      </div>
    </div>
  );
}
