import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className = '', ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={`border-b-2 border-divider ${className}`} {...props} />;
}

/** Underlined tab: a 3px accent bar and heavy weight when active. */
export function TabsTrigger({ className = '', ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={`-mb-0.5 flex cursor-pointer flex-col items-start gap-0.5 border-0 border-r border-b-3 border-r-divider border-b-transparent bg-transparent px-3.5 py-2.5 text-left text-[13px] text-text hover:bg-neutral-200 data-[state=active]:border-b-accent data-[state=active]:font-extrabold ${className}`}
      {...props}
    />
  );
}

export const TabsContent = TabsPrimitive.Content;
